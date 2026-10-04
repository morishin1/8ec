-- ============================================================
-- SNS投稿準備（Persona × Issue × Content × CTA）
--   2026-10-14
--
--   /zaiko/sns で、SNS（Instagram・X）に貼る文を用意する。
--   「PCを売るSNS」ではなく「PC調達の悩みを解決するSNS」にするため、
--   投稿ごとに 誰に（persona）・何の悩みに（issue）・どんな形で（content_type）・
--   何のために（objective）・最後に何をしてほしいか（cta）を必ず持たせる。
--
--   このmigrationでやること
--     1) ec_sns_posts        … 投稿（選んだ軸・元コンテンツ・生成した文・投稿済みの印）
--     2) ec_sns_hashtags     … ハッシュタグの候補（ここにあるものしか使わない）
--     3) ec_sns_generations  … 組み立ての記録（1日の上限を数える・誰がいつ作ったか）
--     4) トリガー           … 文を直したら「古い」と「投稿済み」を外す／
--                             軸や元コンテンツを変えたら「古い」にする
--     5) RLS                … 読めるのは管理者だけ。書き込みは /api/sns（サーバー鍵）だけ
--
--   自動投稿はしない。SNSのトークンも持たない。最終投稿は人が行う。
--   **外部のAI APIは使わない。** 投稿文のたたき台は、選んだ軸の表示名と
--   元コンテンツの見出し・説明だけから、api/_sns.js が決まった型で組み立てる。
--   APIキーを置く列も表も作らない（そもそもキーを使わない）。
--   同じSupabaseを 8sp（エイトスペース）も使っているので、表は必ず ec_sns_ で始める。
--   既存の表・関数には触れない（追加だけ）。何度実行しても安全。
-- ============================================================


-- ------------------------------------------------------------
-- 1) 投稿
--
--    persona / issue / content_type / objective / cta に入るのはキー。
--    キーと表示名の対応は assets/sns-master.js（コードで管理し、PRでレビューする）。
--    **パスワード・APIキー・トークンは1つも持たない。**
--    キーを消すと過去の投稿が読めなくなるので、使わなくなったキーも定義には残す。
-- ------------------------------------------------------------
create table if not exists public.ec_sns_posts (
  id                  uuid primary key default gen_random_uuid(),
  -- 投稿No。計測用の参照（sns-x-12 など）と、人が口頭で呼ぶ番号に使う
  post_no             integer generated always as identity,
  persona             text not null,
  issue               text not null,
  content_type        text not null,
  objective           text not null,
  cta                 text not null,
  -- 元コンテンツ。無しでも作れる（Issue解決だけの投稿）。
  --   column  … /column/<slug>.html        source_ref = slug
  --   product … 公開ビュー inv_public_products  source_ref = 商品コード
  --   page    … 許可した公開ページ           source_ref = パス（/packs/new-employee-pc など）
  source_type         text not null default 'none'
                      check (source_type in ('none', 'column', 'product', 'page')),
  source_ref          text,
  source_title        text,          -- 作ったときの見出し（元が消えても一覧で読めるように）
  source_hash         text,          -- 材料のハッシュ（元が更新されたかの判定）
  note                text,          -- 担当者の補足（伝えたい一言）
  -- 生成物
  instagram_caption   text,          -- 本文＋タグ（Instagramはリンクが押せないのでURLは入れない）
  x_caption           text,          -- 本文＋URL＋タグの完成形
  instagram_tags      text[] not null default '{}',
  x_tags              text[] not null default '{}',
  social_image        text,          -- 選んだ画像のURL（公開画像だけ）
  cta_url             text,          -- サーバーが組み立てたURL（AIには書かせない）
  generated_at        timestamptz,
  -- 何で組み立てたかの名札（いまは 'template-v1'）。キーやプロンプトは入れない
  generated_model     text,
  social_stale        boolean not null default false,
  -- 投稿済み（人が押す）
  instagram_posted_at timestamptz,
  x_posted_at         timestamptz,
  created_by_email    text,
  updated_by_email    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz    -- 物理削除はしない（計測の参照を残す）
);

create unique index if not exists ec_sns_posts_no_uniq on public.ec_sns_posts (post_no);
create index if not exists ec_sns_posts_created_idx on public.ec_sns_posts (created_at desc);

comment on table public.ec_sns_posts is
  'SNS投稿準備（/zaiko/sns）。Persona × Issue × Content × CTA を持つ投稿の下書きと、Instagram・Xの投稿済みの印。
   自動投稿はしない。書き込みは /api/sns（サーバー鍵）だけ。
   パスワード・APIキー・トークンは保存しない。';


