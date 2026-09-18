-- ============================================================
-- 8ECトップ／8RENT 公開用の共通カタログと、本番に未適用だった8RENT・商品画像・
-- 楽天連携の関数をまとめて当てる migration
--
--   背景：本番Supabaseは setup.sql 全体を再実行しない運用のため、
--   §28〜30（8RENT・商品説明/画像/スペック列・楽天連携）が未適用のままだった
--   （rental_enabled / image_url / cpu 列、inv_rental_catalog、inv_rental_request、
--    inv_sale_reserve などが本番に存在しない）。この状態では /rental/ は
--   inv_rental_catalog が無く表示できない。
--
--   このファイルは setup.sql 全体ではなく、次の内容だけを本番SQL Editorに
--   貼って実行するためのものです。何度実行しても安全です。
--
--   1. inv_item_op に '予約解除' を追加（楽天等の販売予約を発送前に戻す）
--   2. 8RENT：商品マスタのレンタル設定列、inv_product_rental_set、
--      inventory_rental_requests、inv_reserve_available_item、inv_rental_request、
--      inv_rental_set_status、inv_sale_reserve
--   3. 商品説明・画像（image_url / images）・スペック列（cpu 等）
--   4. 楽天連携の関数（inv_rakuten_apply_one / inv_rakuten_sync_apply /
--      inv_rakuten_link_confirm。列が揃った状態で入れ直す）
--   5. inv_rental_catalog（8RENT用。楽天から補完した一般情報にも対応）
--   6. 【新規】inv_public_catalog：8ECトップと8RENTが共通で読む公開ビュー。
--      販売（楽天に出品中で掲載URLがある）またはレンタル（rental_enabled）で
--      実際に提供している商品だけを出し、提供可能数は status='在庫' の個体数。
--      シリアル・仕入価格・利用者・内部メモは含めない。
--   7. 【新規】inv_product_images_set：/zaiko から商品画像URLを登録する関数
--   8. 権限（anon は公開ビューの参照と inv_rental_request の実行だけ）
--
--   含めていないもの：setup.sql §29-6 の旧レンタル表（rental_items / rental_orders）の
--   削除。データが消える操作なので、この migration では行わない。
-- ============================================================

-- ------------------------------------------------------------
-- 1) inv_item_op（'予約解除' を含む最新版）
-- ------------------------------------------------------------
create or replace function public.inv_item_op(
  p_item_id text,
  p_action  text,
  p_value   text default null,
  p_note    text default null
) returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  it       public.inventory_items;
  actor    text := public.inv_actor();
  v_before text;
  v_after  text;
  st_id    bigint;
  v_sold   numeric;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  if p_action = '貸出' then
    if coalesce(p_value,'') = '' then raise exception '利用者を選んでください'; end if;
    if it.status <> '在庫' then raise exception '「在庫」のものだけ貸し出せます（いまは %）', it.status; end if;
    v_before := it.status;
    v_after  := '貸出中（' || p_value || '）';
    update public.inventory_items
       set status='貸出中', user_name=p_value, loaned_at=now()
     where id=p_item_id returning * into it;
    insert into public.inventory_loans (item_id, user_name, actor) values (p_item_id, p_value, actor);

  elsif p_action = '返却' then
    if it.status <> '貸出中' then raise exception '貸出中のものだけ返却できます（いまは %）', it.status; end if;
    v_before := '貸出中（' || coalesce(it.user_name,'') || '）';
    v_after  := '在庫（' || public.inv_location_path(it.location_id) || '）';
    update public.inventory_items
       set status='在庫', user_name=null, loaned_at=null
     where id=p_item_id returning * into it;
    update public.inventory_loans set returned_at=now()
     where item_id=p_item_id and returned_at is null;

  elsif p_action = '移動' then
    if coalesce(p_value,'') = '' then raise exception '移動先を選んでください'; end if;
    v_before := public.inv_location_path(it.location_id);
    v_after  := public.inv_location_path(p_value);
    update public.inventory_items set location_id=p_value where id=p_item_id returning * into it;

  elsif p_action = '社内使用' then
    v_before := it.status;
    v_after  := '社内使用' || coalesce('（' || nullif(p_value,'') || '）', '');
    update public.inventory_items
       set status='社内使用', user_name=nullif(p_value,''), loaned_at=null
     where id=p_item_id returning * into it;

  elsif p_action = '売却' then
    -- 実際に売れた価格を受け取る。原価と突き合わせて利益が出せる。
    -- 原価が入っていない（0）ものは、売値をそのまま利益と書くと嘘になるので利益は出さない
    v_sold := nullif(regexp_replace(coalesce(p_value,''), '[^0-9.-]', '', 'g'), '')::numeric;
    v_before := it.status;
    v_after  := '売却済'
                || coalesce('（' || to_char(v_sold, 'FM9,999,999,999') || '円'
                   || case when coalesce(it.cost,0) > 0
                        then '／利益 ' || to_char(v_sold - it.cost, 'FM9,999,999,999') || '円'
                        else '' end || '）', '');
    update public.inventory_items
       set status='売却済', sold_price=coalesce(v_sold, it.sold_price), user_name=null, loaned_at=null
     where id=p_item_id returning * into it;

  elsif p_action = '予約解除' then
    -- 楽天など販売チャネルの受注確保（inv_sale_reserve）を、発送前に取り消す。
    -- 8RENTの予約中はここでは扱わない（inv_rental_set_status の「キャンセル」を使う）
    if it.status <> '販売予約' then
      raise exception '販売予約中のものだけ予約解除できます（いまは %）', it.status;
    end if;
    v_before := it.status;
    v_after  := '在庫';
    update public.inventory_items set status='在庫' where id=p_item_id returning * into it;

  elsif p_action in ('状態変更','廃棄') then
    if p_action = '廃棄' and not public.inv_is_admin() then
      raise exception '廃棄は管理者だけができます';
    end if;
    v_before := it.status;
    v_after  := case when p_action='廃棄' then '廃棄' else coalesce(p_value, it.status) end;
    update public.inventory_items
       set status = v_after,
           user_name = case when v_after in ('貸出中','社内使用') then it.user_name else null end,
           loaned_at = case when v_after = '貸出中' then it.loaned_at else null end
     where id=p_item_id returning * into it;

  elsif p_action = '棚卸確認' then
    v_before := it.status;
    v_after  := it.status || '（確認済み）';
    update public.inventory_items set last_checked_at=now() where id=p_item_id returning * into it;
    select id into st_id from public.inventory_stocktakes where status='open' limit 1;
    if st_id is not null then
      insert into public.inventory_stocktake_items (stocktake_id, item_id, expected, checked_at)
      values (st_id, p_item_id, true, now())
      on conflict (stocktake_id, item_id) do update set checked_at = excluded.checked_at;
    end if;

  else
    raise exception '知らない操作です（%）', p_action;
  end if;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (actor, 'item', p_item_id, it.name,
          case p_action when '廃棄' then '廃棄' else p_action end,
          v_before, v_after || coalesce('／' || nullif(p_note,''), ''));

  return it;
