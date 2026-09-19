-- ============================================================
-- /zaiko のダッシュボードに経営数値を出す
--   2026-09-19（2026-09-19-rental-form-master.sql の後に流す追補）
--
--   「在庫がいくつあるか」だけでなく、「いくら売れて・いくら残ったか」を
--   同じ画面で見られるようにする。売上だけでなく粗利と在庫原価を並べる。
--
--   入っているもの
--     inv_dashboard_stats(p_month)  … 今月の売上・粗利・粗利率・販売台数・
--                                     仕入額・仕入台数・在庫原価・平均粗利/台と、
--                                     60日超/90日超の滞留在庫・平均在庫日数
--
--   何度流しても同じ結果になる（create or replace のみ）。データは変えません。
--
--   実行後の確認
--     select jsonb_pretty(public.inv_dashboard_stats());
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 39-1) ダッシュボードの経営数値
--
--     「在庫がいくつあるか」ではなく「いくら売れて、いくら残ったか」を出す。
--     数はすべて実データから数える（固定値・見込み値は入れない）。
--
--     売れた日  … inventory_transactions（追記のみの履歴）の action='売却'。
--                 inventory_items に売却日の列は無いので、日付はここが唯一の出どころ。
--     売れた額  … inventory_items.sold_price（履歴と同じ操作で入った実売価格）
--     原価      … inventory_items.cost（生成列＝price + purchase_fee）
--     粗利      … 実売価格 − その個体の原価
--
--     原価が入っていない個体は、売値をそのまま粗利にすると嘘になるので
--     粗利の計算から外し、外した件数（profit_missing_cost）を返す。
--     粗利率は、粗利を出せた個体の売上（profit_base）に対して出す。
--
--     売上は将来8RENTのレンタル料も足せるように、販売とレンタルを分けて返す。
--     レンタルの請求データはまだ無いので rental は 0 で、集計できるかどうかを
--     rental_available で示す（0円と「未集計」を画面で区別するため）。
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
         count(*) filter (where coalesce(cost, 0) <= 0)                 as missing_cost
    from sold
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
  'avg_profit_per_unit', case when s.cnt - s.missing_cost > 0
                              then round(s.profit / (s.cnt - s.missing_cost)) end,
  'sold_count',        s.cnt,
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
from sale_agg s, buy_agg b2, held_agg h;
$$;

comment on function public.inv_dashboard_stats is
  'ダッシュボードの経営数値。売上・粗利・粗利率・販売台数・仕入・在庫原価・滞留在庫を実データから数える。
   売れた日は inventory_transactions（action=売却）、売れた額は inventory_items.sold_price、
   原価は cost（price + purchase_fee）。原価が入っていない個体は粗利の計算から外し、
   その件数を profit_missing_cost で返す。売上は販売とレンタルを分けて返す
   （レンタルの請求データはまだ無いので rental_available=false）。';

grant execute on function public.inv_dashboard_stats(date) to authenticated;

commit;
