-- ============================================================
-- 売ったあとでも「実売価格・販売先」を直せるようにする
--   2026-10-15
--
--   現場では、売ったあとに金額や販売先の間違いに気づくことがある。
--   そのときに**売却を取り消して売り直す**のは重たいので、
--   販売実績だけを直せるようにする。
--
--     /zaiko/sales の ［販売情報を修正］ → 実売価格・販売先を直す
--
--   **直すのは販売実績の2つだけ。**
--     inventory_items.sold_price    … 今回いくらで売れたか
--     inventory_items.sold_channel  … どこで売れたか
--
--   触らないもの
--     ・在庫状態（status）・利用者（user_name）・貸出日（loaned_at）
--       → 「売却済」のままで、在庫へ戻したりしない
--     ・出品価格・販売予定価格のマスタ
--       inventory_channels.price / inventory_channel_listings.price / plan_price
--     ・売却の履歴（action='売却'）そのもの → 1行も消さない・書き換えない
--
--   「価格の確認」(66) とは別のことがら。混ぜない。
--     価格の確認 … **出品価格**を管理者が確認するまで「出品中」にできない
--     実売価格   … **今回いくらで売れたか**
--   **価格が未確認でも、実売価格の修正はできる**（出品の可否とは関係ない）。
--
--   このmigrationでやること
--     1) inv_item_sale_edit() … 実売価格・販売先を直す（admin / member だけ）
--     2) 権限
--     3) 自己点検
--
--   月次の売上・粗利・販売一覧は inventory_items.sold_price をそのまま読むので
--   （inv_dashboard_stats が i.sold_price を見る）、直した時点で最新の金額になる。
--   新しい表・新しい列は作らない。
-- ============================================================


-- ------------------------------------------------------------
-- 1) 実売価格・販売先を直す
--
--    直せるのは「いま売却済のもの」だけ。
--    売却済でないものを直そうとしたら、在庫状態を動かさずに断る。
--
--    **受け取った金額は必ずここで検める**（画面のガードだけに頼らない）。
--      ・1円以上
--      ・1億円未満（桁の入力間違い）
--      ・販売先は inv_sell_channels() の中だけ
--
--    履歴は**変わったものだけ**追記する。
--      販売情報修正 ｜ 12,800円 → 12,000円
--      販売先修正   ｜ 楽天 → Amazon
--    どちらも変わっていなければ、履歴は書かない（水増ししない）。
-- ------------------------------------------------------------
create or replace function public.inv_item_sale_edit(
  p_item_id    text,
  p_sold_price numeric,
  p_channel    text,
  p_note       text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it      public.inventory_items;
  v_who   text := public.inv_actor();
  v_price numeric;
  v_ch    text;
  fmt     text := 'FM9,999,999,999';
  v_label text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  if p_sold_price is null then
    raise exception '実売価格を入力してください';
  end if;
  if p_sold_price <= 0 then
    raise exception '実売価格は1円以上で入力してください';
  end if;
  if p_sold_price >= 100000000 then
    raise exception '実売価格が大きすぎます。桁を確かめてください（%円）',
      to_char(p_sold_price, fmt);
  end if;
  if coalesce(btrim(p_channel), '') = '' then
    raise exception '販売先を選んでください';
  end if;
  if not (p_channel = any (public.inv_sell_channels())) then
    raise exception '知らない販売先です（%）', p_channel;
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;
  -- **在庫状態は動かさない。** 売却済のものだけ直せる
  if it.status <> '売却済' then
    raise exception '販売情報を直せるのは「売却済」のものだけです（いまは %）', it.status;
  end if;

  v_price := it.sold_price;
  v_ch    := it.sold_channel;
  v_label := it.name;

  -- 何も変わらないなら、書き込みも履歴もしない
  if v_price is not distinct from p_sold_price
     and v_ch is not distinct from p_channel then
    return it;
  end if;

  /* **直すのは2列だけ。** status / user_name / loaned_at は触らない。
     出品価格・販売予定価格のマスタへも1行も書き戻さない。 */
  update public.inventory_items
     set sold_price   = p_sold_price,
         sold_channel = p_channel
   where id = p_item_id
  returning * into it;

  if v_price is distinct from p_sold_price then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_who, 'item', p_item_id, v_label, '販売情報修正',
            coalesce(to_char(v_price, fmt) || '円', '未登録'),
            to_char(p_sold_price, fmt) || '円'
            || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), ''));
  end if;

  if v_ch is distinct from p_channel then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_who, 'item', p_item_id, v_label, '販売先修正',
            coalesce(v_ch, '未登録'),
            p_channel
            || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), ''));
  end if;

  return it;