end $$;

-- ------------------------------------------------------------
-- 2) 8RENT（setup.sql §29-1〜29-4b）
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- 29-1) 商品マスタにレンタル設定を追加
-- ------------------------------------------------------------
alter table public.inventory_products add column if not exists rental_enabled     boolean default false;
alter table public.inventory_products add column if not exists rental_price_month numeric;         -- 月額料金
alter table public.inventory_products add column if not exists rental_min_months  integer default 1; -- 最低利用期間（月）
alter table public.inventory_products add column if not exists office_supported   boolean default false; -- Office対応
alter table public.inventory_products add column if not exists trial_eligible     boolean default false; -- お試し対象
alter table public.inventory_products add column if not exists rental_tags        text[] default '{}'; -- 'recommend' / 'new' / 'popular' など
alter table public.inventory_products add column if not exists rental_description text;             -- 8RENT公開用の説明文
alter table public.inventory_products add column if not exists rental_image_url   text;             -- 8RENT公開用のメイン画像
alter table public.inventory_products add column if not exists rental_images      jsonb default '[]'::jsonb; -- 複数枚（1枚目がメイン）

comment on column public.inventory_products.rental_enabled is
  'true の商品だけが8RENT（/rental/）に公開される。source of truthは/zaiko。';
comment on column public.inventory_products.rental_tags is
  '8RENTの「おすすめ商品」で使う印。レンタル可能数が0の商品はタグが付いていても表示しない。';

create index if not exists inventory_products_rental_idx
  on public.inventory_products (rental_enabled) where rental_enabled = true;

-- ------------------------------------------------------------
-- 29-1b) 商品のレンタル設定を変える（/zaiko の商品詳細から）
--        値を変える操作は必ず関数を通す、という既存の方針にそろえる。
--        rental_enabled が変わったときだけ履歴に残す（価格の打ち直しで埋まらないように）
-- ------------------------------------------------------------
create or replace function public.inv_product_rental_set(
  p_code         text,
  p_enabled      boolean,
  p_price_month  numeric default null,
  p_min_months   integer default 1,
  p_office       boolean default false,
  p_trial        boolean default false,
  p_tags         text[] default '{}',
  p_description  text default null,
  p_image_url    text default null
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr public.inventory_products;
  v_before text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into pr from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  v_before := case when pr.rental_enabled then '公開中' else '非公開' end;

  update public.inventory_products set
    rental_enabled      = coalesce(p_enabled, false),
    rental_price_month  = p_price_month,
    rental_min_months   = coalesce(p_min_months, 1),
    office_supported    = coalesce(p_office, false),
    trial_eligible      = coalesce(p_trial, false),
    rental_tags         = coalesce(p_tags, '{}'),
    rental_description  = nullif(btrim(coalesce(p_description,'')), ''),
    rental_image_url    = nullif(btrim(coalesce(p_image_url,'')), '')
  where code = p_code
  returning * into pr;

  if v_before <> (case when pr.rental_enabled then '公開中' else '非公開' end) then
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'product', p_code, coalesce(pr.name, pr.model), '8RENT公開設定',
            v_before, case when pr.rental_enabled then '公開中' else '非公開' end);
  end if;

  return pr;
end $$;

comment on function public.inv_product_rental_set is
  '商品の8RENT向け設定（公開・月額・最低利用期間・Office対応・お試し対象・おすすめタグ・説明・画像）をまとめて入れ直す。';

