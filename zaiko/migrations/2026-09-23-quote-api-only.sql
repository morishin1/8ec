-- ============================================================
-- 47) 顧客見積APIを「サーバー経由だけ」にする（2026-09-22-quotes.sql の追補）
--
--   これまでの形
--     お客様のブラウザ → /api/quote-view・/api/quote-decide → Supabase
--     …のつもりだったが、anon に inv_quote_public / inv_quote_decide の
--     実行権限を残していた。公開鍵（sb_publishable_…）は assets/catalog.js や
--     quote.html に載っているので、顧客URL（token）を持っている人なら
--     ブラウザから Supabase を直接たたけてしまう。
--     そうすると「承認はDBに入るのに、Slack通知や今後の共通処理は素通り」になる。
--
--   これからの形
--     お客様のブラウザ → Vercel /api/*  →（サーバー鍵）→ Supabase
--     見積の関数は service_role（サーバー側）からしか呼べない。
--
--   ※ 先に Vercel へ SUPABASE_SECRET_KEY を登録し、APIを配信してから
--     このmigrationを当ててください。順番が逆だと顧客ページが一時的に開けません。
--     （手順は README「顧客見積APIはサーバー経由だけにする」に書いてあります）
--
--   在庫まわりは一切さわりません。
--   inventory_items / inv_sale_reserve() / inv_rental_allocate() /
--   inv_reserve_available_item() / 楽天連携 は変更していません。
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 47-1) お客様の乱暴なアクセスを数えておく箱
--
--     token は推測できない長さだが、数えていないと「延々と叩かれても
--     気づかない」ことになる。失敗した回数を分単位で数えて、
--     短時間に失敗が続く相手は一定時間ことわる。
--
--     IPそのものは持たない。APIが sha256 にしてから渡す。
-- ------------------------------------------------------------
create table if not exists public.inventory_quote_access (
  client_key text        not null,
  window_at  timestamptz not null,
  tries      integer     not null default 0,
  misses     integer     not null default 0,
  primary key (client_key, window_at)
);

comment on table public.inventory_quote_access is
  '顧客見積ページへのアクセス回数（分単位）。総当たりを止めるためだけに使う。
   client_key はIPのsha256で、IPそのものは保存しない。';

create index if not exists inventory_quote_access_window_idx
  on public.inventory_quote_access (window_at);

alter table public.inventory_quote_access enable row level security;
revoke all on public.inventory_quote_access from anon, authenticated;

-- ------------------------------------------------------------
-- 47-2) 数えて、行きすぎならことわる
--
--     直近10分で
--       ・見つからないtokenが 20回
--       ・または合計 150回
--     を超えたら blocked=true を返す。APIはこれを見て429を返す。
--
--     p_miss は「tokenが見つからなかった」ときだけ true。
-- ------------------------------------------------------------
create or replace function public.inv_quote_access_check(
  p_client text,
  p_miss   boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_key    text := nullif(btrim(coalesce(p_client, '')), '');
  v_win    timestamptz := date_trunc('minute', now());
  v_tries  integer;
  v_misses integer;
begin
  -- 相手が分からないときは数えようがないので素通しする（APIが必ず渡す）
  if v_key is null then
    return jsonb_build_object('blocked', false, 'tries', 0, 'misses', 0);
  end if;
  v_key := left(v_key, 64);

  insert into public.inventory_quote_access (client_key, window_at, tries, misses)
  values (v_key, v_win, 1, case when p_miss then 1 else 0 end)
  on conflict (client_key, window_at) do update
    set tries  = public.inventory_quote_access.tries + 1,
        misses = public.inventory_quote_access.misses + case when p_miss then 1 else 0 end;

  select coalesce(sum(tries), 0), coalesce(sum(misses), 0)
    into v_tries, v_misses
    from public.inventory_quote_access
   where client_key = v_key and window_at > now() - interval '10 minutes';

  -- ときどき古い行を捨てる（掃除のためだけにcronを足したくないので）
  if random() < 0.02 then
    delete from public.inventory_quote_access where window_at < now() - interval '2 hours';
  end if;

  return jsonb_build_object(
    'blocked', (v_misses >= 20 or v_tries >= 150),
    'tries',   v_tries,
    'misses',  v_misses);
end $$;

comment on function public.inv_quote_access_check is
  '顧客見積ページへのアクセスを分単位で数え、短時間に失敗が続く相手をことわる。
   APIからサーバー鍵で呼ぶ。client_key はIPのsha256（IPそのものは保存しない）。';

-- ------------------------------------------------------------
-- 47-3) 同じ操作をもう一度送られたときの扱い
--
--     お客様が2つのタブから続けて押す、通信が切れて押し直す、といったことは起きる。
--     いまは「この見積は現在お手続きいただけません（承認）」とエラーになるので、
--     同じ操作のやり直しは、何もせずに成功として返すようにする。
--       ・DBは二重に書かない（decided_at も decided_by も変えない）
--       ・返り値に already=true を入れて、APIがSlackを二重に送らないようにする
--
--     違う操作（相談したあとに承認、など）は、これまでどおりことわる。
--     担当者が新しい版を出す流れにしたいため。
--
--     ※ 在庫は、ここでも一切動かさない。
-- ------------------------------------------------------------
create or replace function public.inv_quote_decide(
  p_token   text,
  p_action  text,
  p_name    text default null,
  p_company text default null,
  p_message text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  q public.inventory_quotes;
  v_name text;
  v_done text;   -- その操作が済んだときの状態名
begin
  if p_action not in ('approve', 'consult') then
    raise exception '知らない操作です';
  end if;
  v_done := case when p_action = 'approve' then '承認' else '相談中' end;
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'お名前を入力してください';
  end if;

  select * into q from public.inventory_quotes where token = btrim(coalesce(p_token, '')) for update;
  if not found then
    raise exception 'この見積は見つかりません。担当者へお問い合わせください';
  end if;

  -- 同じ操作のやり直し：何もせずに成功として返す（二重送信・連打の受け止め）
  if q.status = v_done then
    return jsonb_build_object('ok', true, 'already', true, 'status', q.status,
                              'quote_no', public.inv_quote_no(q.deal_id, q.rev));
  end if;

  if q.status <> '提示済み' then
    raise exception 'この見積は現在お手続きいただけません（%）。担当者へお問い合わせください', q.status;
  end if;
  if q.valid_until is not null and current_date > q.valid_until then
    raise exception 'この見積は有効期限を過ぎています。担当者へお問い合わせください';
  end if;

  if p_action = 'approve' then
    update public.inventory_quotes
       set status = '承認', decided_at = now(), decided_by = v_name
     where id = q.id returning * into q;
    -- 案件は 顧客承認 → 契約準備 へ。ここでも在庫は動かさない
    update public.inventory_deals
       set status = '契約準備', actor = coalesce(actor, 'お客様')
     where id = q.deal_id;
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_name || '（お客様）', 'quote', q.id::text, public.inv_quote_no(q.deal_id, q.rev),
            '見積承認', '提示済み', '承認（契約準備へ。在庫は確保していません）');
  else
    update public.inventory_quotes
       set status = '相談中', decided_at = now(), decided_by = v_name,
           customer_message = nullif(btrim(coalesce(p_message, '')), '')
     where id = q.id returning * into q;
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_name || '（お客様）', 'quote', q.id::text, public.inv_quote_no(q.deal_id, q.rev),
            '見積の相談', '提示済み', '相談中');
  end if;

  if nullif(btrim(coalesce(p_company, '')), '') is not null then
    update public.inventory_deals
       set company = coalesce(company, btrim(p_company))
     where id = q.deal_id;
  end if;

  return jsonb_build_object('ok', true, 'already', false, 'status', q.status,
                            'quote_no', public.inv_quote_no(q.deal_id, q.rev));
end $$;

comment on function public.inv_quote_decide is
  'お客様の［この内容で進める］［内容について相談する］。進めるは契約ではなく意思表示で、
   案件は「契約準備」へ進む。**この関数は inventory_items を一切変更しない**
   （在庫の確保は、契約と支払方法が決まってから別途行う）。
   同じ操作を二度送られたときは already=true で何もせず返す。
   サーバー（service_role）からだけ呼べる。';

-- ------------------------------------------------------------
-- 47-4) 権限：顧客見積の関数は、サーバーからだけ呼べるようにする
--
--     anon（＝お客様のブラウザ）から実行権限を外す。
--     公開鍵はサイトのJSに載っているので、anon に残すと
--     /api を通さずに直接たたけてしまい、Slack通知や今後の共通処理を迂回できる。
--
--     これ以降、顧客ページは必ず
--       ブラウザ → /api/quote-view・/api/quote-decide →（サーバー鍵）→ Supabase
--     を通る。
-- ------------------------------------------------------------
--     PostgreSQL は関数を作ると PUBLIC に実行権限が付くので、
--     anon から revoke するだけでは足りない。PUBLIC ごと落としてから配り直す。
revoke all on function public.inv_quote_public(text)                     from public, anon, authenticated;
revoke all on function public.inv_quote_decide(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.inv_quote_no(bigint,integer)               from public, anon;
revoke all on function public.inv_quote_access_check(text,boolean)       from public, anon, authenticated;

--     顧客見積の関数を呼べるのはサーバー（service_role）だけにする。
grant execute on function public.inv_quote_public(text)                     to service_role;
grant execute on function public.inv_quote_decide(text,text,text,text,text) to service_role;
grant execute on function public.inv_quote_access_check(text,boolean)       to service_role;
--     見積番号を作るだけの関数は、社内画面から使うこともあるので authenticated に残す
--     （中身は 'Q-00012-2' のような文字列を組み立てるだけで、データは読まない）。
grant execute on function public.inv_quote_no(bigint,integer)               to authenticated, service_role;

commit;
