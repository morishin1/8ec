-- ============================================================
-- QR販売・売却取消・月次集計の点検（本番でそのまま流せます）
--
--   使いかた
--     Supabase の SQL Editor に貼って実行するだけ。psql でも動きます。
--     **全体が1つのトランザクションで、最後に必ず rollback します。**
--     途中で作った商品・個体・履歴・価格はすべて消えるので、本番のデータは
--     1行も変わりません（在庫数も売上も動きません）。
--
--   何を見るか
--     2026-10-13-sell-channel-price.sql を適用したあと、
--     「倉庫メンバーが販売先を選ぶだけで、登録価格で売れる」
--     「取り消した売却が今月の数字に残らない」
--     が本当にそうなっているかを、実データと同じ経路で確かめます。
--
--   ブラウザ側（画面）の回帰テストは Playwright で別に走らせています
--   （このリポジトリには入れていません。理由は README の「テスト」を参照）。
--   ここに入れてあるのは、**SQLだけで確かめられる部分**です。
-- ============================================================

begin;

-- 点検のあいだだけ「管理者としてログインしている」ことにする。
-- auth.jwt() を差し替えるが、rollback で元に戻る（本番の認証設定は変わらない）
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select jsonb_build_object('email', coalesce(current_setting('chk.email', true), ''))
$$;

-- 点検用の人。rollback で消える
insert into public.inventory_members (email, display_name, role) values
  ('chk-admin@example.invalid',  '点検（管理者）',     'admin'),
  ('chk-member@example.invalid', '点検（倉庫）',       'member'),
  ('chk-viewer@example.invalid', '点検（閲覧）',       'viewer');

-- 点検用の商品と個体。原価 30,000円（仕入 28,000 ＋ 手数料 2,000）
insert into public.inventory_products (code, name, maker, model, category_id, kind)
values ('CHK-P', '点検用PC', 'CHK', 'CHK-1',
        (select id from public.inventory_categories order by sort_no limit 1), 'individual');

insert into public.inventory_items (id, name, product_code, location_id, status, serial, price, purchase_fee)
select x, '点検用PC', 'CHK-P',
       (select id from public.inventory_locations order by sort_no limit 1),
       '在庫', 'CHK-' || x, 28000, 2000
  from unnest(array['CHK-1','CHK-2','CHK-3']) x;

-- 商品 × 販売先の価格。メルカリはわざと未設定、ヤフオクはわざと0円
insert into public.inventory_channel_listings (product_code, channel, state, price) values
  ('CHK-P', 'rakuten', '出品中', 42800),
  ('CHK-P', 'amazon',  '出品中', 45000),
  ('CHK-P', 'mercari', '出品中', null),
  ('CHK-P', 'yahuoku', '出品中', 0);
-- 個体 × 販売先の価格（CHK-2 の楽天だけ個体価格あり）
insert into public.inventory_channels (product_code, channel, item_id, price, state)
values ('CHK-P', 'rakuten', 'CHK-2', 39800, '出品中');

-- 結果を1行ずつためる
create temporary table chk_result (no int, kind text, result text) on commit drop;
create or replace function pg_temp.say(p_no int, p_kind text, p_ok boolean, p_note text default null)
returns void language sql as $$
  insert into chk_result values (p_no, p_kind,
    case when p_ok then 'OK' else 'NG' end || coalesce('　' || p_note, ''))
