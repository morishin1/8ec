-- ============================================================
-- EC一元管理システム（Phase 1）セットアップ  ―― 8ec.jp/admin/ec/
--
--   Supabase ダッシュボード → SQL Editor に「このファイルの中身をすべて」
--   貼り付けて Run してください。何度実行しても安全です。
--
--   ここで作るのは「新品SKUの商品マスター」です。
--   いまの ec_items（オークション仕入れの中古品。1行＝現物1台）には
--   いっさい手を触れません。棚卸・決算資料・ショップ出品はこれまでどおり動きます。
--
--   ※ 決算資料（9/10・9/15締切）には、このファイルは関係ありません。
--     決算に必要なのは admin/setup-all.sql の方です。まだ実行していなければ
--     先にそちらを流してください。
--
--   作られるもの
--     ec_products     商品マスター（1行＝1SKU。在庫数を持ち、売れると減る）
--     ec_listings     モール別の出品設定（8EC／楽天／Amazon／Yahoo）
--     ec_stock_moves  在庫の増減履歴（いつ・どのモールで・いくつ動いたか）
--     ec_sync_log     モール連携の実行履歴（CSV出力・取込・APIの結果）
--     ec_stock_apply()  在庫を増減する関数（同時実行しても数が狂わない）
-- ============================================================

-- 管理者（zimu共有アカウント）判定。setup-all.sql と同じもの
create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;


-- ============================================================
-- 1) 商品マスター
-- ============================================================

create table if not exists public.ec_products (
  id            uuid primary key default gen_random_uuid(),
  sku           text not null,                  -- 社内SKU。全モール共通の商品キー
  jan           text,                           -- JANコード
  name          text not null,                  -- 商品名（マスター）
  maker         text,
  model         text,                           -- 型番
  category      text,
  condition     text not null default '新品',    -- 新品／未使用に近い／中古A／中古B／中古C

  -- 価格
  cost          numeric,                        -- 仕入価格（税抜）
  price         numeric,                        -- 標準販売価格（税込）
  min_price     numeric,                        -- 最低販売価格。これを下回る値付けは警告する
  shipping_fee  numeric,                        -- 送料

  -- 在庫。全モールでこの1つを共有する（モールごとに別在庫を持たない）
  stock         integer not null default 0,
  safety_stock  integer not null default 0,     -- これ以下になったら出品を止める目安

  -- 商品情報
  warranty      text,                           -- 保証内容
  spec          text,                           -- スペック
  description   text,                           -- 商品説明
  seo_keywords  text,
  image_urls    text[] default '{}',            -- 商品画像。1枚目がメイン

  -- 中古PCで必要になる項目
  cpu           text,
  memory        text,
  storage       text,
  os            text,
  office        text,
  screen_size   text,
  battery       text,
  grade         text,                           -- 傷ランク（A／B／C）
  accessories   text,                           -- 付属品

  status        text not null default 'active', -- active(取扱中)／paused(一時停止)／archived(終売)
  note          text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  updated_by    text
);

comment on table public.ec_products is
  '新品SKUの商品マスター。1行＝1SKUで在庫数を持ち、モールで売れると減る。'
  '中古の現物1台ずつを管理する ec_items とは別系統。';
comment on column public.ec_products.stock is
  '全モール共通の在庫数。直接UPDATEせず ec_stock_apply() を通すと履歴が残る。';
comment on column public.ec_products.min_price is
  '最低販売価格。価格改定で下回るときに画面で警告する（自動では止めない）。';

create unique index if not exists ec_products_sku_idx    on public.ec_products (sku);
create index        if not exists ec_products_jan_idx    on public.ec_products (jan);
create index        if not exists ec_products_model_idx  on public.ec_products (model);
create index        if not exists ec_products_status_idx on public.ec_products (status, category);


-- ============================================================
-- 2) モール別の出品設定
--    「どのモールに出すか」「そのモール用の商品名・価格」をSKUごとに持つ
-- ============================================================

create table if not exists public.ec_listings (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references public.ec_products(id) on delete cascade,
  mall           text not null,                 -- 8ec／rakuten／amazon／yahoo
  enabled        boolean not null default false, -- そのモールに出す対象か

  -- 空ならマスターの値をそのまま使う
  title          text,
  price          numeric,
  description    text,
  mall_category  text,                          -- モール側のジャンルID・カテゴリ
  shipping_fee   numeric,
  point_rate     numeric,                       -- ポイント倍率

  state          text not null default 'draft', -- draft(未出品)／listed(出品中)／paused(停止)／soldout(売切)／error
  mall_item_id   text,                          -- モール側の商品ID（楽天の商品管理番号など）
  mall_url       text,
  last_synced_at timestamptz,
  last_error     text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

comment on table public.ec_listings is
  'SKU×モールの出品設定。モールごとの処理を足すときは、この行に情報を寄せる。';

create unique index if not exists ec_listings_pm_idx    on public.ec_listings (product_id, mall);
create index        if not exists ec_listings_mall_idx  on public.ec_listings (mall, state);
create index        if not exists ec_listings_item_idx  on public.ec_listings (mall, mall_item_id);


-- ============================================================
-- 3) 在庫の増減履歴
--    「なぜ在庫が減ったのか」を後から追えるようにする
-- ============================================================

