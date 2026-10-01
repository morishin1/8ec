-- ============================================================
-- QRから販売先を選ぶだけで売る／取消済み売却を集計から外す
--   2026-10-13
--
--   倉庫メンバーは値段を手で入れない。QRを読んで販売先を選ぶと、
--   **登録済みの販売価格**が出て、その金額でだけ売却できるようにする。
--
--   新しい価格テーブルは作らない。価格の出どころは既存の2つだけ。
--     1) inventory_channels.price          … 個体 × 販売先（item_id あり）
--     2) inventory_channel_listings.price  … 商品 × 販売先
--   画面の listingOf() と同じ順番で、個体の価格が入っていればそれを、
--   無ければ商品の価格を使う。
--
--   **画面に出した金額は信用しない。** 売るときはサーバーがもう一度
--   item_id × 販売先 から価格を引き直し、その金額だけを sold_price に入れる。
--   状態の変更と履歴は既存の inv_item_sell() → inv_item_op('売却') をそのまま通る。
--
--   あわせて、取り消した売却が今月の売上・粗利・販売台数に残らないようにする。
--   判定（その売却より後に「売却取消」があるか）は **1か所だけ** に置き、
--   売却取消（2026-10-12）とダッシュボードの両方がそれを通る。
-- ============================================================


-- ------------------------------------------------------------
-- 1) その「売却」はいま生きているか
--
--    売却A → 売却取消A → 売却B と進んだとき、A はもう効いていない。
--    「その行より後に 売却取消 があるか」だけを見る。
--    同じ時刻の行があっても狂わないよう (occurred_at, id) の組で前後を見る。
--
--    **この判定を書くのはここだけ。** 売却取消も月次集計もこれを呼ぶ。
-- ------------------------------------------------------------
create or replace function public.inv_sale_is_active(
  p_item_id text,
  p_at      timestamptz,
  p_id      bigint
) returns boolean
language sql stable security invoker set search_path = public as $$
  select not exists (
    select 1 from public.inventory_transactions u
     where u.ref_kind = 'item'
       and u.ref_id   = p_item_id
       and u.action   = '売却取消'
       and (u.occurred_at, u.id) > (p_at, p_id))
$$;

comment on function public.inv_sale_is_active is
  'その「売却」の履歴がいまも効いているか（あとで取り消されていないか）。
   売却取消と月次集計は、同じ判定をここ1か所で見る。読むだけで何も変えない。';


-- ------------------------------------------------------------
-- 2) 売却取消の材料（2026-10-12 の判定を上の関数に寄せる）
--
--    中身は同じ。重複して書いていた「後に売却取消があるか」を
--    inv_sale_is_active() へ移しただけ。
-- ------------------------------------------------------------
create or replace function public.inv_item_sell_undo_info(p_item_id text)
returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'back',
      (select t.before_value
         from public.inventory_transactions t
        where t.ref_kind = 'item'
          and t.ref_id   = p_item_id
          and t.action in ('売却', '状態変更')
          and t.after_value like '売却済%'
          and btrim(coalesce(t.before_value, ''))
              = any (array['在庫','出品中','予約中','販売予約','修理中','故障','紛失','不明'])
          -- 取り消し済みの古い売却は拾わない（判定は1か所）
          and public.inv_sale_is_active(p_item_id, t.occurred_at, t.id)
        order by t.occurred_at desc, t.id desc
        limit 1),
    'orders',
      (select coalesce(jsonb_agg(jsonb_build_object(
                'id', o.id, 'channel', o.channel, 'order_number', o.order_number,
                'line_number', o.line_number, 'unit_no', o.unit_no, 'status', o.status)
              order by o.id), '[]'::jsonb)
         from public.inventory_sale_orders o
        where o.item_id = p_item_id
          and o.status <> 'キャンセル'))
$$;


