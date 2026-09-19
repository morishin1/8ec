-- ============================================================
-- 保守用の一括処理を、DB管理セッションからも実行できるようにする
--   2026-09-19（2026-09-19-rental-inquiry.sql の後に流す追補）
--
--   直すこと
--     inv_rental_text_fill() が inv_can_edit()（＝ログイン中のWebユーザーの権限）
--     だけを見ていたため、Supabase の SQL Editor から実行すると
--     auth.jwt() が空 → inv_role() が 'viewer' → 「操作する権限がありません（閲覧のみ）」
--     になっていた。SQL Editor はWebのログインを持たないので当然の結果で、
--     SQLの文法やLimitの問題ではない。
--
--   直しかた（権限チェックは外さない）
--     実行元を2通りに分けて判定する。
--       Webアプリ（PostgREST）経由 … これまでどおり権限が要る。
--                                     一括生成は全商品を書き換える保守操作なので管理者だけ
--       DB管理セッション（SQL Editor・psql など） … 許可する
--
--     見分けかたは session_user。
--       PostgREST は authenticator でDBに接続し、リクエストごとに
--       SET ROLE anon / authenticated する。つまり
--         session_user = 'authenticator'（SET ROLE では変わらない）
--         current_user = 'anon' / 'authenticated'
--       SQL Editor や psql は postgres などで直接ログインするので
--         session_user = 'postgres'
--     current_user は SECURITY DEFINER で関数所有者に変わるため判定に使わない。
--     session_user は SET ROLE でも SECURITY DEFINER でも変わらないので、
--     anon / authenticated から迂回できない。
--
--   何度流しても同じ結果になる（create or replace のみ）。
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 36-1) 実行元がDB管理セッションかどうか
--
--     true になるのは、DBへ直接ログインしているセッションだけ。
--     PostgREST 経由（anon / authenticated / service_role）は
--     session_user が authenticator なので必ず false になる。
--     ロール名は Supabase が使う固定の名前で、いずれも NOLOGIN なので
--     これらが session_user になることはないが、念のため明示的に除く。
-- ------------------------------------------------------------
create or replace function public.inv_is_db_session()
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select session_user not in ('authenticator', 'anon', 'authenticated', 'service_role');
$$;

comment on function public.inv_is_db_session is
  'DBへ直接ログインしているセッション（Supabase SQL Editor・psql など）なら true。
   PostgREST経由（anon/authenticated/service_role）は session_user が authenticator なので false。
   current_user は SECURITY DEFINER で所有者に変わるため使わない。';

-- ------------------------------------------------------------
-- 36-2) 保守操作を実行してよいか
--     Webアプリからは管理者だけ。DB管理セッションからは許可する。
-- ------------------------------------------------------------
create or replace function public.inv_can_maintain()
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select public.inv_is_db_session() or public.inv_is_admin();
$$;

comment on function public.inv_can_maintain is
  'まとめて書き換える保守操作を実行してよいか。Webアプリ（PostgREST）からは管理者だけ、
   DB管理セッション（SQL Editor・psql）からは許可する。一般メンバー・閲覧のみ・anon は不可。';

-- ------------------------------------------------------------
-- 36-3) 一括生成の権限チェックを差し替える
--     チェックは残したまま、判定を inv_can_maintain() にする。
--     更新そのものは security invoker のままなので、
--     Webからの実行では RLS と列の権限も従来どおり効く。
-- ------------------------------------------------------------
create or replace function public.inv_rental_text_fill(p_only_empty boolean default true)
returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_n integer := 0;
begin
  -- Webアプリからは管理者だけ。SQL Editor などDBへ直接つないだ保守実行は許可する
  if not public.inv_can_maintain() then
    raise exception 'レンタル説明の一括生成は管理者だけができます（いまの権限：%）', public.inv_role()
      using hint = 'Supabase の SQL Editor から実行する場合はそのまま実行できます。'
                || 'Webアプリから実行する場合は inventory_members の role を admin にしてください。';
  end if;

  update public.inventory_products p
     set rental_description = public.inv_rental_text(p.code)
   where p.kind = 'individual'
     and coalesce(p.rental_description_manual, false) = false
     and (not coalesce(p_only_empty, true)
          or nullif(btrim(coalesce(p.rental_description,'')), '') is null);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

comment on function public.inv_rental_text_fill is
  '人が直していない商品のレンタル向け説明を、自動生成で埋める。p_only_empty=false なら作り直す。
   Webアプリからは管理者だけ、Supabase SQL Editor など DB管理セッションからは保守実行できる。';

-- 実行権限はこれまでどおり authenticated だけ（anon には渡さない）。
-- 中の inv_can_maintain() が、管理者以外のWebユーザーを弾く。
revoke all on function public.inv_rental_text_fill(boolean) from public;
revoke all on function public.inv_rental_text_fill(boolean) from anon;
grant execute on function public.inv_rental_text_fill(boolean) to authenticated;

revoke all on function public.inv_is_db_session() from public;
revoke all on function public.inv_can_maintain() from public;
grant execute on function public.inv_is_db_session() to authenticated;
grant execute on function public.inv_can_maintain() to authenticated;

commit;