-- ------------------------------------------------------------
-- 29-2) レンタル申込（8RENT公開ページからの問い合わせ・申込）
-- ------------------------------------------------------------
create table if not exists public.inventory_rental_requests (
  id            bigint generated by default as identity primary key,
  product_code  text not null references public.inventory_products(code) on delete cascade,
  item_id       text references public.inventory_items(id) on delete set null, -- 割り当てた実物1台
  customer_name text not null,
  company       text,
  email         text,
  phone         text,
  start_date    date,          -- 希望開始日
  months        integer,       -- 希望利用月数
  message       text,          -- お問い合わせ内容
  status        text not null default '申込',  -- 申込 / 貸出中 / 返却済み / キャンセル
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists inventory_rental_requests_status_idx
  on public.inventory_rental_requests (status, created_at desc);
create index if not exists inventory_rental_requests_item_idx
  on public.inventory_rental_requests (item_id);

comment on table public.inventory_rental_requests is
  '8RENTからのレンタル申込。個体の割り当ては申込時にRPCが自動で行い、以後の状態変更も個体と同じ行で追える。';

drop trigger if exists inventory_rental_requests_touch on public.inventory_rental_requests;
create trigger inventory_rental_requests_touch before update on public.inventory_rental_requests
  for each row execute function public.inv_touch();

-- ------------------------------------------------------------
-- 29-2b) 在庫確保の共通処理（8RENTのレンタル予約と、楽天などの販売予約が共用する）
--
--     楽天で売れたら8RENTで借りられなくなり、8RENTで借りられたら楽天で売れなくなる、
--     を保証するための唯一の入口。「status='在庫' の個体を1台、行ロックして
--     指定の状態にする」だけを行い、呼び出し元固有の記録（申込テーブルへのinsert・
--     出品情報の更新など）は行わない。同じ商品コードに対して2つの経路
--     （inv_rental_request と inv_sale_reserve）が同時に呼ばれても、
--     for update skip locked により在庫1台につきどちらか一方しか成功しない。
--
--     権限チェックはしない（anon から呼ばれる inv_rental_request 経由の
--     利用があるため）。呼び出し元の関数が権限確認を行うこと。
--     直接RPCとしては公開しない（grantしない）。
-- ------------------------------------------------------------
create or replace function public.inv_reserve_available_item(
  p_code       text,
  p_new_status text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item_id text;
begin
  select id into v_item_id
    from public.inventory_items
   where product_code = p_code and status = '在庫'
   order by id
   limit 1
   for update skip locked;

  if v_item_id is not null then
    update public.inventory_items set status = p_new_status where id = v_item_id;
  end if;

  return v_item_id;
end $$;

comment on function public.inv_reserve_available_item is
  '在庫（status=''在庫''）の個体を1台、行ロックして指定の状態にする。無ければNULL。
   8RENTの申込（予約中にする）と楽天等の販売予約（販売予約にする）が、
   同じ実在庫を安全に取り合うための共通処理。';

-- ------------------------------------------------------------
-- 29-3) 申込を受け付ける（公開ページから anon が呼ぶ）
--       在庫の個体を1台、申込と同じトランザクションで「予約中」にする。
--       これをしないと、ほぼ同時の2件の申込で同じ1台が二重に割り当たる。
-- ------------------------------------------------------------
create or replace function public.inv_rental_request(
  p_code    text,
  p_name    text,
  p_company text default null,
  p_email   text default null,
  p_phone   text default null,
  p_start   date default null,
  p_months  integer default null,
  p_message text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_item_id text;
  v_req_id  bigint;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'お名前を入力してください';
  end if;
  if not exists (select 1 from public.inventory_products where code = p_code and rental_enabled = true) then
    raise exception 'この商品は現在レンタルを受け付けていません';
  end if;

  -- 在庫の個体を1台、行ロックして予約中にする（楽天の販売予約と共通の処理を使う。
  -- 管理番号の若いものから）
  v_item_id := public.inv_reserve_available_item(p_code, '予約中');

  if v_item_id is null then
    raise exception 'あいにく、この商品はいまレンタルできる台数がありません';
  end if;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values ('8RENT', 'item', v_item_id,
          (select coalesce(name, model) from public.inventory_products where code = p_code),
          '予約', '在庫', '予約中（' || btrim(p_name) || '）');

  insert into public.inventory_rental_requests
    (product_code, item_id, customer_name, company, email, phone, start_date, months, message, status)
  values
    (p_code, v_item_id, btrim(p_name), nullif(btrim(coalesce(p_company,'')),''),
     nullif(btrim(coalesce(p_email,'')),''), nullif(btrim(coalesce(p_phone,'')),''),
     p_start, p_months, nullif(btrim(coalesce(p_message,'')),''), '申込')
  returning id into v_req_id;

  return jsonb_build_object('request_id', v_req_id, 'item_id', v_item_id);
end $$;

comment on function public.inv_rental_request is
  '8RENT公開ページからのレンタル申込。在庫の個体を1台その場で予約中にし、申込を記録する。anonが実行する唯一の書き込み経路。';

-- ------------------------------------------------------------
-- 29-4) 申込の状態を進める（社内・/zaiko側の操作）
--       申込に紐づく個体の状態も、同じトランザクションで連動させる。
--         貸出中   … 発送した（個体: 予約中 → 貸出中）
--         返却済み … 戻ってきた（個体: 貸出中 → 在庫）
--         キャンセル … 申込を取り消す（個体: 予約中 → 在庫）
-- ------------------------------------------------------------
create or replace function public.inv_rental_set_status(
  p_request_id bigint,
  p_status     text
) returns public.inventory_rental_requests
language plpgsql security invoker set search_path = public as $$
declare
  r  public.inventory_rental_requests;
  it public.inventory_items;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  -- 「申込」へ戻す操作は無い（最初の1回だけ inv_rental_request() がその状態で作る）。
  -- ここで受け付けるのは、そこから先へ進む3つの操作だけ
  if p_status not in ('貸出中','返却済み','キャンセル') then
    raise exception '知らない状態です（%）', p_status;
  end if;

  select * into r from public.inventory_rental_requests where id = p_request_id for update;
  if not found then
    raise exception '申込が見つかりません（%）', p_request_id;
  end if;
  -- 返却済み・キャンセルは終端の状態。そこからは何もできない
  if r.status in ('返却済み','キャンセル') then
    raise exception 'この申込はすでに「%」で終わっています', r.status;
  end if;

  if r.item_id is not null then
    select * into it from public.inventory_items where id = r.item_id for update;
  end if;

  if p_status = '貸出中' then
    if it.id is null or it.status <> '予約中' then
      raise exception '予約中の個体だけ貸出中にできます（いまは %）', coalesce(it.status, '個体なし');
    end if;
    update public.inventory_items
       set status = '貸出中', user_name = r.customer_name, loaned_at = now()
     where id = it.id;

  elsif p_status = '返却済み' then
    if it.id is null or it.status <> '貸出中' then
      raise exception '貸出中の個体だけ返却済みにできます（いまは %）', coalesce(it.status, '個体なし');
    end if;
    update public.inventory_items
       set status = '在庫', user_name = null, loaned_at = null
     where id = it.id;

  elsif p_status = 'キャンセル' then
    -- キャンセルは「発送前」だけ。発送済み（貸出中）はキャンセルではなく返却済みで扱う
    if it.id is null or it.status <> '予約中' then
      raise exception '予約中の個体だけキャンセルできます（発送済みは「返却済みにする」を使ってください。いまは %）',
        coalesce(it.status, '個体なし');
    end if;
    update public.inventory_items set status = '在庫' where id = it.id;
  end if;

  if it.id is not null then
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'item', it.id, r.customer_name, 'レンタル' || p_status, r.status, p_status);
  end if;

  update public.inventory_rental_requests set status = p_status where id = p_request_id
  returning * into r;

  return r;