-- ------------------------------------------------------------
-- 3) その1台の、その販売先の登録価格
--
--    画面（販売先を選んだとき）と、売却の本体の**両方がこれを通る**。
--    同じ価格判定を2か所に書かない。
--
--    個体の行があっても price が入っていなければ、商品の価格へ落とす
--    （「個体 × 販売先の価格が明示されている場合はその価格」なので、
--      行があるだけで価格が空のときは明示されていないとみなす）。
--
--    原価も利益も返さない。返すのはこの販売先の売値1つだけ。
-- ------------------------------------------------------------
create or replace function public.inv_item_channel_price(
  p_item_id text,
  p_channel text
) returns numeric
language sql stable security invoker set search_path = public as $$
  select coalesce(
    (select c.price
       from public.inventory_channels c
      where c.item_id = p_item_id and c.channel = p_channel and c.price is not null
      order by c.id desc limit 1),
    (select l.price
       from public.inventory_channel_listings l
       join public.inventory_items i on i.product_code = l.product_code
      where i.id = p_item_id and l.channel = p_channel and l.price is not null
      order by l.id desc limit 1))
$$;

comment on function public.inv_item_channel_price is
  'その1台を、その販売先で売るときの登録価格。個体（inventory_channels.price）が
   入っていればそれ、無ければ商品（inventory_channel_listings.price）。
   どちらも無ければ null。原価・利益は返さない。読むだけで何も変えない。';


