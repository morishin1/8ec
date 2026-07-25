-- ============================================================
-- EC在庫管理（ec_items）テーブル一式  ―― 8ec.jp/admin/ 用
--   Supabase ダッシュボード → SQL Editor に貼り付けて Run してください。
--
--   管理者：zimu@8grp.co.jp（事務の共有アカウント）でログインして利用します。
--
--   実行順：
--     1) このファイル（admin/supabase-setup.sql）      … ec_items 本体
--     2) shop/supabase-shop-setup.sql                  … 公開ショップ用ビュー
--     3) admin/contact/supabase-setup.sql              … 問い合わせ・見積もりフォーム
--     4) rental/supabase-setup.sql                     … レンタル
--
--   何度実行しても安全です（create ... if not exists / add column if not exists）。
-- ============================================================

-- 管理者（zimu共有アカウント）判定（既に存在すれば再定義でOK）
create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;

-- 1) 商品テーブル
create table if not exists public.ec_items (
  id            uuid primary key default gen_random_uuid(),
  seq           integer,                    -- 画面表示用の連番（EC-◯）
  mgmt_no       text not null,              -- 管理番号（SKU）
  product_name  text,                       -- 商品名
  category      text,                       -- 種別（NTPC / TWPC / スマホ など）
  maker         text,                       -- メーカー
  model         text,                       -- 型番
  spec          text,                       -- スペック
  purchase_date date,                       -- 仕入日
  cost          numeric,                    -- 仕入値
  shipping      numeric,                    -- 送料
  fee           numeric,                    -- 手数料
  listings      jsonb default '{}'::jsonb,  -- 出品状況 {mercari:'出品中', yahuoku:'', ...}
  listing_urls  jsonb default '{}'::jsonb,  -- 出品URL {rakuten:'https://…', ...}
  sale_price    numeric,                    -- 売上
  sold_channel  text,                       -- 販売先（mercari など）
  sold_at       timestamptz,                -- 販売日時（入っていれば「販売済み」）
  buyer_name    text,                       -- 購入者（氏名）
  buyer_phone   text,                       -- 電話番号
  ship_address  text,                       -- 発送先住所
  ship_action   text,                       -- 発送方法（発送／発送（本社から）／柏 など）
  accessories   text,                       -- 台数・付属品
  shipped_at    date,                       -- 出荷日（入っていれば「発送済み」）
  tracking_no   text,                       -- 伝票番号
  memo          text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- 既存テーブルに後から列を足す場合の保険
alter table public.ec_items add column if not exists seq          integer;
alter table public.ec_items add column if not exists listings     jsonb default '{}'::jsonb;
alter table public.ec_items add column if not exists listing_urls jsonb default '{}'::jsonb;
alter table public.ec_items add column if not exists sold_channel text;
alter table public.ec_items add column if not exists sold_at      timestamptz;
alter table public.ec_items add column if not exists buyer_name   text;
alter table public.ec_items add column if not exists buyer_phone  text;
alter table public.ec_items add column if not exists ship_address text;
alter table public.ec_items add column if not exists ship_action  text;
alter table public.ec_items add column if not exists ship_location text;   -- 発送場所（柏／岩瀬／本社）
alter table public.ec_items add column if not exists accessories  text;
alter table public.ec_items add column if not exists shipped_at   date;
alter table public.ec_items add column if not exists tracking_no  text;

-- 自社ショップ（8ec.jp/shop/）への出品設定
--   管理画面の「ショップ出品」タブから編集します。
--   実際にショップへ並ぶ条件は shop/supabase-shop-setup.sql の shop_products ビュー側で
--   「shop_published = true かつ sold_at is null かつ shop_price > 0」と定義しています。
alter table public.ec_items add column if not exists shop_published boolean default false;
alter table public.ec_items add column if not exists shop_title text;
alter table public.ec_items add column if not exists shop_description text;
alter table public.ec_items add column if not exists shop_price numeric;
alter table public.ec_items add column if not exists shop_image_url text;      -- メイン画像（shop_images の1枚目と同じものが入る）
alter table public.ec_items add column if not exists stripe_payment_link text; -- Stripe決済リンクのURL

-- 商品画像（メルカリのように複数枚アップロードして並べ替えできる）
--   ["https://…/shop-images/xxx.jpg", ...] の形で公開URLを保持。1枚目がメイン画像。
alter table public.ec_items add column if not exists shop_images jsonb default '[]'::jsonb;

-- Stripe連携（Products / Prices / Payment Links API で自動生成したオブジェクトのID）
--   価格を変更したときは Price を作り直す必要があるため、作成し直した際は
--   古い Payment Link を active=false にしてから新しいリンクを発行します。
alter table public.ec_items add column if not exists stripe_product_id      text;
alter table public.ec_items add column if not exists stripe_price_id        text;
alter table public.ec_items add column if not exists stripe_payment_link_id text;
alter table public.ec_items add column if not exists stripe_synced_price    numeric;  -- リンク発行時の価格（価格変更の検知用）

-- 手数料・利用料（粗利計算用）
alter table public.ec_items add column if not exists commission_rate numeric;   -- サイト手数料率（％。販売先で自動設定・編集可）
alter table public.ec_items add column if not exists platform_fee    numeric;   -- プラットフォーム利用料（円）
-- 発送指示の添付ファイル [{name,path}]
alter table public.ec_items add column if not exists ship_files      jsonb default '[]'::jsonb;
-- クレーム対応
alter table public.ec_items add column if not exists claim_content   text;      -- どんなクレームか
alter table public.ec_items add column if not exists claim_response  text;      -- どんな対応をしたか
alter table public.ec_items add column if not exists claim_date      date;      -- 発生日
alter table public.ec_items add column if not exists claim_done      boolean default false;  -- 対応済みか
-- 商品名・メーカー
alter table public.ec_items add column if not exists product_name   text;
alter table public.ec_items add column if not exists maker          text;
-- 仕入CSV（オークション）の全項目を保持（商品情報に表示）
alter table public.ec_items add column if not exists source_data    jsonb;     -- {開催日,出品番号,構成,状態,個品ID,...}
-- 個数（バルク品：ACセット50個 など。単体・分割済みセットは1）
alter table public.ec_items add column if not exists quantity       integer default 1;

create index if not exists ec_items_sold_at_idx on public.ec_items (sold_at);

-- 2) 行レベルセキュリティ（zimu共有アカウントのみ全操作可）
alter table public.ec_items enable row level security;
drop policy if exists "ec_items admin all" on public.ec_items;
create policy "ec_items admin all" on public.ec_items for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

