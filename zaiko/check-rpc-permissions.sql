-- ============================================================
-- RPC権限の点検（selfcheck）
--
--   使いかた
--     Supabase の SQL Editor か psql でそのまま流します。
--     問題があれば ERROR で止まり、何が外れているかを出します。
--     問題が無ければ「RPC権限の点検：問題なし」とだけ出ます。
--     読むだけで、権限もデータも変えません。
--
--   なぜ要るか
--     PostgreSQL は関数を作った時点で PUBLIC に EXECUTE を付けます。
--     PUBLIC には anon（ログインしていない相手）が含まれるので、
--     revoke を書き忘れると、社内向けの関数が外から呼べる状態になります。
--     Phase 2 の見積関数と、管理画面URLの関数で2度これを踏みました。
--     新しい関数を足したあとは必ずこれを流してください。
--
--   許可リストの直しかた
--     下の anon_ok / api_only を直します。
--     anon_ok に足すのは「公開ページから直接呼ぶ必要がある」ものだけです。
--     お客様が送るフォームは browser → /api/* → service_role が原則なので、
--     ここには足しません。
-- ============================================================

do $$
declare
  -- 公開（anon）から呼んでよい関数。ここに無いのに anon が呼べたら失敗
  --   inv_model_key             公開カタログのビュー inv_public_products が中で呼ぶ
  --   inv_rental_request_create 8RENT（/rent）の申込フォーム。ブラウザから直接呼んでいる
  anon_ok  text[] := array['inv_model_key', 'inv_rental_request_create'];

  -- サーバーAPI専用。service_role だけが呼べること
  api_only text[] := array[
    'inv_quote_public', 'inv_quote_decide',
    'inv_contract_public', 'inv_contract_customer_confirm',
    'inv_public_access_check', 'inv_public_access_cleanup'
  ];

  bad text;
  n   int;
begin
  -- 1) 許可リストに無いのに anon が呼べる関数
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into bad, n
    from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public'
     and p.proname like 'inv\_%'
     and has_function_privilege('anon', p.oid, 'execute')
     and not (p.proname = any (anon_ok));
  if n > 0 then
    raise exception E'anon から呼べてはいけない関数が % 件あります：%\n'
      '  対処：zaiko/migrations に follow-up を作り、\n'
      '        revoke all on function public.<名前>(<引数>) from public, anon;\n'
      '        grant execute on function public.<名前>(<引数>) to authenticated;',
      n, bad;
  end if;

  -- 2) サーバーAPI専用なのに anon か authenticated が呼べる関数
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into bad, n
    from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public'
     and p.proname = any (api_only)
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'));
  if n > 0 then
    raise exception 'サーバーAPI専用の関数を anon か authenticated が呼べます（% 件）：%', n, bad;
  end if;

  -- 3) サーバーAPI専用なのに service_role が呼べない（APIが動かなくなる）
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into bad, n
    from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public'
     and p.proname = any (api_only)
     and not has_function_privilege('service_role', p.oid, 'execute');
  if n > 0 then
    raise exception 'サーバーAPI専用の関数を service_role が呼べません（% 件）：%', n, bad;
  end if;

  -- 4) 社内向けの関数を authenticated が呼べない（/zaiko が動かなくなる）
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into bad, n
    from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public'
     and p.proname like 'inv\_%'
     and not (p.proname = any (api_only))
     and not has_function_privilege('authenticated', p.oid, 'execute');
  if n > 0 then
    raise exception '/zaiko から呼ぶ関数を authenticated が呼べません（% 件）：%', n, bad;
  end if;

  -- 5) security definer なのに search_path を固定していない関数
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into bad, n
    from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public' and p.prosecdef and p.proconfig is null;
  if n > 0 then
    raise exception 'security definer で search_path を固定していない関数が % 件あります：%', n, bad;
  end if;

  -- 6) お客様のフォーム（問い合わせ）が anon から直接呼べていないか
  declare
    v_contact oid := to_regprocedure('public.contact_public_submit(text,text,text,text,text,text,text)');
  begin
    if v_contact is not null and has_function_privilege('anon', v_contact, 'execute') then
      raise exception 'contact_public_submit が anon から呼べます（/api/contact 経由だけにしてください）';
    end if;
  end;

  raise notice 'RPC権限の点検：問題なし';
end $$;

-- いまの状態を目で見たいとき
--   select p.proname,
--          case when p.prosecdef then 'DEFINER' else 'INVOKER' end as 実行権限,
--          has_function_privilege('anon',          p.oid,'execute') as anon,
--          has_function_privilege('authenticated', p.oid,'execute') as auth,
--          has_function_privilege('service_role',  p.oid,'execute') as svc
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname like 'inv\_%'
--    order by 1;