end $$;

comment on function public.inv_item_sale_edit is
  '売ったあとで、販売実績の 実売価格（sold_price）と 販売先（sold_channel）だけを直す。
   直せるのは「売却済」のものだけで、**在庫状態（status）は動かさない**。
   出品価格・販売予定価格のマスタ（inventory_channels / inventory_channel_listings /
   plan_price）へは1行も書き戻さない。1円以上・1億円未満でなければ通さず、
   販売先は inv_sell_channels() の中だけ。admin / member だけ（viewer は不可）。
   変わったものだけ履歴（販売情報修正 / 販売先修正）に追記し、
   既存の「売却」履歴は1行も消さない。価格の確認（price_checked_at）とは無関係。';


-- ------------------------------------------------------------
-- 2) 権限
-- ------------------------------------------------------------
revoke all on function public.inv_item_sale_edit(text, numeric, text, text) from public, anon, service_role;
grant execute on function public.inv_item_sale_edit(text, numeric, text, text) to authenticated;


-- ------------------------------------------------------------
-- 自己点検（15項目＋件数2行）
-- ------------------------------------------------------------
select '関数ができている' as kind,
       case when to_regprocedure('public.inv_item_sale_edit(text,numeric,text,text)') is not null
            then 'OK' else 'NG' end as result
union all
select '権限は inv_can_edit（admin / member だけ）',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%if not public.inv_can_edit() then%'
            then 'OK' else 'NG' end
union all
select '空では直せない',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%p_sold_price is null%'
            then 'OK' else 'NG' end
union all
select '0円以下では直せない',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%p_sold_price <= 0%'
            then 'OK' else 'NG' end
union all
select '桁の入力間違いも止める',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%p_sold_price >= 100000000%'
            then 'OK' else 'NG' end
union all
select '販売先は inv_sell_channels の中だけ',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%public.inv_sell_channels()%'
            then 'OK' else 'NG' end
union all
select '直せるのは売却済のものだけ',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%it.status <> ''売却済''%'
            then 'OK' else 'NG' end
union all
select '在庫状態・利用者・貸出日は動かさない',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%set status =%'
            and pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%user_name =%'
            and pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%loaned_at =%'
            then 'OK' else 'NG 動かしている' end
union all
select '出品価格マスタへ書き戻さない',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%update public.inventory_channels%'
            and pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%update public.inventory_channel_listings%'
            and pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%plan_price =%'
            then 'OK' else 'NG 書き戻している' end
union all
select '売却の履歴を消さない・書き換えない',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%delete from public.inventory_transactions%'
            and pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%update public.inventory_transactions%'
            then 'OK' else 'NG' end
union all
select '変わったものだけ履歴に残す',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%販売情報修正%'
            and pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 like '%販売先修正%'
            then 'OK' else 'NG' end
union all
select '価格の確認（price_checked）とは無関係',
       case when pg_get_functiondef('public.inv_item_sale_edit(text,numeric,text,text)'::regprocedure)
                 not like '%price_checked%'
            then 'OK' else 'NG 混ざっている' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_item_sale_edit(text,numeric,text,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select 'service_roleも呼べない',
       case when has_function_privilege('service_role', 'public.inv_item_sale_edit(text,numeric,text,text)', 'execute')
            then 'NG service_roleが呼べる' else 'OK' end
union all
select '社員は呼べる',
       case when has_function_privilege('authenticated', 'public.inv_item_sale_edit(text,numeric,text,text)', 'execute')
            then 'OK' else 'NG' end
union all
select 'いま売却済の台数',
       (select count(*)::text from public.inventory_items where status = '売却済') || '台'
union all
select 'うち実売価格が未登録の台数',
       (select count(*)::text from public.inventory_items
         where status = '売却済' and coalesce(sold_price, 0) <= 0) || '台';
