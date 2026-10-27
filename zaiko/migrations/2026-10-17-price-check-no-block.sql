-- ============================================================
-- 価格の確認を「在庫状態の条件」から外す（2026-10-17）
--
--    #55（2026-10-14-price-check.sql）では
--      ① 価格（仕入・手数料・販売予定）が変わったら確認が外れる
--      ② 未確認のまま inventory_items.status = '出品中' にはできない
--    の2つをトリガー inv_price_check_guard() に入れていた。
--
--    運用してみると ② が強すぎた。「在庫状態としての出品中」は、
--    棚や作業の実態を表すただの状態で、**外部モールへ掲載する操作ではない**。
--    実際にモールへ掲載する処理は8ECには無い（外部モール側へは1行も書かない）。
--    そこで ② をやめる。
--
--      ・価格が未設定でも「出品中」にできる
--      ・価格が未確認でも「出品中」にできる
--      ・「価格確認済み／未確認」の表示は残す（管理上の確認フラグとして）
--      ・確認済みにできるのは管理者だけ、というのも残す（inv_price_check_set）
--      ・価格を変えたら確認が外れる（①）も残す
--
--    **既存の 2026-10-14-price-check.sql は書き換えない。**
--    本番で一度実行したものなので、解除はこのファイルで行う。
--    列（price_checked_at / price_checked_by）も、確認の操作も、履歴も消さない。
--
--    売却・QR販売・実売価格の入力には影響させない。
--    inv_item_sell() / inv_item_sell_channel() / inv_item_sale_edit() は触らない。
--    ただし #55 が ② のために**安全側へ寄せていた2か所**は、寄せる理由が
--    無くなるので元に戻す（下の 3) 4)）。
--
--    何度実行しても同じ結果になる（create or replace だけ）。
-- ============================================================


-- ------------------------------------------------------------
-- 1) トリガーは残す。**「出品中にさせない」だけを外す**
--
--    トリガーそのものを落とすと「価格を変えたら確認が外れる」も消えてしまう。
--    関数の中身を入れ替えて、前半（確認を外す）だけを残す。
-- ------------------------------------------------------------
create or replace function public.inv_price_check_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 価格（仕入・手数料・販売予定）が変わったら、確認は外れる
  if new.price         is distinct from old.price
  or new.purchase_fee  is distinct from old.purchase_fee
  or new.plan_price    is distinct from old.plan_price then
    new.price_checked_at := null;
    new.price_checked_by := null;
  end if;

  -- **「未確認のまま出品中にはできない」は外した（2026-10-17）。**
  -- 在庫状態としての「出品中」は、外部モールへの掲載とは別もの。
  -- 価格が未設定・未確認でも、状態は現場の実態どおりに変えられる。

  return new;
end $$;

comment on function public.inv_price_check_guard is
  '価格（仕入・手数料・販売予定）を変えたら、価格の確認を外す。
   どの経路の UPDATE でも通るようにトリガーにしている。
   **在庫状態（status）は見ない。** 未確認の個体を「出品中」にすることは止めない
   （2026-10-17 でその制限を外した。在庫状態と外部モールへの掲載は別もの）。';

-- トリガーは付け直す（念のため。名前・タイミングは #55 と同じ）
drop trigger if exists inventory_items_price_check on public.inventory_items;
create trigger inventory_items_price_check before update on public.inventory_items
  for each row execute function public.inv_price_check_guard();