$$;
-- 失敗するはずの呼び出しを、落ちずに確かめる
create or replace function pg_temp.fails(p_sql text, p_like text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;                       -- 通ってしまった＝NG
exception when others then
  return sqlerrm like p_like;
end $$;


-- 月次集計は**この点検で動かしたぶんだけ**を見たいので、
-- 何も売る前の数字を先に控えておく（本番の既存データには触れない）
create temporary table chk_base on commit drop as
select (public.inv_dashboard_stats() ->> 'sales_sale')::numeric   as sales,
       (public.inv_dashboard_stats() ->> 'gross_profit')::numeric as profit,
       (public.inv_dashboard_stats() ->> 'sold_count')::int       as cnt;


-- ------------------------------------------------------------
set chk.email = 'chk-member@example.invalid';      -- 倉庫メンバーとして
-- ------------------------------------------------------------

select pg_temp.say(1, '楽天の登録価格が出る',
  public.inv_item_channel_price('CHK-1', 'rakuten') = 42800,
  public.inv_item_channel_price('CHK-1', 'rakuten')::text || '円');

select pg_temp.say(2, 'Amazonの登録価格が出る',
  public.inv_item_channel_price('CHK-1', 'amazon') = 45000,
  public.inv_item_channel_price('CHK-1', 'amazon')::text || '円');

select pg_temp.say(3, '個体の価格が商品の価格より優先',
  public.inv_item_channel_price('CHK-2', 'rakuten') = 39800,
  public.inv_item_channel_price('CHK-2', 'rakuten')::text || '円');

select pg_temp.say(4, '価格が無ければ売れない',
  pg_temp.fails($$select public.inv_item_sell_channel('CHK-1','mercari')$$, '%価格が登録されていません%'));

select pg_temp.say(5, '0円では売れない',
  pg_temp.fails($$select public.inv_item_sell_channel('CHK-1','yahuoku')$$, '%0円以下%'));

select pg_temp.say(6, '知らない販売先では売れない',
  pg_temp.fails($$select public.inv_item_sell_channel('CHK-1','notion')$$, '%知らない販売先%')
  and pg_temp.fails($$select public.inv_item_channel_price('CHK-1','notion')$$, '%知らない販売先%'));

select pg_temp.say(7, '売り先は決まった6つだけ',
  public.inv_sell_channels() = array['rakuten','amazon','mercari','yahuoku','yahoo_free','other']);

-- 実際に売る（倉庫メンバー）
select public.inv_item_sell_channel('CHK-1', 'rakuten', '点検');

select pg_temp.say(8, 'DBの価格が売価に入る',
  (select sold_price from public.inventory_items where id = 'CHK-1') = 42800);
select pg_temp.say(9, '販売先も保存される',
  (select sold_channel from public.inventory_items where id = 'CHK-1') = 'rakuten');
select pg_temp.say(10, '状態は売却済',
  (select status from public.inventory_items where id = 'CHK-1') = '売却済');
select pg_temp.say(11, '売却の履歴が既存の形で残る',
  exists (select 1 from public.inventory_transactions
           where ref_kind = 'item' and ref_id = 'CHK-1' and action = '売却'
             and before_value = '在庫' and after_value like '売却済（rakuten）%'));

-- 掲載価格を上げても、売った金額は動かない
update public.inventory_channel_listings set price = 45800
 where product_code = 'CHK-P' and channel = 'rakuten';
select pg_temp.say(12, '後から掲載価格を変えても売価は不変',
  (select sold_price from public.inventory_items where id = 'CHK-1') = 42800
  and public.inv_item_channel_price('CHK-3', 'rakuten') = 45800);


-- ------------------------------------------------------------
set chk.email = 'chk-viewer@example.invalid';      -- 閲覧のみとして
-- ------------------------------------------------------------

select pg_temp.say(13, '閲覧のみは売れない',
  pg_temp.fails($$select public.inv_item_sell_channel('CHK-3','rakuten')$$, '%権限がありません%'));
select pg_temp.say(14, '閲覧のみは価格も見られない',
  pg_temp.fails($$select public.inv_item_channel_price('CHK-3','rakuten')$$, '%権限がありません%'));
select pg_temp.say(15, '閲覧のみの試行で状態は変わらない',
  (select status from public.inventory_items where id = 'CHK-3') = '在庫');


-- ------------------------------------------------------------
set chk.email = 'chk-admin@example.invalid';       -- 管理者として
-- ------------------------------------------------------------

-- 画面（viewDash）が読むキーが1つも欠けていないこと
select pg_temp.say(16, '経営数値の返すキーが変わっていない',
  (select array_agg(k order by k) from jsonb_object_keys(public.inv_dashboard_stats()) k)
  = array['aged_60','aged_90','aged_90_cost','avg_profit_per_unit','avg_stock_days',
          'gross_margin','gross_profit','month','profit_base','profit_count',
          'profit_missing_cost','purchase_amount','purchase_count','rental_available',
          'sales_rental','sales_sale','sales_total','sold_count','sold_price_missing',
          'sold_price_missing_month','stock_cost','stock_count','stock_no_date'],
  (select count(*)::text from jsonb_object_keys(public.inv_dashboard_stats()) k) || '個');

-- ここから月次集計。見るのは「何も売る前」からの差だけ
select pg_temp.say(17, '売った1台が今月に乗る',
  (select (public.inv_dashboard_stats() ->> 'sales_sale')::numeric - sales from chk_base) = 42800
  and (select (public.inv_dashboard_stats() ->> 'gross_profit')::numeric - profit from chk_base) = 12800
  and (select (public.inv_dashboard_stats() ->> 'sold_count')::int - cnt from chk_base) = 1,
  '＋42,800円 ／ 粗利 ＋12,800円 ／ ＋1台');

-- 売却を取り消す
select public.inv_item_sell_undo('CHK-1', '点検');

select pg_temp.say(18, '取り消すと売上・粗利・台数すべて元に戻る',
  (select (public.inv_dashboard_stats() ->> 'sales_sale')::numeric - sales from chk_base) = 0
  and (select (public.inv_dashboard_stats() ->> 'gross_profit')::numeric - profit from chk_base) = 0
  and (select (public.inv_dashboard_stats() ->> 'sold_count')::int - cnt from chk_base) = 0,
  '売上 ±0 ／ 粗利 ±0 ／ ±0台');
select pg_temp.say(19, '取り消すと売価・販売先が消える',
  (select sold_price is null and sold_channel is null
     from public.inventory_items where id = 'CHK-1'));
select pg_temp.say(20, '売却の履歴は消えず、売却取消が足される',
  (select count(*) from public.inventory_transactions
    where ref_kind = 'item' and ref_id = 'CHK-1' and action = '売却') = 1
  and exists (select 1 from public.inventory_transactions
               where ref_kind = 'item' and ref_id = 'CHK-1' and action = '売却取消'));

-- 取り消したあとに、別の販売先で売り直す
set chk.email = 'chk-member@example.invalid';
select public.inv_item_sell_channel('CHK-1', 'amazon', '点検（再売却）');
set chk.email = 'chk-admin@example.invalid';

select pg_temp.say(21, '再売却は新しいほうだけ数える',
  (select (public.inv_dashboard_stats() ->> 'sales_sale')::numeric - sales from chk_base) = 45000,
  '＝ 45,000円（古い 42,800円を二重計上していない）');
select pg_temp.say(22, '再売却の粗利も新しいほうだけ',
  (select (public.inv_dashboard_stats() ->> 'gross_profit')::numeric - profit from chk_base) = 15000,
  '＝ 45,000 − 原価 30,000');
select pg_temp.say(23, '販売台数も1台だけ',
  (select (public.inv_dashboard_stats() ->> 'sold_count')::int - cnt from chk_base) = 1,
  '（売り直した1台だけ。取り消したぶんは数えない）');

select pg_temp.say(24, '古い売却はもう効いていない',
  not public.inv_sale_is_active('CHK-1',
        (select occurred_at from public.inventory_transactions
          where ref_kind='item' and ref_id='CHK-1' and action='売却' order by id limit 1),
        (select id from public.inventory_transactions
          where ref_kind='item' and ref_id='CHK-1' and action='売却' order by id limit 1)));
select pg_temp.say(25, '新しい売却は効いている',
  public.inv_sale_is_active('CHK-1',
        (select occurred_at from public.inventory_transactions
          where ref_kind='item' and ref_id='CHK-1' and action='売却' order by id desc limit 1),
        (select id from public.inventory_transactions
          where ref_kind='item' and ref_id='CHK-1' and action='売却' order by id desc limit 1)));

select pg_temp.say(26, 'ほかの個体に影響していない',
  (select count(*) from public.inventory_items
    where id in ('CHK-2','CHK-3') and status = '在庫'
      and sold_price is null and sold_channel is null) = 2);


-- ------------------------------------------------------------
-- 結果
-- ------------------------------------------------------------
select no, kind, result from chk_result order by no;

select case when exists (select 1 from chk_result where result like 'NG%')
            then 'NG　上の一覧で NG の行を見てください'
            else 'QR販売・売却取消・月次集計の点検：問題なし（' ||
                 (select count(*)::text from chk_result) || '項目）' end as "点検結果";

-- **ここまでの変更はすべて取り消します。** 本番のデータは1行も変わりません
rollback;
