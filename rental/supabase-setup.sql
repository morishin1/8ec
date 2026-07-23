-- ============================================================
-- PC・機材レンタル 管理＆公開カタログ 用テーブル一式
--   （rental_items＝貸出機材 / rental_orders＝貸出・問い合わせ）
--
--   Supabase ダッシュボード → SQL Editor に貼り付けて Run してください。
--
--   ● 管理者：zimu@8grp.co.jp（事務ポータルの共有アカウント）がログインして
--     /admin/rental/ から在庫・貸出を管理します（8/ec と同じ zimu 共有運用）。
--   ● 公開：/rental/ の一般訪問者（anon）は public_published=true の機材だけを
--     閲覧でき、問い合わせは SECURITY DEFINER 関数 rental_public_inquiry() 経由で
--     安全に投函します（テーブルへの直接書き込み権限は付与しません）。
-- ============================================================

-- ------------------------------------------------------------
-- 管理者（zimu共有アカウント）判定（8/ec と同様。既に存在すれば再定義でOK）
-- ------------------------------------------------------------
create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;

-- ============================================================
-- 1) 貸出機材テーブル（rental_items）
-- ============================================================
create table if not exists public.rental_items (
  id               uuid primary key default gen_random_uuid(),
  seq              integer,                    -- 画面表示用の連番（R-◯）
  mgmt_no          text,                       -- 管理番号
  name             text,                       -- 機材名
  category         text,                       -- カテゴリ（ノートPC / デスクトップ / タブレット / モニター / 周辺機器 など）
  maker            text,                       -- メーカー
  model            text,                       -- 型番
  spec             text,                       -- スペック（CPU / メモリ / ストレージ など）
  image_url        text,                       -- 画像URL（公開カタログ表示用）
  daily_rate       numeric,                    -- 日額（円）
  weekly_rate      numeric,                    -- 週額（円）
  monthly_rate     numeric,                    -- 月額（円）
  deposit          numeric,                    -- 保証金・預り金（円）
  quantity         integer default 1,          -- 保有台数
  status           text default '在庫',         -- 在庫 / 貸出中 / 整備中 / 廃棄
  public_published boolean default false,      -- 公開カタログ（/rental/）に掲載するか
  description      text,                       -- 公開用の説明文
  memo             text,                       -- 社内メモ
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 既存テーブルに後から列を足す場合の保険
alter table public.rental_items add column if not exists seq              integer;
alter table public.rental_items add column if not exists mgmt_no          text;
alter table public.rental_items add column if not exists name             text;
alter table public.rental_items add column if not exists category         text;
alter table public.rental_items add column if not exists maker            text;
alter table public.rental_items add column if not exists model            text;
alter table public.rental_items add column if not exists spec             text;
alter table public.rental_items add column if not exists image_url        text;
alter table public.rental_items add column if not exists daily_rate       numeric;
alter table public.rental_items add column if not exists weekly_rate      numeric;
alter table public.rental_items add column if not exists monthly_rate     numeric;
alter table public.rental_items add column if not exists deposit          numeric;
alter table public.rental_items add column if not exists quantity         integer default 1;
alter table public.rental_items add column if not exists status           text default '在庫';
alter table public.rental_items add column if not exists public_published boolean default false;
alter table public.rental_items add column if not exists description      text;
alter table public.rental_items add column if not exists memo             text;
alter table public.rental_items add column if not exists created_at       timestamptz default now();
alter table public.rental_items add column if not exists updated_at       timestamptz default now();

create index if not exists rental_items_status_idx    on public.rental_items (status);
create index if not exists rental_items_published_idx on public.rental_items (public_published);

-- ============================================================
-- 2) 貸出・問い合わせテーブル（rental_orders）
-- ============================================================
create table if not exists public.rental_orders (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid references public.rental_items(id) on delete set null,  -- 対象機材
  customer_name text not null,                 -- お客様氏名・団体名（必須）
  company       text,                          -- 会社名
  email         text,                          -- 連絡先メール
  phone         text,                          -- 連絡先電話
  start_date    date,                          -- 貸出開始日
  end_date      date,                          -- 返却予定日
  days          integer,                       -- 貸出日数
  amount        numeric,                       -- 金額（税込）
  status        text default '問い合わせ',       -- 問い合わせ / 仮予約 / 貸出中 / 返却済 / キャンセル
  ship_address  text,                          -- 発送先住所
  memo          text,                          -- フォーム内容・担当メモ
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- 既存テーブルに後から列を足す場合の保険
alter table public.rental_orders add column if not exists item_id       uuid references public.rental_items(id) on delete set null;
alter table public.rental_orders add column if not exists company       text;
alter table public.rental_orders add column if not exists email         text;
alter table public.rental_orders add column if not exists phone         text;
alter table public.rental_orders add column if not exists start_date    date;
alter table public.rental_orders add column if not exists end_date      date;
alter table public.rental_orders add column if not exists days          integer;
alter table public.rental_orders add column if not exists amount        numeric;
alter table public.rental_orders add column if not exists status        text default '問い合わせ';
alter table public.rental_orders add column if not exists ship_address  text;
alter table public.rental_orders add column if not exists memo          text;
alter table public.rental_orders add column if not exists created_at    timestamptz default now();
alter table public.rental_orders add column if not exists updated_at    timestamptz default now();

create index if not exists rental_orders_status_idx  on public.rental_orders (status);
create index if not exists rental_orders_item_idx    on public.rental_orders (item_id);
create index if not exists rental_orders_created_idx on public.rental_orders (created_at);

-- ============================================================
-- 3) 行レベルセキュリティ（RLS）
--    管理者（zimu共有アカウント）のみ全操作可
-- ============================================================
alter table public.rental_items  enable row level security;
alter table public.rental_orders enable row level security;