-- ------------------------------------------------------------
-- 2) 残すもの（ここでは触らない）
--
--    inventory_items.price_checked_at / price_checked_by … 列はそのまま
--    inv_price_check_set(text[], boolean, text)          … 管理者だけ。そのまま
--    画面の「確認済み／未確認」の表示                      … そのまま
--    履歴の「価格確認」「価格確認取消」                    … 消さない
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 3) 棚卸の差異確定取消を元に戻す
--
--    #55 では「戻り先が出品中で価格が未確認なら在庫へ寄せる」を足していた。
--    1) のトリガーが例外を投げるため、そうしないと取消そのものが
--    できなくなるからだった。例外が無くなったので、この寄せはもう要らない。
--
--    **本文は #55 のものをそのまま使い、その寄せ（if 文）だけを外している。**
--    戻り先を履歴の before_value から取る（推測しない）ところは変えていない。
-- ------------------------------------------------------------
create or replace function public.inv_stocktake_unmark_missing(
  p_stocktake_id bigint,
  p_item_id      text
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  st     public.inventory_stocktakes;
  it     public.inventory_items;
  v_row  public.inventory_stocktake_items;
  v_back text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into st from public.inventory_stocktakes where id = p_stocktake_id;
  if not found then
    raise exception '棚卸が見つかりません（%）', p_stocktake_id;
  end if;
  if st.status <> 'open' then
    raise exception '終了した棚卸は直せません';
  end if;

  select * into v_row from public.inventory_stocktake_items
   where stocktake_id = p_stocktake_id and item_id = p_item_id
   for update;
  if not found then
    raise exception 'この棚卸の対象ではありません（%）', p_item_id;
  end if;
  if v_row.missing_at is null then
    raise exception '差異確定していません（%）', p_item_id;
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  update public.inventory_stocktake_items
     set missing_at = null
   where stocktake_id = p_stocktake_id and item_id = p_item_id;

  -- '不明' のままなら、差異確定する前の状態へ戻す。
  -- 戻り先は推測せず、差異確定のときに履歴へ残した before_value をそのまま使う。
  -- 棚卸の対象は 在庫・出品中 だけなので、それ以外が入っていたら在庫に寄せる。
  if it.status = '不明' then
    select t.before_value into v_back
      from public.inventory_transactions t
     where t.ref_kind = 'item' and t.ref_id = p_item_id
       and t.action = '棚卸差異確定'
       and t.occurred_at >= st.started_at
     order by t.occurred_at desc
     limit 1;
    if v_back is null or v_back not in ('在庫', '出品中') then
      v_back := '在庫';
    end if;
    update public.inventory_items set status = v_back where id = p_item_id
    returning * into it;
  else
    -- 人があとから別の状態にしている。上書きしない
    v_back := it.status || '（そのまま）';
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '棚卸差異確定取消',
          '不明', v_back);

  return it;
end $$;

comment on function public.inv_stocktake_unmark_missing is
  '差異確定を取り消して未処理へ戻す。状態が ''不明'' のままのときだけ、
   差異確定のときに履歴へ残した元の状態（在庫／出品中）へ戻す。
   人があとから別の状態にしていたら上書きしない。履歴は消さず追記する。
   価格が未確認でも ''出品中'' へ戻す（2026-10-17。価格の確認は在庫状態の条件ではない）。';