end $$;

comment on function public.inv_rental_set_status is
  'レンタル申込の状態を進める。紐づく個体の状態（予約中・貸出中・在庫）も同じトランザクションで連動させる。';

-- ------------------------------------------------------------
-- 29-4b) 楽天など販売チャネルの受注で在庫を確保する（社内・/zaiko側の操作）
--
--     楽天RMSにはまだAPI連携がなく、受注はスタッフが楽天の管理画面を見て
--     手動でこの関数を呼ぶ運用になる（自動化にはRMS WEB SERVICEのAPI利用が必要）。
--     在庫の確保自体は inv_reserve_available_item() で8RENTと共通処理にするため、
--     同じ商品の最後の1台に楽天注文と8RENT申込がほぼ同時に来ても、
--     どちらか一方しか成功しない。
--
--     状態の流れ：在庫 → 販売予約 →（発送）→ 売却済（既存の inv_item_op の
--     '売却' をそのまま使う。'売却' はどの状態からでも実行できるため変更不要）
--                              →（発送前キャンセル）→ 在庫（inv_item_op の '予約解除'）
-- ------------------------------------------------------------
create or replace function public.inv_sale_reserve(
  p_code    text,
  p_channel text,
  p_ref     text default null,
  p_note    text default null
) returns public.inventory_items
language plpgsql security definer set search_path = public as $$
declare
  v_item_id text;
  it        public.inventory_items;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if coalesce(btrim(p_channel), '') = '' then
    raise exception '販売サイトを指定してください';
  end if;

  v_item_id := public.inv_reserve_available_item(p_code, '販売予約');
  if v_item_id is null then
    raise exception 'あいにく、この商品はいま販売できる在庫がありません';
  end if;

  select * into it from public.inventory_items where id = v_item_id;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', v_item_id, it.name, '販売予約', '在庫',
          p_channel || coalesce('（注文番号: ' || nullif(btrim(p_ref), '') || '）', ''));

  -- 出品先（チャネル）にも受注状況を残す。同じ個体・チャネルの行が既にあれば更新
  insert into public.inventory_channels (product_code, item_id, channel, state, sku, note, updated_at)
  values (p_code, v_item_id, p_channel, '受注確定', nullif(btrim(coalesce(p_ref,'')),''),
          nullif(btrim(coalesce(p_note,'')),''), now())
  on conflict (item_id, channel) where item_id is not null
  do update set state = excluded.state,
                sku   = coalesce(excluded.sku, public.inventory_channels.sku),
                note  = coalesce(excluded.note, public.inventory_channels.note),
                updated_at = now();

  return it;
end $$;

comment on function public.inv_sale_reserve is
  '楽天などモールで受注が入ったとき、在庫の個体を1台その場で「販売予約」にする。
   inv_reserve_available_item() を使うため、8RENTの予約と同じ実在庫を取り合っても
   二重に確保されない。RMS WEB SERVICE等のAPI連携が無い間は、スタッフが手動で呼ぶ。';


-- ------------------------------------------------------------
-- 3) 商品説明・画像・スペックの列（setup.sql §30）
-- ------------------------------------------------------------
alter table public.inventory_products add column if not exists description       text;       -- 一般の商品説明（8RENTでも使う。rental_descriptionは8RENT向けの上書き）
alter table public.inventory_products add column if not exists image_url         text;       -- 一般のメイン画像（rental_image_urlは8RENT向けの上書き）
alter table public.inventory_products add column if not exists images            jsonb default '[]'::jsonb;
alter table public.inventory_products add column if not exists cpu               text;
alter table public.inventory_products add column if not exists cpu_gen           text;       -- CPU世代
alter table public.inventory_products add column if not exists memory_size       text;       -- 例: '8GB'
alter table public.inventory_products add column if not exists storage_type      text;       -- SSD / HDD
alter table public.inventory_products add column if not exists storage_capacity  text;       -- 例: '256GB'
alter table public.inventory_products add column if not exists screen_size       text;       -- 例: '13.3型'
alter table public.inventory_products add column if not exists os                text;
alter table public.inventory_products add column if not exists webcam            boolean;
alter table public.inventory_products add column if not exists wifi             boolean;
alter table public.inventory_products add column if not exists bluetooth        boolean;
alter table public.inventory_products add column if not exists numpad           boolean;     -- テンキー
alter table public.inventory_products add column if not exists accessories      text;        -- 付属品
alter table public.inventory_products add column if not exists rakuten_synced_at timestamptz; -- 最後に楽天から補完した時刻

