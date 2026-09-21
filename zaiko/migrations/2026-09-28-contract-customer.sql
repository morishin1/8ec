-- ============================================================
-- 52) 顧客側の契約手続き（Phase 3-d）
--
--   担当者が発行したURL /c/:token をお客様が開き、
--     契約内容を確認 → 請求先 → お届け先 → お支払い方法 → 最終確認
--   まで進められるようにする。
--
--   いちばん大事なこと
--     お客様がボタンを押しても、契約は「確定」になりません。
--     記録するのは「この内容で進めたい」という意思表示だけで、
--     担当者が /zaiko で中身を見てから［契約を確定］を押します。
--
--   この migration がしないこと
--     ・契約を確定にする
--     ・入金済みにする
--     ・手配（販売予約・レンタル割当）を始める
--     ・発送する
--     ・Stripeを呼ぶ
--   inventory_items は1行も変更しません。
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 52-1) 契約に、顧客ページ用の列を足す
--
--     顧客URLの鍵は、見積の鍵を使い回しません。契約ごとに別に発行します。
--     再発行したら前の鍵は使えなくなります。
-- ------------------------------------------------------------
alter table public.inventory_contracts
  -- 顧客ページの鍵
  add column if not exists public_token            text,
  add column if not exists public_token_issued_at  timestamptz,
  add column if not exists public_token_expires_at timestamptz,
  add column if not exists public_token_revoked_at timestamptz,
  -- お客様が「この内容で進めたい」と送ってきた記録
  add column if not exists customer_confirmed_at   timestamptz,
  add column if not exists customer_confirmed_by   text,
  add column if not exists customer_message        text,
  -- お客様が選んだ支払方法（希望）。社内の確定値 payment_method とは別に持つ
  add column if not exists requested_payment_method text,
  -- 顧客ページに出してよい支払方法（担当者が決める）
  add column if not exists allowed_payment_methods text[] not null default '{}'::text[],
  -- お届け先（発送のPhaseで使う。ここでは受け取って持っておくだけ）
  add column if not exists shipping_company     text,
  add column if not exists shipping_department  text,
  add column if not exists shipping_person      text,
  add column if not exists shipping_postal_code text,
  add column if not exists shipping_address     text,
  add column if not exists shipping_phone       text,
  add column if not exists shipping_note        text,
  add column if not exists desired_delivery_date date;

create unique index if not exists inventory_contracts_public_token_uk
  on public.inventory_contracts (public_token) where public_token is not null;

comment on column public.inventory_contracts.public_token is
  '顧客ページ /c/:token の鍵。契約ごとに1つだけ有効。再発行すると前の鍵は使えなくなる。
   見積の鍵は使い回さない。';
comment on column public.inventory_contracts.requested_payment_method is
  'お客様が顧客ページで選んだ支払方法（希望）。社内の確定値 payment_method とは別に持つ。
   担当者が中身を見てから payment_method を確定する。';
comment on column public.inventory_contracts.allowed_payment_methods is
  '顧客ページに出してよい支払方法。担当者が契約ごとに決める。
   空のときは顧客ページで選べない（担当者が先に設定する）。';
comment on column public.inventory_contracts.desired_delivery_date is
  'お客様のお届け希望日。これだけでは納期確定ではない（在庫・調達を見て担当者が確定日を案内する）。';

-- 支払方法の言葉をそろえる
alter table public.inventory_contracts drop constraint if exists inventory_contracts_req_method_chk;
alter table public.inventory_contracts add constraint inventory_contracts_req_method_chk check
  (requested_payment_method is null
   or requested_payment_method in ('カード', '請求書払い', '銀行振込'));

alter table public.inventory_contracts drop constraint if exists inventory_contracts_allowed_chk;
alter table public.inventory_contracts add constraint inventory_contracts_allowed_chk check
  (allowed_payment_methods <@ array['カード', '請求書払い', '銀行振込']::text[]);

-- ------------------------------------------------------------
-- 52-2) 顧客URLを発行する（再発行もこれ）
--
--     推測できない鍵を作る。UUIDを2つつないで記号を落とす（約154ビット）。
--     再発行すると前の鍵は上書きされるので、古いURLは開けなくなる。
-- ------------------------------------------------------------
create or replace function public.inv_contract_token_issue(
  p_id   bigint,
  p_days integer default 60
) returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c      public.inventory_contracts;
  v_days integer := greatest(coalesce(p_days, 60), 1);
  v_new  boolean;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;
  if c.status = '取消' then raise exception 'この契約は取消です'; end if;
  v_new := (c.public_token is null);

  update public.inventory_contracts
     set public_token = replace(gen_random_uuid()::text, '-', '')
                        || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
         public_token_issued_at  = now(),
         public_token_expires_at = now() + (v_days || ' days')::interval,
         public_token_revoked_at = null,
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into c;

  -- 鍵そのものは履歴に残さない（URLを知られたら誰でも開けてしまうため）
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq),
          case when v_new then '顧客URL発行' else '顧客URL再発行' end, null,
          '有効期限 ' || to_char(c.public_token_expires_at, 'YYYY-MM-DD')
            || case when v_new then '' else '（前のURLは使えなくなりました）' end);
  return c;
