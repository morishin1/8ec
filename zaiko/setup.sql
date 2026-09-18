-- ============================================================
-- QRコード在庫・備品管理  セットアップ  ―― 8ec.jp/zaiko/
--
--   Supabase ダッシュボード → SQL Editor に「このファイルの中身をすべて」
--   貼り付けて Run してください。何度実行しても安全です。
--
--   これは「社内のPC・IT機器・備品・消耗品」を管理する仕組みです。
--   併せて、実在庫（個体）を基準に「販売（楽天など）」と「レンタル（8RENT）」
--   を同じ在庫で連動させる基盤でもあります（在庫確保の共通処理は下記
--   inv_reserve_available_item() を参照）。
--   /admin/ の ec_items、/admin/ec/ の ec_products（新品SKUのモール出品用の
--   独自在庫）はまだ別スキーマのままで、このファイルからは触れません。
--
--   作られるもの
--     inventory_members         使う人と権限（管理者／一般／閲覧）
--     inventory_categories      カテゴリと採番プレフィックス
--     inventory_locations       保管場所（拠点 → 部屋 → 棚 の階層）
--     inventory_items           個体管理（1行＝現物1台。管理番号がQRのキー）
--     inventory_products        数量管理（1行＝1品目。数が増減する）
--     inventory_channels        個体×販売チャネル（実物1台ごとの出品状態）
--     inventory_channel_listings 商品×販売チャネル（1つのURL・価格を
--                               複数の個体が共有する「掲載」情報。楽天等）
--     inventory_rental_requests 8RENT（自社在庫のレンタル公開）への申込
--     inventory_transactions    履歴（追記のみ。更新も削除もしない）
--     inventory_loans           貸出
--     inventory_stocktakes      棚卸セッション
--     inventory_stocktake_items 棚卸の確認状況
--     inventory_counters        採番カウンタ
--
--   操作用の関数（画面から直接UPDATEせず、必ずこれを通す）
--     inv_item_op()        貸出／返却／移動／状態変更／廃棄／予約解除／棚卸確認
--     inv_listing_set()    出品情報を入れ直す（個体1台ならinventory_channels、
--                          商品まるごとならinventory_channel_listingsに書く）
--     inv_reserve_available_item() 在庫の個体を1台確保する共通処理（下の2つが使う）
--     inv_rental_request()    8RENTからのレンタル申込（在庫を1台その場で予約中にする）
--     inv_rental_set_status() レンタル申込の状態を進める（個体の状態も連動）
--     inv_sale_reserve()      楽天など販売チャネルの受注で在庫を1台販売予約にする
--     inv_rakuten_sync_apply() 楽天から取得した商品をinventory_productsと照合・補完
--     inv_product_move()   入庫／出庫
--     inv_product_adjust() 棚卸調整（実数に合わせる）
--     inv_next_id()        管理番号・商品コードの採番
--     inv_start_stocktake() / inv_close_stocktake()
-- ============================================================


-- ============================================================
-- 1) 使う人と権限
-- ============================================================

create table if not exists public.inventory_members (
  email        text primary key,
  display_name text not null,
  role         text not null default 'viewer',   -- admin(管理者) / member(一般) / viewer(閲覧)
  created_at   timestamptz default now()
);

comment on table public.inventory_members is
  '在庫管理を使う人。ここに無いログインは自動的に閲覧（viewer）扱いになる。';

insert into public.inventory_members (email, display_name, role)
values ('zimu@8grp.co.jp', '事務', 'admin')
on conflict (email) do nothing;

-- 権限判定。inventory_members 自身のRLSに引っかからないよう security definer にする
create or replace function public.inv_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role from public.inventory_members where email = auth.jwt() ->> 'email'),
    'viewer')
$$;

create or replace function public.inv_actor() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select display_name from public.inventory_members where email = auth.jwt() ->> 'email'),
    auth.jwt() ->> 'email',
    '(不明)')
$$;

create or replace function public.inv_can_edit() returns boolean
language sql stable as $$ select public.inv_role() in ('admin','member') $$;

create or replace function public.inv_is_admin() returns boolean
language sql stable as $$ select public.inv_role() = 'admin' $$;


-- ============================================================
-- 2) カテゴリ・保管場所
-- ============================================================

create table if not exists public.inventory_categories (
  id          text primary key,
  name        text not null,
  kind        text not null default 'individual',  -- individual(個体) / quantity(数量)
  code_prefix text,                                -- 個体の管理番号に使う（PC-00125 の PC）
  sort_no     integer default 0
);

create table if not exists public.inventory_locations (
  id         text primary key,                     -- L1, L2 …（棚QRのキー）
  parent_id  text references public.inventory_locations(id) on delete restrict,
  name       text not null,
  kind       text not null default 'shelf',        -- site(拠点) / room(部屋・倉庫) / shelf(棚)
  qr_enabled boolean not null default true,
  sort_no    integer default 0
);

comment on table public.inventory_locations is
  '保管場所。拠点 → 部屋 → 棚 の3階層を想定。棚にQRを貼ると「この棚へまとめて移動」ができる。';

create index if not exists inventory_locations_parent_idx on public.inventory_locations (parent_id, sort_no);


-- ============================================================
-- 3) 個体管理（1行＝現物1台）
-- ============================================================

create table if not exists public.inventory_items (
  id              text primary key,                -- 管理番号。QRのURLに入るキー
  name            text not null,
  category_id     text references public.inventory_categories(id),
  maker           text,
  model           text,
  serial          text,
  purchased_on    date,
  price           numeric,
  location_id     text references public.inventory_locations(id),
  status          text not null default '在庫',     -- 在庫/貸出中/使用中/修理中/故障/紛失/廃棄
  user_name       text,
  loaned_at       timestamptz,                     -- 貸出日。長期貸出（30日超）の判定に使う
  note            text,
  last_checked_at timestamptz,                     -- 最後に棚卸で現物を確認した日時
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists inventory_items_status_idx on public.inventory_items (status, location_id);
create index if not exists inventory_items_loc_idx    on public.inventory_items (location_id);
create index if not exists inventory_items_cat_idx    on public.inventory_items (category_id);


-- ============================================================
-- 4) 数量管理（1行＝1品目。数が増減する）
-- ============================================================

create table if not exists public.inventory_products (
  code            text primary key,                -- 商品コード。QRのURLに入るキー
  name            text not null,
  category_id     text references public.inventory_categories(id),
  qty             integer not null default 0,
  min_qty         integer not null default 0,      -- これ以下で「要発注」
  location_id     text references public.inventory_locations(id),
  supplier        text,
  unit_price      numeric,
  note            text,
  last_checked_at timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

comment on column public.inventory_products.qty is
  '現在庫。直接UPDATEせず inv_product_move() / inv_product_adjust() を通すこと（履歴が残る）。';

create index if not exists inventory_products_loc_idx on public.inventory_products (location_id);


-- ============================================================
-- 5) 履歴（追記のみ）
--    権限でも UPDATE / DELETE を与えない。在庫の現在値は履歴から再計算できる
-- ============================================================

create table if not exists public.inventory_transactions (
  id           bigint generated by default as identity primary key,
  occurred_at  timestamptz not null default now(),
  actor        text,
  ref_kind     text not null,                      -- item / product
  ref_id       text not null,
  label        text,                               -- そのときの商品名
  action       text not null,                      -- 貸出/返却/移動/状態変更/廃棄/入庫/出庫/棚卸確認/棚卸調整/登録
  before_value text,
  after_value  text
);

comment on table public.inventory_transactions is
  '操作の履歴。追記のみで、更新も削除もしない（権限そのものを与えていない）。';

create index if not exists inventory_tx_at_idx  on public.inventory_transactions (occurred_at desc);
create index if not exists inventory_tx_ref_idx on public.inventory_transactions (ref_kind, ref_id, occurred_at desc);


-- ============================================================
-- 6) 貸出・棚卸
-- ============================================================

create table if not exists public.inventory_loans (
  id          bigint generated by default as identity primary key,
  item_id     text not null references public.inventory_items(id) on delete cascade,
  user_name   text not null,
  loaned_at   timestamptz not null default now(),
  due_at      timestamptz,
  returned_at timestamptz,
  actor       text
);

create index if not exists inventory_loans_open_idx on public.inventory_loans (item_id) where returned_at is null;

create table if not exists public.inventory_stocktakes (
  id                bigint generated by default as identity primary key,
  started_at        timestamptz not null default now(),
  closed_at         timestamptz,
  actor             text,
  scope_location_id text references public.inventory_locations(id),
  status            text not null default 'open'   -- open / closed
);

create table if not exists public.inventory_stocktake_items (
  stocktake_id bigint not null references public.inventory_stocktakes(id) on delete cascade,
  item_id      text not null,
  expected     boolean not null default true,
  checked_at   timestamptz,
  primary key (stocktake_id, item_id)
);