comment on column public.inventory_products.description is
  '一般の商品説明。楽天から取得した説明、または人が入力したもの。8RENTはrental_descriptionが空ならこちらを使う。';
comment on column public.inventory_products.rakuten_synced_at is
  '楽天商品APIとの照合・補完が最後に行われた時刻。nullは未連携。';

create index if not exists inventory_channels_sku_idx on public.inventory_channels (channel, sku);

-- ------------------------------------------------------------
-- 4) 楽天連携の関数（setup.sql §30-1〜30-3）
-- ------------------------------------------------------------
-- 30-1) 商品コードが決まったあとの共通処理：不足情報を埋め、楽天の出品先に紐付ける
--
--     p_item の形（Edge Functionが正規化して渡す）:
--       { item_code, item_url, shop_code, name, caption, price, image_url, images,
--         maker, model,
--         extracted: { cpu, cpu_gen, memory, storage_type, storage_capacity,
--                       screen_size, os, office_supported, webcam, wifi,
--                       bluetooth, numpad, accessories } }
--
--     呼び出し元（30-2・30-3）がすでに inv_can_edit() を確認しているが、
--     直接叩かれても困らないよう、ここでも念のため確認する。
-- ------------------------------------------------------------
create or replace function public.inv_rakuten_apply_one(
  p_code text,
  p_item jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  ex           jsonb := coalesce(p_item->'extracted', '{}'::jsonb);
  v_item_code  text  := nullif(btrim(coalesce(p_item->>'item_code','')), '');
  v_url        text  := nullif(btrim(coalesce(p_item->>'item_url','')), '');
  v_price      numeric;
  before_row   public.inventory_products;
  after_row    public.inventory_products;
  before_snap  jsonb;
  after_snap   jsonb;
  v_chan_new   boolean := false;
  v_changed    boolean;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into before_row from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  before_snap := to_jsonb(before_row) - 'updated_at' - 'rakuten_synced_at';

  v_price := nullif(p_item->>'price', '')::numeric;

  update public.inventory_products set
    maker             = coalesce(nullif(maker,''), nullif(p_item->>'maker','')),
    model             = coalesce(nullif(model,''), nullif(p_item->>'model','')),
    description       = coalesce(nullif(description,''), nullif(p_item->>'caption','')),
    image_url         = coalesce(nullif(image_url,''), nullif(p_item->>'image_url','')),
    images            = case when jsonb_array_length(coalesce(images,'[]'::jsonb)) = 0
                              and jsonb_typeof(p_item->'images') = 'array'
                         then p_item->'images' else images end,
    cpu               = coalesce(nullif(cpu,''), nullif(ex->>'cpu','')),
    cpu_gen           = coalesce(nullif(cpu_gen,''), nullif(ex->>'cpu_gen','')),
    memory_size       = coalesce(nullif(memory_size,''), nullif(ex->>'memory','')),
    storage_type      = coalesce(nullif(storage_type,''), nullif(ex->>'storage_type','')),
    storage_capacity  = coalesce(nullif(storage_capacity,''), nullif(ex->>'storage_capacity','')),
    screen_size       = coalesce(nullif(screen_size,''), nullif(ex->>'screen_size','')),
    os                = coalesce(nullif(os,''), nullif(ex->>'os','')),
    office_supported  = coalesce(office_supported, (nullif(ex->>'office_supported',''))::boolean, false),
    webcam            = coalesce(webcam, (nullif(ex->>'webcam',''))::boolean),
    wifi              = coalesce(wifi, (nullif(ex->>'wifi',''))::boolean),
    bluetooth         = coalesce(bluetooth, (nullif(ex->>'bluetooth',''))::boolean),
    numpad            = coalesce(numpad, (nullif(ex->>'numpad',''))::boolean),
    accessories       = coalesce(nullif(accessories,''), nullif(ex->>'accessories','')),
    rakuten_synced_at = now()
  where code = p_code
  returning * into after_row;

  after_snap := to_jsonb(after_row) - 'updated_at' - 'rakuten_synced_at';
  v_changed := before_snap is distinct from after_snap;

  -- 出品先（楽天）への紐付けは、商品×チャネルの掲載情報テーブルへ。
  -- 楽天のitemCodeは external_item_code に入れる（sku はスタッフ入力欄なので混同しない）。
  -- 初回だけ作る。すでにあれば external_item_code/url が空のときだけ埋める
  -- （出品状態・価格・skuなど、スタッフが手で入れた値は変えない）
  if v_item_code is not null then
    if not exists (select 1 from public.inventory_channel_listings
                    where product_code = p_code and channel = 'rakuten') then
      insert into public.inventory_channel_listings
        (product_code, channel, state, external_item_code, url, price, api_synced_at, api_sync_status, updated_at)
      values (p_code, 'rakuten', '出品中', v_item_code, v_url, v_price, now(), 'ok', now());
      v_chan_new := true;
    else
      update public.inventory_channel_listings set
        external_item_code = coalesce(external_item_code, v_item_code),
        url = coalesce(url, v_url),
        api_synced_at = now(),
        api_sync_status = 'ok',
        updated_at = case when external_item_code is null or url is null then now() else updated_at end
      where product_code = p_code and channel = 'rakuten';
    end if;
  end if;

  if v_changed or v_chan_new then
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values ('楽天連携', 'product', p_code, coalesce(after_row.name, after_row.model), '楽天連携で補完',
            null, coalesce(v_item_code, ''));
  end if;

  return jsonb_build_object('product', to_jsonb(after_row), 'changed', (v_changed or v_chan_new));
end $$;

comment on function public.inv_rakuten_apply_one is
  '楽天から取得した1商品ぶんのデータで、指定した商品コードの不足情報だけを埋める。
   すでに値が入っている列は上書きしない。実在庫（inventory_items）は作らない。';

-- ------------------------------------------------------------
-- 30-2) 楽天の商品一覧をまとめて照合・補完する（「楽天商品を同期」ボタンの本体）
--
--     商品の照合順序：
--       1. すでに紐付いている（inventory_channels に同じ楽天商品コードがある）
--       2. 型番の完全一致
--       3. メーカー＋型番
--       4. 商品名＋型番
--     候補が2件以上あるときは自動で選ばず needs_review に積む（人に選んでもらう）。
--     候補が0件のときだけ、新しい商品マスターを作る（実在庫は作らない）。
-- ------------------------------------------------------------
create or replace function public.inv_rakuten_sync_apply(p_items jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  it           jsonb;
  v_item_code  text;
  v_item_url   text;
  v_model      text;
  v_maker      text;
  v_name       text;
  v_norm_model text;
  v_code       text;
  v_candidates text[];
  v_result     jsonb;
  created      jsonb := '[]'::jsonb;
  updated      jsonb := '[]'::jsonb;
  unchanged    jsonb := '[]'::jsonb;
  needs_review jsonb := '[]'::jsonb;
  errs         jsonb := '[]'::jsonb;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_candidates := null;
    begin
      v_item_code := nullif(btrim(coalesce(it->>'item_code','')), '');
      if v_item_code is null then
        errs := errs || jsonb_build_object('item_code', it->>'item_code', 'message', '楽天商品コードがありません');
        continue;
      end if;
      v_item_url := nullif(btrim(coalesce(it->>'item_url','')), '');
      v_model := nullif(btrim(coalesce(it->>'model','')), '');
      v_maker := nullif(btrim(coalesce(it->>'maker','')), '');
      v_name  := nullif(btrim(coalesce(it->>'name','')), '');
      v_norm_model := case when v_model is not null then public.inv_norm_model(v_model) end;
      v_code := null;

      -- 1) すでに紐付いている楽天商品は再検索しない
      --    （商品×チャネルの掲載情報を external_item_code、無ければURLで引く。
      --     URLは手入力で登録されていることもあるため、末尾スラッシュ・httpsの
      --     有無・クエリ文字列の差を無視して比べる）
      select product_code into v_code
        from public.inventory_channel_listings
       where channel = 'rakuten'
         and (
           external_item_code = v_item_code
           or (
             url is not null and v_item_url is not null
             and regexp_replace(rtrim(split_part(url, '?', 1), '/'), '^https?://', '')
               = regexp_replace(rtrim(split_part(v_item_url, '?', 1), '/'), '^https?://', '')
           )
         )
       limit 1;

      -- 2) 型番の完全一致
      if v_code is null and v_norm_model is not null then
        select array_agg(code) into v_candidates
          from public.inventory_products
         where public.inv_norm_model(coalesce(nullif(model,''), name)) = v_norm_model;
      end if;

      -- 3) メーカー＋型番（部分一致。型番の表記ゆれを吸収する）
      if v_code is null and (v_candidates is null or array_length(v_candidates,1) is null)
         and v_maker is not null and v_norm_model is not null then
        select array_agg(code) into v_candidates
          from public.inventory_products
         where lower(coalesce(maker,'')) = lower(v_maker)
           and public.inv_norm_model(coalesce(nullif(model,''), name)) like '%'||v_norm_model||'%';
      end if;

      -- 4) 商品名＋型番
      if v_code is null and (v_candidates is null or array_length(v_candidates,1) is null)
         and v_name is not null and v_norm_model is not null then
        select array_agg(code) into v_candidates
          from public.inventory_products
         where name = v_name
           and public.inv_norm_model(coalesce(nullif(model,''), name)) like '%'||v_norm_model||'%';
      end if;

      if v_code is not null then
        v_result := public.inv_rakuten_apply_one(v_code, it);
        if (v_result->>'changed')::boolean then
          updated := updated || to_jsonb(v_code);
        else
          unchanged := unchanged || to_jsonb(v_code);
        end if;
      elsif v_candidates is not null and array_length(v_candidates,1) = 1 then
        v_result := public.inv_rakuten_apply_one(v_candidates[1], it);
        if (v_result->>'changed')::boolean then
          updated := updated || to_jsonb(v_candidates[1]);
        else
          unchanged := unchanged || to_jsonb(v_candidates[1]);
        end if;
      elsif v_candidates is not null and array_length(v_candidates,1) > 1 then
        needs_review := needs_review || jsonb_build_object(
          'item_code', v_item_code, 'name', v_name, 'model', v_model,
          'candidates', to_jsonb(v_candidates), 'item', it);
      else
        -- 5) 一致なし → 新しい商品マスターを作る（実在庫は作らない）
        v_code := public.inv_next_id('P', 5);
        insert into public.inventory_products (code, name, kind, maker, model)
        values (v_code, coalesce(v_name, v_model, '(名称未設定)'), 'individual', v_maker, v_model);
        perform public.inv_rakuten_apply_one(v_code, it);
        created := created || to_jsonb(v_code);
      end if;
    exception when others then
      errs := errs || jsonb_build_object('item_code', v_item_code, 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'created', created, 'updated', updated, 'unchanged', unchanged,
    'needs_review', needs_review, 'errors', errs,
    'created_count', jsonb_array_length(created), 'updated_count', jsonb_array_length(updated),
    'unchanged_count', jsonb_array_length(unchanged),
    'needs_review_count', jsonb_array_length(needs_review), 'error_count', jsonb_array_length(errs)
  );
