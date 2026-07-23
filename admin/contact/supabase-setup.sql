-- ============================================================
-- 問い合わせ／見積もり 受信テーブル（contact_submissions）
--   サイト各ページのフォーム（例：pc.html）からの投函を一元管理。
--   管理者：zimu@8grp.co.jp（事務ポータルの共有アカウント）。
--   Supabase ダッシュボード → SQL Editor に貼り付けて Run。
-- ============================================================

-- 管理者判定（既存なら再定義でOK。他ツールと共通）
create or replace function public.zimu_is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email','') = 'zimu@8grp.co.jp'
$$;

create table if not exists public.contact_submissions (
  id            uuid primary key default gen_random_uuid(),
  source        text,                         -- 送信元ページ（pc / cloud / ai-dev / company / top / general）
  inquiry_type  text,                         -- お見積もり / ご相談 / その他
  name          text not null,                -- お名前（必須）
  company       text,                         -- 会社名
  email         text,                         -- メール
  phone         text,                         -- 電話
  message       text,                         -- 内容
  status        text default '未対応',         -- 未対応 / 対応中 / 対応済
  staff_memo    text,                         -- 担当メモ
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists contact_submissions_created_idx on public.contact_submissions (created_at desc);
create index if not exists contact_submissions_status_idx  on public.contact_submissions (status);

-- 行レベルセキュリティ：zimu共有アカウントのみ全操作可
alter table public.contact_submissions enable row level security;
drop policy if exists "contact admin all" on public.contact_submissions;
create policy "contact admin all" on public.contact_submissions for all to authenticated
  using (public.zimu_is_admin()) with check (public.zimu_is_admin());

-- ============================================================
-- 公開フォームからの投函（anonはこの関数だけ実行可）
--   anon にテーブル直接権限は付与しない＝ステータス・メモ等は書き換え不可、
--   他人の投函の閲覧・削除も不可。入力に対応する列だけ受け付ける。
-- ============================================================
create or replace function public.contact_public_submit(
  p_source text,
  p_name text,
  p_company text,
  p_email text,
  p_phone text,
  p_message text,
  p_inquiry_type text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name_required';
  end if;
  insert into public.contact_submissions(
    source, inquiry_type, name, company, email, phone, message, status
  ) values (
    coalesce(nullif(btrim(coalesce(p_source,'')),''), 'general'),
    nullif(btrim(coalesce(p_inquiry_type,'')),''),
    p_name,
    nullif(btrim(coalesce(p_company,'')),''),
    nullif(btrim(coalesce(p_email,'')),''),
    nullif(btrim(coalesce(p_phone,'')),''),
    nullif(btrim(coalesce(p_message,'')),''),
    '未対応'
  ) returning id into v_id;
  return v_id;
end $$;

grant execute on function public.contact_public_submit(text,text,text,text,text,text,text) to anon;

-- PostgREST スキーマキャッシュを再読み込み
notify pgrst, 'reload schema';