end $$;

comment on function public.inv_contract_token_issue is
  '顧客ページ /c/:token の鍵を発行する。再発行すると前の鍵は使えなくなる。
   鍵そのものは履歴に残さない。';

-- ------------------------------------------------------------
-- 52-3) 顧客ページが読む中身
--
--     出さないもの：原価・粗利・社内メモ・在庫数・S/N・管理番号・仕入先・
--     社内与信（credit_approved_*）・StripeのID・SupabaseのID。
--     開けない理由（取消・期限切れ・再発行済み）は伝える。
-- ------------------------------------------------------------
create or replace function public.inv_contract_public(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c       public.inventory_contracts;
  v_items jsonb;
  v_tok   text := btrim(coalesce(p_token, ''));
begin
  if length(v_tok) < 20 then
    return jsonb_build_object('found', false);
  end if;
  select * into c from public.inventory_contracts where public_token = v_tok;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  if c.public_token_revoked_at is not null then
    return jsonb_build_object('found', true, 'viewable', false, 'reason', 'revoked');
  end if;
  if c.status = '取消' then
    return jsonb_build_object('found', true, 'viewable', false, 'reason', 'cancelled');
  end if;
  if c.public_token_expires_at is not null and now() > c.public_token_expires_at then
    return jsonb_build_object('found', true, 'viewable', false, 'reason', 'expired');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', i.kind, 'name', i.name, 'spec', i.spec, 'qty', i.qty,
           'unit_price', i.unit_price, 'months', i.months, 'billing', i.billing,
           'taxable', i.taxable, 'amount', i.amount, 'note', i.note
         ) order by i.sort_no, i.id), '[]'::jsonb)
    into v_items
    from public.inventory_contract_items i where i.contract_id = c.id;

  return jsonb_build_object(
    'found', true,
    'viewable', true,
    'contract_no', public.inv_contract_no(c.deal_id, c.seq),
    'title', c.title,
    'company', c.company,
    'customer_name', c.customer_name,
    'status', c.status,
    -- お客様が入力できるのは、まだ確定していないあいだだけ
    'editable', (c.status in ('作成中', '確定') and c.customer_confirmed_at is null),
    'confirmed', (c.customer_confirmed_at is not null),
    'confirmed_at', c.customer_confirmed_at,
    -- 「契約手続きは完了しています」と出すのは、お客様が送ったあとに
    -- 担当者が契約を確定させたときだけ。まだなら「担当者が確認しています」。
    'settled', (c.status in ('履行中', '完了')
                or (c.confirmed_at is not null and c.customer_confirmed_at is not null
                    and c.confirmed_at >= c.customer_confirmed_at)),
    'contract_date', c.contract_date,
    'start_date', c.start_date,
    'end_date', c.end_date,
    'months', c.months,
    'tax_rate', c.tax_rate,
    'items', v_items,
    'totals', jsonb_build_object(
      'initial_total', coalesce(c.initial_total, 0),
      'monthly_total', coalesce(c.monthly_total, 0),
      'months', c.months,
      'monthly_period_total', coalesce(c.monthly_period_total, 0),
      'subtotal', coalesce(c.subtotal, 0),
      'tax', coalesce(c.tax, 0),
      'total', coalesce(c.total, 0)),
    'billing', jsonb_build_object(
      'company', c.billing_company, 'department', c.billing_department,
      'person', c.billing_person, 'postal_code', c.billing_postal_code,
      'address', c.billing_address, 'email', c.billing_email, 'note', c.billing_note),
    'shipping', jsonb_build_object(
      'company', c.shipping_company, 'department', c.shipping_department,
      'person', c.shipping_person, 'postal_code', c.shipping_postal_code,
      'address', c.shipping_address, 'phone', c.shipping_phone, 'note', c.shipping_note),
    'desired_delivery_date', c.desired_delivery_date,
    'allowed_payment_methods', to_jsonb(c.allowed_payment_methods),
    'requested_payment_method', c.requested_payment_method,
    'payment_terms', c.payment_terms,
    'payment_timing', c.payment_timing,
    'note', c.note,
    'customer_message', c.customer_message
  );
end $$;

