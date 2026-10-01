-- ============================================================
-- SNS投稿準備（ec_sns_*）の点検（selfcheck）
--
--   使いかた
--     2026-10-10-sns-posts.sql を実行したあと、Supabase の SQL Editor で流します。
--     最後に rollback するので、データも権限も変えません。
--     問題があれば ERROR で止まり、何が外れているかを出します。
--     問題が無ければ「SNS投稿の点検：問題なし」とだけ出ます。
--
--   確かめること
--     ・文を直すと、その文の「投稿済み」だけが外れる
--     ・選んだ軸を変えたのに文がそのままなら「古い」になる
--     ・管理者（admin）は読めるが、画面から直接は書けない
--     ・倉庫メンバー（member）・閲覧（viewer）・anon には下書きが見えない（SNS投稿は管理者だけ）
-- ============================================================
begin;

-- 点検用の3人（rollback で消える）
insert into public.inventory_members (email, display_name, role) values
  ('sns-check-admin@example.invalid', '点検（管理者）', 'admin'),
  ('sns-check-member@example.invalid', '点検（倉庫メンバー）', 'member'),
  ('sns-check-viewer@example.invalid', '点検（閲覧）', 'viewer')
on conflict (email) do nothing;

do $$
declare r record; n int; pid uuid;
begin
  set local role service_role;
  insert into public.ec_sns_posts (persona, issue, content_type, objective, cta, x_caption, instagram_caption, note)
    values ('hr_recruit', 'new_hire_pc', 'issue', 'inquiry', 'quote', 'X1', 'IG1', 'sns-check')
    returning id into pid;
  update public.ec_sns_posts set x_posted_at = now(), instagram_posted_at = now() where id = pid;
  update public.ec_sns_posts set x_caption = 'X2' where id = pid;
  select * into r from public.ec_sns_posts where id = pid;
  if r.x_posted_at is not null then raise exception 'X の文を直しても X済 が残りました（トリガー ec_sns_posts_touch）'; end if;
  if r.instagram_posted_at is null then raise exception 'X の文を直したら Instagram済 まで外れました'; end if;
  update public.ec_sns_posts set persona = 'general_affairs' where id = pid;
  select * into r from public.ec_sns_posts where id = pid;
  if not r.social_stale then raise exception '軸を変えても「古い」になりません'; end if;
  reset role;

  perform set_config('request.jwt.claims', '{"email":"sns-check-admin@example.invalid"}', true);
  set local role authenticated;
  select count(*) into n from public.ec_sns_posts where id = pid;
  if n <> 1 then raise exception '管理者（admin）が下書きを読めません'; end if;
  begin
    update public.ec_sns_posts set note = 'x' where id = pid;
    raise exception '画面（authenticated）から直接書けてしまいます。書き込みは /api/sns だけのはずです';
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims', '{"email":"sns-check-member@example.invalid"}', true);
  set local role authenticated;
  select count(*) into n from public.ec_sns_posts where id = pid;
  if n <> 0 then raise exception '倉庫メンバー（member）に下書きが見えます（SNS投稿は管理者だけ）'; end if;
  select count(*) into n from public.ec_sns_hashtags;
  if n <> 0 then raise exception '倉庫メンバー（member）にハッシュタグ候補が見えます'; end if;
  reset role;

  perform set_config('request.jwt.claims', '{"email":"sns-check-viewer@example.invalid"}', true);
  set local role authenticated;
  select count(*) into n from public.ec_sns_posts where id = pid;
  if n <> 0 then raise exception '閲覧（viewer）に下書きが見えます'; end if;
  reset role;

  set local role anon;
  begin
    perform 1 from public.ec_sns_posts limit 1;
    raise exception 'anon（ログインしていない相手）が ec_sns_posts を読めます';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'SNS投稿の点検：問題なし';
end $$;

rollback;