end $$;

comment on function public.inv_rakuten_sync_apply is
  '楽天から取得した商品配列を、既存の商品マスターと照合して不足情報を補完する。
   候補が複数あるものは needs_review に積み、自動では選ばない。実在庫は作らない。';

-- ------------------------------------------------------------
-- 30-3) 候補が複数あったとき、人が選んだ商品に紐付ける
-- ------------------------------------------------------------
create or replace function public.inv_rakuten_link_confirm(
  p_code text,
  p_item jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  return public.inv_rakuten_apply_one(p_code, p_item);
end $$;

comment on function public.inv_rakuten_link_confirm is
  '「楽天商品候補を選択」で、人が選んだ商品コードに楽天商品を紐付ける。';

-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5) inv_rental_catalog（setup.sql §30-4）
-- ------------------------------------------------------------
-- 30-4) inv_rental_catalog を、楽天から補完した一般情報にも対応させる
--
--     8RENT向けの上書き（rental_description / rental_image_url）があれば
--     それを優先し、無ければ楽天等から補完した一般の説明・画像を使う。
--     8RENT側で写真・説明を再入力しなくてよいようにするため。
-- ------------------------------------------------------------
drop view if exists public.inv_rental_catalog;
create view public.inv_rental_catalog as
select
  p.code, p.name, p.model, p.maker, p.category_id, p.spec,
  p.rental_price_month, p.rental_min_months, p.office_supported, p.trial_eligible,
  p.rental_tags,
  coalesce(nullif(p.rental_description,''), p.description) as rental_description,
  coalesce(nullif(p.rental_image_url,''), p.image_url)      as rental_image_url,
  case when jsonb_array_length(coalesce(p.rental_images,'[]'::jsonb)) > 0
       then p.rental_images else coalesce(p.images,'[]'::jsonb) end as rental_images,
  p.cpu, p.cpu_gen, p.memory_size, p.storage_type, p.storage_capacity,
  p.screen_size, p.os, p.webcam, p.wifi, p.bluetooth, p.numpad, p.accessories,
  count(i.id) filter (where i.status = '在庫')                    as rental_available,
  count(i.id) filter (where i.status not in ('売却済','廃棄'))     as total_owned,
  p.updated_at