-- 実施中の棚卸は同時に1つだけ
create unique index if not exists inventory_stocktakes_open_idx
  on public.inventory_stocktakes ((status)) where status = 'open';


-- ============================================================
-- 7) 採番
-- ============================================================

create table if not exists public.inventory_counters (
  prefix  text primary key,
  next_no integer not null default 1
);

comment on table public.inventory_counters is
  '管理番号の連番。採番は inv_next_id() が update ... returning で取るので、同時に登録しても番号がぶつからない。';


-- ============================================================
-- 8) 更新時刻の自動セット
-- ============================================================

create or replace function public.inv_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists inventory_items_touch on public.inventory_items;
create trigger inventory_items_touch before update on public.inventory_items
  for each row execute function public.inv_touch();

drop trigger if exists inventory_products_touch on public.inventory_products;
create trigger inventory_products_touch before update on public.inventory_products
  for each row execute function public.inv_touch();


-- ============================================================
-- 9) 操作の関数
--
--    画面から items / products を直接UPDATEしない。
--    「値を変える」と「履歴を残す」を必ず同じトランザクションにまとめるため、
--    すべてこの関数を通す。update ... returning で行ロックも取れる。
-- ============================================================

/* 個体の操作。p_value の意味は操作ごとに変わる
     貸出     … 利用者名
     返却     … 使わない
     移動     … 移動先のロケーションID
     状態変更 … 新しい状態
     廃棄     … 使わない
     棚卸確認 … 使わない                                        */
create or replace function public.inv_item_op(
  p_item_id text,
  p_action  text,
  p_value   text default null,
  p_note    text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it       public.inventory_items;
  actor    text := public.inv_actor();
  v_before text;
  v_after  text;
  st_id    bigint;
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

  elsif p_action in ('状態変更','廃棄') then
    v_before := it.status;
    v_after  := case when p_action='廃棄' then '廃棄' else coalesce(p_value, it.status) end;
    if p_action='廃棄' and not public.inv_is_admin() then
      raise exception '廃棄は管理者だけができます';
    end if;
    update public.inventory_items
       set status = v_after,
           user_name = case when v_after in ('貸出中','使用中') then it.user_name else null end
     where id=p_item_id returning * into it;

  elsif p_action = '棚卸確認' then
    v_before := it.status;
    v_after  := it.status || '（確認済み）';
    update public.inventory_items set last_checked_at=now() where id=p_item_id returning * into it;
    -- 実施中の棚卸があれば、その確認済みに加える
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
          case when p_action='廃棄' then '廃棄' else p_action end,
          v_before, v_after || coalesce('／' || nullif(p_note,''), ''));

  return it;
end $$;

/* 数量品の入庫・出庫。p_delta はプラスが入庫、マイナスが出庫 */
create or replace function public.inv_product_move(
  p_code  text,
  p_delta integer,
  p_note  text default null
) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  pr      public.inventory_products;
  v_after integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if coalesce(p_delta,0) = 0 then
    raise exception '数量を入れてください';
  end if;

  update public.inventory_products
     set qty = qty + p_delta
   where code = p_code
   returning * into pr;

  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  if pr.qty < 0 then
    raise exception '在庫が足りません（現在 %／出庫 %）', pr.qty - p_delta, -p_delta;
  end if;
  v_after := pr.qty;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code, pr.name,
          case when p_delta > 0 then '入庫' else '出庫' end,
          (v_after - p_delta)::text,
          v_after::text || '（' || case when p_delta>0 then '+' else '' end || p_delta::text || '）'
            || coalesce('／' || nullif(p_note,''), ''));

  return v_after;
end $$;

/* 数量品の棚卸調整。数えた実数に合わせる */
create or replace function public.inv_product_adjust(
  p_code   text,
  p_actual integer,
  p_note   text default null
) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  pr     public.inventory_products;
  v_from integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_actual is null or p_actual < 0 then
    raise exception '実数は0以上で入れてください';
  end if;

  select * into pr from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  v_from := pr.qty;

  update public.inventory_products
     set qty = p_actual, last_checked_at = now()
   where code = p_code returning * into pr;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code, pr.name, '棚卸調整',
          v_from::text, p_actual::text || coalesce('／' || nullif(p_note,''), ''));

  return p_actual;
end $$;

/* 保管場所のパス表記（原宿本社 / 倉庫A / 棚A-01） */
create or replace function public.inv_location_path(p_id text) returns text
language sql stable security definer set search_path = public as $$
  with recursive up as (
    select id, parent_id, name, 0 as depth from public.inventory_locations where id = p_id
    union all
    select l.id, l.parent_id, l.name, up.depth + 1
      from public.inventory_locations l join up on l.id = up.parent_id
    )
  select coalesce(string_agg(name, ' / ' order by depth desc), '')
  from up
$$;

/* 採番。update ... returning で取るので、同時に登録しても番号がぶつからない */
create or replace function public.inv_next_id(p_prefix text, p_digits integer default 5)
returns text
language plpgsql security invoker set search_path = public as $$
declare
  n integer;
begin
  if not public.inv_can_edit() then
    raise exception '登録する権限がありません';
  end if;

  insert into public.inventory_counters (prefix, next_no) values (p_prefix, 1)
  on conflict (prefix) do nothing;

  update public.inventory_counters
     set next_no = next_no + 1
   where prefix = p_prefix
   returning next_no - 1 into n;

  return p_prefix || '-' || lpad(n::text, p_digits, '0');
end $$;

/* 棚卸を始める。対象を確定して stocktake_items に並べる */
create or replace function public.inv_start_stocktake(p_scope text default null)
returns public.inventory_stocktakes
language plpgsql security invoker set search_path = public as $$
declare
  st public.inventory_stocktakes;
begin
  if not public.inv_can_edit() then
    raise exception '棚卸を始める権限がありません';
  end if;
  if exists (select 1 from public.inventory_stocktakes where status='open') then
    raise exception 'すでに実施中の棚卸があります。先に終了してください';
  end if;

  insert into public.inventory_stocktakes (actor, scope_location_id)
  values (public.inv_actor(), p_scope) returning * into st;

  insert into public.inventory_stocktake_items (stocktake_id, item_id, expected)
  select st.id, i.id, true
  from public.inventory_items i
  where i.status <> '廃棄'
    and (p_scope is null or i.location_id in (select id from public.inv_location_tree(p_scope)));

  return st;
end $$;

/* ある保管場所と、その下にぶら下がる場所すべて */
create or replace function public.inv_location_tree(p_id text)
returns table (id text)
language sql stable security definer set search_path = public as $$
  with recursive down as (
    select l.id, l.parent_id from public.inventory_locations l where l.id = p_id
    union all
    select c.id, c.parent_id from public.inventory_locations c join down on c.parent_id = down.id
    )
  select down.id from down
$$;

create or replace function public.inv_close_stocktake(p_id bigint)
returns public.inventory_stocktakes
language plpgsql security invoker set search_path = public as $$
declare
  st public.inventory_stocktakes;
begin
  if not public.inv_can_edit() then
    raise exception '棚卸を終える権限がありません';
  end if;
  update public.inventory_stocktakes
     set status='closed', closed_at=now()
   where id=p_id and status='open' returning * into st;
  if not found then
    raise exception '実施中の棚卸が見つかりません';
  end if;
  return st;
end $$;


-- ============================================================
-- 10) 権限とRLS
--
--    ログインしていれば誰でも「見る」ことはできる。
--    書き込みは inventory_members の role 次第。
--    履歴は UPDATE / DELETE の権限そのものを与えない（追記のみ）。
-- ============================================================

grant usage on schema public to anon, authenticated;

grant select on public.inventory_members, public.inventory_categories, public.inventory_locations,
                public.inventory_items, public.inventory_products, public.inventory_transactions,
                public.inventory_loans, public.inventory_stocktakes, public.inventory_stocktake_items,
                public.inventory_counters
  to authenticated;

grant insert, update, delete on public.inventory_items, public.inventory_products,
                                public.inventory_locations, public.inventory_categories,
                                public.inventory_loans, public.inventory_stocktakes,
                                public.inventory_stocktake_items, public.inventory_counters
  to authenticated;
grant insert, update, delete on public.inventory_members to authenticated;

-- 履歴は追記だけ。UPDATE と DELETE は誰にも渡さない
grant insert on public.inventory_transactions to authenticated;

grant usage, select on all sequences in schema public to authenticated;

grant execute on function public.inv_role(), public.inv_actor(), public.inv_can_edit(),
                          public.inv_is_admin(), public.inv_location_path(text),
                          public.inv_location_tree(text),
                          public.inv_item_op(text,text,text,text),
                          public.inv_product_move(text,integer,text),
                          public.inv_product_adjust(text,integer,text),
                          public.inv_next_id(text,integer),
                          public.inv_start_stocktake(text),
                          public.inv_close_stocktake(bigint)
  to authenticated;