-- ------------------------------------------------------------
-- 4) 売却取消（#49）を元に戻す
--
--    3) と同じ理由。戻り先が '出品中' なら、価格が未確認でも出品中へ戻す。
--    **本文は #55 のものをそのまま使い、その寄せ（if 文）だけを外している。**
--    #49 の「戻り先は履歴から決める・推測しない」、受注明細の割り当て解除、
--    履歴の書き方（売却の行を消さずに売却取消を足す）は1行も変えていない。
--    外部販売サイトへは何も送らない（再出品もしない）。
-- ------------------------------------------------------------
create or replace function public.inv_item_sell_undo(
  p_item_id text,
  p_note    text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it     public.inventory_items;
  v_prev text;
  v_was  text;
  v_info jsonb;
  v_ord  jsonb;
  v_ords text[] := '{}';
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  -- 1) いま売却済のものだけ。取消済み・もともと売却済でないものはここで止まる
  if it.status <> '売却済' then
    raise exception '「売却済」のものだけ取り消せます（いまは %）', it.status;
  end if;

  -- 2) 戻る状態は履歴から取る。**推測しない。**判定は確認画面と同じ1つの関数に任せる
  v_info := public.inv_item_sell_undo_info(p_item_id);
  v_prev := v_info ->> 'back';
  if v_prev is null then
    raise exception
      '売却前の状態が履歴から決められないので取り消せません（%）。'
      '売却の履歴が無い／いちばん新しい売却はすでに取り消し済み／'
      '売却前が貸出中・社内使用（利用者を復元できない）、のどれかです。'
      'もとの操作からやり直してください', p_item_id;
  end if;


  -- 3) 戻す。売却のときだけ入る値は空にする
  v_was := '売却済'
           || coalesce('（' || nullif(btrim(coalesce(it.sold_channel, '')), '') || '）', '')
           || coalesce('（' || to_char(it.sold_price, 'FM9,999,999,999') || '円）', '');

  update public.inventory_items
     set status       = v_prev,
         sold_price   = null,
         sold_channel = null,
         user_name    = null,
         loaned_at    = null
   where id = p_item_id
  returning * into it;

  -- 4) モールの受注明細に割り当たっていたら、**8EC の中の紐付けだけ**を外す。
  --    外さないと「この注文は個体Aへ発送済み」という記録が残り、個体Aは在庫に戻るので
  --    中のデータが食い違う。外部のモールへは何も送らない。
  for v_ord in select * from jsonb_array_elements(coalesce(v_info -> 'orders', '[]'::jsonb)) loop
    perform public.inv_sale_order_unlink((v_ord ->> 'id')::bigint, p_item_id,
      p_item_id || ' の販売済みを取り消したため割り当てを解除しました。別の個体を割り当ててください');
    v_ords := v_ords || ((v_ord ->> 'channel') || ' 注文 ' || (v_ord ->> 'order_number'));
  end loop;

  -- 5) 履歴。**「売却」の行は消さない。**「売却取消」を足して 売却 → 売却取消 と並べる
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '売却取消',
          v_was,
          v_prev
          || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), '')
          || case when array_length(v_ords, 1) is null then ''
                  else '／割り当て解除 ' || array_to_string(v_ords, '・') end);

  return it;
end $$;

comment on function public.inv_item_sell_undo is
  '誤って売却済にした1台を、売却の直前の状態へ戻す。戻り先は履歴（action=''売却'' の
   before_value）から取り、分からなければ戻さずエラーにする。sold_price / sold_channel は
   空に戻す。既存の「売却」履歴は消さず、「売却取消」を足す。外部販売サイトへの再出品はしない。
   価格が未確認でも ''出品中'' へ戻す（2026-10-17。価格の確認は在庫状態の条件ではない）。';


-- ------------------------------------------------------------
-- 5) 権限（create or replace で既存の権限は残るが、同じ形で配り直す）
-- ------------------------------------------------------------
revoke all on function public.inv_price_check_guard() from public, anon, authenticated, service_role;

revoke all on function public.inv_stocktake_unmark_missing(bigint, text) from public, anon, service_role;
grant execute on function public.inv_stocktake_unmark_missing(bigint, text) to authenticated;

revoke all on function public.inv_item_sell_undo(text, text) from public, anon, service_role;
grant execute on function public.inv_item_sell_undo(text, text) to authenticated;


-- ------------------------------------------------------------
-- 自己点検（15項目＋件数3行）
--
--    データは1行も作らず、関数の中身と権限だけを見る（読むだけ）。
--    実際の振る舞いは zaiko/check-price-check.sql で確かめる
--    （そちらは BEGIN … ROLLBACK で、本番のデータを1行も変えない）。
-- ------------------------------------------------------------
select '確認の列は残っている' as kind,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'inventory_items'
                     and column_name in ('price_checked_at', 'price_checked_by')) = 2
            then 'OK 2列そろっている' else 'NG' end as result
union all
select 'トリガーは付いたまま（価格を変えたら確認を外すため）',
       case when exists (select 1 from pg_trigger
                          where tgname = 'inventory_items_price_check'
                            and tgrelid = 'public.inventory_items'::regclass
                            and not tgisinternal)
            then 'OK' else 'NG 付いていない' end
