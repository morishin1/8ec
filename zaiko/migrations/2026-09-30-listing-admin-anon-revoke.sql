-- ============================================================
-- 出品先の管理画面まわりの関数を、anon から外す
--
--   PostgreSQL の関数は、作った時点で PUBLIC に EXECUTE が付きます。
--   PUBLIC には anon も含まれるので、revoke しないかぎり
--   ログインしていない相手からも呼べる状態になります。
--   （Phase 2 の見積関数で一度ひっかかったのと同じ話です）
--
--   いまも実害はありません。3つとも security invoker で、
--     ・関数の頭で inv_can_edit() / inv_is_admin() を見ている
--     ・anon には表への書き込み権限がない
--   ので、anon が呼んでも「操作する権限がありません」で止まります。
--   それでも、呼べること自体を残す理由がないので外します。
--
--   2026-09-29-listing-admin-search.sql はすでに main に入っているため、
--   あちらは書き換えず、follow-up としてこのファイルで直します。
-- ============================================================

revoke all on function public.inv_admin_url_check(text,text)              from public, anon;
revoke all on function public.inv_listing_admin_url_set(text,text,text)   from public, anon;
revoke all on function public.inv_channel_settings_set(text,text,text,text,text) from public, anon;

grant execute on function public.inv_admin_url_check(text,text)              to authenticated;
grant execute on function public.inv_listing_admin_url_set(text,text,text)   to authenticated;
grant execute on function public.inv_channel_settings_set(text,text,text,text,text) to authenticated;

-- 確かめかた（3つとも anon=f / authenticated=t になれば正しい）
--   select p.proname,
--          has_function_privilege('anon',          p.oid, 'execute') as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('inv_admin_url_check', 'inv_listing_admin_url_set',
--                        'inv_channel_settings_set');
