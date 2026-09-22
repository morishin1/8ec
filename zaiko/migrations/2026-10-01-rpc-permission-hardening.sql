-- ============================================================
-- public スキーマのRPC権限を、意図したところだけに絞る
--
--   PostgreSQL は関数を作った時点で PUBLIC に EXECUTE を付けます。
--   PUBLIC には anon（ログインしていない相手）も含まれるので、
--   revoke しないかぎり、社内向けの関数まで外から呼べる状態になります。
--   Phase 2 の見積関数と、今回の管理画面URLの関数で2度ひっかかったので、
--   ここで public スキーマの関数を全部見直します。
--
--   実害の有無
--     いまも書き換えられてはいません。社内向けの関数は頭で
--     inv_can_edit() / inv_is_admin() を見ていて、anon には表への
--     書き込み権限もないため、呼んでも「操作する権限がありません」で
--     止まります。ただ、呼べること自体を残す理由がないので外します。
--
--   分類（この5つで考えます）
--     A 公開読み取り     … 公開カタログが読む。anon 可
--     B 公開フォーム     … お客様が送る。原則 browser → /api/* → service_role
--     C ログイン社員向け … /zaiko から使う。authenticated だけ
--     D 管理者のみ       … C と同じ権限で、関数の中で inv_is_admin() を見る
--     E サーバーAPI専用  … service_role だけ。anon も authenticated も不可
--
--   この migration で変えるのは EXECUTE だけです。
--   表への直接の権限は1つも増やしません。
-- ============================================================

do $$
declare
  -- A 公開読み取り／B 公開フォーム：anon に残すもの（ここだけが例外）
  --   inv_model_key            公開カタログのビュー inv_public_products が中で呼ぶ。
  --                            外すと公開カタログが出なくなる
  --   inv_rental_request_create 8RENT（/rent）の申込フォーム。いまはブラウザから
  --                            直接呼んでいる。/api/* 経由へ移すのは別途
  anon_ok   text[] := array['inv_model_key', 'inv_rental_request_create'];

  -- E サーバーAPI専用：service_role だけ。anon も authenticated も呼べない
  api_only  text[] := array[
    'inv_quote_public', 'inv_quote_decide',
    'inv_contract_public', 'inv_contract_customer_confirm',
    'inv_public_access_check', 'inv_public_access_cleanup'
  ];

  -- C/D に加えて、サーバーAPIからも呼ぶもの（authenticated と service_role の両方）
  both_ok   text[] := array['inv_deal_create', 'inv_quote_no', 'inv_contract_no'];

  r record;
  n_revoked int := 0;
  n_api     int := 0;
  n_auth    int := 0;
  n_anon    int := 0;
begin
  for r in
    select p.oid, p.proname, p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'inv\_%'
     order by p.proname
  loop
    -- まず全部いったん落とす。ここから必要な role にだけ配り直す
    execute format('revoke all on function %s from public', r.sig);
    execute format('revoke all on function %s from anon', r.sig);
    execute format('revoke all on function %s from authenticated', r.sig);
    execute format('revoke all on function %s from service_role', r.sig);
    n_revoked := n_revoked + 1;

    if r.proname = any (api_only) then
      -- E サーバーAPI専用
      execute format('grant execute on function %s to service_role', r.sig);
      n_api := n_api + 1;
    else
      -- C/D ログイン社員向け・管理者向け
      execute format('grant execute on function %s to authenticated', r.sig);
      n_auth := n_auth + 1;
      if r.proname = any (both_ok) then
        execute format('grant execute on function %s to service_role', r.sig);
      end if;
      if r.proname = any (anon_ok) then
        -- A/B 公開から呼ぶもの
        execute format('grant execute on function %s to anon', r.sig);
        n_anon := n_anon + 1;
      end if;
    end if;
  end loop;

  raise notice '対象 % 件 / サーバーAPI専用 % 件 / 社員向け % 件 / うち公開にも残した % 件',
    n_revoked, n_api, n_auth, n_anon;
end $$;

-- ------------------------------------------------------------
-- 棚卸しで見つかった既存の不具合：販売サイトの設定が保存できない
--
--   inv_channel_settings_set は security invoker なのに、
--   authenticated には inventory_channel_settings の SELECT しか
--   渡していないため、管理者が保存しようとすると
--     permission denied for table inventory_channel_settings
--   になります。今回の権限整理より前（main 25fcbff）からで、
--   管理画面URLの設定は一度も保存できていませんでした。
--
--   このプロジェクトの決まりどおり、表は読み取りのままにして
--   関数側を security definer にします。中で inv_is_admin() を
--   見ているので、管理者以外は今までどおり弾かれます。
-- ------------------------------------------------------------
create or replace function public.inv_channel_settings_set(
  p_channel  text,
  p_home     text default null,
  p_template text default null,
  p_note     text default null,
  p_search   text default null
) returns public.inventory_channel_settings
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  r public.inventory_channel_settings;
  v_home   text;
  v_tpl    text;
  v_search text;
begin
  if not public.inv_is_admin() then
    raise exception '販売サイトの設定は管理者だけが変えられます';
  end if;
  v_home := public.inv_admin_url_check(p_channel, p_home);

  -- ひな形は差し替え前だと形が崩れているので、いちど埋めてから確かめる。
  -- 保存するのはひな形のまま。
  v_tpl := nullif(btrim(coalesce(p_template, '')), '');
  if v_tpl is not null then
    perform public.inv_admin_url_check(p_channel,
      replace(replace(replace(v_tpl, '{manage}', 'x'), '{sku}', 'x'), '{item_code}', 'x'));
  end if;

  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is not null then
    if position('{q}' in v_search) = 0 then
      raise exception '検索URLのひな形には、検索語が入る {q} を含めてください';
    end if;
    perform public.inv_admin_url_check(p_channel, replace(v_search, '{q}', 'x'));
  end if;

  insert into public.inventory_channel_settings
         (channel, admin_home_url, admin_item_url_template, note, admin_search_url_template)
  values (p_channel, v_home, v_tpl, nullif(btrim(coalesce(p_note, '')), ''), v_search)
  on conflict (channel) do update
    set admin_home_url            = v_home,
        admin_item_url_template   = v_tpl,
        admin_search_url_template = v_search,
        note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), public.inventory_channel_settings.note)
  returning * into r;
  return r;
end $$;

comment on function public.inv_channel_settings_set is
  '販売サイトの管理画面URL（トップ・商品ごとのひな形・検索語つきのひな形）を設定する。管理者だけ。
   表は読み取りのままにしたいので security definer。権限は関数の中の inv_is_admin() で見る。';

-- 作り直したので、権限を入れ直す（create or replace でも既定のPUBLICが付き直す）
revoke all   on function public.inv_channel_settings_set(text,text,text,text,text) from public, anon, service_role;
grant execute on function public.inv_channel_settings_set(text,text,text,text,text) to authenticated;

-- 問い合わせフォームは setup.sql ではなく admin/contact/supabase-setup.sql 側にある。
-- 2026-09-24-public-api-only.sql で service_role 専用にしてあるので、念のため確かめるだけ。
do $$
begin
  if to_regprocedure('public.contact_public_submit(text,text,text,text,text,text,text)') is null then
    raise notice 'contact_public_submit は未作成（このDBでは確認を飛ばします）';
  elsif has_function_privilege('anon',
        'public.contact_public_submit(text,text,text,text,text,text,text)'::regprocedure, 'execute') then
    raise exception 'contact_public_submit が anon から呼べます。2026-09-24-public-api-only.sql を先に流してください';
  end if;
end $$;

-- ------------------------------------------------------------
-- 確かめかた
--
--   1) anon から呼べる関数は2つだけか
--        select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--         where n.nspname='public' and p.proname like 'inv\_%'
--           and has_function_privilege('anon', p.oid, 'execute');
--      → inv_model_key と inv_rental_request_create だけ
--
--   2) サーバーAPI専用の6つが service_role だけになっているか
--        select p.proname,
--               has_function_privilege('anon',          p.oid,'execute') as anon,
--               has_function_privilege('authenticated', p.oid,'execute') as auth,
--               has_function_privilege('service_role',  p.oid,'execute') as svc
--          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--         where n.nspname='public'
--           and p.proname in ('inv_quote_public','inv_quote_decide','inv_contract_public',
--                             'inv_contract_customer_confirm','inv_public_access_check',
--                             'inv_public_access_cleanup');
--      → 3つとも f,f,t
--
--   3) 公開カタログが anon で読めるか（0行でもエラーにならなければOK）
--        set role anon; select count(*) from public.inv_public_products; reset role;
-- ------------------------------------------------------------
