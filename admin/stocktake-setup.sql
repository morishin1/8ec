-- ============================================================
-- 棚卸（実地棚卸）  ―― 8ec.jp/admin/ の「棚卸」タブ用
--   Supabase ダッシュボード → SQL Editor に貼り付けて Run してください。
--
--   毎月の在庫報告のために、
--     1) 現物があるかを1件ずつ確認して ec_items に結果を残す
--     2) 実施ごとの集計を stocktakes に1行残す（前月との比較に使う）
--   の2つを扱います。
--
--   管理者：zimu@8grp.co.jp（事務の共有アカウント）
--   何度実行しても安全です。
-- ============================================================

create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;

-- 1) 商品ごとの「最新の棚卸結果」
alter table public.ec_items add column if not exists location        text;         -- 保管場所（柏／岩瀬／本社）
alter table public.ec_items add column if not exists stocktake_at    timestamptz;  -- 最後に確認した日時
alter table public.ec_items add column if not exists stocktake_ym    text;         -- 確認した対象月（2026-08）
alter table public.ec_items add column if not exists stocktake_result text;        -- ok（現物あり）／missing（見つからない）／check（要確認）
alter table public.ec_items add column if not exists stocktake_note  text;         -- 差異のメモ

comment on column public.ec_items.location         is '保管場所。棚卸を場所ごとに回せるようにするための項目。';
comment on column public.ec_items.stocktake_result is 'ok=現物あり / missing=見つからない / check=要確認';

create index if not exists ec_items_stocktake_idx on public.ec_items (stocktake_ym, stocktake_result);

-- 2) 実施ごとの集計（月次の在庫報告の履歴）
create table if not exists public.stocktakes (
  id           uuid primary key default gen_random_uuid(),
  ym           text not null,                  -- 対象月 2026-08
  taken_on     date not null default current_date,
  stock_count  integer not null default 0,     -- 在庫点数
  stock_cost   numeric not null default 0,     -- 在庫金額（仕入原価の合計）
  ok_count     integer not null default 0,
  missing_count integer not null default 0,
  check_count  integer not null default 0,
  unchecked_count integer not null default 0,
  note         text,
  created_by   text,
  created_at   timestamptz default now()
);

comment on table public.stocktakes is
  '棚卸の実施記録。毎月の在庫報告の裏付けとして、確定時点の点数・金額・差異件数を残す。';

create unique index if not exists stocktakes_ym_idx on public.stocktakes (ym);
create index if not exists stocktakes_taken_idx on public.stocktakes (taken_on desc);

-- 3) 権限と行レベルセキュリティ（zimu共有アカウントのみ全操作可）
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.stocktakes to authenticated;

alter table public.stocktakes enable row level security;
drop policy if exists "stocktakes admin all" on public.stocktakes;
create policy "stocktakes admin all" on public.stocktakes for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());
