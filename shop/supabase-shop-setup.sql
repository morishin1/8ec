-- ============================================================
-- 8 SHOP 公開用ビュー設定
-- Supabase SQL Editor で実行してください。
-- 既存の ec_items を在庫管理の正とし、ショップ公開に必要な列だけを公開します。
-- ============================================================

alter table public.ec_items add column if not exists shop_published boolean default false;
alter table public.ec_items add column if not exists shop_title text;
alter table public.ec_items add column if not exists shop_description text;
alter table public.ec_items add column if not exists shop_price numeric;
alter table public.ec_items add column if not exists shop_image_url text;
alter table public.ec_items add column if not exists stripe_payment_link text;

create index if not exists ec_items_shop_public_idx
  on public.ec_items (shop_published, sold_at, updated_at desc);

-- 公開ページが参照する列だけを持つビュー。
-- ec_items 本体を anon に直接開放しないことで、仕入値・購入者情報などを公開しません。
create or replace view public.shop_products as
select
  id,
  mgmt_no,
  coalesce(nullif(shop_title,''), nullif(model,''), mgmt_no) as title,
  category,
  model,
  spec,
  shop_description as description,
  shop_price as price,
  shop_image_url as image_url,
  stripe_payment_link,
  updated_at
from public.ec_items
where shop_published = true
  and sold_at is null
  and coalesce(shop_price,0) > 0;

grant usage on schema public to anon;
grant select on public.shop_products to anon;

comment on view public.shop_products is
'8/shop の公開商品一覧。shop_published=true、sold_at is null、shop_price>0 の商品だけを公開する。';