alter table public.inventory_members          enable row level security;
alter table public.inventory_categories       enable row level security;
alter table public.inventory_locations        enable row level security;
alter table public.inventory_items            enable row level security;
alter table public.inventory_products         enable row level security;
alter table public.inventory_transactions     enable row level security;
alter table public.inventory_loans            enable row level security;
alter table public.inventory_stocktakes       enable row level security;
alter table public.inventory_stocktake_items  enable row level security;
alter table public.inventory_counters         enable row level security;

-- 参照：ログインしていれば全員
do $$
declare t text;
begin
  foreach t in array array['inventory_members','inventory_categories','inventory_locations',
                           'inventory_items','inventory_products','inventory_transactions',
                           'inventory_loans','inventory_stocktakes','inventory_stocktake_items',
                           'inventory_counters']
  loop
    execute format('drop policy if exists "%s read" on public.%I', t, t);
    execute format('create policy "%s read" on public.%I for select to authenticated using (true)', t, t);
  end loop;
end $$;

-- 書き込み：一般以上
do $$
declare t text;
begin
  foreach t in array array['inventory_products','inventory_loans','inventory_stocktakes',
                           'inventory_stocktake_items','inventory_counters','inventory_transactions']
  loop
    execute format('drop policy if exists "%s write" on public.%I', t, t);
    execute format('create policy "%s write" on public.%I for all to authenticated
                    using (public.inv_can_edit()) with check (public.inv_can_edit())', t, t);
  end loop;
end $$;

-- 個体：更新は一般以上、登録と削除は管理者だけ
drop policy if exists "inventory_items update" on public.inventory_items;
create policy "inventory_items update" on public.inventory_items for update to authenticated
  using (public.inv_can_edit()) with check (public.inv_can_edit());
drop policy if exists "inventory_items insert" on public.inventory_items;
create policy "inventory_items insert" on public.inventory_items for insert to authenticated
  with check (public.inv_is_admin());
drop policy if exists "inventory_items delete" on public.inventory_items;
create policy "inventory_items delete" on public.inventory_items for delete to authenticated
  using (public.inv_is_admin());

-- マスタ（カテゴリ・保管場所・メンバー）は管理者だけが触る
do $$
declare t text;
begin
  foreach t in array array['inventory_categories','inventory_locations','inventory_members']
  loop
    execute format('drop policy if exists "%s write" on public.%I', t, t);
    execute format('create policy "%s write" on public.%I for all to authenticated
                    using (public.inv_is_admin()) with check (public.inv_is_admin())', t, t);
  end loop;
end $$;


-- ============================================================
-- 11) 最初のデータ（カテゴリと保管場所）
--     中身は画面から足せます。ここは動かし始めるための最小限
-- ============================================================

insert into public.inventory_categories (id, name, kind, code_prefix, sort_no) values
  ('pc',       'PC',               'individual', 'PC',  10),
  ('monitor',  'モニター',          'individual', 'MON', 20),
  ('tablet',   'タブレット',        'individual', 'TB',  30),
  ('phone',    'スマートフォン',     'individual', 'PH',  40),
  ('network',  'ネットワーク機器',   'individual', 'NW',  50),
  ('printer',  'プリンター',        'individual', 'PR',  60),
  ('other',    'その他IT機器',      'individual', 'IT',  70),
  ('cable',    'ケーブル',          'quantity',   null,  110),
  ('input',    '入力機器',          'quantity',   null,  120),
  ('paper',    '用紙・事務用品',     'quantity',   null,  130),
  ('consume',  '消耗品',            'quantity',   null,  140),
  ('adapter',  'アダプタ',          'quantity',   null,  150)
on conflict (id) do nothing;

insert into public.inventory_locations (id, parent_id, name, kind, sort_no) values
  ('L1',  null, '本社',     'site',  10),
  ('L2',  'L1', '倉庫',     'room',  10),
  ('L3',  'L2', '棚A-01',   'shelf', 10),
  ('L4',  'L2', '棚A-02',   'shelf', 20),
  ('L5',  'L2', '棚A-03',   'shelf', 30),
  ('L6',  'L1', 'オフィス',  'room',  20),
  ('L7',  'L6', 'デスク島1', 'shelf', 10),
  ('L10', null, '柏',       'site',  20),
  ('L11', 'L10','倉庫',     'room',  10),
  ('L12', 'L11','棚K-01',   'shelf', 10),
  ('L20', null, '岩瀬',     'site',  30),
  ('L21', 'L20','倉庫',     'room',  10),
  ('L22', 'L21','棚I-01',   'shelf', 10)
on conflict (id) do nothing;


-- ============================================================
-- 12) 商品マスタ化（型番・商品単位でまとめる）
--
--     もとは「個体」と「数量品」が別々の表だったが、実務では
--     同じ型番のPCが何台もある。型番でまとめた1行＝商品マスタを置き、
--     個体はそこにぶら下げる。数量品もマスタの一種として同じ表に入る。
--
--     inventory_products が商品マスタ。code が商品IDになる。
--       個体管理のマスタ … P-00001（在庫数は個体の状態から数える）
--       数量管理のマスタ … SKU-0001（qty をそのまま持つ）
-- ============================================================

alter table public.inventory_products add column if not exists kind        text not null default 'quantity';
alter table public.inventory_products add column if not exists maker       text;
alter table public.inventory_products add column if not exists model       text;   -- 型番
alter table public.inventory_products add column if not exists spec        text;
alter table public.inventory_products add column if not exists legacy_note text;   -- 旧データ備考（移行元の値をそのまま残す）

comment on table  public.inventory_products is
  '商品マスタ。型番・商品単位の1行。kind=individual なら個体を ぶら下げ、quantity なら qty を直接持つ。';
comment on column public.inventory_products.kind is
  'individual（個体管理：1台＝1レコード）／quantity（数量管理：数が増減する）';
comment on column public.inventory_products.qty is
  '数量管理のときの現在庫。個体管理では使わない（個体の状態から数える）。';
comment on column public.inventory_products.legacy_note is
  '移行前のデータ。消さずに残して、あとから元を確かめられるようにする。';

create index if not exists inventory_products_kind_idx  on public.inventory_products (kind, category_id);
create index if not exists inventory_products_model_idx on public.inventory_products (model);

-- 個体はマスタにぶら下がる
alter table public.inventory_items add column if not exists product_code text
  references public.inventory_products(code) on delete restrict;
alter table public.inventory_items add column if not exists legacy_note text;

create index if not exists inventory_items_product_idx on public.inventory_items (product_code);

comment on column public.inventory_items.product_code is
  'どの商品マスタの個体か。商品名・メーカー・型番・スペックはマスタ側が正。';


-- ============================================================
-- 13) 販売チャネル情報
--     在庫一覧からは切り離し、商品詳細の「販売情報」タブで扱う
-- ============================================================

create table if not exists public.inventory_channels (
  id           bigint generated by default as identity primary key,
  product_code text not null references public.inventory_products(code) on delete cascade,
  channel      text not null,     -- amazon / rakuten / mercari / yahuoku / yahoo_free / notion / other
  sku          text,              -- そのモールでの商品コード
  url          text,
  state        text,              -- 出品中 / 出品停止 / 保留 / 売り切れ / 出品中止 / 販売済み
  note         text,
  updated_at   timestamptz default now()
);

comment on table public.inventory_channels is
  'モールごとの出品情報。商品マスタ1件につき、モード1つで1行。';

-- 商品まるごとの一意制約は、後段（27・30-5）で inventory_channels を
-- 個体専用にし、商品×チャネルの制約は inventory_channel_listings 側に移すため
-- ここでは作らない。以前はここで product_code+channel の素朴なUNIQUEを作って
-- いたが、1つの出品（同じSKU）に複数の個体がぶら下がる実データ（例:
-- 1つの楽天商品ページに実在庫20台）と矛盾するため廃止した。
create index if not exists inventory_channels_ch_idx on public.inventory_channels (channel, state);

drop trigger if exists inventory_channels_touch on public.inventory_channels;
create trigger inventory_channels_touch before update on public.inventory_channels
  for each row execute function public.inv_touch();


-- ============================================================
-- 14) 既存データの引き上げ
--     すでに登録されている個体を、型番ごとのマスタにぶら下げ直す。
--     何度実行しても、すでに紐づいているものは触らない
-- ============================================================

-- 数量管理として作られていた既存の品目に印をつける
update public.inventory_products set kind = 'quantity' where kind is null;

do $$
declare
  it   record;
  key  text;
  code text;
begin
  for it in
    select * from public.inventory_items where product_code is null order by id
  loop
    -- 同じ型番（型番が無ければ商品名）のマスタを探す。無ければ作る
    key := coalesce(nullif(it.model, ''), it.name);
    select p.code into code
      from public.inventory_products p
     where p.kind = 'individual'
       and coalesce(nullif(p.model, ''), p.name) = key
     limit 1;

    if code is null then
      insert into public.inventory_counters (prefix, next_no) values ('P', 1)
        on conflict (prefix) do nothing;
      update public.inventory_counters set next_no = next_no + 1
       where prefix = 'P' returning 'P-' || lpad((next_no - 1)::text, 5, '0') into code;

      insert into public.inventory_products
        (code, name, category_id, maker, model, kind, location_id, qty, min_qty)
      values
        (code, it.name, it.category_id, it.maker, it.model, 'individual', it.location_id, 0, 0);
    end if;

    update public.inventory_items set product_code = code where id = it.id;
  end loop;
