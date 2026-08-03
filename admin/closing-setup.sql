-- ============================================================
-- 決算資料（入金・請求）  ―― 8ec.jp/admin/ の「決算資料」タブ用
--   Supabase ダッシュボード → SQL Editor に貼り付けて Run してください。
--
--   毎期の決算で提出する次の3つを、基準日を指定して出せるようにします。
--     ① EC在庫金額   … 基準日時点で在庫だった商品の仕入原価
--     ② EC未収入金   … 基準日までに売れたが、入金がまだのもの
--     ④ 未請求売上   … 基準日までに売れたが、請求がまだのもの
--
--   ①は今のデータで出せますが、②④は入金日・請求日を持っていないため
--   この2列を追加します。
--
--   管理者：zimu@8grp.co.jp（事務の共有アカウント）
--   何度実行しても安全です。
-- ============================================================

create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;

-- 入金・請求の記録
alter table public.ec_items add column if not exists billed_at text;   -- 請求日（YYYY-MM-DD）
alter table public.ec_items add column if not exists paid_at   text;   -- 入金日（YYYY-MM-DD）

comment on column public.ec_items.billed_at is
  '請求日。空なら未請求。基準日までに売れて請求日が空（または基準日より後）のものが「未請求売上」。';
comment on column public.ec_items.paid_at is
  '入金日。空なら未入金。基準日までに売れて入金日が空（または基準日より後）のものが「未収入金」。';

-- 決算の集計で使う絞り込みに合わせた索引
create index if not exists ec_items_closing_idx on public.ec_items (sold_at, paid_at, billed_at);
create index if not exists ec_items_purchase_idx on public.ec_items (purchase_date);