-- ------------------------------------------------------------
-- 4) 販売先を選んで売る（倉庫メンバー用）
--
--    **画面から金額を受け取らない。** 受け取るのは販売先だけ。
--    価格はここで引き直すので、開発者ツールから好きな金額を送っても
--    その金額では売れない。
--
--    売却そのものは作り直さない。既存の inv_item_sell() を呼ぶので、
--    sold_channel の保存・状態の変更・履歴は今までと同じ経路を通る。
--
--    売れる状態は 在庫・出品中・販売予約 の3つだけ（画面と同じ）。
--    予約中・貸出中・社内使用などは、先に本来の操作で戻してもらう。
-- ------------------------------------------------------------
create or replace function public.inv_item_sell_channel(
  p_item_id text,
  p_channel text,
  p_note    text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it      public.inventory_items;
  v_price numeric;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if coalesce(btrim(p_channel), '') = '' then
    raise exception '販売先を選んでください';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;
  if it.status not in ('在庫', '出品中', '販売予約') then
    raise exception '販売済みにできるのは 在庫・出品中・販売予約 のものだけです（いまは %）', it.status;
  end if;

  -- **ここで引き直した金額だけを使う**
  v_price := public.inv_item_channel_price(p_item_id, p_channel);
  if v_price is null then
    raise exception 'この販売先の価格が登録されていません。管理者に設定してもらってください';
  end if;
  if v_price <= 0 then
    raise exception 'この販売先の価格が 0円以下です。管理者に直してもらってください';
  end if;

  -- 状態変更も履歴も、既存の売却処理をそのまま通す
  it := public.inv_item_sell(p_item_id, p_channel, v_price::text, p_note);
  return it;
end $$;

comment on function public.inv_item_sell_channel is
  '販売先を選んで1台を売却済にする。**金額は受け取らず、サーバーが登録価格を引き直す。**
   売却そのものは既存の inv_item_sell() → inv_item_op(''売却'') をそのまま通る。
   売れるのは 在庫・出品中・販売予約 のときだけ。';


-- ------------------------------------------------------------
-- 5) 月次の経営数値から、取り消した売却を外す
--
--    これまでは action='売却' の履歴をそのまま数えていたので、
--    取り消したあとも販売台数に残り、売上も（sold_price が null でも）
--    1台ぶん数えてしまっていた。
--
--    変えたのは sold の1か所だけ。**その売却が生きているか**を
--    inv_sale_is_active() で見る。ほかの集計（仕入・在庫）は触っていない。
--      売却 → 取消                 … 数えない
--      売却 → 取消 → 再売却        … 新しいほうだけ数える
--      売却（取消なし）            … これまでどおり
-- ------------------------------------------------------------
create or replace function public.inv_dashboard_stats(p_month date default null)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
with
bounds as (
  select date_trunc('month', coalesce(p_month, current_date))::date            as m_start,
         (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month')::date as m_end
),
-- 今月売れた個体（売却の履歴がある個体を、重複なく1台ずつ）。
-- **あとで取り消された売却は数えない**（判定は inv_sale_is_active の1か所）
sold as (
  select distinct on (i.id) i.id, i.sold_price, i.cost
    from public.inventory_transactions t
    join public.inventory_items i on i.id = t.ref_id
    cross join bounds b
   where t.ref_kind = 'item' and t.action = '売却'
     and t.occurred_at >= b.m_start and t.occurred_at < b.m_end
     and public.inv_sale_is_active(i.id, t.occurred_at, t.id)
   order by i.id, t.occurred_at desc
),
sale_agg as (
  select coalesce(sum(sold_price), 0)                                   as sales,
         count(*)                                                       as cnt,
         coalesce(sum(sold_price) filter (where cost > 0), 0)           as profit_base,
         coalesce(sum(sold_price - cost) filter (where cost > 0), 0)    as profit,
         count(*) filter (where coalesce(cost, 0) <= 0)                 as missing_cost,
         count(*) filter (where coalesce(sold_price, 0) <= 0)           as missing_price,
         -- 粗利を出せた台数＝原価も売価も入っている台数。平均粗利/台の母数はこれ
         count(*) filter (where cost > 0 and sold_price > 0)            as profit_cnt
    from sold
),
-- 売却済みなのに売価が入っていない個体（全期間）。今月かどうかに関わらず直してほしい
price_gap as (
  select count(*) as cnt
    from public.inventory_items i
   where i.status = '売却済'
     and coalesce(i.sold_price, 0) <= 0
),
-- 今月仕入れた個体（仕入日で見る）
buy_agg as (
  select coalesce(sum(i.cost), 0) as amount, count(*) as cnt
    from public.inventory_items i cross join bounds b
   where i.purchased_on >= b.m_start and i.purchased_on < b.m_end
),
-- いま手元にある在庫（売却済・廃棄は除く）
held as (
  select i.cost,
         case when i.purchased_on is not null
              then (current_date - i.purchased_on) end as days
    from public.inventory_items i
   where i.status not in ('売却済', '廃棄')
),
held_agg as (
  select count(*)                                                as cnt,
         coalesce(sum(cost), 0)                                  as cost_total,
         count(*) filter (where days > 60)                       as aged60,
         count(*) filter (where days > 90)                       as aged90,
         coalesce(sum(cost) filter (where days > 90), 0)         as aged90_cost,
         round(avg(days) filter (where days is not null), 1)     as avg_days,
         count(*) filter (where days is null)                    as no_date
    from held
)
select jsonb_build_object(
  'month', to_char((select m_start from bounds), 'YYYY-MM'),
  -- 売上（販売／レンタル／合計）。レンタルは請求データが無いので未集計
  'sales_sale',        s.sales,
  'sales_rental',      0,
  'sales_total',       s.sales,
  'rental_available',  false,
  -- 粗利
  'gross_profit',      s.profit,
  'profit_base',       s.profit_base,
  'gross_margin',      case when s.profit_base > 0
                            then round(s.profit * 100.0 / s.profit_base, 1) end,
  'sold_count',        s.cnt,
  'profit_count',      s.profit_cnt,
  'avg_profit',        case when s.profit_cnt > 0
                            then round(s.profit / s.profit_cnt) end,
  'missing_cost',      s.missing_cost,
  'missing_price',     s.missing_price,
  'price_gap',         (select cnt from price_gap),
  -- 仕入
  'buy_amount',        (select amount from buy_agg),
  'buy_count',         (select cnt from buy_agg),
  -- 在庫
  'stock_count',       h.cnt,
  'stock_cost',        h.cost_total,
  'aged60',            h.aged60,
  'aged90',            h.aged90,
  'aged90_cost',       h.aged90_cost,
  'avg_stock_days',    h.avg_days,
  'no_purchase_date',  h.no_date
)
from sale_agg s cross join held_agg h
$$;

comment on function public.inv_dashboard_stats is
  '管理者ホームの経営数値。今月の売上・粗利・販売台数と、仕入・在庫。
   **取り消した売却は数えない**（inv_sale_is_active）。読むだけで何も変えない。';


-- ------------------------------------------------------------
-- 6) 権限
--
--    2026-10-01-rpc-permission-hardening.sql の配り直しは「そのとき存在した関数」への
--    1回きりの処理なので、あとから足した関数には効かない。明示的に配り直す。
--    inv_dashboard_stats と inv_item_sell_undo_info は create or replace なので
--    権限は変わらない（既存のまま）。
-- ------------------------------------------------------------
revoke all on function public.inv_sale_is_active(text, timestamptz, bigint) from public, anon, service_role;
grant execute on function public.inv_sale_is_active(text, timestamptz, bigint) to authenticated;