-- ============================================================
-- 3) 発送指示の添付ファイル用ストレージ（Storage）
--    非公開バケット。zimu共有アカウントのみアップロード／閲覧可（署名URLで表示）。
-- ============================================================
insert into storage.buckets (id, name, public)
values ('ec-ship', 'ec-ship', false)
on conflict (id) do nothing;

drop policy if exists "ec-ship zimu all" on storage.objects;
create policy "ec-ship zimu all" on storage.objects for all to authenticated
  using      (bucket_id = 'ec-ship' and public.zimu_is_admin())
  with check (bucket_id = 'ec-ship' and public.zimu_is_admin());

-- ============================================================
-- 3-2) 商品画像用ストレージ（Storage）
--     こちらは「公開」バケットです。ショップの閲覧者に画像を表示する必要があり、
--     さらに Stripe の商品画像は公開URLでないと登録できないためです。
--     アップロード・削除は zimu共有アカウントのみ。
-- ============================================================
insert into storage.buckets (id, name, public)
values ('shop-images', 'shop-images', true)
on conflict (id) do update set public = true;

-- 閲覧：誰でも可（ショップ表示・Stripeの商品画像取得のため）
drop policy if exists "shop-images public read" on storage.objects;
create policy "shop-images public read" on storage.objects for select to public
  using (bucket_id = 'shop-images');

-- 追加・更新・削除：管理者のみ
drop policy if exists "shop-images admin insert" on storage.objects;
create policy "shop-images admin insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-images' and public.zimu_is_admin());

drop policy if exists "shop-images admin update" on storage.objects;
create policy "shop-images admin update" on storage.objects for update to authenticated
  using      (bucket_id = 'shop-images' and public.zimu_is_admin())
  with check (bucket_id = 'shop-images' and public.zimu_is_admin());

drop policy if exists "shop-images admin delete" on storage.objects;
create policy "shop-images admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'shop-images' and public.zimu_is_admin());

-- ============================================================
-- 4) PostgREST スキーマキャッシュを再読み込み
--    列を add column した直後は、キャッシュが古いままだと
--    「Could not find the 'shop_price' column ... in the schema cache」
--    のようなエラーで保存に失敗します（列は存在するのに弾かれる）。
-- ============================================================
notify pgrst, 'reload schema';
