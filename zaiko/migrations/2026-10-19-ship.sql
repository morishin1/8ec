-- ============================================================
-- 発送の管理（売ったあと、まだ発送していないものを見落とさない）
--
--    販売済みにする → 販売一覧（未発送）に出る → 発送する →
--    未発送から消えて「発送済み」のほうへ移る。
--    **データは消さない。出す場所を分けるだけ。**
--
--    持つのは inventory_items の2列だけ。
--      shipped_at … 発送した日時。NULL なら未発送
--      shipped_by … 発送した人（inv_actor）
--    配送会社・追跡番号は Phase 2。いまは列も作らない
--    （決まっていないことを列にしても埋まらないので）。
--
--    **外部販売サイトの出品停止とは別の話。**
--    発送したからといって楽天・Amazonの出品を止めたことにはしない
--    （出品の状態は inventory_channels / inventory_channel_listings が持つ）。
--    売上・粗利（inv_dashboard_stats）も発送では変わらない。
--    売れた時点で売上なので、ここでは1行も触らない。
--
--    既存の migration は書き換えない。何度実行しても同じ結果になる。
-- ============================================================


-- ------------------------------------------------------------
-- 1) 列（2つだけ）
-- ------------------------------------------------------------
alter table public.inventory_items add column if not exists shipped_at timestamptz;
alter table public.inventory_items add column if not exists shipped_by text;

comment on column public.inventory_items.shipped_at is
  '発送した日時。NULL なら未発送。売却済でなくなったら自動で NULL に戻る
   （売却取消のあと、同じ個体をもう一度売ったときに「発送済み」が残らないように）。';
comment on column public.inventory_items.shipped_by is
  '発送した人（inv_actor）。shipped_at と同時に入り、同時に消える。';

-- 未発送の件数を数えるところ（メニューのバッジ・ダッシュボード）が一番よく引くので、
-- 売却済のぶんだけの部分索引にする（全件に索引を張らない）
create index if not exists inventory_items_unshipped_idx
  on public.inventory_items (shipped_at)
  where status = '売却済';


-- ------------------------------------------------------------
-- 2) 売却済でなくなったら、発送の記録も外す
--
--    売却取消（inv_item_sell_undo）・状態変更・一括操作、どの経路でも
--    通るようにトリガーにする。**既存の関数を書き換えない**のが狙いで、
--    売却取消の本文（#49 の「戻り先は履歴から決める」）には1行も触らない。
--
--    あわせて、**発送済みのものを売却前へ戻すのは管理者だけ**にする。
--    もう出荷してしまったものを倉庫メンバーが在庫へ戻すと、現物が無いのに
--    在庫があることになる。管理者なら戻せる（返品の受け入れなど）。
-- ------------------------------------------------------------
create or replace function public.inv_ship_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 売却済 → それ以外（売却取消・状態変更）
  if old.status = '売却済' and new.status is distinct from '売却済' then
    if old.shipped_at is not null and not public.inv_is_admin() then
      raise exception
        '% は発送済みです（%）。発送したものを売却前へ戻せるのは管理者だけです',
        old.id, to_char(old.shipped_at, 'YYYY/MM/DD HH24:MI');
    end if;
    new.shipped_at := null;
    new.shipped_by := null;
  end if;

  -- それ以外 → 売却済（新しく売った）。前の発送の記録を持ち越さない
  if new.status = '売却済' and old.status is distinct from '売却済' then
    new.shipped_at := null;
    new.shipped_by := null;
  end if;

  return new;
end $$;

comment on function public.inv_ship_guard is
  '売却済でなくなったら発送の記録（shipped_at / shipped_by）を外す。
   新しく売ったときも持ち越さない。どの経路の UPDATE でも通るようにトリガーにしている。
   発送済みのものを売却前へ戻せるのは管理者だけ（倉庫メンバーはここで止まる）。';

drop trigger if exists inventory_items_ship on public.inventory_items;
create trigger inventory_items_ship before update on public.inventory_items
  for each row execute function public.inv_ship_guard();


-- ------------------------------------------------------------
-- 3) 発送する・発送を取り消す
--
--    画面から直接UPDATEせず、必ずここを通す（値を変えるのと履歴を残すのが
--    1つの取引になるように）。
--
--      発送する     … admin / member（倉庫の作業なので）
--      発送を取り消す … admin だけ（出荷の記録を戻すのは訂正なので）
--
--    二重に押しても壊れない。すでにその状態なら何も書かず、履歴も増やさない。
-- ------------------------------------------------------------
create or replace function public.inv_item_ship(
  p_item_id text,
  p_on      boolean default true,
  p_note    text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it    public.inventory_items;
  v_who text := public.inv_actor();
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if not p_on and not public.inv_is_admin() then
    raise exception '発送を取り消せるのは管理者だけです';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  -- 発送できるのは売れたものだけ。まだ売っていないものは発送の話にならない
  if it.status <> '売却済' then
    raise exception '発送を記録できるのは「売却済」のものだけです（いまは %）', it.status;
  end if;

  -- すでに同じ状態なら触らない（二重に押しても履歴を水増ししない）
  if (p_on and it.shipped_at is not null)
  or (not p_on and it.shipped_at is null) then
    return it;
  end if;

  update public.inventory_items
     set shipped_at = case when p_on then now() else null end,
         shipped_by = case when p_on then v_who else null end
   where id = p_item_id
  returning * into it;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (v_who, 'item', p_item_id, it.name,
          case when p_on then '発送完了' else '発送取消' end,
          case when p_on then '未発送' else '発送済み' end,
          (case when p_on
                then '発送済み（' || to_char(it.shipped_at, 'YYYY/MM/DD HH24:MI') || '）'
                else '未発送' end)
            || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), ''));

  return it;