revoke all on function public.inv_item_channel_price(text, text) from public, anon, service_role;
grant execute on function public.inv_item_channel_price(text, text) to authenticated;

revoke all on function public.inv_item_sell_channel(text, text, text) from public, anon, service_role;
grant execute on function public.inv_item_sell_channel(text, text, text) to authenticated;


-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select '関数がある' as kind,
       case when to_regprocedure('public.inv_sale_is_active(text,timestamptz,bigint)') is not null
             and to_regprocedure('public.inv_item_channel_price(text,text)') is not null
             and to_regprocedure('public.inv_item_sell_channel(text,text,text)') is not null
            then 'OK 3つとも' else 'NG' end as result
union all
select '価格の判定は1か所だけ',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,text)'::regprocedure)
                 like '%public.inv_item_channel_price(p_item_id, p_channel)%'
            then 'OK 画面と同じ関数を通る' else 'NG' end
union all
select '画面から金額を受け取らない',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,text)'::regprocedure)
                 ~* 'p_price|p_amount|p_sold'
            then 'NG 金額を受け取っている' else 'OK' end
union all
select '売却は既存の処理を通る',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,text)'::regprocedure)
                 like '%public.inv_item_sell(p_item_id, p_channel%'
            then 'OK inv_item_sell を呼ぶ' else 'NG' end
union all
select '価格なし・0円以下は売らない',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,text)'::regprocedure)
                 like '%if v_price is null then%'
             and pg_get_functiondef('public.inv_item_sell_channel(text,text,text)'::regprocedure)
                 like '%if v_price <= 0 then%'
            then 'OK' else 'NG' end
union all
select '権限は既存の inv_can_edit()',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,text)'::regprocedure)
                 like '%if not public.inv_can_edit() then%'
            then 'OK' else 'NG' end
union all
select '価格の出どころは既存の2つだけ',
       case when pg_get_functiondef('public.inv_item_channel_price(text,text)'::regprocedure)
                 like '%public.inventory_channels c%'
             and pg_get_functiondef('public.inv_item_channel_price(text,text)'::regprocedure)
                 like '%public.inventory_channel_listings l%'
            then 'OK' else 'NG' end
union all
select '価格の関数は原価・利益を返さない',
       case when pg_get_functiondef('public.inv_item_channel_price(text,text)'::regprocedure)
                 ~* '\.(cost|price_|purchase_fee|plan_price)'
            then 'NG' else 'OK' end
union all
select '取消済みの売却を月次から外している',
       case when pg_get_functiondef('public.inv_dashboard_stats(date)'::regprocedure)
                 like '%public.inv_sale_is_active(i.id, t.occurred_at, t.id)%'
            then 'OK' else 'NG' end
union all
select '売却取消も同じ判定を通る',
       case when pg_get_functiondef('public.inv_item_sell_undo_info(text)'::regprocedure)
                 like '%public.inv_sale_is_active(p_item_id, t.occurred_at, t.id)%'
            then 'OK 判定は1か所' else 'NG' end
union all
select '同じ判定を書き写していない',
       case when pg_get_functiondef('public.inv_dashboard_stats(date)'::regprocedure)
                 like '%売却取消%'
             or pg_get_functiondef('public.inv_item_sell_undo_info(text)'::regprocedure)
                 like '%u.action   = ''売却取消''%'
            then 'NG 判定が散っている' else 'OK' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_item_sell_channel(text,text,text)', 'execute')
              or has_function_privilege('anon', 'public.inv_item_channel_price(text,text)', 'execute')
              or has_function_privilege('anon', 'public.inv_sale_is_active(text,timestamptz,bigint)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select '社員は呼べる（中で権限を見る）',
       case when has_function_privilege('authenticated', 'public.inv_item_sell_channel(text,text,text)', 'execute')
             and has_function_privilege('authenticated', 'public.inv_item_channel_price(text,text)', 'execute')
            then 'OK' else 'NG' end
union all
select '販売先ごとの価格が入っている商品数',
       (select count(distinct product_code)::text from public.inventory_channel_listings
         where price is not null and price > 0) || '商品'
union all
select '販売先ごとの価格が入っている個体数',
       (select count(distinct item_id)::text from public.inventory_channels
         where item_id is not null and price is not null and price > 0) || '台';