comment on function public.inv_contract_public is
  '顧客ページ /c/:token が読む契約の中身。原価・粗利・社内メモ・在庫数・管理番号・
   社内与信・StripeのID・内部IDは返さない。サーバー（service_role）からだけ呼べる。';

-- ------------------------------------------------------------
-- 52-4) お客様が［この内容で契約手続きを進める］を押したとき
--
--     記録するのは「この内容で進めたい」という意思表示だけです。
--     契約の確定・入金・手配・発送・Stripeは、ここでは一切行いません。
--
--     同じ内容をもう一度送られたときは、何もせず already=true で返します。
--     違う内容で送り直されたときは、勝手に上書きせず断ります
--     （担当者がもう中身を見ているかもしれないため）。
-- ------------------------------------------------------------
create or replace function public.inv_contract_customer_confirm(
  p_token    text,
  p_name     text,
  p_billing  jsonb   default '{}'::jsonb,
  p_shipping jsonb   default '{}'::jsonb,
  p_method   text    default null,
  p_delivery date    default null,
  p_message  text    default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c      public.inventory_contracts;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_tok  text := btrim(coalesce(p_token, ''));
  v_msg  text := nullif(btrim(coalesce(p_message, '')), '');
  v_same boolean;
  g      text;   -- 空文字をNULLにするための道具
begin
  if v_name is null then
    raise exception 'お名前を入力してください';
  end if;
  select * into c from public.inventory_contracts where public_token = v_tok for update;
  if not found then
    raise exception 'このURLは無効になっています。担当者へお問い合わせください';
  end if;
  if c.public_token_revoked_at is not null then
    raise exception 'このURLは無効になっています。最新のご案内をご確認ください';
  end if;
  if c.status = '取消' then
    raise exception 'この契約手続きは取り消されています。担当者へお問い合わせください';
  end if;
  if c.public_token_expires_at is not null and now() > c.public_token_expires_at then
    raise exception 'このURLの有効期限が切れています。担当者へ新しいURLをご依頼ください';
  end if;
  if c.status not in ('作成中', '確定') then
    raise exception '契約手続きは完了しています。担当者から今後のご案内をお送りします';
  end if;

  -- 支払方法は、担当者が出してよいと決めたものだけ
  if p_method is not null then
    if not (p_method = any(c.allowed_payment_methods)) then
      raise exception 'このお支払い方法は選べません。担当者へお問い合わせください';
    end if;
  end if;

  -- 同じ内容の送り直しなら、何も書き換えずに成功として返す
  if c.customer_confirmed_at is not null then
    v_same := (coalesce(c.customer_confirmed_by, '') = coalesce(v_name, ''))
          and (coalesce(c.requested_payment_method, '') = coalesce(p_method, ''))
          and (c.desired_delivery_date is not distinct from p_delivery)
          and (coalesce(c.customer_message, '') = coalesce(v_msg, ''))
          and (coalesce(c.billing_company, '') = coalesce(nullif(btrim(coalesce(p_billing->>'company', '')), ''), ''))
          and (coalesce(c.shipping_company, '') = coalesce(nullif(btrim(coalesce(p_shipping->>'company', '')), ''), ''))
          and (coalesce(c.shipping_address, '') = coalesce(nullif(btrim(coalesce(p_shipping->>'address', '')), ''), ''));
    if v_same then
      return jsonb_build_object('ok', true, 'already', true,
        'contract_no', public.inv_contract_no(c.deal_id, c.seq));
    end if;
    raise exception 'すでに送信済みです。変更が必要な場合は担当者へご連絡ください';
  end if;

  update public.inventory_contracts
     set billing_company     = nullif(btrim(coalesce(p_billing->>'company', '')), ''),
         billing_department  = nullif(btrim(coalesce(p_billing->>'department', '')), ''),
         billing_person      = nullif(btrim(coalesce(p_billing->>'person', '')), ''),
         billing_postal_code = nullif(btrim(coalesce(p_billing->>'postal_code', '')), ''),
         billing_address     = nullif(btrim(coalesce(p_billing->>'address', '')), ''),
         billing_email       = nullif(btrim(coalesce(p_billing->>'email', '')), ''),
         billing_note        = nullif(btrim(coalesce(p_billing->>'note', '')), ''),
         shipping_company     = nullif(btrim(coalesce(p_shipping->>'company', '')), ''),
         shipping_department  = nullif(btrim(coalesce(p_shipping->>'department', '')), ''),
         shipping_person      = nullif(btrim(coalesce(p_shipping->>'person', '')), ''),
         shipping_postal_code = nullif(btrim(coalesce(p_shipping->>'postal_code', '')), ''),
         shipping_address     = nullif(btrim(coalesce(p_shipping->>'address', '')), ''),
         shipping_phone       = nullif(btrim(coalesce(p_shipping->>'phone', '')), ''),
         shipping_note        = nullif(btrim(coalesce(p_shipping->>'note', '')), ''),
         desired_delivery_date    = p_delivery,
         requested_payment_method = p_method,
         customer_confirmed_at    = now(),
         customer_confirmed_by    = v_name,
         customer_message         = v_msg,
         actor = coalesce(actor, 'お客様'), updated_at = now()
   where id = c.id
  returning * into c;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (v_name || '（お客様）', 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '顧客確認', null,
          '契約手続きを進めたいとのご連絡（契約はまだ確定していません）');
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (v_name || '（お客様）', 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '請求先更新', null,
          coalesce(c.billing_company, '（契約先と同じ）'));
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (v_name || '（お客様）', 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '納品先更新', null,
          coalesce(c.shipping_company, '（契約先と同じ）')
            || coalesce('／お届け希望日 ' || c.desired_delivery_date::text, ''));
  if c.requested_payment_method is not null then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_name || '（お客様）', 'contract', c.id::text,
            public.inv_contract_no(c.deal_id, c.seq), '支払方法希望', null,
            c.requested_payment_method || '（社内の確定はこれから）');
  end if;
  if v_msg is not null then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_name || '（お客様）', 'contract', c.id::text,
            public.inv_contract_no(c.deal_id, c.seq), '顧客メッセージ', null, left(v_msg, 200));
  end if;

  return jsonb_build_object('ok', true, 'already', false,
    'contract_no', public.inv_contract_no(c.deal_id, c.seq),
    'company', c.company, 'customer_name', v_name,
    'requested_payment_method', c.requested_payment_method,
    'desired_delivery_date', c.desired_delivery_date,
    'billing_company', c.billing_company,
    'shipping_company', c.shipping_company,
    'message', v_msg,
    'contract_id', c.id);