end $$;

comment on function public.inv_item_ship is
  'その1台を発送済みにする（p_on = false で取り消し）。売却済のものだけ。
   shipped_at / shipped_by だけを書き、在庫状態・実売価格・販売先・出品価格は触らない。
   発送するのは admin / member、取り消せるのは admin だけ。
   二重に押しても何も起きない（履歴も増えない）。';


-- ------------------------------------------------------------
-- 4) 権限
-- ------------------------------------------------------------
revoke all on function public.inv_item_ship(text, boolean, text) from public, anon, service_role;
grant execute on function public.inv_item_ship(text, boolean, text) to authenticated;

-- トリガー関数は直接呼ばせない
revoke all on function public.inv_ship_guard() from public, anon, authenticated, service_role;


-- ------------------------------------------------------------
-- 自己点検（14項目＋件数3行）
--
--    データは1行も作らず、形と権限だけを見る（読むだけ）。
--    実際の振る舞いは zaiko/check-ship.sql で確かめる
--    （そちらは BEGIN … ROLLBACK で、本番のデータを1行も変えない）。
-- ------------------------------------------------------------
select '発送の列ができている' as kind,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'inventory_items'
                     and column_name in ('shipped_at', 'shipped_by')) = 2
            then 'OK 2列そろっている' else 'NG' end as result
union all
select '未発送をすぐ数えられる（部分索引）',
       case when exists (select 1 from pg_indexes
                          where schemaname = 'public' and tablename = 'inventory_items'
                            and indexname = 'inventory_items_unshipped_idx')
            then 'OK' else 'NG' end
union all
select '発送の関数ができている',
       case when to_regprocedure('public.inv_item_ship(text, boolean, text)') is not null
            then 'OK' else 'NG' end
union all
select '発送できるのは admin / member',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 like '%inv_can_edit()%'
            then 'OK' else 'NG' end
union all
select '発送を取り消せるのは admin だけ',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 like '%not p_on and not public.inv_is_admin()%'
            then 'OK' else 'NG' end
union all
select '発送できるのは売却済のものだけ',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 like '%it.status <> ''売却済''%'
            then 'OK' else 'NG' end
union all
select '二重に押しても履歴を増やさない',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 like '%it.shipped_at is not null%then%return it;%'
            then 'OK' else 'NG' end
union all
select '発送で在庫状態・実売価格・販売先を動かさない',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 not like '%status =%'
             and (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 not like '%sold_price =%'
             and (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 not like '%sold_channel =%'
            then 'OK' else 'NG' end
union all
select '出品価格のマスタへ書き戻さない',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_ship(text, boolean, text)'::regprocedure)
                 not like '%inventory_channel%'
            then 'OK' else 'NG' end
union all
select '売却済でなくなったら発送の記録を外す（トリガー）',
       case when exists (select 1 from pg_trigger
                          where tgname = 'inventory_items_ship'
                            and tgrelid = 'public.inventory_items'::regclass
                            and not tgisinternal)
             and (select prosrc from pg_proc
                   where oid = 'public.inv_ship_guard()'::regprocedure)
                 like '%new.shipped_at := null%'
            then 'OK' else 'NG' end
union all
select '発送済みを売却前へ戻せるのは管理者だけ',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_ship_guard()'::regprocedure)
                 like '%not public.inv_is_admin()%'
            then 'OK' else 'NG' end
union all
select '売上・粗利の数えかたは変えていない',
       case when to_regprocedure('public.inv_dashboard_stats(date)') is not null
             and (select prosrc from pg_proc
                   where oid = 'public.inv_dashboard_stats(date)'::regprocedure)
                 not like '%shipped%'
            then 'OK 発送では変わらない' else 'NG' end
union all
select '実売価格の入力・修正はそのまま',
       case when to_regprocedure('public.inv_item_sell_channel(text, text, numeric, text)') is not null
             and to_regprocedure('public.inv_item_sale_edit(text, numeric, text, text)') is not null
             and (select coalesce(string_agg(prosrc, ' '), '') from pg_proc
                   where oid in ('public.inv_item_sell_channel(text, text, numeric, text)'::regprocedure,
                                 'public.inv_item_sale_edit(text, numeric, text, text)'::regprocedure))
                 not like '%shipped%'
            then 'OK' else 'NG' end
union all
select '権限は authenticated だけ（トリガー関数は誰も呼べない）',
       case when has_function_privilege('authenticated',
                   'public.inv_item_ship(text, boolean, text)', 'execute')
             and not has_function_privilege('anon',
                   'public.inv_item_ship(text, boolean, text)', 'execute')
             and not has_function_privilege('authenticated', 'public.inv_ship_guard()', 'execute')
             and not has_function_privilege('anon', 'public.inv_ship_guard()', 'execute')
            then 'OK' else 'NG' end
union all
select 'いま売却済の台数',
       (select count(*)::text from public.inventory_items where status = '売却済') || '台'
union all
select 'うち まだ発送していない台数（メニューのバッジに出ます）',
       (select count(*)::text from public.inventory_items
         where status = '売却済' and shipped_at is null) || '台'
union all
select 'うち 発送済みの台数',
       (select count(*)::text from public.inventory_items
         where status = '売却済' and shipped_at is not null) || '台';