end $$;

-- 状態の呼び方をそろえる（使用中 → 社内使用）
update public.inventory_items set status = '社内使用' where status = '使用中';


-- ============================================================
-- 15) 個体管理の在庫数は数えて出す
--
--     現在庫 … すぐ出せるもの（在庫・出品中）
--     登録数 … 廃棄・売却済をのぞいた、持っている台数
--     手で入れた数と現物がずれるのを避けるため、必ずここから数える
-- ============================================================

create or replace view public.inventory_stock_view as
select
  p.code,
  p.name,
  p.kind,
  case when p.kind = 'individual'
       then (select count(*) from public.inventory_items i
              where i.product_code = p.code and i.status in ('在庫','出品中'))
       else p.qty end                                   as in_stock,
  case when p.kind = 'individual'
       then (select count(*) from public.inventory_items i
              where i.product_code = p.code and i.status not in ('廃棄','売却済'))
       else p.qty end                                   as registered,
  case when p.kind = 'individual'
       then (select count(*) from public.inventory_items i where i.product_code = p.code)
       else 1 end                                       as total_units
from public.inventory_products p;

comment on view public.inventory_stock_view is
  '商品ごとの在庫数。個体管理は状態から数え、数量管理は qty をそのまま返す。';

grant select on public.inventory_stock_view to authenticated;


-- ============================================================
-- 16) 売却の操作を足す
-- ============================================================

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

  elsif p_action in ('状態変更','廃棄','売却') then
    if p_action = '廃棄' and not public.inv_is_admin() then
      raise exception '廃棄は管理者だけができます';
    end if;
    v_before := it.status;
    v_after  := case p_action
                  when '廃棄' then '廃棄'
                  when '売却' then '売却済'
                  else coalesce(p_value, it.status) end;
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
          case p_action when '廃棄' then '廃棄' when '売却' then '売却' else p_action end,
          v_before, v_after || coalesce('／' || nullif(p_note,''), ''));

  return it;
end $$;


-- ============================================================
-- 18) 社内使用にする（利用者も一緒に入れる）
--
--     貸出と同じく「誰が使っているか」を残したいので、
--     状態変更とは別の操作にして p_value に利用者を取る。
--     inv_item_op の中に足す（下の 19 で作り直している）
-- ============================================================


-- ============================================================
-- 19) 在庫データの全削除
--
--     移行をやり直したいときのための操作。取り返しがつかないので
--     管理者だけ、かつ実施中の棚卸がないときに限る。
--     履歴（inventory_transactions）は消さない。追記のみの記録で、
--     何をいつ消したかもここに残す。
--
--       p_scope = 'all'   商品マスタ・個体・販売情報をすべて消す
--       p_scope = 'units' 個体だけ消す（商品マスタと販売情報は残す）
-- ============================================================

create or replace function public.inv_wipe_inventory(p_scope text default 'all')
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_items    integer := 0;
  n_masters  integer := 0;
  n_chans    integer := 0;
  n_listings integer := 0;
begin
  if not public.inv_is_admin() then
    raise exception '在庫の全削除は管理者だけができます';
  end if;
  if p_scope is null or p_scope not in ('all','units') then
    raise exception '範囲の指定が違います（all または units）';
  end if;
  if exists (select 1 from public.inventory_stocktakes where status = 'open') then
    raise exception '実施中の棚卸があります。先に棚卸を終了してください';
  end if;

  -- どの DELETE にも WHERE を付ける。Supabase で「WHEREのないDELETE/UPDATE」を
  -- 禁止する保護（safeupdate）が入っていると、関数の中でも弾かれるため。
  -- where true や 1=1 はプランナに畳み込まれて消えてしまい保護をすり抜けられないので、
  -- 主キーへの is not null を使う（全行が対象になり、Filter としてプランに残る）。
  delete from public.inventory_loans           where id is not null;
  delete from public.inventory_stocktake_items where item_id is not null;

  with d as (delete from public.inventory_items where id is not null returning 1)
  select count(*) into n_items from d;

  if p_scope = 'all' then
    with d as (delete from public.inventory_channels where id is not null returning 1)
    select count(*) into n_chans from d;
    with d as (delete from public.inventory_channel_listings where id is not null returning 1)
    select count(*) into n_listings from d;
    with d as (delete from public.inventory_products where code is not null returning 1)
    select count(*) into n_masters from d;
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values
    (public.inv_actor(), 'item', '-', '在庫データ', '全削除',
     format('個体 %s件／商品マスタ %s件／販売情報 %s件', n_items, n_masters, n_chans + n_listings),
     case p_scope when 'all' then 'すべて削除' else '個体だけ削除' end);

  return jsonb_build_object('items', n_items, 'masters', n_masters, 'channels', n_chans + n_listings);
end $$;

comment on function public.inv_wipe_inventory is
  '在庫データを消す。管理者のみ。履歴は消さず、何を消したかを履歴に残す。';


-- ============================================================
-- 21) 選んだ商品をまとめて更新する
--
--     取り込んだ直後は、カテゴリも保管場所も全件が同じになる。
--     一覧でチェックを入れて、まとめて直せるようにする。
--     null を渡した項目は変えない（「カテゴリだけ直す」ができる）。
--
--     保管場所は、個体もいっしょに動かすかを選べる。動かすときは
--     1台ずつ履歴を残す（あとで「いつ柏へ移したか」を追えるように）。
-- ============================================================

create or replace function public.inv_bulk_update_products(
  p_codes      text[],
  p_category   text default null,
  p_maker      text default null,
  p_location   text default null,
  p_move_units boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_products integer := 0;
  n_units    integer := 0;
  it         record;
begin
  if not public.inv_can_edit() then
    raise exception '変更する権限がありません（閲覧のみ）';
  end if;
  if p_codes is null or array_length(p_codes, 1) is null then
    raise exception '対象が選ばれていません';
  end if;
  if p_category is null and p_maker is null and p_location is null then
    raise exception '変える項目が選ばれていません';
  end if;

  update public.inventory_products p
     set category_id = coalesce(p_category, p.category_id),
         maker       = coalesce(p_maker, p.maker),
         location_id = coalesce(p_location, p.location_id)
   where p.code = any(p_codes);
  get diagnostics n_products = row_count;

  -- 個体も動かす場合。売却済・廃棄はもう手元に無いので触らない
  if p_location is not null and coalesce(p_move_units, false) then
    for it in
      select i.id, i.name, i.location_id
        from public.inventory_items i
       where i.product_code = any(p_codes)
         and i.status not in ('売却済','廃棄')
         and coalesce(i.location_id,'') is distinct from p_location
    loop
      update public.inventory_items set location_id = p_location where id = it.id;
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values
        (public.inv_actor(), 'item', it.id, it.name, '移動',
         public.inv_location_path(it.location_id),
         public.inv_location_path(p_location) || '／一括変更');
      n_units := n_units + 1;
    end loop;
  end if;

  -- 個体に持たせている表示用の写しも、マスタに合わせておく
  if p_category is not null or p_maker is not null then
    update public.inventory_items i
       set category_id = coalesce(p_category, i.category_id),
           maker       = coalesce(p_maker, i.maker)
     where i.product_code = any(p_codes);
  end if;

  return jsonb_build_object('products', n_products, 'units', n_units);
end $$;

comment on function public.inv_bulk_update_products is
  '選んだ商品のカテゴリ・メーカー・保管場所をまとめて直す。null の項目は変えない。';


-- ============================================================
-- 22) 選んだ商品をまとめて削除する
--
--     ぶら下がる個体と販売情報も一緒に消える。管理者だけ。
--     何を消したかは商品ごとに履歴へ残す。
-- ============================================================

create or replace function public.inv_delete_products(p_codes text[])
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_products integer := 0;
  n_units    integer := 0;
  n_chans    integer := 0;
  n_listings integer := 0;
  p          record;
