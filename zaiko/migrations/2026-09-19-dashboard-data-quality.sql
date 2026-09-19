-- ============================================================
-- ダッシュボードに「売価未登録」の警告を足す
--   2026-09-19（2026-09-19-dashboard-pl.sql の後に流す追補）
--
--   売却済みなのに販売価格（sold_price）が入っていない個体は、今月売上に
--   足しようがない。黙って0円として数えると、売上も粗利も実態より小さく出る。
--   数えて返し、画面の「要確認」に出す。
--
--   入っているもの
--     inv_dashboard_stats() の返り値に3つ足す（売上・仕入・在庫の集計は変えない）
--       sold_price_missing        … 売却済みなのに売価が入っていない個体（全期間）
--       sold_price_missing_month  … そのうち今月売却したぶん
--       profit_count              … 粗利を出せた台数（原価も売価も入っている台数）
--
--   あわせて、平均粗利/台の母数を profit_count に直します。これまでは
--   「販売台数 − 原価未登録」で割っていたので、売価が入っていない個体があると
--   分子（粗利）には乗らないのに分母だけ増え、平均が小さく出ていました。
--
--   何度流しても同じ結果になる（create or replace のみ）。データは変えません。
--
--   実行後の確認
--     select jsonb_pretty(public.inv_dashboard_stats());
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 40-1) 経営数値に「売価未登録」を足す
--
--     売価が入っていない＝金額としては数えられない、という意味なので
--     null も 0 も同じ「未登録」として数える（0円で売った記録は残らない）。
--
--     全期間ぶん（sold_price_missing）は「要確認」の件数に、
--     今月ぶん（sold_price_missing_month）は「今月売上に入っていない台数」として使う。
--     ほかの集計（売上・粗利・仕入・在庫）は 2026-09-19-dashboard-pl.sql のまま。
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
-- 今月売れた個体（売却の履歴がある個体を、重複なく1台ずつ）
sold as (
  select distinct on (i.id) i.id, i.sold_price, i.cost
    from public.inventory_transactions t
    join public.inventory_items i on i.id = t.ref_id
    cross join bounds b
   where t.ref_kind = 'item' and t.action = '売却'
     and t.occurred_at >= b.m_start and t.occurred_at < b.m_end
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
  'profit_missing_cost', s.missing_cost,
  'profit_count',      s.profit_cnt,
  'avg_profit_per_unit', case when s.profit_cnt > 0
                              then round(s.profit / s.profit_cnt) end,
  'sold_count',        s.cnt,
  -- 売価が入っていない個体（金額として数えられないもの）
  'sold_price_missing',       g.cnt,
  'sold_price_missing_month', s.missing_price,
  -- 仕入
  'purchase_amount',   b2.amount,
  'purchase_count',    b2.cnt,
  -- 在庫
  'stock_cost',        h.cost_total,
  'stock_count',       h.cnt,
  'aged_60',           h.aged60,
  'aged_90',           h.aged90,
  'aged_90_cost',      h.aged90_cost,
  'avg_stock_days',    h.avg_days,
  'stock_no_date',     h.no_date
)
from sale_agg s, price_gap g, buy_agg b2, held_agg h;
$$;

comment on function public.inv_dashboard_stats is
  'ダッシュボードの経営数値。売上・粗利・粗利率・販売台数・仕入・在庫原価・滞留在庫を実データから数える。
   売れた日は inventory_transactions（action=売却）、売れた額は inventory_items.sold_price、
   原価は cost（price + purchase_fee）。原価が入っていない個体は粗利の計算から外し、
   その件数を profit_missing_cost で返す。売却済みなのに売価が入っていない個体は
   sold_price_missing（全期間）と sold_price_missing_month（今月ぶん）で返す。
   売上は販売とレンタルを分けて返す（レンタルの請求データはまだ無いので rental_available=false）。';

grant execute on function public.inv_dashboard_stats(date) to authenticated;

commit;