union all
select '「未確認のまま出品中にはできない」は外れた',
       -- 判定そのものを見る（説明のコメントには「出品中」の語が残るので、
       -- 止める処理＝raise exception と、状態を読む new.status の有無で見る）
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_price_check_guard()'::regprocedure)
                 not like '%raise exception%'
             and (select prosrc from pg_proc
                   where oid = 'public.inv_price_check_guard()'::regprocedure)
                 not like '%new.status%'
            then 'OK 状態を見ず、止めもしない' else 'NG まだ止めている' end
union all
select '価格を変えたら確認が外れる（これは残す）',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_price_check_guard()'::regprocedure)
                 like '%price_checked_at := null%'
            then 'OK' else 'NG 外れなくなっている' end
union all
select '確認済みにする操作は残っている',
       case when to_regprocedure('public.inv_price_check_set(text[], boolean, text)') is not null
            then 'OK' else 'NG 消えている' end
union all
select '確認済みにできるのは管理者だけ（これも残す）',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_price_check_set(text[], boolean, text)'::regprocedure)
                 like '%inv_is_admin()%'
            then 'OK' else 'NG' end
union all
select '棚卸の差異確定取消は、未確認でも出品中へ戻す',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_stocktake_unmark_missing(bigint, text)'::regprocedure)
                 not like '%price_checked%'
            then 'OK 在庫へ寄せない' else 'NG まだ寄せている' end
union all
select '売却取消は、未確認でも出品中へ戻す',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_sell_undo(text, text)'::regprocedure)
                 not like '%price_checked%'
            then 'OK 在庫へ寄せない' else 'NG まだ寄せている' end
union all
select '売却取消の戻り先は履歴から取る（#49 のまま）',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_sell_undo(text, text)'::regprocedure)
                 like '%inv_item_sell_undo_info(p_item_id)%'
            then 'OK' else 'NG' end
union all
select '受注明細の割り当て解除も残っている（#49 のまま）',
       case when (select prosrc from pg_proc
                   where oid = 'public.inv_item_sell_undo(text, text)'::regprocedure)
                 like '%inv_sale_order_unlink%'
            then 'OK' else 'NG' end
union all
select '売却・QR販売・実売価格の関数はそのまま',
       case when to_regprocedure('public.inv_item_sell(text, text, text, text)') is not null
             and to_regprocedure('public.inv_item_sell_channel(text, text, numeric, text)') is not null
             and to_regprocedure('public.inv_item_sale_edit(text, numeric, text, text)') is not null
            then 'OK 3つそろっている' else 'NG' end
union all
select '実売価格の入力・修正は価格の確認を見ていない',
       case when (select coalesce(string_agg(prosrc, ' '), '') from pg_proc
                   where oid in ('public.inv_item_sell_channel(text, text, numeric, text)'::regprocedure,
                                 'public.inv_item_sale_edit(text, numeric, text, text)'::regprocedure))
                 not like '%price_checked%'
            then 'OK' else 'NG' end
union all
select '「価格が未確認です」で止める場所がもう無い',
       case when not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public'
                 and p.prosrc like '%価格が未確認です%')
            then 'OK どこにも無い' else 'NG まだ残っている' end
union all
select 'トリガー関数は直接呼べない',
       case when not has_function_privilege('authenticated', 'public.inv_price_check_guard()', 'execute')
             and not has_function_privilege('anon',          'public.inv_price_check_guard()', 'execute')
            then 'OK' else 'NG' end
union all
select '棚卸取消・売却取消は社員が呼べる',
       case when has_function_privilege('authenticated',
                   'public.inv_stocktake_unmark_missing(bigint, text)', 'execute')
             and has_function_privilege('authenticated',
                   'public.inv_item_sell_undo(text, text)', 'execute')
            then 'OK' else 'NG' end
union all
select 'いま価格が未確認の個体数',
       (select count(*)::text from public.inventory_items
         where price_checked_at is null and status <> '廃棄') || '台'
union all
select 'うち いま出品中のもの（これからは未確認でも出品中にできます）',
       (select count(*)::text from public.inventory_items
         where price_checked_at is null and status = '出品中') || '台'
union all
select 'すでに価格を確認済みの個体数',
       (select count(*)::text from public.inventory_items
         where price_checked_at is not null) || '台';
