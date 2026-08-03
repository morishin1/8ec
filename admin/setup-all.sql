-- ============================================================
-- 追加機能まとめてセットアップ  ―― 8ec.jp/admin/
--
--   Supabase ダッシュボード → SQL Editor に「このファイルの中身をすべて」
--   貼り付けて Run してください。1回で下の3つが有効になります。
--
--     1) 棚卸・在庫報告   … 「棚卸・在庫報告」タブ
--     2) 決算資料         … 「決算資料」タブ（請求日・入金日）
--     3) 商品画像管理     … /admin/catalog/
--
--   何度実行しても安全です（すでにある列・表は作り直しません）。
--   個別に実行したい場合は、次のファイルを使ってください。
--     admin/stocktake-setup.sql
--     admin/closing-setup.sql
--     admin/catalog/supabase-setup.sql
-- ============================================================

-- 管理者（zimu共有アカウント）判定
create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;


-- ============================================================
-- 1) 棚卸・在庫報告
-- ============================================================

-- 商品ごとの「最新の棚卸結果」
alter table public.ec_items add column if not exists location         text;         -- 保管場所（柏／岩瀬／本社）
alter table public.ec_items add column if not exists stocktake_at     timestamptz;  -- 最後に確認した日時
alter table public.ec_items add column if not exists stocktake_ym     text;         -- 確認した対象月（2026-08）
alter table public.ec_items add column if not exists stocktake_result text;         -- ok（現物あり）／missing（見つからない）／check（要確認）
alter table public.ec_items add column if not exists stocktake_note   text;         -- 差異のメモ

comment on column public.ec_items.location         is '保管場所。棚卸を場所ごとに回せるようにするための項目。';
comment on column public.ec_items.stocktake_result is 'ok=現物あり / missing=見つからない / check=要確認';

create index if not exists ec_items_stocktake_idx on public.ec_items (stocktake_ym, stocktake_result);

-- 実施ごとの集計（月次の在庫報告の履歴）
create table if not exists public.stocktakes (
  id              uuid primary key default gen_random_uuid(),
  ym              text not null,                  -- 対象月 2026-08
  taken_on        date not null default current_date,
  stock_count     integer not null default 0,     -- 在庫点数
  stock_cost      numeric not null default 0,     -- 在庫金額（仕入原価の合計）
  ok_count        integer not null default 0,
  missing_count   integer not null default 0,
  check_count     integer not null default 0,
  unchecked_count integer not null default 0,
  note            text,
  created_by      text,
  created_at      timestamptz default now()
);

comment on table public.stocktakes is
  '棚卸の実施記録。毎月の在庫報告の裏付けとして、確定時点の点数・金額・差異件数を残す。';

create unique index if not exists stocktakes_ym_idx on public.stocktakes (ym);
create index if not exists stocktakes_taken_idx on public.stocktakes (taken_on desc);

alter table public.stocktakes enable row level security;
drop policy if exists "stocktakes admin all" on public.stocktakes;
create policy "stocktakes admin all" on public.stocktakes for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());


-- ============================================================
-- 2) 決算資料（請求日・入金日）
-- ============================================================

alter table public.ec_items add column if not exists billed_at text;   -- 請求日（YYYY-MM-DD）
alter table public.ec_items add column if not exists paid_at   text;   -- 入金日（YYYY-MM-DD）

comment on column public.ec_items.billed_at is
  '請求日。空なら未請求。基準日までに売れて請求日が空（または基準日より後）のものが「未請求売上」。';
comment on column public.ec_items.paid_at is
  '入金日。空なら未入金。基準日までに売れて入金日が空（または基準日より後）のものが「未収入金」。';

create index if not exists ec_items_closing_idx  on public.ec_items (sold_at, paid_at, billed_at);
create index if not exists ec_items_purchase_idx on public.ec_items (purchase_date);


-- ============================================================
-- 3) 商品画像管理（/admin/catalog/）
-- ============================================================

create table if not exists public.catalog_images (
  product_code text primary key,           -- 商品コード（例 CI7P000118）
  model        text,                       -- 型番（画面での確認用。キーではない）
  image_url    text not null,              -- 画像URL。自社配信なら /images/products/<商品コード>.webp
  credit       text default '自社配信',     -- 商品カードの隅に出す出所表記
  memo         text,                       -- 社内メモ（どこから入手したか等）
  updated_at   timestamptz default now(),
  updated_by   text
);

comment on table public.catalog_images is
  'トップページの商品一覧に出す商品画像。商品コードをキーに、画像URLを1件ずつ持つ。';

create index if not exists catalog_images_updated_idx
  on public.catalog_images (updated_at desc);

-- 更新時刻を自動で入れる
create or replace function public.catalog_images_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists catalog_images_touch on public.catalog_images;
create trigger catalog_images_touch before update on public.catalog_images
  for each row execute function public.catalog_images_touch();

-- anon（トップページ）は読むだけ。書き込めるのは zimu 共有アカウントのみ
alter table public.catalog_images enable row level security;

drop policy if exists "catalog_images read" on public.catalog_images;
create policy "catalog_images read" on public.catalog_images
  for select to anon, authenticated using (true);

drop policy if exists "catalog_images admin write" on public.catalog_images;
create policy "catalog_images admin write" on public.catalog_images
  for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

grant usage on schema public to anon;
grant select on public.catalog_images to anon;

-- 画像ファイルをアップロードする場合の公開バケット（ショップ用と共用）
insert into storage.buckets (id, name, public)
values ('shop-images', 'shop-images', true)
on conflict (id) do nothing;


-- ============================================================
-- 確認：追加された列と表
-- ============================================================
select 'ec_items の追加列' as kind, column_name as name
from information_schema.columns
where table_schema='public' and table_name='ec_items'
  and column_name in ('location','stocktake_at','stocktake_ym','stocktake_result','stocktake_note','billed_at','paid_at')
union all
select '追加された表', table_name
from information_schema.tables
where table_schema='public' and table_name in ('stocktakes','catalog_images')
order by kind, name;
