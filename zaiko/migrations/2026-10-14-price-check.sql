-- ============================================================
-- 価格の確認（未確認のまま出品しない）
--   2026-10-14
--
--   値段を入れる人と、その値段でよいと決める人を分ける。
--   **新しい role も権限種別も承認フローも申請テーブルも作らない。**
--   いまの admin / member をそのまま使う。
--
--     member … 価格の入力も販売価格の計算もできる（これまでどおり）
--     admin  … それに加えて「価格確認済み」にできる
--
--   持つのは2列だけ。
--     price_checked_at … 確認した日時。NULL なら未確認
--     price_checked_by … 確認した人
--
--   **「価格未設定」と「価格未確認」は別のことがら。**
--     価格未設定 … plan_price / 出品情報の価格が入っていない（金額が決まっていない）
--     価格未確認 … 金額は入っているが、管理者がまだ「これでよい」と言っていない
--   未設定のまま確認済みにすることはできてしまうので、画面で注意を出す
--   （出品の可否を決めるのは「未確認かどうか」だけ。ここを2つの条件にすると、
--     どちらで止まったのか分からなくなる）。
--
--   このmigrationでやること
--     1) inventory_items に2列
--     2) トリガー … 価格が変わったら確認を自動で外す／
--                   未確認のものを「出品中」にさせない
--     3) inv_price_check_set() … 確認済みにする・外す（管理者だけ）
--     4) inv_stocktake_unmark_missing() … 差異確定の取消が 2) で止まらないようにする
--     5) inv_item_sell_undo()           … 売却取消が 2) で止まらないようにする
--     6) 権限
--
--   在庫数・管理番号・QRのURL・棚卸・8RENT・販売先の価格には触らない。
--   履歴（inventory_transactions）は追記のみで、1行も消さない。
--
--   ■ 最新 main（#54 時点）との関係
--     4) と 5) は **main のいまの定義をそのまま取り出して、1段だけ足したもの**。
--     古い写しを当てて #48 / #49 / #52 の修正を消すことがないようにしている。
--       - #52 の inv_item_sell_channel() / inv_item_channel_price() /
--         inv_sale_is_active() / inv_dashboard_stats() は**触らない**
--       - #48 の inv_item_basic_edit() も触らない（価格を変えないのでトリガーも素通り）
--       - #53 の「未出品／出品停止／出品中」は inventory_channel_listings 側の話で、
--         ここで見る inventory_items.status = '出品中' とは別もの。混ぜない
-- ============================================================


-- ------------------------------------------------------------
-- 1) 確認の状態（2列だけ）
-- ------------------------------------------------------------
alter table public.inventory_items
  add column if not exists price_checked_at timestamptz,
  add column if not exists price_checked_by text;

comment on column public.inventory_items.price_checked_at is
  '価格を確認した日時。NULL なら未確認。価格を変えると自動で NULL に戻る。';
comment on column public.inventory_items.price_checked_by is
  '価格を確認した人。price_checked_at と一緒に入る。';

create index if not exists inventory_items_price_check_idx
  on public.inventory_items (price_checked_at);


-- ------------------------------------------------------------
-- 2) 価格が変わったら確認を外す／未確認のまま出品中にしない
--
--    **トリガーにするのは、抜け道を作らないため。**
--    authenticated は inventory_items を直接 UPDATE できるので、
--    RPCの中だけで見ていると、画面のコードを1行足すだけで回避できてしまう。
--    どの経路から更新しても必ずここを通る。
--
--    価格を変えた更新では、同じ文で price_checked_at を立てても外す
--    （安全側。確認は値段が決まったあとに、別の操作としてやってもらう）。
--
--    **すでに「出品中」のものはそのまま。** このmigrationを当てた直後は
--    全個体が未確認なので、いま出ている出品を落とさない。
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

  -- 未確認のまま「出品中」にはできない（すでに出品中のものはそのまま）
  if new.status = '出品中' and old.status is distinct from '出品中'
     and new.price_checked_at is null then
    raise exception '価格が未確認です。管理者が価格を確認してから出品中にしてください（%）', new.id;
  end if;

  return new;
