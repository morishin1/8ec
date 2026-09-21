-- ============================================================
-- 48) 公開フォームもサーバー経由だけにする（2026-09-23 の続き）
--
--   これまで、公開フォームの2つは anon（ブラウザの公開鍵）から
--   直接たたける状態でした。
--     ・inv_deal_create()        …/quote の3分IT調達診断
--     ・contact_public_submit()  …各ページの相談フォーム
--
--   見積の承認と違って「状態を進める」わけではありませんが、
--   直接たたかれると
--     ・Slack通知が飛ばない（担当者が気づかない問い合わせが作れる）
--     ・サーバー側の入力チェックを通らない
--     ・回数制限を通らない
--   ので、サイト全体を
--     お客様のブラウザ → Vercel /api/* →（サーバー鍵）→ Supabase
--   に揃えます。
--
--   ※ 先に Vercel へ SUPABASE_SECRET_KEY を登録し、APIを配信してから
--     このmigrationを当ててください。順番が逆だと、その間フォームが
--     エラーになります（APIは鍵が無いと 503 で止まります）。
--
--   在庫まわりは一切さわりません。
--   inventory_items / inv_sale_reserve() / inv_rental_allocate() /
--   inv_reserve_available_item() / 楽天連携 は変更していません。
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 48-1) アクセスを数える箱を、見積だけでなく公開フォームにも使う
--
--     2026-09-23 で inventory_quote_access として作ったものを、
--     名前だけ inventory_public_access に変えて使い回します
--     （中身も持ち方も同じ。列 kind は「どの入口か」を見るためだけ）。
-- ------------------------------------------------------------
alter table if exists public.inventory_quote_access
  rename to inventory_public_access;

create table if not exists public.inventory_public_access (
  client_key text        not null,
  window_at  timestamptz not null,
  tries      integer     not null default 0,
  misses     integer     not null default 0,
  primary key (client_key, window_at)
);

alter table public.inventory_public_access
  add column if not exists kind text not null default 'quote-view';

alter index if exists public.inventory_quote_access_window_idx
  rename to inventory_public_access_window_idx;
create index if not exists inventory_public_access_window_idx
  on public.inventory_public_access (window_at);

alter table public.inventory_public_access enable row level security;
revoke all on public.inventory_public_access from anon, authenticated;

comment on table public.inventory_public_access is
  '公開の入口（顧客見積ページ・診断フォーム・相談フォーム）へのアクセス回数を分単位で数える。
   総当たりと連打を止めるためだけに使う。client_key は「入口の種類:IPのsha256」で、
   IPそのものは保存しない。保持期間は既定30日（inv_public_access_cleanup で消える）。';

-- ------------------------------------------------------------
-- 48-2) 保持期間（無期限に残さない）
--
--     既定30日。90日にしたいときは inv_public_access_cleanup(90) のように呼ぶ。
--     inv_public_access_check から毎回呼ばれるので、ふだんは何もしなくても消えます。
--     手で消したいときや、Supabaseのcronに載せたいときにも使えます。
-- ------------------------------------------------------------
create or replace function public.inv_public_access_cleanup(
  p_days integer default 30
) returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_days integer := greatest(coalesce(p_days, 30), 1);
  v_n    integer;
begin
  delete from public.inventory_public_access
   where window_at < now() - (v_days || ' days')::interval;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

comment on function public.inv_public_access_cleanup is
  'アクセス記録の掃除。既定30日より前を消して、消した件数を返す。
   inv_public_access_check が毎回呼ぶので、ふだんは手で実行しなくてよい。';

-- ------------------------------------------------------------
-- 48-3) 数えて、行きすぎならことわる（入口ごとに上限を変える）
--
--     直近10分で
--       quote-view   …外れ20回 / 合計150回   （URLを開くだけなので多め）
--       quote-decide …外れ10回 / 合計 30回   （書き込む操作）
--       form         …外れ10回 / 合計 20回   （診断・相談フォームの送信）
--     を超えたら blocked=true。APIはこれを見て429を返す。
--
--     ついでに、古い記録をここで消す（30日より前）。
--     無期限に残さないため、cronを足さなくても必ず消えるようにしている。
-- ------------------------------------------------------------
create or replace function public.inv_public_access_check(
  p_client text,
  p_kind   text default 'quote-view',
  p_miss   boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_kind   text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'other');
  v_raw    text := nullif(btrim(coalesce(p_client, '')), '');
  v_key    text;
  v_win    timestamptz := date_trunc('minute', now());
  v_tries  integer;
  v_misses integer;
  v_max_miss integer;
  v_max_try  integer;
begin
  -- 相手が分からないときは数えようがないので素通しする（APIが必ず渡す）
  if v_raw is null then
    return jsonb_build_object('blocked', false, 'tries', 0, 'misses', 0);
  end if;
  v_kind := left(v_kind, 16);
  v_key  := v_kind || ':' || left(v_raw, 64);

  if v_kind = 'quote-view' then
    v_max_miss := 20; v_max_try := 150;
  elsif v_kind = 'quote-decide' then
    v_max_miss := 10; v_max_try := 30;
  else
    v_max_miss := 10; v_max_try := 20;
  end if;

  insert into public.inventory_public_access (client_key, kind, window_at, tries, misses)
  values (v_key, v_kind, v_win, 1, case when p_miss then 1 else 0 end)
  on conflict (client_key, window_at) do update
    set tries  = public.inventory_public_access.tries + 1,
        misses = public.inventory_public_access.misses + case when p_miss then 1 else 0 end;

  select coalesce(sum(tries), 0), coalesce(sum(misses), 0)
    into v_tries, v_misses
    from public.inventory_public_access
   where client_key = v_key and window_at > now() - interval '10 minutes';

  -- 古い記録はここで消す。数えるのに要るのは直近10分だけなので、
  -- 残しているのは「あとで様子を見るため」の30日ぶん。
  perform public.inv_public_access_cleanup(30);

  return jsonb_build_object(
    'blocked', (v_misses >= v_max_miss or v_tries >= v_max_try),
    'kind',    v_kind,
    'tries',   v_tries,
    'misses',  v_misses);
end $$;

comment on function public.inv_public_access_check is
  '公開の入口へのアクセスを分単位で数え、短時間に外し続ける相手・送り続ける相手をことわる。
   APIからサーバー鍵で呼ぶ。client_key はIPのsha256（IPそのものは保存しない）。
   呼ぶたびに30日より前の記録を消すので、無期限には残らない。';

drop function if exists public.inv_quote_access_check(text, boolean);

-- ------------------------------------------------------------
-- 48-4) 権限
--
--     公開フォームの2つも、サーバー（service_role）からだけ呼べるようにする。
--     関数を作るとPUBLICに実行権限が付くので、PUBLICごと落としてから配り直す。
-- ------------------------------------------------------------
revoke all on function public.inv_public_access_check(text,text,boolean) from public, anon, authenticated;
revoke all on function public.inv_public_access_cleanup(integer)         from public, anon, authenticated;
grant execute on function public.inv_public_access_check(text,text,boolean) to service_role;
grant execute on function public.inv_public_access_cleanup(integer)         to service_role;

--     先に必要なものが入っているか確かめる（入っていなければ、何を当てるか伝えて止まる）
do $$
begin
  if to_regprocedure('public.inv_deal_create(text,text,text,text,text,integer,integer,date,integer,text,jsonb,text[],text,text,text,text)') is null then
    raise exception '関数 inv_deal_create が見つかりません。先に 2026-09-21-deals.sql を適用してください';
  end if;
  if to_regprocedure('public.contact_public_submit(text,text,text,text,text,text,text)') is null then
    raise exception '関数 contact_public_submit が見つかりません。先に admin/contact/supabase-setup.sql を適用してください';
  end if;
end $$;

-- /quote の3分IT調達診断（ブラウザは /api/quote を通す）
revoke all on function public.inv_deal_create(
  text,text,text,text,text,integer,integer,date,integer,text,jsonb,text[],text,text,text,text)
  from public, anon;
grant execute on function public.inv_deal_create(
  text,text,text,text,text,integer,integer,date,integer,text,jsonb,text[],text,text,text,text)
  to service_role;

-- 各ページの相談フォーム（ブラウザは /api/contact を通す）
revoke all on function public.contact_public_submit(text,text,text,text,text,text,text)
  from public, anon;
grant execute on function public.contact_public_submit(text,text,text,text,text,text,text)
  to service_role;

commit;

-- PostgREST のスキーマキャッシュを読み直す（権限の変更を反映させる）
notify pgrst, 'reload schema';
