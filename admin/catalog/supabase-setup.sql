-- ============================================================
-- 法人在庫の商品画像（catalog_images）  ―― 8ec.jp/admin/catalog/ 用
--   Supabase ダッシュボード → SQL Editor に貼り付けて Run してください。
--
--   トップページの商品一覧（assets/inventory-data.js の1,292件）に出す
--   商品画像のURLを、管理画面から登録するためのテーブルです。
--
--   商品コード（productCode）をキーにします。自社配信の画像ファイル名が
--   商品コードで付いており、型番は別SKUで重複することがあるためです。
--
--   管理者：zimu@8grp.co.jp（事務の共有アカウント）
--   何度実行しても安全です。
-- ============================================================

-- 管理者判定（admin/supabase-setup.sql と同じもの。単体でも実行できるよう再定義）
create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;

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
  'トップpage の商品一覧に出す商品画像。商品コードをキーに、画像URLを1件ずつ持つ。';

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

-- 行レベルセキュリティ
--   anon（トップページ）は読むだけ。書き込めるのは zimu 共有アカウントのみ。
grant usage on schema public to anon, authenticated;
grant select on public.catalog_images to anon;
grant select, insert, update, delete on public.catalog_images to authenticated;

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

-- 画像ファイルをアップロードする場合は、公開バケット shop-images を使います
-- （ショップ用と同じバケット。catalog/ の下に置いて用途を分けます）
insert into storage.buckets (id, name, public)
values ('shop-images', 'shop-images', true)
on conflict (id) do nothing;