end $$;

comment on function public.inv_price_check_guard is
  '価格を変えたら確認を外す。未確認の個体を「出品中」にさせない。
   どの経路の UPDATE でも通るようにトリガーにしている。';

drop trigger if exists inventory_items_price_check on public.inventory_items;
create trigger inventory_items_price_check before update on public.inventory_items
  for each row execute function public.inv_price_check_guard();


-- ------------------------------------------------------------
-- 3) 確認済みにする・外す（管理者だけ）
--
--    member は価格の入力も計算もできるが、ここだけは admin。
--    新しい role は作らず、既存の inv_is_admin() を見る。
-- ------------------------------------------------------------
create or replace function public.inv_price_check_set(
  p_item_ids text[],
  p_on       boolean default true,
  p_note     text default null
) returns setof public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it     public.inventory_items;
  v_id   text;
  v_who  text := public.inv_actor();
  fmt    text := 'FM9,999,999,999';
begin
  if not public.inv_is_admin() then
    raise exception '価格を確認できるのは管理者だけです';
  end if;
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception '対象が選ばれていません';
  end if;

  foreach v_id in array p_item_ids loop
    select * into it from public.inventory_items where id = v_id for update;
    if not found then
      raise exception '商品が見つかりません（%）', v_id;
    end if;

    -- すでに同じ状態なら触らない（履歴を水増ししない）
    if (p_on and it.price_checked_at is not null)
    or (not p_on and it.price_checked_at is null) then
      return next it;
      continue;
    end if;

    update public.inventory_items
       set price_checked_at = case when p_on then now() else null end,
           price_checked_by = case when p_on then v_who else null end
     where id = v_id returning * into it;

    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_who, 'item', v_id, it.name,
            case when p_on then '価格確認' else '価格確認取消' end,
            case when p_on then '未確認' else '確認済み' end,
            (case when p_on then '確認済み' else '未確認' end)
              || '／原価 ' || to_char(coalesce(it.cost, 0), fmt) || '円・予定 '
              || coalesce(to_char(it.plan_price, fmt) || '円', '未定')
              || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), ''));

    return next it;
  end loop;
end $$;

comment on function public.inv_price_check_set is
  '価格を確認済みにする（または外す）。管理者だけ。価格そのものは変えない。
   価格を変えるとトリガーが確認を自動で外すので、確認は値段を決めたあとに行う。';


-- ------------------------------------------------------------
-- 4) 棚卸の「差異確定の取消」との兼ね合い
--
--    inv_stocktake_unmark_missing() は、差異確定を取り消すときに
--    状態を '不明' から元へ（在庫／出品中）戻す。戻り先が '出品中' で
--    価格が未確認だと、2) のトリガーが例外を投げ、**取消そのものが
--    できなくなってしまう**（このmigrationを当てた直後は全個体が未確認）。
--
--    そこで、戻り先が '出品中' で価格が未確認のときは在庫へ戻し、
--    その理由を履歴に残す。出品し直すときは、先に価格を確認してもらう。
--
--    **本文は最新 main の定義をそのまま使っている。** 2026-10-08 の
--    stocktake-reconcile は本番で実行済みなので、そちらは触らない。
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
  v_note text := '';
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
    -- 価格が未確認の個体は「出品中」へは戻せない（→ 66) 価格の確認）。
    -- ここで例外にすると差異確定の取消そのものができなくなるので、在庫へ戻して
    -- 履歴にその理由を残す。出品し直すときは、先に価格を確認してもらう。
    if v_back = '出品中' and it.price_checked_at is null then
      v_back := '在庫';
      v_note := '（価格が未確認のため、出品中ではなく在庫へ戻しました）';
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
          '不明', v_back || v_note);

  return it;
end $$;

comment on function public.inv_stocktake_unmark_missing is
  '差異確定を取り消して未処理へ戻す。状態が ''不明'' のままのときだけ、
   差異確定のときに履歴へ残した元の状態（在庫／出品中）へ戻す。
   人があとから別の状態にしていたら上書きしない。履歴は消さず追記する。
   戻り先が ''出品中'' でも価格が未確認なら、在庫へ戻して理由を履歴に残す。';