begin
  if not public.inv_is_admin() then
    raise exception '削除は管理者だけができます';
  end if;
  if p_codes is null or array_length(p_codes, 1) is null then
    raise exception '対象が選ばれていません';
  end if;
  if exists (select 1 from public.inventory_stocktakes where status = 'open') then
    raise exception '実施中の棚卸があります。先に棚卸を終了してください';
  end if;

  -- 先に「何を消すのか」を履歴へ。消したあとでは名前が分からなくなる
  for p in
    select pr.code, pr.name, pr.model,
           (select count(*) from public.inventory_items i where i.product_code = pr.code) as units
      from public.inventory_products pr
     where pr.code = any(p_codes)
  loop
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values
      (public.inv_actor(), 'product', p.code, coalesce(nullif(p.name,''), p.model), '削除',
       format('%s（個体 %s台）', coalesce(nullif(p.model,''), p.code), p.units), '削除');
  end loop;

  delete from public.inventory_loans
   where item_id in (select id from public.inventory_items where product_code = any(p_codes));
  delete from public.inventory_stocktake_items
   where item_id in (select id from public.inventory_items where product_code = any(p_codes));

  with d as (delete from public.inventory_items where product_code = any(p_codes) returning 1)
  select count(*) into n_units from d;
  with d as (delete from public.inventory_channels where product_code = any(p_codes) returning 1)
  select count(*) into n_chans from d;
  with d as (delete from public.inventory_channel_listings where product_code = any(p_codes) returning 1)
  select count(*) into n_listings from d;
  with d as (delete from public.inventory_products where code = any(p_codes) returning 1)
  select count(*) into n_products from d;

  return jsonb_build_object('products', n_products, 'units', n_units, 'channels', n_chans + n_listings);
end $$;

comment on function public.inv_delete_products is
  '選んだ商品を、ぶら下がる個体と販売情報ごと消す。管理者のみ。何を消したかは履歴に残す。';


-- ============================================================
-- 23) 価格（仕入れ → 原価 → 売値 → 利益）
--
--     項目は増やさず、この5つだけで回す。
--
--       仕入価格      price（落札価格）
--       手数料        purchase_fee（落札料）
--       原価          cost = 仕入価格 + 手数料   ← 生成列。手では入れない
--       販売予定価格  plan_price（取り込み時は原価×1.3。あとから直せる）
--       実際の販売価格 sold_price（売却したときに入る）
--
--     想定利益 = 販売予定価格 − 原価、利益 = 実際の販売価格 − 原価。
--     どちらも引き算なので列は持たず、その場で出す。
-- ============================================================

alter table public.inventory_items add column if not exists purchase_fee numeric;
alter table public.inventory_items add column if not exists plan_price   numeric;
alter table public.inventory_items add column if not exists sold_price   numeric;

comment on column public.inventory_items.price        is '仕入価格（落札価格）。';
comment on column public.inventory_items.purchase_fee is '手数料（落札料）。';
comment on column public.inventory_items.plan_price   is '販売予定価格。取り込み時は原価×1.3を入れるが、あとから直せる。';
comment on column public.inventory_items.sold_price   is '実際に売れた価格。売却の操作で入る。';

-- 原価は足し算なので、手で入れられないよう生成列にする（仕入価格や手数料と食い違わない）
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='inventory_items' and column_name='cost')
  then
    alter table public.inventory_items
      add column cost numeric
      generated always as (coalesce(price,0) + coalesce(purchase_fee,0)) stored;
  end if;
end $$;

comment on column public.inventory_items.cost is
  '原価 ＝ 仕入価格 ＋ 手数料。生成列なので直接は書き込めない。';

create index if not exists inventory_items_plan_idx on public.inventory_items (plan_price);

-- 仕入元ID（仕入CSVの個品ID）。
-- セット出品のように「個品IDは1つ、総数は9」という仕入があり、そのときは
-- 管理番号を9個発行する。元の個品IDはここに残して、仕入と現物をたどれるようにする。
alter table public.inventory_items add column if not exists source_id text;
comment on column public.inventory_items.source_id is
  '仕入元ID（仕入CSVの個品ID）。管理番号を採番したときに、元の番号を残すために使う。';
create index if not exists inventory_items_source_idx on public.inventory_items (source_id);

-- 値段を直す。3つまとめて受け取り、何がどう変わったかを履歴に残す。
-- 渡さなかった（null の）ものは「空にする」という意味なので、画面からは必ず3つとも送る。
create or replace function public.inv_item_price(
  p_item_id text,
  p_price   numeric default null,
  p_fee     numeric default null,
  p_plan    numeric default null
) returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  it public.inventory_items;
  v_before text;
  v_after  text;
  fmt      text := 'FM9,999,999,999';
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if coalesce(p_price,0) < 0 or coalesce(p_fee,0) < 0 or coalesce(p_plan,0) < 0 then
    raise exception 'マイナスの金額は入れられません';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  v_before := '原価 ' || to_char(coalesce(it.cost,0), fmt) || '円／予定 '
              || coalesce(to_char(it.plan_price, fmt) || '円', '未定');

  update public.inventory_items
     set price = p_price, purchase_fee = p_fee, plan_price = p_plan
   where id = p_item_id returning * into it;

  v_after := '原価 ' || to_char(coalesce(it.cost,0), fmt) || '円／予定 '
             || coalesce(to_char(it.plan_price, fmt) || '円', '未定');

  if v_before is distinct from v_after then
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'item', p_item_id, it.name, '価格変更', v_before, v_after);
  end if;

  return it;
end $$;

comment on function public.inv_item_price is
  '個体の仕入価格・手数料・販売予定価格をまとめて直す。原価は生成列なので自動で付いてくる。';


-- ============================================================
-- 24) 売却のときに実際の販売価格を受け取る
--     inv_item_op の '売却' で p_value に価格を渡せるようにする
-- ============================================================

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


-- ============================================================
-- 25) CSV取込の履歴
--
--     毎週の仕入CSVを取り込む運用になるので、「いつ・どのファイルを・誰が」
--     入れたかを残す。何を入れたかは product_codes に持たせ、取り込んだ直後に
--     「今回登録した商品だけ表示」できるようにする。
--     履歴なので UPDATE / DELETE の権限は渡さない（追記だけ）。
-- ============================================================

create table if not exists public.inventory_imports (
  id            bigserial primary key,
  imported_at   timestamptz default now(),
  actor         text,
  file_name     text,
  kind          text,                       -- purchase / master / legacy
  product_count integer default 0,
  item_count    integer default 0,
  product_codes text[]  default '{}',       -- 今回登録した商品。一覧の絞り込みに使う
  summary       text
);

-- 今回発行した管理番号。取り込んだ直後に「今回のQRだけ印刷」するのに使う
alter table public.inventory_imports add column if not exists item_ids text[] default '{}';

-- 飛ばした管理番号。黙って消えたように見えないよう、理由ごと履歴に残す。
--   [{"id":"PC-00125","why":"すでに在庫にあります","line":12}, …]
alter table public.inventory_imports add column if not exists skip_count integer default 0;
alter table public.inventory_imports add column if not exists skips jsonb default '[]'::jsonb;

comment on column public.inventory_imports.skips is
  '重複などで飛ばした管理番号と、その理由。取込結果と履歴の「詳細を見る」で出す。';

create index if not exists inventory_imports_at_idx on public.inventory_imports (imported_at desc);

comment on table public.inventory_imports is
  'CSV取込の履歴。取込日・ファイル名・登録数・登録者と、登録した商品IDを残す。追記のみ。';

grant select, insert on public.inventory_imports to authenticated;
alter table public.inventory_imports enable row level security;

drop policy if exists "inventory_imports read" on public.inventory_imports;
create policy "inventory_imports read" on public.inventory_imports
  for select to authenticated using (true);

-- 取り込みは商品の登録なので、入れられるのは管理者だけ（inventory_items insert と同じ）
drop policy if exists "inventory_imports insert" on public.inventory_imports;
create policy "inventory_imports insert" on public.inventory_imports
  for insert to authenticated with check (public.inv_is_admin());


-- ============================================================
-- 26) 商品は「探して、無ければ作る」
--
--     取込で inventory_products_pkey の重複が出ていた。原因は2つある。
--
--     (a) CSVの「商品ID」をそのまま主キーにして入れていた。
--         CSVの番号は手元のメモでしかなく、DBの主キーとは別物。
--         すでに同じ番号が入っていれば当然ぶつかる。
--     (b) inv_next_id がカウンタだけを見ていた。
--         (a) などでカウンタを追い越したIDが入ると、以後の採番は
--         既存とぶつかり続ける。
--
--     そこで、
--       ・DBのIDは必ずDB側で採番する（CSVの番号は source_code に控えるだけ）
--       ・採番は空いている番号が出るまで進める
--       ・商品は型番をそろえて検索し、あれば作らず再利用する
--     の3つにする。
--
--     番号の役割を混ぜないこと：
--       inventory_products.code        商品コード（DBが採番。QRのURLに入る）
--       inventory_products.source_code 取込元の商品ID（CSVに書いてあった番号）
--       inventory_items.id             管理番号（DBが採番、または現物のバーコード）
--       inventory_items.source_id      仕入先の個品ID
-- ============================================================

alter table public.inventory_products add column if not exists source_code text;
comment on column public.inventory_products.source_code is
  '取込元の商品ID（CSVに書いてあった番号）。主キーではなく、元データをたどるための控え。';