-- ------------------------------------------------------------
-- 2) ハッシュタグの候補
--
--    ここにあるタグしか使わない（サーバーで完全一致を照合する）。
--    8sp の space_settings は使わない（同じSupabaseでも別のサービス）。
-- ------------------------------------------------------------
create table if not exists public.ec_sns_hashtags (
  tag        text primary key check (tag ~ '^#[^[:space:]#＃]+$'),
  sort_index integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.ec_sns_hashtags (tag, sort_index) values
  ('#法人PC', 10), ('#PCレンタル', 20), ('#中古PC', 30), ('#整備済みPC', 40),
  ('#IT調達', 50), ('#新入社員', 60), ('#キッティング', 70), ('#情シス', 80),
  ('#総務', 90), ('#中小企業', 100), ('#研修', 110), ('#オフィス開設', 120)
on conflict (tag) do nothing;


-- ------------------------------------------------------------
-- 3) 組み立ての記録
--
--    1日に何回作ったかを数えて上限をかける（作り直しも1回と数える）。
--    上限に当たっても、文は手で書いて保存できる。
--    投稿の行は上書きされるので、回数はここで数える。
-- ------------------------------------------------------------
create table if not exists public.ec_sns_generations (
  id           bigint generated always as identity primary key,
  post_id      uuid references public.ec_sns_posts(id) on delete set null,
  actor_email  text,
  model        text,
  ok           boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists ec_sns_generations_created_idx on public.ec_sns_generations (created_at desc);


-- ------------------------------------------------------------
-- 4) トリガー
--
--    ・文（instagram_caption / x_caption）が変わったら
--        social_stale = false（新しい文になったので古くない）
--        その文の投稿済みを外す（前の文を投稿した印を、新しい文に付けたままにしない）
--      同じ更新で posted_at を明示していれば、そちらを優先する。
--    ・軸（persona〜cta）や元コンテンツが変わったのに文が変わっていなければ
--        social_stale = true（今の文は別の人・別の悩みに向けたもの）
--    ・updated_at を進める
-- ------------------------------------------------------------
create or replace function public.ec_sns_posts_touch()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if new.instagram_caption is distinct from old.instagram_caption then
      new.social_stale := false;
      if new.instagram_posted_at is not distinct from old.instagram_posted_at then
        new.instagram_posted_at := null;
      end if;
    end if;
    if new.x_caption is distinct from old.x_caption then
      new.social_stale := false;
      if new.x_posted_at is not distinct from old.x_posted_at then
        new.x_posted_at := null;
      end if;
    end if;
    if (new.instagram_caption is not distinct from old.instagram_caption
        and new.x_caption is not distinct from old.x_caption)
       and (new.instagram_caption is not null or new.x_caption is not null)
       and (new.persona is distinct from old.persona
         or new.issue is distinct from old.issue
         or new.content_type is distinct from old.content_type
         or new.objective is distinct from old.objective
         or new.cta is distinct from old.cta
         or new.source_type is distinct from old.source_type
         or new.source_ref is distinct from old.source_ref) then
      new.social_stale := true;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ec_sns_posts_touch on public.ec_sns_posts;
create trigger ec_sns_posts_touch
  before insert or update on public.ec_sns_posts
  for each row execute function public.ec_sns_posts_touch();

revoke all on function public.ec_sns_posts_touch() from public, anon, authenticated;


-- ------------------------------------------------------------
-- 5) RLS
--
--    inventory_* は「ログインしていれば誰でも読める（using true）」だが、
--    SNSの下書きは管理者だけに絞る（倉庫メンバー・閲覧のみのログインには見せない）。
--    書き込みのポリシーは作らない＝画面から直接は書けない。/api/sns がサーバー鍵で書く
--    （役割の確認・たたき台の組み立て・URLの組み立てを必ずサーバーで通すため）。
--    判定は #51 で入った共通の L.caller()（token を Supabase に聞き、role を
--    inventory_members から読み直す）と、ここの inv_is_admin() の二重。
-- ------------------------------------------------------------
alter table public.ec_sns_posts enable row level security;
alter table public.ec_sns_hashtags enable row level security;
alter table public.ec_sns_generations enable row level security;

drop policy if exists "ec_sns_posts staff read" on public.ec_sns_posts;
create policy "ec_sns_posts staff read" on public.ec_sns_posts
  for select to authenticated using (public.inv_is_admin());