-- ------------------------------------------------------------
-- 5) 「売却取消」(#49) との兼ね合い
--
--    inv_item_sell_undo() は、売却の直前の状態へ戻す。その戻り先が
--    '出品中' で価格が未確認だと、2) のトリガーが例外を投げ、
--    **売却取消そのものができなくなってしまう**。
--
--    4) と同じ考えで、戻り先が '出品中' で価格が未確認のときは在庫へ戻し、
--    理由を履歴に残す。#49 の「戻り先は履歴から決める・推測しない」は
--    そのままで、決まった戻り先を1段だけ安全側へ寄せるだけ。
--
--    **本文は最新 main の定義をそのまま使っている**（#49 の判定・
--    inv_sale_order_unlink の呼び出し・履歴の書き方は1行も変えていない）。
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
  v_note text := '';
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

  -- 2-b) 価格が未確認の個体は「出品中」へは戻せない（→ 66) 価格の確認）。
  --      ここで例外にすると**売却取消そのものができなくなる**ので、在庫へ戻して
  --      履歴にその理由を残す。出品し直すときは、先に価格を確認してもらう。
  --      （#49 の「取消は履歴から決める・推測しない」はそのまま。
  --        決めた戻り先が出品中のときだけ、1段だけ安全側に寄せる）
  if v_prev = '出品中' and it.price_checked_at is null then
    v_prev := '在庫';
    v_note := '（価格が未確認のため、出品中ではなく在庫へ戻しました）';
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
          v_prev || v_note
          || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), '')
          || case when array_length(v_ords, 1) is null then ''
                  else '／割り当て解除 ' || array_to_string(v_ords, '・') end);

  return it;
end $$;

comment on function public.inv_item_sell_undo is
  '誤って売却済にした1台を、売却の直前の状態へ戻す。戻り先は履歴（action=''売却'' の
   before_value）から取り、分からなければ戻さずエラーにする。sold_price / sold_channel は
   空に戻す。既存の「売却」履歴は消さず、「売却取消」を足す。外部販売サイトへの再出品はしない。
   戻り先が ''出品中'' でも価格が未確認なら、在庫へ戻して理由を履歴に残す。';


-- ------------------------------------------------------------
-- 6) 権限
--
--    2026-10-01-rpc-permission-hardening.sql の一括配り直しは
--    「そのとき存在した関数」への1回きりの処理なので、あとから足した関数には効かない。
--    既定では PUBLIC に EXECUTE が付き anon からも呼べてしまうため、明示的に配り直す。
--    管理者かどうかは関数の中で inv_is_admin() が見る。
--    トリガー関数は直接呼ばせない。
-- ------------------------------------------------------------
revoke all on function public.inv_price_check_set(text[], boolean, text) from public, anon, service_role;
grant execute on function public.inv_price_check_set(text[], boolean, text) to authenticated;

revoke all on function public.inv_price_check_guard() from public, anon, authenticated, service_role;

-- 4) 5) で create or replace した関数。既存の権限は残るが、念のため同じ形で配り直す
revoke all on function public.inv_stocktake_unmark_missing(bigint, text) from public, anon, service_role;
grant execute on function public.inv_stocktake_unmark_missing(bigint, text) to authenticated;

revoke all on function public.inv_item_sell_undo(text, text) from public, anon, service_role;
grant execute on function public.inv_item_sell_undo(text, text) to authenticated;


-- ------------------------------------------------------------
-- 確認（19項目＋件数3行）
-- ------------------------------------------------------------
select '確認の列' as kind,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'inventory_items'
                     and column_name in ('price_checked_at', 'price_checked_by')) = 2
            then 'OK 2列そろっている' else 'NG' end as result
union all
select 'トリガーが付いている',
       case when exists (select 1 from pg_trigger
                          where tgname = 'inventory_items_price_check' and not tgisinternal)
            then 'OK' else 'NG' end
union all
select '価格を変えたら確認を外す',
       case when pg_get_functiondef('public.inv_price_check_guard()'::regprocedure)
                 like '%new.price_checked_at := null;%'
            then 'OK' else 'NG' end