-- 3-1) 機材：管理者は全操作可
drop policy if exists "rental_items admin all" on public.rental_items;
create policy "rental_items admin all" on public.rental_items for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

-- 3-2) 機材：公開カタログ用に anon（一般訪問者）へ公開機材のみ SELECT を許可
drop policy if exists "rental_items public read" on public.rental_items;
create policy "rental_items public read" on public.rental_items for select to anon
  using (public_published = true);

-- 3-3) 貸出・問い合わせ：管理者は全操作可
drop policy if exists "rental_orders admin all" on public.rental_orders;
create policy "rental_orders admin all" on public.rental_orders for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

-- ※ rental_orders には anon 用ポリシーを作らない＝一般訪問者はテーブルを
--   直接読み書きできない（他人の申込を読む/消す/書き換えることは不可）。
--   公開フォームからの投函は下記 SECURITY DEFINER 関数だけで受け付ける。

-- ============================================================
-- 4) 公開問い合わせ用 SECURITY DEFINER 関数
--    anon（/rental/ の一般訪問者）はこの関数の実行だけを許可。
--    rental_orders に status='問い合わせ' で1行 insert する。
--    書き込める項目はフォーム入力に対応する列だけに限定
--    （status・amount・担当メモなど内部管理用の列は触らせない）。
-- ============================================================
create or replace function public.rental_public_inquiry(
  p_item_id uuid,        -- 問い合わせ対象の機材ID（任意。指定時は公開中の機材のみ受付）
  p_name    text,        -- お客様氏名・団体名（必須）
  p_company text,        -- 会社名
  p_email   text,        -- メール
  p_phone   text,        -- 電話
  p_start   date,        -- 希望貸出開始日
  p_end     date,        -- 希望返却日
  p_message text         -- お問い合わせ内容・メッセージ
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid;
  v_days integer;
begin
  -- 氏名は必須
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name_required';
  end if;

  -- 機材IDが指定された場合は、公開中（public_published=true）の機材のみ受け付ける
  if p_item_id is not null then
    if not exists (
      select 1 from public.rental_items
      where id = p_item_id and public_published = true
    ) then
      raise exception 'item_not_available';
    end if;
  end if;

  -- 開始・返却日が両方あれば日数を自動計算（両端含む）
  if p_start is not null and p_end is not null and p_end >= p_start then
    v_days := (p_end - p_start) + 1;
  else
    v_days := null;
  end if;

  insert into public.rental_orders(
    item_id, customer_name, company, email, phone,
    start_date, end_date, days, status, memo
  ) values (
    p_item_id, btrim(p_name), nullif(btrim(coalesce(p_company,'')),''),
    nullif(btrim(coalesce(p_email,'')),''), nullif(btrim(coalesce(p_phone,'')),''),
    p_start, p_end, v_days, '問い合わせ', nullif(btrim(coalesce(p_message,'')),'')
  ) returning id into v_id;

  return v_id;
end $$;

-- anon（/rental/ の訪問者）にはこの関数の実行だけを許可。テーブルへの直接権限は付与しない。
grant execute on function public.rental_public_inquiry(
  uuid, text, text, text, text, date, date, text
) to anon;

-- ============================================================
-- 5) PostgREST スキーマキャッシュを再読み込み
--    列を add column した直後は、キャッシュが古いままだと
--    「Could not find the '...' column in the schema cache」の
--    ようなエラーになるため、下記で即時リロードして解消します。
-- ============================================================
notify pgrst, 'reload schema';