from public.inventory_products p
left join public.inventory_items i on i.product_code = p.code
where p.rental_enabled = true
group by p.code;

comment on view public.inv_rental_catalog is
  '8RENT公開ページ用。rental_enabled=true の商品だけを、レンタル可能数つきで出す。仕入価格・原価は含めない。
   説明・画像は8RENT向けの上書きが無ければ、楽天等から補完した一般情報を使う。';


-- ============================================================

-- ------------------------------------------------------------
-- 6) inv_public_catalog：8ECトップ／8RENT 共通の公開ビュー【新規】
--
--     表示項目 → 取得元：
--       商品名・型番・メーカー・カテゴリ・スペック・説明 … inventory_products
--       代表画像 image_url … image_url（人が指定したメイン画像。楽天同期は空欄だけ埋める）
--                            → 無ければ images の1枚目
--       画像一覧 images     … inventory_products.images（楽天同期・手入力）
--       8RENT用画像         … rental_image_url / rental_images（空なら一般画像）
--       提供可能数 available … inventory_items.status = '在庫' の個体数
--                            （予約中・販売予約・貸出中・修理中・故障などは含めない。
--                             8RENTのレンタル可能数と楽天の販売可能数は同じこの数）
--       レンタル可否・月額   … rental_enabled / rental_price_month / rental_min_months
--       販売可否・購入先・価格 … inventory_channel_listings（channel='rakuten'、
--                            state='出品中'、url あり）。URLは登録済みのものだけ使い、
--                            商品コードから推測生成しない
--     公開条件：kind='individual' かつ（rental_enabled または 楽天に出品中でURLあり）。
--     含めない：シリアル・仕入価格・原価・販売予定価格・利用者・備考・保管場所
-- ------------------------------------------------------------
drop view if exists public.inv_public_catalog;
create view public.inv_public_catalog as
with avail as (
  select product_code,
         count(*) filter (where status = '在庫')                 as available,
         count(*) filter (where status not in ('売却済','廃棄')) as total_owned
    from public.inventory_items
   group by product_code
),
rk as (
  select product_code, url, state, price
    from public.inventory_channel_listings
   where channel = 'rakuten'
)
select
  p.code, p.name, p.model, p.maker, p.category_id, c.name as category_name,
  p.spec, p.description,
  coalesce(nullif(p.image_url,''),
           (select x from jsonb_array_elements_text(coalesce(p.images,'[]'::jsonb)) x
             where btrim(x) <> '' limit 1))                        as image_url,
  coalesce(p.images,'[]'::jsonb)                                    as images,
  coalesce(nullif(p.rental_image_url,''), nullif(p.image_url,''),
           (select x from jsonb_array_elements_text(coalesce(p.images,'[]'::jsonb)) x
             where btrim(x) <> '' limit 1))                        as rental_image_url,
  case when jsonb_array_length(coalesce(p.rental_images,'[]'::jsonb)) > 0
       then p.rental_images else coalesce(p.images,'[]'::jsonb) end as rental_images,
  p.cpu, p.cpu_gen, p.memory_size, p.storage_type, p.storage_capacity,
  p.screen_size, p.os, p.webcam, p.wifi, p.bluetooth, p.numpad, p.accessories,
  p.office_supported,
  coalesce(a.available, 0)::integer                                 as available,
  coalesce(a.total_owned, 0)::integer                               as total_owned,
  coalesce(p.rental_enabled, false)                                 as rental_enabled,
  p.rental_price_month, p.rental_min_months, p.trial_eligible, p.rental_tags,
  coalesce(nullif(p.rental_description,''), p.description)          as rental_description,
  (rk.state = '出品中' and nullif(rk.url,'') is not null)           as sale_enabled,
  case when rk.state = '出品中' and nullif(rk.url,'') is not null then 'rakuten' end as sale_channel,
  case when rk.state = '出品中' and nullif(rk.url,'') is not null then rk.url   end as sale_url,
  case when rk.state = '出品中' and nullif(rk.url,'') is not null then rk.price end as sale_price,
  p.updated_at