union all
select '未確認は出品中にできない',
       case when pg_get_functiondef('public.inv_price_check_guard()'::regprocedure)
                 like '%価格が未確認です%'
            then 'OK' else 'NG' end
union all
select 'すでに出品中のものは落とさない',
       case when pg_get_functiondef('public.inv_price_check_guard()'::regprocedure)
                 like '%old.status is distinct from ''出品中''%'
            then 'OK' else 'NG' end
union all
select '確認できるのは管理者だけ',
       case when pg_get_functiondef('public.inv_price_check_set(text[],boolean,text)'::regprocedure)
                 like '%if not public.inv_is_admin() then%'
            then 'OK' else 'NG' end
union all
select '確認では価格そのものを変えない',
       case when pg_get_functiondef('public.inv_price_check_set(text[],boolean,text)'::regprocedure)
                 not like '%set price =%'
            then 'OK' else 'NG' end
union all
select '誰がいつ確認したか残る',
       case when pg_get_functiondef('public.inv_price_check_set(text[],boolean,text)'::regprocedure)
                 like '%price_checked_by = case when p_on then v_who%'
            then 'OK' else 'NG' end
union all
select '履歴に価格確認を追記する',
       case when pg_get_functiondef('public.inv_price_check_set(text[],boolean,text)'::regprocedure)
                 like '%insert into public.inventory_transactions%'
            then 'OK' else 'NG' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_price_check_set(text[],boolean,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select 'service_roleも呼べない',
       case when has_function_privilege('service_role', 'public.inv_price_check_set(text[],boolean,text)', 'execute')
            then 'NG service_roleが呼べる' else 'OK' end
union all
select '社員は呼べる',
       case when has_function_privilege('authenticated', 'public.inv_price_check_set(text[],boolean,text)', 'execute')
            then 'OK' else 'NG' end
union all
select 'トリガー関数は直接呼べない',
       case when has_function_privilege('authenticated', 'public.inv_price_check_guard()', 'execute')
            then 'NG 呼べてしまう' else 'OK' end
union all
select '差異確定の取消が止まらない',
       case when pg_get_functiondef('public.inv_stocktake_unmark_missing(bigint,text)'::regprocedure)
                 like '%価格が未確認のため、出品中ではなく在庫へ戻しました%'
            then 'OK' else 'NG' end
union all
select '売却取消が止まらない',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%価格が未確認のため、出品中ではなく在庫へ戻しました%'
            then 'OK' else 'NG' end
union all
select '売却取消は履歴から戻り先を決めるまま',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%inv_item_sell_undo_info(p_item_id)%'
            then 'OK' else 'NG' end
union all
select '売却取消は割り当て解除もするまま',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%inv_sale_order_unlink%'
            then 'OK' else 'NG' end
union all
select '#52 の販売先価格を触っていない',
       case when pg_get_functiondef('public.inv_item_channel_price(text,text)'::regprocedure)
                 like '%coalesce%' and exists (select 1 from pg_proc p join pg_namespace n
                   on n.oid = p.pronamespace where n.nspname = 'public'
                   and p.proname = 'inv_item_sell_channel')
            then 'OK' else 'NG' end
union all
select '#52 の経営数値のキーを触っていない',
       case when (select bool_and(pg_get_functiondef(
                    'public.inv_dashboard_stats(date)'::regprocedure) like '%' || k || '%')
                  from unnest(array['''sales_total''', '''gross_profit''', '''sold_count''',
                                    '''stock_cost''', '''avg_stock_days''']) k)
            then 'OK' else 'NG' end
union all
select 'いま価格未確認の個体数',
       (select count(*)::text from public.inventory_items
         where price_checked_at is null and status <> '廃棄') || '台'
union all
select 'うち すでに出品中（そのまま出し続けられます）',
       (select count(*)::text from public.inventory_items
         where price_checked_at is null and status = '出品中') || '台'
union all
select 'すでに確認済みの個体数',
       (select count(*)::text from public.inventory_items
         where price_checked_at is not null) || '台';