-- 型番の表記ゆれをそろえる。全角／半角・空白・大文字小文字・ハイフンの種類を吸収する
create or replace function public.inv_norm_model(s text)
returns text language sql immutable set search_path = public as $$
  select upper(regexp_replace(
           translate(normalize(coalesce(s, ''), NFKC), '‐‑‒–—―−', '-------'),
           '[[:space:]]', '', 'g'))
$$;
comment on function public.inv_norm_model is
  '型番の突き合わせ用に表記をそろえる（全角→半角・空白除去・大文字化）。';

create index if not exists inventory_products_norm_model_idx
  on public.inventory_products (public.inv_norm_model(coalesce(nullif(model,''), name)), kind);
create index if not exists inventory_products_source_idx
  on public.inventory_products (source_code);

-- 採番が既存のIDとぶつからないようにする。空いている番号が出るまで進める
create or replace function public.inv_next_id(p_prefix text, p_digits integer default 5)
returns text
language plpgsql security invoker set search_path = public as $$
declare
  n integer;
  v text;
  guard integer := 0;
begin
  if not public.inv_can_edit() then
    raise exception '登録する権限がありません';
  end if;

  insert into public.inventory_counters (prefix, next_no) values (p_prefix, 1)
  on conflict (prefix) do nothing;

  loop
    update public.inventory_counters
       set next_no = next_no + 1
     where prefix = p_prefix
     returning next_no - 1 into n;

    v := p_prefix || '-' || lpad(n::text, p_digits, '0');

    -- カウンタが追い越されていても、使われていない番号が出るまで進める
    exit when not exists (select 1 from public.inventory_products where code = v)
          and not exists (select 1 from public.inventory_items    where id   = v);

    guard := guard + 1;
    if guard > 100000 then
      raise exception '採番できる番号が見つかりません（接頭辞 %）', p_prefix;
    end if;
  end loop;

  return v;
end $$;

-- 採番の続きを、いま入っているIDに合わせる。
-- 手やCSVから入ったIDがカウンタより先に進んでいると、採番が既存とぶつかるため
do $$
declare r record;
begin
  for r in
    select prefix, max(n) as mx from (
      select split_part(code, '-', 1) as prefix, (split_part(code, '-', 2))::bigint as n
        from public.inventory_products where code ~ '^[A-Za-z0-9]+-[0-9]+$'
      union all
      select split_part(id, '-', 1), (split_part(id, '-', 2))::bigint
        from public.inventory_items where id ~ '^[A-Za-z0-9]+-[0-9]+$'
    ) t group by prefix
  loop
    insert into public.inventory_counters (prefix, next_no) values (r.prefix, r.mx + 1)
    on conflict (prefix) do update
      set next_no = greatest(public.inventory_counters.next_no, excluded.next_no);
  end loop;
end $$;

-- 商品を型番で探し、無ければ作る。取込も手登録もここを通す。
-- 同じ型番を毎週仕入れても、商品は1つのまま個体だけ増えていく
create or replace function public.inv_upsert_product(p_row jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_model text := nullif(btrim(coalesce(p_row->>'model', '')), '');
  v_name  text := nullif(btrim(coalesce(p_row->>'name',  '')), '');
  v_kind  text := coalesce(nullif(p_row->>'kind', ''), 'individual');
  v_src   text := nullif(btrim(coalesce(p_row->>'source_code', '')), '');
  v_key   text;
  v_code  text;
  v_cat   text;
  v_loc   text;
begin
  if not public.inv_is_admin() then
    raise exception '商品の登録は管理者だけができます';
  end if;
  if v_model is null and v_name is null then
    raise exception '型番か商品名のどちらかは要ります';
  end if;
  if v_kind not in ('individual', 'quantity') then
    raise exception '知らない管理方式です（%）', v_kind;
  end if;

  -- 1) 型番（無ければ商品名）をそろえて既存商品を探す
  v_key := public.inv_norm_model(coalesce(v_model, v_name));
  select code, category_id into v_code, v_cat
    from public.inventory_products
   where kind = v_kind
     and public.inv_norm_model(coalesce(nullif(model, ''), name)) = v_key
   order by created_at nulls last, code
   limit 1;

  -- 2) あれば作らない。商品はそのまま、個体だけあとで足す
  if v_code is not null then
    if v_src is not null then
      update public.inventory_products set source_code = coalesce(source_code, v_src)
       where code = v_code;
    end if;
    return jsonb_build_object('code', v_code, 'created', false, 'category_id', v_cat);
  end if;

  -- 3) 無ければ作る。IDはDB側で採番する（CSVの商品IDは主キーにしない）
  v_cat := nullif(p_row->>'category_id', '');
  v_loc := nullif(p_row->>'location_id', '');
  v_code := public.inv_next_id(
    case when v_kind = 'individual' then 'P' else 'SKU' end,
    case when v_kind = 'individual' then 5 else 4 end);

  insert into public.inventory_products
    (code, name, model, maker, category_id, kind, spec, location_id,
     qty, min_qty, supplier, unit_price, note, legacy_note, source_code)
  values
    (v_code, coalesce(v_name, v_model), v_model, nullif(p_row->>'maker', ''),
     v_cat, v_kind, nullif(p_row->>'spec', ''), v_loc,
     coalesce((p_row->>'qty')::integer, 0), coalesce((p_row->>'min_qty')::integer, 0),
     nullif(p_row->>'supplier', ''), (nullif(p_row->>'unit_price', ''))::numeric,
     nullif(p_row->>'note', ''), nullif(p_row->>'legacy_note', ''), v_src);

  return jsonb_build_object('code', v_code, 'created', true, 'category_id', v_cat);
end $$;

comment on function public.inv_upsert_product is
  '型番で商品を探し、無ければ採番して作る。CSVの商品IDは主キーにせず source_code に残す。';


-- ============================================================
-- 27) 出品（実物1台ごとに、販売サイト別）
--     自社在庫DBが正。楽天・Amazonなどは「そこに出している」という情報でしかない。
--     売れた台数を販売サイトから持ってきて在庫に上書きすることはしない。
--     inventory_channels を個体まで下ろす。item_id が
--       null     … 商品まるごとの出品情報（数量管理の品目・移行前のデータ）
--       入っている … その1台の出品情報
-- ============================================================

alter table public.inventory_channels
  add column if not exists item_id text references public.inventory_items(id) on delete cascade;
alter table public.inventory_channels
  add column if not exists price numeric;      -- そのサイトでの販売価格

comment on column public.inventory_channels.item_id is
  '出品している実物1台。null は商品まるごとの出品情報（数量管理など）。';
comment on column public.inventory_channels.price is
  'そのサイトでの販売価格。自社の販売予定価格（inventory_items.plan_price）とは別。';

-- 商品単位の行と個体単位の行を両立させる。もとの (product_code, channel) の
-- 一意制約は、商品単位の行だけに絞って残す
drop index if exists public.inventory_channels_pc_idx;
create unique index if not exists inventory_channels_prod_idx
  on public.inventory_channels (product_code, channel) where item_id is null;
create unique index if not exists inventory_channels_item_idx
  on public.inventory_channels (item_id, channel) where item_id is not null;
create index if not exists inventory_channels_item_state_idx
  on public.inventory_channels (item_id, state);


-- ============================================================
-- 27b) 商品×チャネルの「掲載」情報を分離する（inventory_channel_listings）
--
--     背景：1つの楽天商品ページ（1つの商品URL）に、実在庫の個体が複数（例:20台）
--     ぶら下がることがある（inventory_channels は本来「個体×チャネル」の
--     情報だが、商品まるごとの出品情報＝item_id is null の行も同じ表に
--     同居させていたため、両者を混同した設計ミスが起きやすかった）。
--
--     これ以降、役割を分ける：
--       inventory_channels          … 個体×チャネル（item_id 必須）
--       inventory_channel_listings  … 商品×チャネル（1商品につき1チャネル1行。
--                                      掲載URL・価格・external_item_code
--                                      （楽天のitemCode等）・API同期状況など）
--
--     既存の inventory_channels の「商品まるごと」行（item_id is null）は
--     ここで inventory_channel_listings へ移す。個体の行（item_id is not null。
--     例えば1つのSKUに紐づく20台の行）は一切変更しない。
-- ============================================================

-- 念のため、個体×チャネルに重複が無いことを確認してから進める
-- （無いはずだが、上の inventory_channels_item_idx 作成時にも同様に守られる）
do $$
declare
  v_item_id text;
  v_channel text;
  v_count   integer;
begin
  select item_id, channel, count(*) into v_item_id, v_channel, v_count
    from public.inventory_channels
   where item_id is not null
   group by item_id, channel
  having count(*) > 1
   limit 1;

  if v_item_id is not null then
    raise exception '個体×チャネルに重複があります（item_id=%, channel=%, %件）。'
      '先にこの重複を解消してください。', v_item_id, v_channel, v_count;
  end if;
end $$;