end $$;

comment on function public.inv_contract_customer_confirm is
  'お客様の［この内容で契約手続きを進める］。記録するのは意思表示と入力内容だけで、
   契約の確定・入金・手配・発送・Stripeは一切行わない（inventory_items も変更しない）。
   同じ内容の送り直しは already=true。違う内容の送り直しは断る。';

-- ------------------------------------------------------------
-- 52-5) 顧客ページの入口も、回数を数える対象にする
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
   入口は quote-view / quote-decide / contract-view / contract-decide / form。
   APIからサーバー鍵で呼ぶ。client_key はIPのsha256（IPそのものは保存しない）。
   呼ぶたびに30日より前の記録を消すので、無期限には残らない。';

-- ------------------------------------------------------------
-- 52-6) 出してよい支払方法を、担当者が決める
-- ------------------------------------------------------------
create or replace function public.inv_contract_allowed_methods_set(
  p_id      bigint,
  p_methods text[]
) returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts; v text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  foreach v in array coalesce(p_methods, '{}'::text[]) loop
    if v not in ('カード', '請求書払い', '銀行振込') then
      raise exception '知らない支払方法です（%）', v;
    end if;
  end loop;

  update public.inventory_contracts
     set allowed_payment_methods = coalesce(p_methods, '{}'::text[]),
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into c;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '顧客ページの支払方法', null,
          case when coalesce(array_length(c.allowed_payment_methods, 1), 0) = 0
               then '（未設定）' else array_to_string(c.allowed_payment_methods, '・') end);
  return c;
end $$;

comment on function public.inv_contract_allowed_methods_set is
  '顧客ページに出してよい支払方法を決める。ここに入れたものだけがお客様に見える。';

-- ------------------------------------------------------------
-- 52-7) 権限
--
--     顧客向けの関数は、サーバー（service_role）からだけ呼べるようにする。
--     ブラウザの公開鍵（anon）はサイトのJSに載っているので、
--     残すと /api を通さずに直接たたけてしまう。
-- ------------------------------------------------------------
revoke all on function public.inv_contract_public(text)                     from public, anon, authenticated;
revoke all on function public.inv_contract_customer_confirm(text,text,jsonb,jsonb,text,date,text)
  from public, anon, authenticated;
revoke all on function public.inv_contract_token_issue(bigint,integer)      from public, anon;
revoke all on function public.inv_contract_allowed_methods_set(bigint,text[]) from public, anon;

grant execute on function public.inv_contract_public(text)                  to service_role;
grant execute on function public.inv_contract_customer_confirm(text,text,jsonb,jsonb,text,date,text)
  to service_role;
grant execute on function public.inv_contract_token_issue(bigint,integer)      to authenticated;
grant execute on function public.inv_contract_allowed_methods_set(bigint,text[]) to authenticated;

commit;

notify pgrst, 'reload schema';