from public.inventory_products p
left join public.inventory_categories c on c.id = p.category_id
left join avail a on a.product_code = p.code
left join rk on rk.product_code = p.code
where p.kind = 'individual'
  and (coalesce(p.rental_enabled, false)
       or (rk.state = '出品中' and nullif(rk.url,'') is not null));

comment on view public.inv_public_catalog is
  '8ECトップと8RENTが共通で読む公開カタログ。販売（楽天に出品中でURLあり）またはレンタル（rental_enabled）で
   提供している商品だけ。提供可能数は status=在庫 の個体数。シリアル・仕入価格・利用者・備考は含めない。';

-- ------------------------------------------------------------
-- 7) 商品画像の登録（/zaiko の商品詳細から）【新規】
--     image_url（メイン）と images（一覧）を入れ直す。人が指定した値なので、
--     楽天同期（空欄だけ埋める）はこれを上書きしない。
-- ------------------------------------------------------------
create or replace function public.inv_product_images_set(
  p_code      text,
  p_image_url text default null,
  p_images    jsonb default '[]'::jsonb
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr     public.inventory_products;
  v_imgs jsonb;
  v_main text := nullif(btrim(coalesce(p_image_url,'')), '');
  v_before integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into pr from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  v_before := jsonb_array_length(coalesce(pr.images,'[]'::jsonb)) + case when nullif(pr.image_url,'') is null then 0 else 1 end;

  -- 文字列だけ・空白を除き・順番を保つ
  select coalesce(jsonb_agg(btrim(x) order by ord), '[]'::jsonb) into v_imgs
    from jsonb_array_elements_text(case when jsonb_typeof(p_images) = 'array' then p_images else '[]'::jsonb end)
         with ordinality t(x, ord)
   where btrim(x) <> '';

  update public.inventory_products
     set image_url = v_main,
         images    = v_imgs
   where code = p_code
  returning * into pr;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code, coalesce(pr.name, pr.model), '商品画像',
          v_before || '枚', (jsonb_array_length(v_imgs) + case when v_main is null then 0 else 1 end) || '枚');
  return pr;
end $$;

comment on function public.inv_product_images_set is
  '商品のメイン画像URLと画像一覧を入れ直す（/zaiko）。公開ページは再デプロイなしで次の読み込みから反映される。';

-- ------------------------------------------------------------
-- 8) 権限
-- ------------------------------------------------------------
grant execute on function public.inv_item_op(text,text,text,text) to authenticated;
grant execute on function public.inv_rental_set_status(bigint,text) to authenticated;
grant execute on function public.inv_product_rental_set(text,boolean,numeric,integer,boolean,boolean,text[],text,text) to authenticated;
grant execute on function public.inv_sale_reserve(text,text,text,text) to authenticated;
grant execute on function public.inv_rakuten_apply_one(text,jsonb) to authenticated;
grant execute on function public.inv_rakuten_sync_apply(jsonb) to authenticated;
grant execute on function public.inv_rakuten_link_confirm(text,jsonb) to authenticated;
grant execute on function public.inv_product_images_set(text,text,jsonb) to authenticated;
-- anon（一般訪問者）には公開ビューの参照と、レンタル申込の実行だけを許可
grant usage on schema public to anon;
grant execute on function public.inv_rental_request(text,text,text,text,text,date,integer,text) to anon;
grant select on public.inv_rental_catalog to anon, authenticated;
grant select on public.inv_public_catalog to anon, authenticated;
grant select, update on public.inventory_rental_requests to authenticated;

alter table public.inventory_rental_requests enable row level security;
drop policy if exists "inventory_rental_requests read" on public.inventory_rental_requests;
create policy "inventory_rental_requests read" on public.inventory_rental_requests
  for select to authenticated using (true);
drop policy if exists "inventory_rental_requests update" on public.inventory_rental_requests;
create policy "inventory_rental_requests update" on public.inventory_rental_requests
  for update to authenticated
  using (public.inv_can_edit()) with check (public.inv_can_edit());

-- ------------------------------------------------------------
-- 確認：公開ビューの件数と、画像のある商品
-- ------------------------------------------------------------
select '公開カタログ件数' as check_name, count(*)::text as value from public.inv_public_catalog
union all
select 'うち画像あり', count(*)::text from public.inv_public_catalog where image_url is not null
union all
select 'うちレンタル対象', count(*)::text from public.inv_public_catalog where rental_enabled
union all
select 'うち楽天で購入可', count(*)::text from public.inv_public_catalog where sale_enabled;
