-- ============================================================
-- QRコード在庫・備品管理  セットアップ  ―― 8ec.jp/zaiko/
--
--   Supabase ダッシュボード → SQL Editor に「このファイルの中身をすべて」
--   貼り付けて Run してください。何度実行しても安全です。
--
--   これは「社内のPC・IT機器・備品・消耗品」を管理する仕組みです。
--   販売用の在庫（/admin/ の ec_items、/admin/ec/ の ec_products）とは
--   別物で、互いに影響しません。
--
--   作られるもの
--     inventory_members         使う人と権限（管理者／一般／閲覧）
--     inventory_categories      カテゴリと採番プレフィックス
--     inventory_locations       保管場所（拠点 → 部屋 → 棚 の階層）
--     inventory_items           個体管理（1行＝現物1台。管理番号がQRのキー）
--     inventory_products        数量管理（1行＝1品目。数が増減する）
--     inventory_transactions    履歴（追記のみ。更新も削除もしない）
--     inventory_loans           貸出
--     inventory_stocktakes      棚卸セッション
--     inventory_stocktake_items 棚卸の確認状況
--     inventory_counters        採番カウンタ
--
--   操作用の関数（画面から直接UPDATEせず、必ずこれを通す）
--     inv_item_op()        貸出／返却／移動／状態変更／廃棄／棚卸確認
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

create unique index if not exists inventory_channels_pc_idx on public.inventory_channels (product_code, channel);
create index        if not exists inventory_channels_ch_idx on public.inventory_channels (channel, state);

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
  n_items   integer := 0;
  n_masters integer := 0;
  n_chans   integer := 0;
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
    with d as (delete from public.inventory_products where code is not null returning 1)
    select count(*) into n_masters from d;
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values
    (public.inv_actor(), 'item', '-', '在庫データ', '全削除',
     format('個体 %s件／商品マスタ %s件／販売情報 %s件', n_items, n_masters, n_chans),
     case p_scope when 'all' then 'すべて削除' else '個体だけ削除' end);

  return jsonb_build_object('items', n_items, 'masters', n_masters, 'channels', n_chans);
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
  with d as (delete from public.inventory_products where code = any(p_codes) returning 1)
  select count(*) into n_products from d;

  return jsonb_build_object('products', n_products, 'units', n_units, 'channels', n_chans);
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
-- 26) 追加分の権限
-- ============================================================

grant select, insert, update, delete on public.inventory_channels to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.inv_item_op(text,text,text,text) to authenticated;
grant execute on function public.inv_item_price(text,numeric,numeric,numeric) to authenticated;
grant execute on function public.inv_wipe_inventory(text) to authenticated;
grant execute on function public.inv_bulk_update_products(text[],text,text,text,boolean) to authenticated;
grant execute on function public.inv_delete_products(text[]) to authenticated;

alter table public.inventory_channels enable row level security;

drop policy if exists "inventory_channels read" on public.inventory_channels;
create policy "inventory_channels read" on public.inventory_channels
  for select to authenticated using (true);

drop policy if exists "inventory_channels write" on public.inventory_channels;
create policy "inventory_channels write" on public.inventory_channels
  for all to authenticated
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
