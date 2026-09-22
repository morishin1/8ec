-- ============================================================
-- 8RENT の申込を、ほかの公開フォームと同じ「API経由だけ」にする
--
--   これまで /rent の申込フォームは、ブラウザから Supabase の
--   inv_rental_request_create() を直接呼んでいました。公開フォームで
--   これだけが直接RPCのまま残っていて、
--     ・/api/* の入力チェックを通らない
--     ・inv_public_access_check() の回数制限を通らない
--     ・API側にSlack通知や記録を足しても迂回できる
--   という状態でした。
--
--   これからは、見積・問い合わせ・顧客見積・顧客契約と同じ
--     ブラウザ → /api/rental-apply →（サーバー鍵）→ Supabase
--   に統一します。
--
--   この関数は「レンタルの希望を受け取る」だけで、実在庫は動かしません
--   （status = 希望受付）。個体を押さえるのは契約後の手配だけです。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 公開ブラウザからの直接呼び出しをやめる
--     社内（/zaiko）はこの関数を呼んでいないので authenticated も渡しません。
--     呼ぶのは /api/rental-apply（service_role）だけです。
-- ------------------------------------------------------------
revoke all on function public.inv_rental_request_create(
  text[],text,integer,text,text,text,date,integer,boolean,text,jsonb)
  from public, anon, authenticated;

grant execute on function public.inv_rental_request_create(
  text[],text,integer,text,text,text,date,integer,boolean,text,jsonb)
  to service_role;

-- ------------------------------------------------------------
-- 2) 回数制限の入口に rental-apply を足す
--
--     いままでも「その他」の枠（10分で外れ10回・のべ20回）が当たって
--     いましたが、名前が出てこないと意図が読めないので明示します。
--     数え方・保存内容は今までどおりで、IPは平文で持たず sha256 のみ、
--     30日より古い記録は呼ぶたびに消えます。
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
  if v_raw is null then
    return jsonb_build_object('blocked', false, 'tries', 0, 'misses', 0);
  end if;
  v_kind := left(v_kind, 16);
  v_key  := v_kind || ':' || left(v_raw, 64);

  if v_kind in ('quote-view', 'contract-view') then
    v_max_miss := 20; v_max_try := 150;
  elsif v_kind in ('quote-decide', 'contract-decide') then
    v_max_miss := 10; v_max_try := 30;
  elsif v_kind in ('rental-apply', 'form') then
    -- お客様が送るフォーム。1分あたりの上限はAPI側で見る（10回）
    v_max_miss := 10; v_max_try := 20;
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

  -- 呼ぶたびに古い記録を落とす。無期限には残さない
  delete from public.inventory_public_access
   where window_at < now() - interval '30 days';

  return jsonb_build_object(
    'blocked', (v_misses > v_max_miss or v_tries > v_max_try),
    'tries', v_tries, 'misses', v_misses, 'kind', v_kind);
end $$;

comment on function public.inv_public_access_check is
  '公開の入口へのアクセスを分単位で数え、短時間に外し続ける相手・送り続ける相手をことわる。
   入口は quote-view / quote-decide / contract-view / contract-decide / rental-apply / form。
   APIからサーバー鍵で呼ぶ。client_key はIPのsha256（IPそのものは保存しない）。
   呼ぶたびに30日より前の記録を消すので、無期限には残らない。';

-- 作り直したので権限を入れ直す（create or replace でも既定のPUBLICが付き直す）
revoke all   on function public.inv_public_access_check(text,text,boolean) from public, anon, authenticated;
grant execute on function public.inv_public_access_check(text,text,boolean) to service_role;

-- ------------------------------------------------------------
-- 3) 公開カタログが読めなくなっていたのを直す
--
--     2026-10-01 で inv_norm_model の anon EXECUTE を外しましたが、
--     公開ビュー inv_public_products が中で呼ぶ inv_model_key は
--     security invoker で、その中でさらに inv_norm_model を呼びます。
--     invoker の関数は呼んだ人の権限で中を実行するので、
--     anon が inv_norm_model を呼べないと
--       ERROR: permission denied for function inv_norm_model
--       CONTEXT: SQL function "inv_model_key" statement 1
--     になり、公開カタログの中身が取れなくなっていました。
--
--     count(*) だけだとプランナが列の計算を省くので気づけません。
--     実際に行の中身を作る（json_agg など）と出ます。
--
--     どちらも文字列を整えるだけの関数で、表には触りません。
-- ------------------------------------------------------------
grant execute on function public.inv_norm_model(text) to anon;

-- ------------------------------------------------------------
-- 確かめかた
--
--   1) 公開から呼べる inv_ 関数は inv_model_key だけになったか
--        select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--         where n.nspname='public' and p.proname like 'inv\_%'
--           and has_function_privilege('anon', p.oid,'execute');
--      → inv_model_key の1行だけ
--
--   2) 申込はサーバー鍵だけが呼べるか（f,f,t）
--        select has_function_privilege('anon', f,'execute') as anon,
--               has_function_privilege('authenticated', f,'execute') as auth,
--               has_function_privilege('service_role', f,'execute') as svc
--          from (select 'public.inv_rental_request_create(text[],text,integer,text,text,text,date,integer,boolean,text,jsonb)'::regprocedure f) t;
--
--   3) zaiko/check-rpc-permissions.sql を流して「問題なし」になること
-- ------------------------------------------------------------