create table if not exists public.inventory_channel_listings (
  id                 bigint generated by default as identity primary key,
  product_code       text not null references public.inventory_products(code) on delete cascade,
  channel            text not null,
  state              text,        -- 出品中 / 出品停止 / 保留 / 売り切れ / 出品中止 / 販売済み
  sku                text,        -- 社内・スタッフ入力用の商品コード欄（自由記入。モールのIDとは別）
  price              numeric,
  url                text,
  note               text,
  external_item_code text,        -- そのモールが発行する商品識別子（楽天のitemCode等）。
                                   -- APIでの再照合はこの列で行い、skuとは混同しない
  api_synced_at      timestamptz, -- APIで最後に取得・反映した時刻（手入力のみなら null）
  api_sync_status    text,        -- 直近の同期結果（'ok' / エラーメッセージ 等）
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- すでに inventory_channel_listings がある環境（先行migration適用済み）にも列を足す
alter table public.inventory_channel_listings add column if not exists external_item_code text;

comment on table public.inventory_channel_listings is
  '商品×販売チャネルの「掲載」情報（1つのURL・価格を、複数の実在庫個体が共有する）。
   個体ごとの出品状態は引き続き inventory_channels（item_id必須）で管理する。';
comment on column public.inventory_channel_listings.sku is
  'スタッフが自由に入れる商品コード欄。モールのAPIが発行する識別子は external_item_code を使う（混同しない）。';
comment on column public.inventory_channel_listings.external_item_code is
  'そのモールのAPIが発行する商品識別子（楽天なら itemCode。例: "shopCode:1234567"）。
   楽天連携の再照合はこの列（無ければurl）で行う。';

create unique index if not exists inventory_channel_listings_idx
  on public.inventory_channel_listings (product_code, channel);
drop index if exists public.inventory_channel_listings_sku_idx;
create index if not exists inventory_channel_listings_extcode_idx
  on public.inventory_channel_listings (channel, external_item_code);

drop trigger if exists inventory_channel_listings_touch on public.inventory_channel_listings;
create trigger inventory_channel_listings_touch before update on public.inventory_channel_listings
  for each row execute function public.inv_touch();

-- 既存の「商品まるごと」行（item_id is null）を移す。移行件数を確認できてから
-- delete する（一致しなければ中断・ロールバックし、個体の行には触れない）
do $$
declare
  v_before_count integer;
  v_after_count  integer;
begin
  select count(*) into v_before_count from public.inventory_channels where item_id is null;
  if v_before_count = 0 then
    return; -- 移すものが無ければ何もしない（毎回の再実行を軽くする）
  end if;

  insert into public.inventory_channel_listings
    (product_code, channel, state, sku, price, url, note, updated_at)
  select product_code, channel, state, sku, price, url, note, updated_at
    from public.inventory_channels
   where item_id is null
  on conflict (product_code, channel) do nothing;

  select count(*) into v_after_count from public.inventory_channel_listings;
  if v_after_count < v_before_count then
    raise exception '商品まるごとの出品情報の移行件数が想定より少ないため中断しました'
      '（%件 に対し、移行先は %件）。inventory_channels の delete は行っていません。',
      v_before_count, v_after_count;
  end if;

  delete from public.inventory_channels where item_id is null;
  raise notice '商品まるごとの出品情報 % 件を inventory_channel_listings へ移しました', v_before_count;
end $$;

-- inventory_channels は個体専用になったので、商品まるごと用の一意制約は不要
drop index if exists public.inventory_channels_prod_idx;

grant select, insert, update, delete on public.inventory_channel_listings to authenticated;

alter table public.inventory_channel_listings enable row level security;

drop policy if exists "inventory_channel_listings read" on public.inventory_channel_listings;
create policy "inventory_channel_listings read" on public.inventory_channel_listings
  for select to authenticated using (true);

drop policy if exists "inventory_channel_listings write" on public.inventory_channel_listings;
create policy "inventory_channel_listings write" on public.inventory_channel_listings
  for all to authenticated
  using (public.inv_can_edit()) with check (public.inv_can_edit());


-- 出品情報を1件入れ直す。p_item_id を渡せばその1台（inventory_channels）、
-- null なら商品まるごと（inventory_channel_listings）。
-- 中身をすべて空にしたら「未出品」＝行を消す。
-- 出品状態が変わったときだけ履歴に残す（SKUの打ち直しで履歴が埋まらないように）
drop function if exists public.inv_listing_set(text,text,text,text,text,numeric,text,text);
create function public.inv_listing_set(
  p_item_id text,
  p_code    text,
  p_channel text,
  p_state   text,
  p_sku     text default null,
  p_price   numeric default null,
  p_url     text default null,
  p_note    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code   text := p_code;
  v_before text;
  v_row    jsonb;
  v_empty  boolean;
  v_st     text := nullif(trim(coalesce(p_state, '')), '');
  v_sku    text := nullif(trim(coalesce(p_sku, '')), '');
  v_url    text := nullif(trim(coalesce(p_url, '')), '');
  v_note   text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.inv_can_edit() then
    raise exception '出品情報を変えられる権限がありません';
  end if;
  if v_st = '未出品' then v_st := null; end if;
  v_empty := v_st is null and v_sku is null and v_url is null and v_note is null and p_price is null;

  if p_item_id is not null then
    -- 個体1台ぶん（既存どおり inventory_channels）
    select product_code into v_code from public.inventory_items where id = p_item_id;
    if not found then
      raise exception '個体 % が見つかりません', p_item_id;
    end if;
    select state into v_before from public.inventory_channels
     where item_id = p_item_id and channel = p_channel;

    if v_empty then
      delete from public.inventory_channels where item_id = p_item_id and channel = p_channel;
    else
      insert into public.inventory_channels
        (product_code, item_id, channel, state, sku, price, url, note, updated_at)
      values (v_code, p_item_id, p_channel, v_st, v_sku, p_price, v_url, v_note, now())
      on conflict (item_id, channel) where item_id is not null
      do update set state = excluded.state, sku = excluded.sku, price = excluded.price,
                    url = excluded.url, note = excluded.note, updated_at = now()
      returning to_jsonb(inventory_channels.*) into v_row;
    end if;
  else
    -- 商品まるごと（inventory_channel_listings）
    if v_code is null then
      raise exception '商品が指定されていません';
    end if;
    select state into v_before from public.inventory_channel_listings
     where product_code = v_code and channel = p_channel;

    if v_empty then
      delete from public.inventory_channel_listings where product_code = v_code and channel = p_channel;
    else
      insert into public.inventory_channel_listings
        (product_code, channel, state, sku, price, url, note, updated_at)
      values (v_code, p_channel, v_st, v_sku, p_price, v_url, v_note, now())
      on conflict (product_code, channel)
      do update set state = excluded.state, sku = excluded.sku, price = excluded.price,
                    url = excluded.url, note = excluded.note, updated_at = now()
      returning to_jsonb(inventory_channel_listings.*) into v_row;
    end if;
  end if;

  if coalesce(v_before, '未出品') is distinct from coalesce(v_st, '未出品') then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values
      (public.inv_actor(),
       case when p_item_id is not null then 'item' else 'product' end,
       coalesce(p_item_id, v_code), p_channel, '出品',
       coalesce(v_before, '未出品'), coalesce(v_st, '未出品'));
  end if;

  return v_row;
end $$;

comment on function public.inv_listing_set is
  '販売サイトごとの出品情報を入れ直す。個体1台なら inventory_channels、
   商品まるごとなら inventory_channel_listings に書く。空にすると未出品。';

-- 既存在庫CSVからの移行用。すでに入っている出品情報は上書きしない
-- （自社落札CSVで作った仕入の情報を、あとから来た表計算で消さないため）。
-- p_rows は [{item_id?, product_code?, channel, state, sku, price, url, note}, …]
create or replace function public.inv_listings_import(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r       jsonb;
  v_item  text;
  v_code  text;
  v_added integer := 0;
  v_kept  integer := 0;
begin
  if not public.inv_is_admin() then
    raise exception '取り込みは管理者だけができます';
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_item := nullif(r->>'item_id', '');
    if v_item is not null then
      select product_code into v_code from public.inventory_items where id = v_item;
      if not found then continue; end if;
    else
      v_code := nullif(r->>'product_code', '');
      if v_code is null
         or not exists (select 1 from public.inventory_products where code = v_code) then
        continue;
      end if;
    end if;

    if v_item is not null then
      -- 個体1台ぶん（inventory_channels）
      if exists (select 1 from public.inventory_channels where item_id = v_item and channel = r->>'channel') then
        update public.inventory_channels set
          state = coalesce(state, nullif(r->>'state', '')),
          sku   = coalesce(sku,   nullif(r->>'sku', '')),
          price = coalesce(price, (nullif(r->>'price', ''))::numeric),
          url   = coalesce(url,   nullif(r->>'url', '')),
          note  = coalesce(note,  nullif(r->>'note', ''))
         where item_id = v_item and channel = r->>'channel';
        v_kept := v_kept + 1;
      else
        insert into public.inventory_channels
          (product_code, item_id, channel, state, sku, price, url, note)
        values
          (v_code, v_item, r->>'channel', nullif(r->>'state', ''),
           nullif(r->>'sku', ''), (nullif(r->>'price', ''))::numeric,
           nullif(r->>'url', ''), nullif(r->>'note', ''));
        v_added := v_added + 1;
      end if;
    else
      -- 商品まるごと（inventory_channel_listings）
      if exists (select 1 from public.inventory_channel_listings where product_code = v_code and channel = r->>'channel') then
        update public.inventory_channel_listings set
          state = coalesce(state, nullif(r->>'state', '')),
          sku   = coalesce(sku,   nullif(r->>'sku', '')),
          price = coalesce(price, (nullif(r->>'price', ''))::numeric),
          url   = coalesce(url,   nullif(r->>'url', '')),
          note  = coalesce(note,  nullif(r->>'note', ''))
         where product_code = v_code and channel = r->>'channel';
        v_kept := v_kept + 1;
      else
        insert into public.inventory_channel_listings
          (product_code, channel, state, sku, price, url, note)
        values
          (v_code, r->>'channel', nullif(r->>'state', ''),
           nullif(r->>'sku', ''), (nullif(r->>'price', ''))::numeric,
           nullif(r->>'url', ''), nullif(r->>'note', ''));
        v_added := v_added + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'kept', v_kept);
end $$;

comment on function public.inv_listings_import is
  '既存在庫CSVの出品状態を移す。個体1台なら inventory_channels、商品まるごとなら
   inventory_channel_listings に入れる。すでにある出品情報は上書きしない。';


-- ============================================================
-- 28) 8RENT（自社在庫のレンタル公開）
--
--     8RENTは「販売」とは統合しない。/zaiko の自社在庫のうち
--     rental_enabled=true の商品だけを、レンタル専用で公開する。
--
--     個体の状態がそのままレンタル可否になる。新しい状態は「予約中」の1つだけ：
--       在庫    … レンタル可能（現在庫にも数える）
--       予約中  … 申込が入り、発送待ち（現在庫からは外れる。売る・貸すへは進めない）
--       貸出中  … 発送済み・レンタル中（社内の内部貸出と同じ状態を共用する）
--       修理中・故障・紛失・廃棄・売却済 … 利用不可
--
--     レンタル可能数 = 総在庫 − 貸出中 − 予約中 − 修理中 − 利用不可
--                    = status = '在庫' の個体数（他はすべて上のどれかに当たるため）
-- ============================================================

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
-- 29-5) 公開カタログ（8RENT / anon が読む）
--       仕入価格・原価など内部情報は一切含めない。rental_enabled=true だけを出す。
-- ------------------------------------------------------------
drop view if exists public.inv_rental_catalog;
create view public.inv_rental_catalog as
select
  p.code, p.name, p.model, p.maker, p.category_id, p.spec,
  p.rental_price_month, p.rental_min_months, p.office_supported, p.trial_eligible,
  p.rental_tags, p.rental_description, p.rental_image_url, p.rental_images,
  count(i.id) filter (where i.status = '在庫')                    as rental_available,
  count(i.id) filter (where i.status not in ('売却済','廃棄'))     as total_owned,
  p.updated_at