create table if not exists public.ec_stock_moves (
  id          bigint generated by default as identity primary key,
  product_id  uuid not null references public.ec_products(id) on delete cascade,
  delta       integer not null,                 -- ＋入荷／−出荷
  stock_after integer not null,                 -- 反映後の在庫数
  reason      text not null default 'manual',   -- purchase(仕入)／order(受注)／cancel(取消)／stocktake(棚卸調整)／import(CSV取込)／manual(手修正)
  mall        text,                             -- どのモールで動いたか
  ref         text,                             -- 注文番号など
  note        text,
  created_at  timestamptz default now(),
  created_by  text
);

comment on table public.ec_stock_moves is
  '在庫の増減履歴。棚卸のときに「帳簿と現物が合わない」原因をたどるために残す。';

create index if not exists ec_stock_moves_pid_idx on public.ec_stock_moves (product_id, created_at desc);
create index if not exists ec_stock_moves_at_idx  on public.ec_stock_moves (created_at desc);


-- ============================================================
-- 4) モール連携の実行履歴
-- ============================================================

create table if not exists public.ec_sync_log (
  id         bigint generated by default as identity primary key,
  mall       text not null,
  kind       text not null,                     -- export(出力)／import(取込)／api
  target     text,                              -- 商品／在庫／価格／注文
  ok_count   integer not null default 0,
  ng_count   integer not null default 0,
  message    text,
  detail     jsonb,
  created_at timestamptz default now(),
  created_by text
);

comment on table public.ec_sync_log is
  'モール連携の履歴。取込で弾かれた行の内訳を detail に入れて、あとから追えるようにする。';

create index if not exists ec_sync_log_at_idx on public.ec_sync_log (created_at desc);


-- ============================================================
-- 5) 更新時刻の自動セット
-- ============================================================

create or replace function public.ec_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ec_products_touch on public.ec_products;
create trigger ec_products_touch before update on public.ec_products
  for each row execute function public.ec_touch();

drop trigger if exists ec_listings_touch on public.ec_listings;
create trigger ec_listings_touch before update on public.ec_listings
  for each row execute function public.ec_touch();


-- ============================================================
-- 6) 在庫を増減する関数
--
--    在庫は複数のモールから同時に減りうる。画面側で
--    「読んで、引いて、書き戻す」をやると、ほぼ同時の2件で片方が消える。
--    UPDATE ... RETURNING で1文にまとめて行ロックを取り、履歴も同じ取引で残す。
-- ============================================================

create or replace function public.ec_stock_apply(
  p_product_id uuid,
  p_delta      integer,
  p_reason     text default 'manual',
  p_mall       text default null,
  p_ref        text default null,
  p_note       text default null
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_after integer;
begin
  if p_delta = 0 then
    raise exception '増減数が0です';
  end if;

  update public.ec_products
     set stock = stock + p_delta
   where id = p_product_id
   returning stock into v_after;

  if not found then
    raise exception '商品が見つかりません（id=%）', p_product_id;
  end if;

  -- マイナス在庫は作らない。例外を投げれば上のUPDATEごと巻き戻る
  if v_after < 0 then
    raise exception '在庫が足りません（現在 %／変更 %）', v_after - p_delta, p_delta;
  end if;

  insert into public.ec_stock_moves
    (product_id, delta, stock_after, reason, mall, ref, note, created_by)
  values
    (p_product_id, p_delta, v_after, coalesce(p_reason,'manual'), p_mall, p_ref, p_note,
     auth.jwt() ->> 'email');

  return v_after;
end $$;

comment on function public.ec_stock_apply is
  '在庫を増減して履歴を残す。画面から stock を直接UPDATEせず、必ずこれを通すこと。';


-- ============================================================
-- 7) 権限とRLS
--
--    いまは zimu 共有アカウントだけが読み書きする。anon（公開サイト）には
--    いっさい見せない。仕入価格・最低販売価格が入っているためで、
--    公開ショップに出すときは、必要な列だけのビューを別に作る。
-- ============================================================

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.ec_products    to authenticated;
grant select, insert, update, delete on public.ec_listings    to authenticated;
grant select, insert, update, delete on public.ec_stock_moves to authenticated;
grant select, insert, update, delete on public.ec_sync_log    to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.ec_stock_apply(uuid,integer,text,text,text,text) to authenticated;

alter table public.ec_products    enable row level security;
alter table public.ec_listings    enable row level security;
alter table public.ec_stock_moves enable row level security;
alter table public.ec_sync_log    enable row level security;

drop policy if exists "ec_products admin all" on public.ec_products;
create policy "ec_products admin all" on public.ec_products for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

drop policy if exists "ec_listings admin all" on public.ec_listings;
create policy "ec_listings admin all" on public.ec_listings for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

drop policy if exists "ec_stock_moves admin all" on public.ec_stock_moves;
create policy "ec_stock_moves admin all" on public.ec_stock_moves for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

drop policy if exists "ec_sync_log admin all" on public.ec_sync_log;
create policy "ec_sync_log admin all" on public.ec_sync_log for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

-- 商品画像をアップロードする公開バケット（ショップ用と共用）
insert into storage.buckets (id, name, public)
values ('shop-images', 'shop-images', true)
on conflict (id) do nothing;


-- ============================================================
-- 確認：作られた表と関数
-- ============================================================
select '表' as kind, table_name as name
from information_schema.tables
where table_schema='public'
  and table_name in ('ec_products','ec_listings','ec_stock_moves','ec_sync_log')
union all
select '関数', routine_name
from information_schema.routines
where routine_schema='public' and routine_name in ('ec_stock_apply','ec_touch')
order by kind, name;