drop policy if exists "ec_sns_hashtags staff read" on public.ec_sns_hashtags;
create policy "ec_sns_hashtags staff read" on public.ec_sns_hashtags
  for select to authenticated using (public.inv_is_admin());

-- 生成の記録は画面から読まない（サーバーだけ）

revoke all on public.ec_sns_posts, public.ec_sns_hashtags, public.ec_sns_generations from public, anon;
revoke all on public.ec_sns_posts, public.ec_sns_hashtags, public.ec_sns_generations from authenticated;
grant select on public.ec_sns_posts, public.ec_sns_hashtags to authenticated;
grant all on public.ec_sns_posts, public.ec_sns_hashtags, public.ec_sns_generations to service_role;


-- ------------------------------------------------------------
-- 確認（14項目）
-- ------------------------------------------------------------
select '表が3つある' as kind,
       case when to_regclass('public.ec_sns_posts') is not null
             and to_regclass('public.ec_sns_hashtags') is not null
             and to_regclass('public.ec_sns_generations') is not null
            then 'OK' else 'NG' end as result
union all
select '表の名前は ec_sns_ で始まる（8sp と混ざらない）',
       case when (select count(*) from information_schema.tables
                   where table_schema = 'public' and table_name like 'ec\_sns\_%') = 3
            then 'OK' else 'NG' end
union all
select 'RLSが3つとも入っている',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relrowsecurity
                     and c.relname in ('ec_sns_posts','ec_sns_hashtags','ec_sns_generations')) = 3
            then 'OK' else 'NG' end
union all
select '読めるのは管理者だけ（inv_is_admin）',
       case when (select count(*) from pg_policies
                   where schemaname = 'public' and tablename = 'ec_sns_posts'
                     and cmd = 'SELECT' and qual like '%inv_is_admin%') = 1
            then 'OK' else 'NG' end
union all
select '画面から書き込むポリシーは無い',
       case when (select count(*) from pg_policies
                   where schemaname = 'public' and tablename = 'ec_sns_posts'
                     and cmd in ('INSERT','UPDATE','DELETE')) = 0
            then 'OK' else 'NG' end
union all
select 'anon は読めない',
       case when has_table_privilege('anon', 'public.ec_sns_posts', 'select')
             or has_table_privilege('anon', 'public.ec_sns_hashtags', 'select')
             or has_table_privilege('anon', 'public.ec_sns_generations', 'select')
            then 'NG anonが読める' else 'OK' end
union all
select '社員は下書きを読めるが書けない',
       case when has_table_privilege('authenticated', 'public.ec_sns_posts', 'select')
             and not has_table_privilege('authenticated', 'public.ec_sns_posts', 'insert')
             and not has_table_privilege('authenticated', 'public.ec_sns_posts', 'update')
            then 'OK' else 'NG' end
union all
select '組み立ての記録は画面から読めない',
       case when has_table_privilege('authenticated', 'public.ec_sns_generations', 'select')
            then 'NG 読めてしまう' else 'OK' end
union all
select 'サーバー鍵（service_role）は書ける',
       case when has_table_privilege('service_role', 'public.ec_sns_posts', 'insert')
             and has_table_privilege('service_role', 'public.ec_sns_posts', 'update')
            then 'OK' else 'NG' end
union all
select 'トリガーが付いている',
       case when exists (select 1 from pg_trigger
                          where tgname = 'ec_sns_posts_touch' and not tgisinternal)
            then 'OK' else 'NG' end
union all
select 'トリガー関数は直接呼べない',
       case when has_function_privilege('authenticated', 'public.ec_sns_posts_touch()', 'execute')
            then 'NG 呼べてしまう' else 'OK' end
union all
select 'パスワード・鍵を入れる列を作っていない',
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name like 'ec\_sns\_%'
                     and (column_name like '%password%' or column_name like '%secret%'
                       or column_name like '%api_key%' or column_name like '%token%')) = 0
            then 'OK' else 'NG' end
union all
select '既存の inventory_* を触っていない',
       case when (select count(*) from information_schema.tables
                   where table_schema = 'public' and table_name like 'inventory\_%') >= 10
            then 'OK' else 'NG' end
union all
select 'ハッシュタグの候補',
       (select count(*)::text from public.ec_sns_hashtags where active) || '個'
union all
select 'いまの下書き',
       (select count(*)::text from public.ec_sns_posts where archived_at is null) || '件';