from public.inventory_products p
left join public.inventory_items i on i.product_code = p.code
where p.rental_enabled = true
group by p.code;

comment on view public.inv_rental_catalog is
  '8RENT公開ページ用。rental_enabled=true の商品だけを、レンタル可能数つきで出す。仕入価格・原価は含めない。';


-- ============================================================
-- 29-6) 旧レンタル機能の退役
--
--     rental_items / rental_orders（/admin/rental/ で管理していた、
--     /zaiko と独立した在庫）は、上の8RENTの仕組みに完全に置き換わった。
--     在庫を二重に持たないための削除なので、このデータの移行はしない
--     （8RENTは inventory_products／個体／inventory_rental_requests だけを基準にする）。
--
--     このブロックを含む setup.sql を実行すると、rental_items・rental_orders と
--     そこに入っていたデータは元に戻せません。zimu_is_admin() は /admin/ の
--     ほかの画面（棚卸・決算資料・商品画像など）でも使っている共有の関数なので、
--     これは消さない。
-- ============================================================

drop function if exists public.rental_public_inquiry(uuid,text,text,text,text,date,date,text);
drop table if exists public.rental_orders cascade;
drop table if exists public.rental_items cascade;


-- ============================================================
-- 30) 楽天商品API連携 — inventory_products への商品マスター補完
--
--     楽天＝販売、8RENT＝レンタル、/zaiko＝商品・実在庫の共通基盤という方針のもと、
--     楽天に登録済みの商品情報（商品名・説明・画像・スペック等）を取得して
--     inventory_products の不足情報を埋める。実在庫（inventory_items）は
--     ここでは一切作らない（商品マスターと実在庫は別）。
--
--     楽天への実際の問い合わせ（Rakuten Developers API）は Edge Function
--     （zaiko/supabase-functions/rakuten-product-sync/）が行い、正規化した
--     商品データをここへ渡す。Application ID・Access KeyはEdge Function側の
--     環境変数だけに置き、SQLにも画面のJSにも一切持たせない。
--
--     人が確定した値は上書きしない：どの列も「すでに入っていれば」楽天から
--     来た値があっても入れ直さない（coalesceで空欄だけ埋める）。
-- ============================================================

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

-- ------------------------------------------------------------
-- 30-5) inv_public_catalog：8ECトップ／8RENT 共通の公開ビュー
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
-- 30-6) 商品画像の登録（/zaiko の商品詳細から）
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

-- ============================================================
-- 29) 追加分の権限
-- ============================================================

grant select, insert, update, delete on public.inventory_channels to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.inv_item_op(text,text,text,text) to authenticated;
grant execute on function public.inv_item_price(text,numeric,numeric,numeric) to authenticated;
grant execute on function public.inv_wipe_inventory(text) to authenticated;
grant execute on function public.inv_bulk_update_products(text[],text,text,text,boolean) to authenticated;
grant execute on function public.inv_delete_products(text[]) to authenticated;
grant execute on function public.inv_norm_model(text) to authenticated;
grant execute on function public.inv_upsert_product(jsonb) to authenticated;
grant execute on function public.inv_listing_set(text,text,text,text,text,numeric,text,text) to authenticated;
grant execute on function public.inv_listings_import(jsonb) to authenticated;
grant execute on function public.inv_rental_set_status(bigint,text) to authenticated;
grant execute on function public.inv_product_rental_set(text,boolean,numeric,integer,boolean,boolean,text[],text,text) to authenticated;
grant execute on function public.inv_sale_reserve(text,text,text,text) to authenticated;
grant execute on function public.inv_rakuten_apply_one(text,jsonb) to authenticated;
grant execute on function public.inv_rakuten_sync_apply(jsonb) to authenticated;
grant execute on function public.inv_rakuten_link_confirm(text,jsonb) to authenticated;
grant execute on function public.inv_product_images_set(text,text,jsonb) to authenticated;
-- anon（8RENT・8ECトップの一般訪問者）にはこの関数の実行だけを許可。テーブルへの直接書き込み権限は与えない
grant execute on function public.inv_rental_request(text,text,text,text,text,date,integer,text) to anon;
grant usage on schema public to anon;
grant select on public.inv_rental_catalog to anon, authenticated;
grant select on public.inv_public_catalog to anon, authenticated;
grant select, update on public.inventory_rental_requests to authenticated;

alter table public.inventory_channels enable row level security;

drop policy if exists "inventory_channels read" on public.inventory_channels;
create policy "inventory_channels read" on public.inventory_channels
  for select to authenticated using (true);

drop policy if exists "inventory_channels write" on public.inventory_channels;
create policy "inventory_channels write" on public.inventory_channels
  for all to authenticated
  using (public.inv_can_edit()) with check (public.inv_can_edit());

alter table public.inventory_rental_requests enable row level security;

drop policy if exists "inventory_rental_requests read" on public.inventory_rental_requests;
create policy "inventory_rental_requests read" on public.inventory_rental_requests
  for select to authenticated using (true);

-- 状態の更新は inv_rental_set_status() の中でだけ行う（invoker権限で通すため update 自体は許可する）。
-- テーブルへの insert は許可しない＝新しい申込は inv_rental_request()（security definer）経由だけ
drop policy if exists "inventory_rental_requests update" on public.inventory_rental_requests;
create policy "inventory_rental_requests update" on public.inventory_rental_requests
  for update to authenticated
  using (public.inv_can_edit()) with check (public.inv_can_edit());


-- ============================================================
-- 確認：作られた表と関数
-- ============================================================
select '表' as kind, table_name as name
from information_schema.tables
where table_schema='public' and table_name like 'inventory\_%'
union all
select '関数', routine_name
from information_schema.routines
where routine_schema='public' and routine_name like 'inv\_%'
order by kind, name;
