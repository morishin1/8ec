-- ============================================================
-- QRコード在庫・備品管理  セットアップ  ―― 8ec.jp/zaiko/
--
--   Supabase ダッシュボード → SQL Editor に「このファイルの中身をすべて」
--   貼り付けて Run してください。何度実行しても安全です。
--
--   これは「社内のPC・IT機器・備品・消耗品」を管理する仕組みです。
--   併せて、実在庫（個体）を基準に「販売」と「レンタル」を同じ在庫で
--   連動させる基盤でもあります（在庫確保の共通処理は下記
--   inv_reserve_available_item() を参照）。
--
--   チャネルの役割
--     楽天 … 販売チャネル（購入は楽天市場の商品ページで完結する）
--     8EC  … レンタルチャネル（8ECトップ・8RENT がレンタルの入口）
--   同じ商品・同じ実在庫を両方のチャネルに出すが、販売とレンタルは別々に
--   判定する。守るのは次の2つ：
--     1) 同じ実在庫を二重に確保しない（inv_reserve_available_item() が唯一の入口）
--     2) 8ECでレンタル対象にしても、楽天の掲載（listing）は解除しない。
--        消すのは掲載ではなく数量で、発送できない個体（予約中・貸出中・
--        販売予約・修理中）は楽天へ送る販売可能数量に含めない
--        （inv_channel_stock_feed を参照）。
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
--   公開・連携用のビュー
--     inv_public_catalog        8ECトップ／8RENTが読む公開カタログ
--                               （rental_enabled=true の商品だけ）
--     inv_channel_stock_feed    楽天など販売チャネルへ送る販売可能数量（社内用）
--
--   操作用の関数（画面から直接UPDATEせず、必ずこれを通す）
--     inv_item_op()        貸出／返却／移動／状態変更／廃棄／予約解除／棚卸確認
--     inv_listing_set()    出品情報を入れ直す（個体1台ならinventory_channels、
--                          商品まるごとならinventory_channel_listingsに書く）
--     inv_reserve_available_item() 在庫の個体を1台確保する共通処理（下の2つが使う）
--     inv_rental_apply()      8RENTからのレンタル申込（条件と台数で申し込み、個体はサーバーが割り当てる）
--     inv_rental_request()    上の1台ぶんの入口（商品コードを1つ指定する）
--     inv_rental_allocate()   取り寄せ（調達確認）の申込に、入ってきた現物を割り当てる
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

-- まとめて書き換える保守操作は、Webのログインを持たないDB管理セッション
-- （Supabase SQL Editor・psql）からも実行したい。実行元は session_user で見分ける。
--   PostgREST … authenticator でDBに接続し、リクエストごとに SET ROLE anon/authenticated
--               するので session_user は常に 'authenticator'
--   SQL Editor … postgres などで直接ログインするので session_user はそのロール名
-- current_user は SECURITY DEFINER で関数所有者に変わるため判定に使わない。
-- session_user は SET ROLE でも SECURITY DEFINER でも変わらないので迂回できない。
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
   PostgREST経由（anon/authenticated/service_role）は session_user が authenticator なので false。';

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

alter table public.inventory_categories add column if not exists parent_id text;
alter table public.inventory_categories add column if not exists enabled   boolean not null default true;
alter table public.inventory_categories add column if not exists aliases   text[]  not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_categories_parent_fk') then
    alter table public.inventory_categories
      add constraint inventory_categories_parent_fk
      foreign key (parent_id) references public.inventory_categories(id) on delete restrict;
  end if;
end $$;

comment on column public.inventory_categories.parent_id is
  '親カテゴリー。パソコン → ノートパソコン / デスクトップパソコン のような入れ子に使う。';
comment on column public.inventory_categories.enabled is
  '使えるかどうか。false は新規登録の候補に出さない。既存商品では名前を出し「無効」の印をつける。';
comment on column public.inventory_categories.aliases is
  'CSV取込などで受け付ける別名。表示名を変えても取込が壊れないようにするためのもの。';
comment on column public.inventory_categories.name is
  'カテゴリー名。/zaiko も公開側もこれを出す（1つのマスターを正とする）。
   公開側だけ別の名前にしたいときだけ public_name を入れる。';
create index if not exists inventory_categories_parent_idx
  on public.inventory_categories (parent_id, sort_no);

-- 同じ親の下に同じ名前を作らせない
create unique index if not exists inventory_categories_uniq_name
  on public.inventory_categories (coalesce(parent_id, ''), name);

-- 公開画面（8ECトップの「カテゴリーから探す」）で使う情報。
-- 社内の呼び名（name）を変えずに、公開表記・並び・アイコンだけを別に持つ
alter table public.inventory_categories add column if not exists public_name   text;
alter table public.inventory_categories add column if not exists public_icon   text;
alter table public.inventory_categories add column if not exists public_sort   integer;
alter table public.inventory_categories add column if not exists public_listed boolean not null default false;

comment on column public.inventory_categories.public_name is
  '公開側だけ別名にしたいときの上書き。空なら name を使う。通常は空
   （/zaiko と公開側は同じ name を出す＝1つのマスターを正とする）。';
comment on column public.inventory_categories.public_icon is
  'タイルのアイコン（Material Symbols の名前）。空なら devices_other。';
comment on column public.inventory_categories.public_sort is
  '公開側だけ並びを変えたいときの上書き。空なら sort_no を使う。通常は空。';
comment on column public.inventory_categories.public_listed is
  'トップの「カテゴリーから探す」に出すかどうか。商品が0件でも出す（扱っていない、と見せないため）。';

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

alter table public.inventory_locations add column if not exists enabled boolean not null default true;

comment on column public.inventory_locations.enabled is
  '使えるかどうか。false は新規登録・移動の選択肢に出さない。
   すでに置いてあるものの表示には出す（名前が消えると履歴が読めなくなるため）。';
comment on column public.inventory_locations.kind is
  'site(拠点) / room(倉庫・部屋) / shelf(棚) / other(その他)';

-- 同じ親の下に同じ名前を作らせない。別の拠点に同名の「倉庫」があるのは許す
create unique index if not exists inventory_locations_uniq_name
  on public.inventory_locations (coalesce(parent_id, ''), name);

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

  -- 帳簿在庫＝販売できる手元在庫（在庫・出品中）だけを対象にする。
  --   貸出中・予約中・販売予約 … お客様の手元／確保済みで、現物を見に行けない
  --   売却済・廃棄             … もう持っていない
  --   修理中・故障・紛失・不明 … 販売可能在庫ではない
  -- ここに混ぜると「未確認」が実態より多く出て、差異候補が意味を失う。
  insert into public.inventory_stocktake_items (stocktake_id, item_id, expected)
  select st.id, i.id, true
  from public.inventory_items i
  where i.status in ('在庫', '出品中')
    and (p_scope is null or i.location_id in (select id from public.inv_location_tree(p_scope)));

  return st;
end $$;

comment on function public.inv_start_stocktake is
  '棚卸を始める。対象（帳簿在庫）は status in (''在庫'',''出品中'') の個体だけを
   expected=true で並べる。在庫の状態は何も変えない。';

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

-- 公開画面に出す12カテゴリーのうち、既存IDで表せないもの。
-- 「スマホ・タブレットアクセサリ」は機器そのものではなく付属品なので、
-- tablet／phone には寄せず別IDにしている
insert into public.inventory_categories (id, name, kind, code_prefix, sort_no) values
  ('software',   'ソフトウェア',           'quantity',   null,  160),
  ('storage',    '外付けドライブ・ストレージ', 'individual', 'ST',  80),
  ('server',     'サーバー関連',           'individual', 'SV',  90),
  ('parts',      'パソコンパーツ',         'quantity',   null,  170),
  ('mobile-acc', 'スマホ・タブレットアクセサリ', 'quantity', null,  180),
  ('ups',        'UPS（無停電電源装置）',   'individual', 'UP',  100)
on conflict (id) do nothing;

-- 公開する12カテゴリーを、指定された順番・表記で確定させる
update public.inventory_categories c
   set public_name   = v.pname,
       public_icon   = v.picon,
       public_sort   = v.psort,
       public_listed = true
  from (values
    ('pc',         'パソコン',                     'laptop_mac',        10),
    ('monitor',    'ディスプレイ・モニター',         'desktop_windows',   20),
    ('software',   'ソフトウェア',                 'apps',              30),
    ('consume',    'パソコンサプライ・消耗品',       'inventory_2',       40),
    ('network',    '無線LAN・ネットワーク機器',      'router',            50),
    ('printer',    'プリンター・プロジェクター',      'print',             60),
    ('storage',    '外付けドライブ・ストレージ',      'hard_drive',        70),
    ('input',      'キーボード・マウス・ウェブカメラ', 'keyboard',          80),
    ('server',     'サーバー関連',                 'dns',               90),
    ('parts',      'パソコンパーツ',               'memory',           100),
    ('mobile-acc', 'スマホ・タブレットアクセサリ',    'smartphone',       110),
    ('ups',        'UPS（無停電電源装置）',         'battery_charging_full', 120)
  ) as v(id, pname, picon, psort)
 where c.id = v.id;

update public.inventory_categories c
   set aliases = (
         select array_agg(distinct a) from unnest(
           c.aliases || array[c.name, btrim(coalesce(c.public_name, ''))]) a
          where btrim(coalesce(a, '')) <> ''
             and btrim(a) is distinct from btrim(coalesce(nullif(btrim(coalesce(c.public_name,'')),''), c.name)))
 where btrim(coalesce(c.public_name, '')) <> ''
   and btrim(c.public_name) is distinct from c.name;

update public.inventory_categories
   set name = btrim(public_name),
       public_name = null
 where btrim(coalesce(public_name, '')) <> ''
   and btrim(public_name) is distinct from name;

-- 並びも1つにする（public_sort は「公開だけ変えたいとき」の上書きに戻す）
update public.inventory_categories
   set sort_no = public_sort, public_sort = null
 where public_sort is not null and public_sort is distinct from sort_no;

-- CSVで昔から使われている表記を、パソコンの別名として受け付ける。
-- 'ノートPC' 'デスクトップPC' はここには入れない（子カテゴリーの別名なので、
-- 親に付けると どちらに寄せるか決まらなくなる）
update public.inventory_categories
   set aliases = (select array_agg(distinct a)
                    from unnest(aliases || array['PC','ＰＣ','パソコン']) a
                   where btrim(coalesce(a,'')) <> '' and btrim(a) <> name)
 where id = 'pc';

insert into public.inventory_categories
  (id, name, kind, code_prefix, sort_no, parent_id, enabled, public_listed, public_icon, aliases)
values
  ('notebook-pc', 'ノートパソコン',       'individual', 'PC', 11, 'pc', true, true, 'laptop_mac',      array['ノートPC','ノート','notebook']),
  ('desktop-pc',  'デスクトップパソコン', 'individual', 'PC', 12, 'pc', true, true, 'desktop_windows', array['デスクトップPC','デスクトップ','desktop'])
on conflict (id) do nothing;

-- すでに入っているときも、親と並びだけはこの通りにそろえる
update public.inventory_categories
   set parent_id = 'pc', public_listed = true, enabled = true
 where id in ('notebook-pc', 'desktop-pc');

-- 商品とカテゴリーの紐付けは触りません。category_id は inventory_categories(id) への
-- 外部キーなので 'PC' という値はそもそも入らず、商品はもとからIDで紐づいています。
-- 画面に 'PC' と出ていたのは表示名（name）が 'PC' だったためで、上で 'パソコン' に
-- そろえたので、紐付けを触らずにすべての画面の表記が変わります。


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

insert into public.inventory_locations (id, parent_id, name, kind, sort_no, enabled)
values ('L30', null, 'SB C&S', 'site', 40, true)
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
    -- 履歴だけ見て「どこへ・いくらで・原価は・利益は」が分かるようにする。
    -- 売却先（sold_channel）は inv_item_sell が先に入れている
    v_after  := '売却済'
                || coalesce('（' || nullif(btrim(coalesce(it.sold_channel,'')),'') || '）', '')
                || coalesce('（' || to_char(v_sold, 'FM9,999,999,999') || '円'
                   || case when coalesce(it.cost,0) > 0
                        then '／原価 ' || to_char(it.cost, 'FM9,999,999,999') || '円'
                          || '／利益 ' || to_char(v_sold - it.cost, 'FM9,999,999,999') || '円'
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
      -- 帳簿に無い現物を読んだときに足す行は「帳簿外現物」（expected=false）。
      -- すでに対象（expected=true）なら checked_at だけ更新し、true のまま触らない。
      -- こうしないと棚卸の途中で帳簿在庫 241台が 242台へ増えてしまう。
      insert into public.inventory_stocktake_items (stocktake_id, item_id, expected, checked_at)
      values (st_id, p_item_id, false, now())
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

-- 8RENTで1枚のカードにまとめる単位（メーカー＋型番）。同じ型番でメモリ違い・Office違いの
-- 枝番が分かれていても、お客様から見れば1機種なので、この単位でまとめて見せる
create or replace function public.inv_model_key(
  p_maker text,
  p_model text,
  p_code  text default null
) returns text language sql immutable set search_path = public as $$
  select case
    when coalesce(btrim(p_model), '') = '' then coalesce(p_code, '')
    else public.inv_norm_model(coalesce(p_maker, '')) || '/' || public.inv_norm_model(p_model)
  end;
$$;
comment on function public.inv_model_key is
  '8RENTで1枚のカードにまとめる単位（メーカー＋型番）。型番が無ければ商品コードをそのまま返し、
   別の商品と混ざらないようにする。表記ゆれは inv_norm_model でそろえる。';

create index if not exists inventory_products_model_key_idx
  on public.inventory_products (public.inv_model_key(maker, model, code))
  where kind = 'individual';

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
-- 楽天APIが返した正式な掲載URLが、保存済みURLと違ったときの「更新候補」。
-- 勝手に書き換えず、人が/zaikoで確認してから採用する（古いURL・誤URLの検知用）
alter table public.inventory_channel_listings add column if not exists url_candidate text;
alter table public.inventory_channel_listings add column if not exists url_checked_at timestamptz;
comment on column public.inventory_channel_listings.url_candidate is
  'API同期でモール側の正式URLが保存済みURLと違ったときに入る更新候補。inv_listing_url_accept() で採用、
   inv_listing_url_dismiss() で取り消す。自動では書き換えない。';

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

-- ------------------------------------------------------------
-- 27b-2) 個体別の出品情報から、商品単位の楽天listingを補う
--
--     中古は「実物1台ごとに出品」が基本なので、出品情報は個体別
--     （inventory_channels）に入っている。ところが同じ商品ページ（同じURL）に
--     2台以上をぶら下げている場合、商品単位の inventory_channel_listings に
--     楽天の行が無いままになり、楽天APIの画像同期の対象から漏れる。
--     （例：P-00536 は個体 00039769953 / 00039770113 が同じ楽天URLを共有。
--       商品単位の楽天listingが無いため画像が入らなかった）
--
--     ここでは個体別の行から商品単位の行を作る。
--       ・channel='rakuten' の行だけを見る
--       ・同じ商品で同じURL/SKUの行はまとめて1件にする
--       ・すでに商品単位の楽天listingがある商品は作らない（重複させない）
--       ・url / state / price / sku を引き継ぐ
--       ・external_item_code は推測しない（URLやSKUから組み立てない）。
--         次に楽天API同期が成功したとき、APIが返す正式な値を保存する
--       ・元の inventory_channels は消さない（1台ごとの記録はそのまま残す）
--     同じ商品で違うURLが混ざっていた場合は、いま手元にある個体で多く使われて
--     いるほうを採り、混在していたことを notice で知らせる（人が確認できるように）。
-- ------------------------------------------------------------
do $$
declare
  v_created integer := 0;
  v_mixed   integer := 0;
  r record;
begin
  -- 同じ商品・同じURL・同じSKUの行をひとかたまりにする。
  -- ここで2かたまり以上になる商品（違うURL/SKUが混ざっている）は自動で作らない
  create temporary table if not exists tmp_listing_src (
    product_code text, url text, sku text, state text, price numeric,
    rows integer, any_listed boolean, updated_at timestamptz
  ) on commit drop;
  delete from tmp_listing_src;

  insert into tmp_listing_src
  select c.product_code,
         nullif(btrim(coalesce(c.url, '')), '') as url,
         nullif(btrim(coalesce(c.sku, '')), '') as sku,
         (array_agg(c.state order by (c.state = '出品中') desc nulls last, c.updated_at desc nulls last))[1] as state,
         -- 価格はモールでの販売価格（inventory_channels.price）をそのまま引き継ぐ。
         -- 自社の販売予定価格（inventory_items.plan_price）は別概念なので使わない
         max(c.price)      as price,
         count(*)::integer as rows,
         bool_or(c.state = '出品中') as any_listed,
         max(c.updated_at) as updated_at
    from public.inventory_channels c
   where c.channel = 'rakuten'
     and (nullif(btrim(coalesce(c.url, '')), '') is not null
          or nullif(btrim(coalesce(c.sku, '')), '') is not null)
   group by c.product_code,
            nullif(btrim(coalesce(c.url, '')), ''),
            nullif(btrim(coalesce(c.sku, '')), '');

  -- 違うURL/SKUが混ざっている商品は「要確認」。自動では作らない
  -- （どれが正しい掲載かは人にしか決められないため）
  for r in
    select product_code, count(*) as n,
           string_agg(distinct coalesce(url, '(URLなし)'), ' / ') as urls
      from tmp_listing_src
     group by product_code having count(*) > 1
  loop
    v_mixed := v_mixed + 1;
    raise notice '要確認：商品 % は個体ごとに違う楽天の掲載があります（% 種類）。自動では作りません： %',
      r.product_code, r.n, r.urls;
  end loop;

  -- 1種類にまとまった商品だけ作る（すでに楽天listingがある商品は作らない）
  with pick as (
    select t.* from tmp_listing_src t
     where t.product_code in (select product_code from tmp_listing_src group by product_code having count(*) = 1)
  ), ins as (
    insert into public.inventory_channel_listings
      (product_code, channel, state, sku, price, url, note, created_at, updated_at)
    select p.product_code, 'rakuten',
           case when p.any_listed then '出品中' else p.state end,
           p.sku, p.price, p.url,
           '個体別の出品情報から補完（' || p.rows || '台が同じ掲載）',
           now(), now()
      from pick p
     where not exists (
       select 1 from public.inventory_channel_listings l
        where l.product_code = p.product_code and l.channel = 'rakuten')
    returning product_code, url, price
  ), tx as (
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    select '移行', 'product', i.product_code,
           (select coalesce(name, model) from public.inventory_products where code = i.product_code),
           '楽天listingを補完', null,
           coalesce(i.url, '') || coalesce('（' || to_char(i.price, 'FM9,999,999,999') || '円）', '')
      from ins i
    returning 1
  )
  select count(*)::integer into v_created from tx;

  raise notice '個体別の出品情報から、商品単位の楽天listingを % 件つくりました（要確認 % 商品）',
    coalesce(v_created, 0), v_mixed;
end $$;

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
--     /zaiko の自社在庫のうち rental_enabled=true の商品だけを、8EC
--     （8ECトップ・8RENT）にレンタル商品として公開する。楽天に出品中か
--     どうかはレンタル公開の条件にしない（8ECはレンタルサイト、楽天は
--     販売サイト、という別チャネルの扱い）。逆に、8ECでレンタル対象に
--     しても楽天の掲載は解除しない。
--
--     レンタルを受け付けられるのは
--       rental_enabled = true かつ status='在庫' の個体が1台以上あるとき。
--     最後の1台が楽天で売れて '販売予約' になれば、8ECは自動的に
--     「在庫切れ」になる（レンタル可能数が0になるため）。
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
-- 在庫が無くても申込を受けられるか（取り寄せ）。仮の個体は作らず、現物が入ってから割り当てる
alter table public.inventory_products add column if not exists procurement_available boolean not null default false;
-- 楽天の商品説明の原文（販売用）。8ECのレンタル画面には出さない
alter table public.inventory_products add column if not exists sale_description text;
-- 中古品としての状態（事実情報）
alter table public.inventory_products add column if not exists condition_note text;
-- レンタル向け説明を人が直したか。true なら自動生成でも楽天同期でも上書きしない
alter table public.inventory_products add column if not exists rental_description_manual boolean not null default false;
-- レンタル説明のひな形を決める区分と、8ECでの出しかた
alter table public.inventory_products add column if not exists rental_form         text;
alter table public.inventory_products add column if not exists rental_listing_type text not null default 'standalone';
-- Officeを付けられないことがはっきりしている商品だけ true（false は「未確認」）
alter table public.inventory_products add column if not exists office_unavailable  boolean not null default false;

-- 販売（8EC BUY）。レンタル側と同じ形でそろえる。どちらか片方でも両方でもよい。
--   楽天の出品価格（inventory_channel_listings.price）と販売予定価格
--   （inventory_items.plan_price）は社内の参考値なので、ここへ自動コピーしない
alter table public.inventory_products add column if not exists sale_enabled               boolean not null default false;
alter table public.inventory_products add column if not exists sale_price                 integer;
alter table public.inventory_products add column if not exists sale_condition             text;
alter table public.inventory_products add column if not exists sale_procurement_available boolean not null default false;
alter table public.inventory_products drop constraint if exists inventory_products_sale_condition_chk;
alter table public.inventory_products add constraint inventory_products_sale_condition_chk
  check (sale_condition is null or sale_condition in ('新品', '整備済み', '中古'));
alter table public.inventory_products drop constraint if exists inventory_products_sale_price_chk;
alter table public.inventory_products add constraint inventory_products_sale_price_chk
  check (sale_price is null or (sale_price > 0 and sale_price <= 100000000));
create index if not exists inventory_products_sale_idx
  on public.inventory_products (sale_enabled) where sale_enabled;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_products_rental_form_chk') then
    alter table public.inventory_products add constraint inventory_products_rental_form_chk
      check (rental_form is null or rental_form in ('notebook','desktop','monitor','peripheral','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_products_rental_listing_type_chk') then
    alter table public.inventory_products add constraint inventory_products_rental_listing_type_chk
      check (rental_listing_type in ('standalone','option','not_public'));
  end if;
end $$;

comment on column public.inventory_products.rental_form is
  'レンタル説明のひな形を決める区分（notebook/desktop/monitor/peripheral/other）。
   nullは未分類で、分かっている事実から推定する。推定できなければかたちを断定しない文章にする。';
comment on column public.inventory_products.rental_listing_type is
  '8ECでの出しかた。standalone=単品レンタルとしてカード公開／option=PCレンタルのオプション（単独公開しない）／not_public=公開しない。';
comment on column public.inventory_products.office_unavailable is
  'Officeを付けられないことがはっきりしている商品だけ true。office_supported=false は「不可」ではなく「未確認」。';

comment on column public.inventory_products.procurement_available is
  '在庫が無くてもレンタルの申込を受けられるか（取り寄せ）。true なら8RENTに「取り寄せ可能」として出て、
   申込は「調達確認」から始まる。仮の個体は作らない。';

comment on column public.inventory_products.rental_enabled is
  'true の商品だけが8EC（トップ＝8RENT）に掲載される。source of truthは/zaiko。
   実際に貸せるかは、個体側の inventory_items.rental_eligible と在庫状況で決まる。';

-- 個体単位のレンタル対象（「同じ商品10台のうち3台だけ8RENTに回す」を可能にする）
--   商品 rental_enabled … その商品を8ECに掲載するか
--   個体 rental_eligible … この1台をレンタルに回すか
-- 8ECのレンタル可能数 = status='在庫' かつ rental_eligible=true の個体数。
-- 既定は false（明示的に「8RENTに出す」と選んだ個体だけが対象になる）。
alter table public.inventory_items add column if not exists rental_eligible boolean default false;
comment on column public.inventory_items.rental_eligible is
  'この個体を8RENT（レンタル）に回すか。true でも status=''在庫'' の間は楽天でも売れる。
   8ECで予約されれば予約中、楽天で売れれば販売予約になり、どちらか一方にしか確保されない。';
create index if not exists inventory_items_rental_eligible_idx
  on public.inventory_items (product_code) where rental_eligible;

-- 貸出の予定返却日（まとめて貸し出すときに入れられるようにする）
alter table public.inventory_loans add column if not exists due_on date;
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

-- 取り寄せ（在庫0でも申込を受ける）の切り替え。8RENTの公開設定とは別の判断なので
-- inv_product_rental_set とは分けて持つ（既存の呼び出しの形を変えない）
create or replace function public.inv_product_procurement_set(
  p_code text,
  p_on   boolean
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr       public.inventory_products;
  v_before text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into pr from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  v_before := case when coalesce(pr.procurement_available, false) then '取り寄せ可' else '取り寄せ不可' end;

  update public.inventory_products
     set procurement_available = coalesce(p_on, false)
   where code = p_code
  returning * into pr;

  if v_before <> (case when pr.procurement_available then '取り寄せ可' else '取り寄せ不可' end) then
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'product', p_code, coalesce(pr.name, pr.model), '8RENT取り寄せ設定',
            v_before, case when pr.procurement_available then '取り寄せ可' else '取り寄せ不可' end);
  end if;

  return pr;
end $$;

comment on function public.inv_product_procurement_set is
  '在庫が無くてもレンタルの申込を受けるか（取り寄せ）を切り替える。8RENTでは「取り寄せ可能」と出て、
   申込は「調達確認」から始まる。仮の個体は作らない。';

-- ------------------------------------------------------------
-- 29-1b) 販売設定（法人向けに売るかどうか・公開価格・状態・取り寄せ）
-- ------------------------------------------------------------
create or replace function public.inv_product_sale_set(
  p_code        text,
  p_enabled     boolean,
  p_price       integer default null,
  p_condition   text default null,
  p_procurement boolean default null
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr       public.inventory_products;
  v_before text;
  v_after  text;
  v_cond   text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  v_cond := nullif(btrim(coalesce(p_condition, '')), '');
  if v_cond is not null and v_cond not in ('新品', '整備済み', '中古') then
    raise exception '商品の状態は 新品 / 整備済み / 中古 のいずれかでお願いします（%）', v_cond;
  end if;
  if p_price is not null and (p_price <= 0 or p_price > 100000000) then
    raise exception '販売価格は1円〜1億円の範囲で入れてください（%）', p_price;
  end if;

  select * into pr from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;

  v_before := (case when coalesce(pr.sale_enabled, false) then '販売する' else '販売しない' end)
              || ' / ' || coalesce(pr.sale_price::text, '価格未設定')
              || ' / ' || coalesce(pr.sale_condition, '状態未設定')
              || (case when coalesce(pr.sale_procurement_available, false) then ' / 取り寄せ可' else '' end);

  update public.inventory_products
     set sale_enabled               = coalesce(p_enabled, false),
         sale_price                 = p_price,
         sale_condition             = v_cond,
         sale_procurement_available = coalesce(p_procurement, false)
   where code = p_code
  returning * into pr;

  v_after := (case when pr.sale_enabled then '販売する' else '販売しない' end)
             || ' / ' || coalesce(pr.sale_price::text, '価格未設定')
             || ' / ' || coalesce(pr.sale_condition, '状態未設定')
             || (case when pr.sale_procurement_available then ' / 取り寄せ可' else '' end);

  if v_before is distinct from v_after then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'product', p_code, coalesce(pr.name, pr.model), '販売設定',
            v_before, v_after);
  end if;

  return pr;
end $$;

comment on function public.inv_product_sale_set is
  '商品を法人向けに販売するかどうかと、公開販売価格・状態・取り寄せ可否を決める。
   楽天の出品価格や inventory_items.plan_price は見ない（参考値であって公開価格ではないため）。
   価格が未設定でも販売はできる（公開画面は「販売価格はお見積り」と出す）。';














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

-- 1件の申込で複数台を借りられる。割り当てた個体は item_ids に入れ、item_id は
-- 最初の1台を指したまま残す（これまでの画面と履歴がそのまま読めるように）
alter table public.inventory_rental_requests
  add column if not exists qty         integer not null default 1,
  add column if not exists item_ids    text[]  not null default '{}',
  add column if not exists procure_qty integer not null default 0,
  add column if not exists office      boolean not null default false,
  add column if not exists model_key   text,
  add column if not exists conditions  jsonb   not null default '{}'::jsonb;

comment on column public.inventory_rental_requests.qty         is '申し込まれた台数。';
comment on column public.inventory_rental_requests.item_ids    is '割り当てた実物の管理番号。割り当てはサーバー側だけが行う。';
comment on column public.inventory_rental_requests.procure_qty is '在庫から割り当てられず、取り寄せで手当てする台数。';
comment on column public.inventory_rental_requests.office      is 'Officeを付けるか（申込のオプション。別商品にはしない）。';
comment on column public.inventory_rental_requests.model_key   is 'メーカー＋型番。取り寄せぶんを後から割り当てるときの探し先。';
comment on column public.inventory_rental_requests.conditions  is 'お客様が選んだ条件（CPU・メモリなど）の控え。';

comment on table public.inventory_rental_requests is
  '8RENTからのレンタル申込。お客様は条件と台数だけを選び、どの個体を貸すかはサーバーが決める。
   状態は 申込（在庫を確保済み・発送待ち）／調達確認（取り寄せ待ち）／貸出中／返却済み／キャンセル。';

drop trigger if exists inventory_rental_requests_touch on public.inventory_rental_requests;
create trigger inventory_rental_requests_touch before update on public.inventory_rental_requests
  for each row execute function public.inv_touch();

-- ------------------------------------------------------------
-- 29-2b) 在庫確保の共通処理（8ECのレンタル予約と、楽天などの販売予約が共用する）
--
--     楽天で売れたら8ECで借りられなくなり、8ECで借りられたら楽天の販売可能数量から
--     外れる、を保証するための唯一の入口（掲載そのものはどちらでも解除しない）。「status='在庫' の個体を1台、行ロックして
--     指定の状態にする」だけを行い、呼び出し元固有の記録（申込テーブルへのinsert・
--     出品情報の更新など）は行わない。同じ商品コードに対して2つの経路
--     （inv_rental_request と inv_sale_reserve）が同時に呼ばれても、
--     for update skip locked により在庫1台につきどちらか一方しか成功しない。
--
--     権限チェックはしない（anon から呼ばれる inv_rental_request 経由の
--     利用があるため）。呼び出し元の関数が権限確認を行うこと。
--     直接RPCとしては公開しない（grantしない）。
-- ------------------------------------------------------------
drop function if exists public.inv_reserve_available_item(text, text);
create or replace function public.inv_reserve_available_item(
  p_code        text,
  p_new_status  text,
  p_rental_only boolean default false
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item_id text;
begin
  -- p_rental_only=true（8RENTの申込）… rental_eligible の個体だけを対象にする
  -- p_rental_only=false（楽天などの販売）… 在庫の個体すべて。ただし
  --   レンタル対象に選んだ個体は後回しにして、販売はまず対象外の個体から取る
  select id into v_item_id
    from public.inventory_items
   where product_code = p_code and status = '在庫'
     and (not p_rental_only or coalesce(rental_eligible, false))
   order by case when coalesce(rental_eligible, false) then 1 else 0 end, id
   limit 1
   for update skip locked;

  if v_item_id is not null then
    update public.inventory_items set status = p_new_status where id = v_item_id;
  end if;

  return v_item_id;
end $$;

comment on function public.inv_reserve_available_item is
  '在庫（status=''在庫''）の個体を1台、行ロックして指定の状態にする。無ければNULL。
   p_rental_only=true なら rental_eligible=true の個体だけ（8RENTの申込用）。
   false（販売）のときは、レンタル対象に選んだ個体を後回しにして確保する。
   8ECのレンタル申込（予約中にする）と楽天等の販売予約（販売予約にする）が、
   同じ実在庫を安全に取り合うための共通処理。ここで確保された個体は、
   レンタル可能数からも楽天へ送る販売可能数量からも同時に外れる。';

-- ------------------------------------------------------------
-- 29-3) 条件から申し込む（公開ページから anon が呼ぶ）
--       お客様は「機種と条件と台数」だけを選び、どの個体を貸すかはここで決める
--       （管理番号は公開ページに出さないし、受け取りもしない）。
--       確保は申込と同じトランザクションで行う。これをしないと、ほぼ同時の
--       2件の申込で同じ1台が二重に割り当たる。
--       在庫が足りないときは、取り寄せできる商品なら「調達確認」で受け付ける。
--       在庫が無いのに仮の個体を作って予約することはしない。
-- ------------------------------------------------------------
create or replace function public.inv_rental_request_create(
  p_codes      text[],
  p_name       text,
  p_qty        integer default 1,
  p_company    text default null,
  p_email      text default null,
  p_phone      text default null,
  p_start      date    default null,
  p_months     integer default null,
  p_office     boolean default false,
  p_message    text    default null,
  p_conditions jsonb   default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_codes  text[];
  v_keys   text[];
  v_key    text;
  v_req_id bigint;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'お名前を入力してください';
  end if;
  if coalesce(p_qty, 1) < 1 or coalesce(p_qty, 1) > 500 then
    raise exception '台数は1〜500台でお願いします（それ以上はご相談ください）';
  end if;

  -- 機種が指定されていれば、公開中のものだけに絞る。指定が無くても受け付ける
  -- （「条件だけ送る」相談も8RENTの入口なので断らない）
  if p_codes is not null and coalesce(array_length(p_codes, 1), 0) > 0 then
    select array_agg(code order by code), array_agg(distinct public.inv_model_key(maker, model, code))
      into v_codes, v_keys
      from public.inventory_products
     where code = any(p_codes) and kind = 'individual' and coalesce(rental_enabled, false);
    if coalesce(array_length(v_keys, 1), 0) > 1 then
      raise exception '別々の機種はまとめて申し込めません';
    end if;
    v_key := v_keys[1];
  end if;

  insert into public.inventory_rental_requests
    (product_code, item_id, item_ids, qty, procure_qty, office, model_key, conditions,
     customer_name, company, email, phone, start_date, months, message, status)
  values
    (v_codes[1], null, '{}', p_qty, p_qty, coalesce(p_office, false), v_key,
     coalesce(p_conditions, '{}'::jsonb),
     btrim(p_name), nullif(btrim(coalesce(p_company,'')),''),
     nullif(btrim(coalesce(p_email,'')),''), nullif(btrim(coalesce(p_phone,'')),''),
     p_start, p_months, nullif(btrim(coalesce(p_message,'')),''), '希望受付')
  returning id into v_req_id;

  return jsonb_build_object('request_id', v_req_id, 'status', '希望受付', 'qty', p_qty);
end $$;

comment on function public.inv_rental_request_create is
  '8RENTからの「希望条件の送信」。条件と台数だけを受け取り、実在庫は動かさない（status=希望受付）。
   在庫が無くても受け付ける。個体の確保は社内で inv_rental_allocate を実行したときだけ行う。';

create or replace function public.inv_rental_set_status(
  p_request_id bigint,
  p_status     text
) returns public.inventory_rental_requests
language plpgsql security invoker set search_path = public as $$
declare
  r     public.inventory_rental_requests;
  it    public.inventory_items;
  v_ids text[];
  v_id  text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_status not in ('在庫・調達確認','レンタル確定','貸出中','返却済み','キャンセル') then
    raise exception '知らない状態です（%）', p_status;
  end if;

  select * into r from public.inventory_rental_requests where id = p_request_id for update;
  if not found then
    raise exception '申込が見つかりません（%）', p_request_id;
  end if;
  if r.status in ('返却済み','キャンセル') then
    raise exception 'この申込はすでに「%」で終わっています', r.status;
  end if;

  v_ids := case when coalesce(array_length(r.item_ids, 1), 0) > 0 then r.item_ids
                when r.item_id is not null then array[r.item_id]
                else '{}'::text[] end;

  if p_status = '在庫・調達確認' then
    if r.status <> '希望受付' then
      raise exception '「希望受付」の申込だけ確認中にできます（いまは %）', r.status;
    end if;

  elsif p_status = 'レンタル確定' then
    if r.status <> '個体割当' then
      raise exception '個体を割り当ててから確定してください（いまは %）', r.status;
    end if;

  elsif p_status = '貸出中' then
    if r.status <> 'レンタル確定' then
      raise exception '「レンタル確定」の申込だけ発送できます（いまは %）', r.status;
    end if;
    if coalesce(array_length(v_ids, 1), 0) = 0 then
      raise exception '個体が割り当てられていません';
    end if;
    foreach v_id in array v_ids loop
      select * into it from public.inventory_items where id = v_id for update;
      if coalesce(it.status, '') <> '予約中' then
        raise exception '予約中の個体だけ貸出中にできます（% は %）', v_id, coalesce(it.status, '個体なし');
      end if;
      update public.inventory_items
         set status = '貸出中', user_name = r.customer_name, loaned_at = now()
       where id = v_id;
    end loop;

  elsif p_status = '返却済み' then
    if coalesce(array_length(v_ids, 1), 0) = 0 then
      raise exception '個体が割り当てられていません';
    end if;
    foreach v_id in array v_ids loop
      select * into it from public.inventory_items where id = v_id for update;
      if coalesce(it.status, '') <> '貸出中' then
        raise exception '貸出中の個体だけ返却済みにできます（% は %）', v_id, coalesce(it.status, '個体なし');
      end if;
      update public.inventory_items
         set status = '在庫', user_name = null, loaned_at = null
       where id = v_id;
    end loop;

  elsif p_status = 'キャンセル' then
    -- どの段階からでも取り消せる。確保済みの個体だけ在庫に戻す（発送済みは返却で扱う）
    foreach v_id in array coalesce(v_ids, '{}'::text[]) loop
      select * into it from public.inventory_items where id = v_id for update;
      if coalesce(it.status, '') = '貸出中' then
        raise exception '発送済みです。「返却済みにする」を使ってください（% は 貸出中）', v_id;
      end if;
      if coalesce(it.status, '') = '予約中' then
        update public.inventory_items set status = '在庫' where id = v_id;
      end if;
    end loop;
  end if;

  foreach v_id in array coalesce(v_ids, '{}'::text[]) loop
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'item', v_id, r.customer_name, 'レンタル' || p_status, r.status, p_status);
  end loop;

  update public.inventory_rental_requests set status = p_status where id = p_request_id
  returning * into r;
  return r;
end $$;

comment on function public.inv_rental_set_status is
  'レンタル申込の状態を進める（希望受付 → 在庫・調達確認 → 個体割当 → レンタル確定 → 貸出中 → 返却済み）。
   紐づく個体の状態も同じトランザクションで連動させる。';

create or replace function public.inv_rental_allocate(p_request_id bigint)
returns public.inventory_rental_requests
language plpgsql security invoker set search_path = public as $$
declare
  r       public.inventory_rental_requests;
  v_ids   text[];
  v_codes text[];
  v_code  text;
  v_item  text;
  v_need  integer;
  i       integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into r from public.inventory_rental_requests where id = p_request_id for update;
  if not found then
    raise exception '申込が見つかりません（%）', p_request_id;
  end if;
  if r.status not in ('希望受付','在庫・調達確認','個体割当') then
    raise exception '「%」の申込には個体を割り当てられません', r.status;
  end if;
  if r.model_key is null and r.product_code is null then
    raise exception '機種が決まっていません。先に商品を決めてから割り当ててください';
  end if;

  v_ids := case when coalesce(array_length(r.item_ids, 1), 0) > 0 then r.item_ids
                when r.item_id is not null then array[r.item_id]
                else '{}'::text[] end;
  v_need := greatest(coalesce(r.qty, 1) - coalesce(array_length(v_ids, 1), 0), 0);

  if v_need > 0 then
    select array_agg(p.code order by p.code) into v_codes
      from public.inventory_products p
     where p.kind = 'individual'
       and coalesce(p.rental_enabled, false)
       and (not coalesce(r.office, false) or coalesce(p.office_supported, false))
       and (case when r.model_key is null then p.code = r.product_code
                 else public.inv_model_key(p.maker, p.model, p.code) = r.model_key end);
    if coalesce(array_length(v_codes, 1), 0) = 0 then
      raise exception 'この機種はいまレンタルを受け付けていません（商品の8RENT掲載を確認してください）';
    end if;
    for i in 1..v_need loop
      v_item := null;
      foreach v_code in array v_codes loop
        v_item := public.inv_reserve_available_item(v_code, '予約中', true);
        exit when v_item is not null;
      end loop;
      exit when v_item is null;
      v_ids := array_append(v_ids, v_item);
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values (public.inv_actor(), 'item', v_item, r.customer_name, '予約', '在庫',
              '予約中（申込 #' || r.id || '）');
    end loop;
  end if;

  update public.inventory_rental_requests
     set item_ids    = v_ids,
         item_id     = coalesce(v_ids[1], item_id),
         procure_qty = greatest(coalesce(r.qty, 1) - coalesce(array_length(v_ids, 1), 0), 0),
         status      = case when coalesce(array_length(v_ids, 1), 0) >= coalesce(r.qty, 1)
                            then '個体割当' else '在庫・調達確認' end
   where id = p_request_id
  returning * into r;
  return r;
end $$;

comment on function public.inv_rental_allocate is
  '申込に8RENT対象の在庫から個体を割り当てる。台数がそろったら「個体割当」に進む。
   足りないぶんは procure_qty に残し、仮の個体は作らない。';

-- ------------------------------------------------------------
-- 29-4b) 楽天など販売チャネルの受注で在庫を確保する（社内・/zaiko側の操作）
--
--     楽天RMSにはまだAPI連携がなく、受注はスタッフが楽天の管理画面を見て
--     手動でこの関数を呼ぶ運用になる（自動化にはRMS WEB SERVICEのAPI利用が必要）。
--     在庫の確保自体は inv_reserve_available_item() で8RENTと共通処理にするため、
--     同じ商品の最後の1台に楽天注文と8RENT申込がほぼ同時に来ても、
--     どちらか一方しか成功しない。
--
--     状態の流れ：在庫 → 販売予約 →（発送）→ 売却済（＝販売済み。既存の
--     inv_item_op の '売却' をそのまま使う。'売却' はどの状態からでも
--     実行できるため変更不要）
--                              →（発送前キャンセル）→ 在庫（inv_item_op の '予約解除'）
--
--     '販売予約' にした時点で、その個体は8ECのレンタル可能数からも、楽天へ送る
--     販売可能数量（inv_channel_stock_feed.sale_qty）からも外れる。
--     楽天の商品ページ（inventory_channel_listings）はここでは触らない
--     ＝受注が入っても掲載は維持する（在庫数だけが減る）。
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

  -- 在庫の個体を1台確保する。8RENT用に選んだ個体（rental_eligible）は後回しにして、
  -- まずレンタル対象外の個体から販売に回す
  v_item_id := public.inv_reserve_available_item(p_code, '販売予約', false);
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
   inv_reserve_available_item() を使うため、8ECのレンタル予約と同じ実在庫を取り合っても
   二重に確保されない。確保された個体は8ECのレンタル可能台数から即座に外れる。
   商品の掲載（inventory_channel_listings）は変更しない。
   RMS WEB SERVICE等のAPI連携が無い間は、スタッフが手動で呼ぶ。';

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


-- ------------------------------------------------------------
-- 30-1b) レンタル向け説明（商品のかたちごとに作り分ける）
--     inventory_products のスペック列がそろったあとに置く
--     （関数本体が p.cpu などを参照するため、列より前には作れない）
-- ------------------------------------------------------------

create or replace function public.inv_rental_form(p public.inventory_products)
returns text
language sql immutable set search_path = pg_catalog, public as $$
  select case
    when nullif(btrim(coalesce(p.rental_form,'')), '') is not null then btrim(p.rental_form)
    -- CPU・OS・メモリのどれかが分かっていればPC。画面があればノート、なければ据え置き
    when nullif(btrim(coalesce(p.cpu,'')),'') is not null
      or nullif(btrim(coalesce(p.os,'')),'') is not null
      or nullif(btrim(coalesce(p.memory_size,'')),'') is not null
      then case when nullif(btrim(coalesce(p.screen_size,'')),'') is not null
                then 'notebook' else 'desktop' end
    -- PCの手がかりが何も無く、画面サイズだけ分かっていればモニター
    when nullif(btrim(coalesce(p.screen_size,'')),'') is not null then 'monitor'
    else null            -- 分からない。かたちを断定しない
  end;
$$;

comment on function public.inv_rental_form is
  '未分類の商品を洗い出すときの目安。登録済みスペックの有無だけから、かたちの候補を返す
   （商品名やキーワードからの推測はしない）。公開文の生成には使わない
   （断定を避けるため、生成は明示された rental_form だけを見る）。';

create or replace function public.inv_rental_text(p_code text)
returns text
language plpgsql stable set search_path = public, pg_catalog as $$
declare
  p        public.inventory_products;
  v_form   text;
  v_screen numeric;
  v_mem    numeric;
  v_spec   text[] := '{}';
  v_out    text[] := '{}';
  v_head   text;
  v_has    boolean;
  v_unit   text;
begin
  select * into p from public.inventory_products where code = p_code;
  if not found then
    return null;
  end if;
  -- 明示された区分だけを使う。未分類なら推定しない
  v_form   := nullif(btrim(coalesce(p.rental_form, '')), '');
  v_screen := nullif(regexp_replace(coalesce(p.screen_size,''), '[^0-9.]', '', 'g'), '')::numeric;
  v_mem    := nullif(regexp_replace(coalesce(p.memory_size,''), '[^0-9]',   '', 'g'), '')::numeric;
  -- PCとして扱ってよい手がかりがあるか（Officeの案内を出してよいか）
  v_has := nullif(btrim(coalesce(p.cpu,'')),'') is not null
        or nullif(btrim(coalesce(p.os,'')),'') is not null
        or nullif(btrim(coalesce(p.memory_size,'')),'') is not null
        or nullif(btrim(coalesce(p.storage_capacity,'')),'') is not null;
  v_unit  := case when v_form in ('monitor','peripheral','other') then '数量' else '台数' end;

  -- ① どんな用途に向いているか
  if v_form in ('notebook','desktop') then
    if v_has then
      v_head := case
        when v_form = 'desktop' then '法人の事務作業向けのデスクトップPCです。'
        when v_screen is null then '法人の事務作業向けのノートPCです。'
        when v_screen <= 13.5 then coalesce(p.screen_size,'') || 'の持ち運びやすいノートPCです。'
        when v_screen <= 14.9 then coalesce(p.screen_size,'') || 'の標準的なサイズのノートPCです。'
        else coalesce(p.screen_size,'') || 'の大画面ノートPCです。' end;
      v_head := v_head || case
        when v_mem is not null and v_mem >= 16 then
          coalesce(p.cpu || '・', '') || 'メモリ' || coalesce(p.memory_size,'') ||
          'を搭載し、複数のアプリを並行して使う事務作業やオンライン会議にも対応しやすい構成です。'
        when v_mem is not null then
          coalesce(p.cpu || '・', '') || 'メモリ' || coalesce(p.memory_size,'') ||
          'を搭載し、文書作成・表計算・オンライン会議などの事務作業に向いた構成です。'
        when p.cpu is not null then p.cpu || 'を搭載しています。'
        else '' end;
    else
      v_head := '法人利用向けの'
             || case v_form when 'desktop' then 'デスクトップPC' else 'ノートPC' end
             || 'です。詳細な仕様は、ご希望条件に合わせてご案内します。';
    end if;
  elsif v_form = 'monitor' then
    v_head := coalesce(nullif(p.screen_size,'') || 'の', '') || '法人のオフィス利用向けのモニターです。'
           || case when nullif(btrim(coalesce(p.screen_size,'')),'') is null
                   then '設置環境やご利用台数に合わせてご案内します。' else '' end;
  elsif v_form = 'peripheral' then
    v_head := '法人でのご利用向けの周辺機器です。PCと合わせてのご利用にも対応します。';
  else
    -- 未分類、または other。かたちを断定しない
    v_head := '法人向けにレンタルできる機器です。詳細な仕様やご利用条件は、ご希望に合わせてご案内します。';
  end if;
  v_out := array_append(v_out, v_head);

  -- ② 主な仕様。分かっているものだけ書く。モニターにCPU・OSは出さない
  if v_form = 'monitor' then
    if nullif(btrim(coalesce(p.screen_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.screen_size)); end if;
    if nullif(btrim(coalesce(p.spec,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.spec)); end if;
  elsif v_form = 'peripheral' then
    if nullif(btrim(coalesce(p.spec,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.spec)); end if;
  else
    -- ノートPC・デスクトップPC・未分類は、入っている事実をそのまま並べる
    if nullif(btrim(coalesce(p.cpu,'')),'')  is not null then v_spec := array_append(v_spec, btrim(p.cpu)); end if;
    if nullif(btrim(coalesce(p.memory_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.memory_size)); end if;
    if nullif(btrim(coalesce(p.storage_capacity,'')),'') is not null then
      v_spec := array_append(v_spec, btrim(coalesce(p.storage_type || ' ', '') || p.storage_capacity));
    end if;
    if nullif(btrim(coalesce(p.screen_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.screen_size)); end if;
    if nullif(btrim(coalesce(p.os,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.os)); end if;
    if p.webcam    is true then v_spec := array_append(v_spec, 'Webカメラ'); end if;
    if p.wifi      is true then v_spec := array_append(v_spec, 'Wi-Fi'); end if;
    if p.bluetooth is true then v_spec := array_append(v_spec, 'Bluetooth'); end if;
    if p.numpad    is true then v_spec := array_append(v_spec, 'テンキー'); end if;
  end if;
  if coalesce(array_length(v_spec, 1), 0) > 0 then
    v_out := array_append(v_out, '主な仕様：' || array_to_string(v_spec, ' / '));
  end if;

  -- ③ Office。PCと明示された商品か、未分類でもPCの手がかりがある商品だけ。
  --    8RENTは希望を伺って用意するので、原則は「ご相談ください」
  if v_form in ('notebook','desktop') or (v_form is null and v_has) then
    v_out := array_append(v_out, case
      when coalesce(p.office_unavailable, false)
        then 'Office：この商品はOfficeの追加に対応できません。'
      when coalesce(p.office_supported, false)
        then 'Office：ご希望に応じてOffice付きでご用意できます。お申し込み時にお知らせください。'
      else 'Office：Officeの有無はお申し込み時にご希望をお知らせください。ご希望に応じてOffice環境をご案内します。'
    end);
  end if;

  -- ④ 付属品・接続まわり
  if nullif(btrim(coalesce(p.accessories,'')),'') is not null then
    v_out := array_append(v_out,
      case when v_form = 'monitor' then '接続・付属品：' else '付属品：' end || btrim(p.accessories));
  end if;

  -- ⑤ 中古品としての状態
  v_out := array_append(v_out, '状態：' || coalesce(nullif(btrim(coalesce(p.condition_note,'')), ''),
    '中古品です。動作を確認したうえで、クリーニングしてお渡しします。外観に使用に伴う小傷がある場合があります。'));

  -- ⑥ 希望を送ってもらう案内
  v_out := array_append(v_out,
    'ご希望の' || v_unit || '・利用期間'
    || case when v_form in ('notebook','desktop') or (v_form is null and v_has) then '・Officeの有無' else '' end
    || 'をお知らせください。在庫・調達状況を確認のうえ担当者よりご案内します。');

  return array_to_string(v_out, E'\n');
end $$;

comment on function public.inv_rental_text is
  'レンタル向け説明を、明示された rental_form のひな形で組み立てる。
   未分類の商品は、かたち（ノートPC／デスクトップ／モニター）を断定せず、
   分かっている仕様だけを並べる。推定（inv_rental_form）は未分類の洗い出し用で、
   公開文の生成には使わない。OfficeとPC向けの言い回しはPCのときだけ使う。';

create or replace function public.inv_product_rental_description_set(
  p_code   text,
  p_text   text default null,
  p_manual boolean default true
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr public.inventory_products;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_products
     set rental_description        = nullif(btrim(coalesce(p_text,'')), ''),
         rental_description_manual = coalesce(p_manual, true)
   where code = p_code
  returning * into pr;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  return pr;
end $$;

-- まだ手を入れていない商品に、自動生成のレンタル向け説明をまとめて入れる。
-- Webアプリからは管理者だけ、SQL Editor などDB管理セッションからは保守実行できる
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

create or replace function public.inv_product_rental_form_set(
  p_code        text,
  p_form        text default null,
  p_listing     text default null,
  p_office_ng   boolean default null
) returns public.inventory_products
language plpgsql security invoker set search_path = public, pg_catalog as $$
declare
  pr public.inventory_products;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_form is not null and nullif(btrim(p_form),'') is not null
     and btrim(p_form) not in ('notebook','desktop','monitor','peripheral','other') then
    raise exception '知らない区分です（%）', p_form;
  end if;
  if p_listing is not null and btrim(p_listing) not in ('standalone','option','not_public') then
    raise exception '知らない出しかたです（%）', p_listing;
  end if;
  update public.inventory_products
     set rental_form         = case when p_form is null then rental_form
                                    else nullif(btrim(p_form), '') end,
         rental_listing_type = coalesce(nullif(btrim(coalesce(p_listing,'')), ''), rental_listing_type),
         office_unavailable  = coalesce(p_office_ng, office_unavailable)
   where code = p_code
  returning * into pr;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  return pr;
end $$;

comment on function public.inv_product_rental_form_set is
  '商品のレンタル区分（かたち・8ECでの出しかた・Office不可）を設定する。渡さなかった項目は変えない。';

create or replace function public.inv_rental_unclassified()
returns table (code text, name text, rental_form text, listing_type text, 推定 text, 手がかり text)
language sql stable set search_path = public, pg_catalog as $$
  select p.code, coalesce(p.name, p.model), p.rental_form, p.rental_listing_type,
         coalesce(public.inv_rental_form(p), '推定できません'),
         nullif(concat_ws(' / ', nullif(p.cpu,''), nullif(p.memory_size,''),
                          nullif(p.storage_capacity,''), nullif(p.screen_size,''), nullif(p.os,'')), '')
    from public.inventory_products p
   where p.kind = 'individual'
     and coalesce(p.rental_enabled, false)
     and p.rental_form is null
   order by p.code;
$$;

comment on function public.inv_rental_unclassified is
  'レンタル区分（rental_form）が未設定のまま公開している商品の一覧。
   rental_enabled=true だから機械的に公開してよい、とはしないための確認用。';

-- ------------------------------------------------------------
-- ダッシュボードの経営数値
--
--     「在庫がいくつあるか」ではなく「いくら売れて、いくら残ったか」を出す。
--     数はすべて実データから数える（固定値・見込み値は入れない）。
--
--     売れた日  … inventory_transactions（追記のみの履歴）の action='売却'。
--                 inventory_items に売却日の列は無いので、日付はここが唯一の出どころ。
--     売れた額  … inventory_items.sold_price
--     原価      … inventory_items.cost（生成列＝price + purchase_fee）
--     粗利      … 実売価格 − その個体の原価
--
--     原価が入っていない個体は、売値をそのまま粗利にすると嘘になるので
--     粗利の計算から外し、外した件数（profit_missing_cost）を返す。
--     売上は将来8RENTのレンタル料も足せるよう、販売とレンタルを分けて返す。
-- ------------------------------------------------------------
create or replace function public.inv_dashboard_stats(p_month date default null)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
with
bounds as (
  select date_trunc('month', coalesce(p_month, current_date))::date            as m_start,
         (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month')::date as m_end
),
-- 今月売れた個体（売却の履歴がある個体を、重複なく1台ずつ）
sold as (
  select distinct on (i.id) i.id, i.sold_price, i.cost
    from public.inventory_transactions t
    join public.inventory_items i on i.id = t.ref_id
    cross join bounds b
   where t.ref_kind = 'item' and t.action = '売却'
     and t.occurred_at >= b.m_start and t.occurred_at < b.m_end
   order by i.id, t.occurred_at desc
),
sale_agg as (
  select coalesce(sum(sold_price), 0)                                   as sales,
         count(*)                                                       as cnt,
         coalesce(sum(sold_price) filter (where cost > 0), 0)           as profit_base,
         coalesce(sum(sold_price - cost) filter (where cost > 0), 0)    as profit,
         count(*) filter (where coalesce(cost, 0) <= 0)                 as missing_cost,
         count(*) filter (where coalesce(sold_price, 0) <= 0)           as missing_price,
         -- 粗利を出せた台数＝原価も売価も入っている台数。平均粗利/台の母数はこれ
         count(*) filter (where cost > 0 and sold_price > 0)            as profit_cnt
    from sold
),
-- 売却済みなのに売価が入っていない個体（全期間）。今月かどうかに関わらず直してほしい
price_gap as (
  select count(*) as cnt
    from public.inventory_items i
   where i.status = '売却済'
     and coalesce(i.sold_price, 0) <= 0
),
-- 今月仕入れた個体（仕入日で見る）
buy_agg as (
  select coalesce(sum(i.cost), 0) as amount, count(*) as cnt
    from public.inventory_items i cross join bounds b
   where i.purchased_on >= b.m_start and i.purchased_on < b.m_end
),
-- いま手元にある在庫（売却済・廃棄は除く）
held as (
  select i.cost,
         case when i.purchased_on is not null
              then (current_date - i.purchased_on) end as days
    from public.inventory_items i
   where i.status not in ('売却済', '廃棄')
),
held_agg as (
  select count(*)                                                as cnt,
         coalesce(sum(cost), 0)                                  as cost_total,
         count(*) filter (where days > 60)                       as aged60,
         count(*) filter (where days > 90)                       as aged90,
         coalesce(sum(cost) filter (where days > 90), 0)         as aged90_cost,
         round(avg(days) filter (where days is not null), 1)     as avg_days,
         count(*) filter (where days is null)                    as no_date
    from held
)
select jsonb_build_object(
  'month', to_char((select m_start from bounds), 'YYYY-MM'),
  -- 売上（販売／レンタル／合計）。レンタルは請求データが無いので未集計
  'sales_sale',        s.sales,
  'sales_rental',      0,
  'sales_total',       s.sales,
  'rental_available',  false,
  -- 粗利
  'gross_profit',      s.profit,
  'profit_base',       s.profit_base,
  'gross_margin',      case when s.profit_base > 0
                            then round(s.profit * 100.0 / s.profit_base, 1) end,
  'profit_missing_cost', s.missing_cost,
  'profit_count',      s.profit_cnt,
  'avg_profit_per_unit', case when s.profit_cnt > 0
                              then round(s.profit / s.profit_cnt) end,
  'sold_count',        s.cnt,
  -- 売価が入っていない個体（金額として数えられないもの）
  'sold_price_missing',       g.cnt,
  'sold_price_missing_month', s.missing_price,
  -- 仕入
  'purchase_amount',   b2.amount,
  'purchase_count',    b2.cnt,
  -- 在庫
  'stock_cost',        h.cost_total,
  'stock_count',       h.cnt,
  'aged_60',           h.aged60,
  'aged_90',           h.aged90,
  'aged_90_cost',      h.aged90_cost,
  'avg_stock_days',    h.avg_days,
  'stock_no_date',     h.no_date
)
from sale_agg s, price_gap g, buy_agg b2, held_agg h;
$$;

comment on function public.inv_dashboard_stats is
  'ダッシュボードの経営数値。売上・粗利・粗利率・販売台数・仕入・在庫原価・滞留在庫を実データから数える。
   売れた日は inventory_transactions（action=売却）、売れた額は inventory_items.sold_price、
   原価は cost（price + purchase_fee）。原価が入っていない個体は粗利の計算から外し、
   その件数を profit_missing_cost で返す。売却済みなのに売価が入っていない個体は
   sold_price_missing（全期間）と sold_price_missing_month（今月ぶん）で返す。
   売上は販売とレンタルを分けて返す（レンタルの請求データはまだ無いので rental_available=false）。';

comment on column public.inventory_products.description is
  '一般の商品説明。楽天から取得した説明、または人が入力したもの。8RENTはrental_descriptionが空ならこちらを使う。';
comment on column public.inventory_products.rakuten_synced_at is
  '楽天商品APIとの照合・補完が最後に行われた時刻。nullは未連携。';

create index if not exists inventory_channels_sku_idx on public.inventory_channels (channel, sku);

-- ------------------------------------------------------------
-- 27b-3) 1商品ぶんだけ、個体別の出品情報から商品単位のlistingを作る
--
--     27b-2 の一括補完と同じ考え方を、あとから増えた商品にも使えるようにする
--     （取り込み直後は個体別にしか出品情報が無いことがあるため）。
--     /zaiko の商品詳細「販売情報」タブから呼ぶ。
-- ------------------------------------------------------------
create or replace function public.inv_listing_from_items(
  p_code    text,
  p_channel text default 'rakuten'
) returns public.inventory_channel_listings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_listings;
  g record;
  v_groups integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if exists (select 1 from public.inventory_channel_listings
              where product_code = p_code and channel = p_channel) then
    raise exception 'すでに商品単位の出品情報があります（% / %）', p_code, p_channel;
  end if;

  -- 同じURL・同じSKUの個体だけをまとめる。違う掲載が混ざっている商品は作らない
  -- （どれが正しい掲載かは人にしか決められないため）
  select count(*)::integer into v_groups
    from (select 1 from public.inventory_channels c
           where c.channel = p_channel and c.product_code = p_code
             and (nullif(btrim(coalesce(c.url, '')), '') is not null
                  or nullif(btrim(coalesce(c.sku, '')), '') is not null)
           group by nullif(btrim(coalesce(c.url, '')), ''), nullif(btrim(coalesce(c.sku, '')), '')) x;

  if v_groups = 0 then
    raise exception 'この商品には、個体別の%の出品情報（URLかSKU）がありません', p_channel;
  end if;
  if v_groups > 1 then
    raise exception '個体ごとに違う%の掲載（URL・SKU）が%種類あります。どれを商品の掲載にするかを決めてから、販売サイトの編集で入れてください',
      p_channel, v_groups;
  end if;

  -- 価格はモールでの販売価格（inventory_channels.price）をそのまま引き継ぐ
  select nullif(btrim(coalesce(c.url, '')), '')  as url,
         nullif(btrim(coalesce(c.sku, '')), '')  as sku,
         (array_agg(c.state order by (c.state = '出品中') desc nulls last, c.updated_at desc nulls last))[1] as state,
         max(c.price)      as price,
         count(*)::integer as rows,
         bool_or(c.state = '出品中') as any_listed
    into g
    from public.inventory_channels c
   where c.channel = p_channel and c.product_code = p_code
     and (nullif(btrim(coalesce(c.url, '')), '') is not null
          or nullif(btrim(coalesce(c.sku, '')), '') is not null)
   group by nullif(btrim(coalesce(c.url, '')), ''), nullif(btrim(coalesce(c.sku, '')), '');

  insert into public.inventory_channel_listings
    (product_code, channel, state, sku, price, url, note, created_at, updated_at)
  values (p_code, p_channel,
          case when g.any_listed then '出品中' else g.state end,
          g.sku, g.price, g.url,
          '個体別の出品情報から作成（' || g.rows || '台が同じ掲載）', now(), now())
  returning * into r;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code,
          (select coalesce(name, model) from public.inventory_products where code = p_code),
          '出品情報の作成', null, coalesce(r.url, r.sku));
  return r;
end $$;

comment on function public.inv_listing_from_items is
  '個体別の出品情報（inventory_channels）から、商品単位の出品情報を1件作る。
   external_item_code は推測せず空のままにし、次の楽天API同期で正式な値を保存する。';

-- ------------------------------------------------------------
-- 30-1c) 掲載URLの照合まわり
--
--     モール側で商品ページのURLが変わることがある（作り直し・番号の振り直し）。
--     保存済みURLが古いままだと、itemCodeが分かるまでAPIで商品を見つけられない
--     （P-00537：保存 …/l09150188/ ／ 実際 …/00039769233/ ）。
--     そこでAPI同期のたびに正式URLと見比べ、違えば url_candidate に置いて人に見せる。
--     自動で書き換えないのは、URLは人が入れた値でもあるため。
-- ------------------------------------------------------------
create or replace function public.inv_img_hires(p_url text)
returns text language sql immutable as $$
  -- 楽天の画像URLに付く縮小指定（?_ex=128x128）を外して、店舗がアップロードした
  -- 元サイズの画像を指すようにする。商品詳細で大きく出しても粗くならない。
  -- _ex 以外のクエリは残す（将来ほかのパラメータが増えても壊さない）
  select case when coalesce(p_url, '') = '' then p_url
    else regexp_replace(
           regexp_replace(
             regexp_replace(p_url, '([?&])_ex=[^&]*', '\1', 'g'),
           '\?&+', '?'),
         '[?&]+$', '')
  end;
$$;

comment on function public.inv_img_hires is
  '楽天の画像URLの縮小指定（_ex=幅x高さ）を外して元サイズのURLにする。Edge Function側の hiResImageUrl と同じ規則。';

create or replace function public.inv_norm_url(p_url text)
returns text language sql immutable as $$
  -- http/https・末尾スラッシュ・クエリ文字列の違いを無視して比べる
  select nullif(lower(regexp_replace(regexp_replace(split_part(coalesce(p_url,''), '?', 1),
                                     '/+$', ''), '^https?://', '')), '');
$$;

comment on function public.inv_norm_url is
  'URLを比較用に正規化する（http/https・末尾スラッシュ・クエリを無視）。Edge Function側の比較と同じ規則。';

create or replace function public.inv_listing_url_accept(
  p_code    text,
  p_channel text default 'rakuten'
) returns public.inventory_channel_listings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_listings;
  v_before text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into r from public.inventory_channel_listings
   where product_code = p_code and channel = p_channel for update;
  if not found then
    raise exception '出品情報が見つかりません（% / %）', p_code, p_channel;
  end if;
  if nullif(btrim(coalesce(r.url_candidate,'')), '') is null then
    raise exception '更新候補のURLがありません';
  end if;
  v_before := r.url;

  update public.inventory_channel_listings
     set url = r.url_candidate, url_candidate = null, url_checked_at = now(), updated_at = now()
   where product_code = p_code and channel = p_channel
  returning * into r;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code,
          (select coalesce(name, model) from public.inventory_products where code = p_code),
          '掲載URL更新', v_before, r.url);
  return r;
end $$;

comment on function public.inv_listing_url_accept is
  'API同期で見つかった掲載URLの更新候補を採用する（/zaikoから人が確認して実行）。履歴に残す。';

create or replace function public.inv_listing_url_dismiss(
  p_code    text,
  p_channel text default 'rakuten'
) returns public.inventory_channel_listings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_listings;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_channel_listings
     set url_candidate = null, url_checked_at = now(), updated_at = now()
   where product_code = p_code and channel = p_channel
  returning * into r;
  if not found then
    raise exception '出品情報が見つかりません（% / %）', p_code, p_channel;
  end if;
  return r;
end $$;

comment on function public.inv_listing_url_dismiss is
  '掲載URLの更新候補を取り消す（いまのURLのままにする）。次の同期でまた差があれば再び候補に入る。';

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
  v_code_saved   boolean := false;
  v_url_mismatch boolean := false;
  v_old_url      text;
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
    -- モールの商品説明は販売向けの文言（領収書・保証・返品・会社概要など）が多い。
    -- 8ECのレンタル画面には出さないので、原文は sale_description に置くだけにする。
    -- description と rental_description には触らない（レンタル向けの文は自前で作る）
    sale_description  = coalesce(nullif(sale_description,''), nullif(p_item->>'caption','')),
    -- 画像は images（楽天から取り込んだ写真）にだけ入れる。image_url は
    -- 「人が/zaikoで指定したメイン画像」専用にして、同期では一切触らない。
    -- 公開ページは image_url → images[0] の順に見るので、これで写真は出る
    -- 縮小指定（?_ex=128x128）が付いていたらここでも外す。Edge Function側でも
    -- 外しているが、古い版から呼ばれても粗い画像を保存しないための保険
    images            = case when jsonb_array_length(coalesce(images,'[]'::jsonb)) = 0
                              and jsonb_typeof(p_item->'images') = 'array'
                         then (select coalesce(jsonb_agg(u order by ord), '[]'::jsonb)
                                 from (select public.inv_img_hires(x) as u, min(ord) as ord
                                         from jsonb_array_elements_text(p_item->'images')
                                              with ordinality t(x, ord)
                                        where btrim(x) <> ''
                                        group by 1) q)
                         else images end,
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
        (product_code, channel, state, external_item_code, url, price, api_synced_at, api_sync_status,
         url_checked_at, updated_at)
      values (p_code, 'rakuten', '出品中', v_item_code, v_url, v_price, now(), 'ok', now(), now());
      v_chan_new := true;
      v_code_saved := true;
    else
      -- 保存済みURLと、APIが返した正式なURLを見比べる。
      -- 違っていたら勝手に書き換えず、更新候補（url_candidate）として残して人に見せる
      -- （古い商品ページのURLが残っていると、itemCodeが分かるまで商品を見つけられないため）
      select nullif(btrim(coalesce(url,'')), '') into v_old_url
        from public.inventory_channel_listings
       where product_code = p_code and channel = 'rakuten';
      if v_url is not null and v_old_url is not null
         and public.inv_norm_url(v_old_url) is distinct from public.inv_norm_url(v_url) then
        v_url_mismatch := true;
      end if;
      -- 掲載URLしか無かった商品も、ここでAPIが返した正式なitemCodeを覚える。
      -- 次回からはURLの総当たりではなく、itemCodeで直接照合できる
      -- （itemCodeをURLから推測することはしない）
      select nullif(btrim(coalesce(external_item_code,'')), '') is null
        into v_code_saved
        from public.inventory_channel_listings
       where product_code = p_code and channel = 'rakuten';

      update public.inventory_channel_listings set
        external_item_code = coalesce(nullif(btrim(coalesce(external_item_code,'')), ''), v_item_code),
        url = coalesce(url, v_url),                       -- 空のときだけ入れる
        url_candidate = case when v_url_mismatch then v_url else null end,  -- 違っていれば候補に、同じなら消す
        url_checked_at = now(),
        api_synced_at = now(),
        api_sync_status = 'ok',
        updated_at = case when external_item_code is null or url is null or v_url_mismatch
                          then now() else updated_at end
      where product_code = p_code and channel = 'rakuten';

      if v_url_mismatch then
        insert into public.inventory_transactions
          (actor, ref_kind, ref_id, label, action, before_value, after_value)
        values ('楽天連携', 'product', p_code, coalesce(after_row.name, after_row.model),
                '掲載URL差異', v_old_url, v_url || '（更新候補）');
      end if;
    end if;
  end if;

  if v_changed or v_chan_new then
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values ('楽天連携', 'product', p_code, coalesce(after_row.name, after_row.model), '楽天連携で補完',
            null, coalesce(v_item_code, ''));
  end if;

  return jsonb_build_object(
    'product', to_jsonb(after_row),
    'changed', (v_changed or v_chan_new),
    -- 掲載URLしか無かった商品に、正式なitemCodeを保存できたか
    'external_item_code_saved', coalesce(v_code_saved, false),
    'external_item_code', v_item_code,
    -- 保存済みURLが楽天の正式URLと違っていたか（違えば url_candidate に入れてある）
    'url_mismatch', coalesce(v_url_mismatch, false),
    'url_saved', v_old_url,
    'url_candidate', case when v_url_mismatch then v_url end,
    -- 画像が0枚から入ったか（同期結果の「画像取得成功 ○件」に使う）
    'images_added', (jsonb_array_length(coalesce(before_row.images,'[]'::jsonb)) = 0
                     and jsonb_array_length(coalesce(after_row.images,'[]'::jsonb)) > 0),
    'image_count', jsonb_array_length(coalesce(after_row.images,'[]'::jsonb)));
end $$;

comment on function public.inv_rakuten_apply_one is
  '楽天から取得した1商品ぶんのデータで、指定した商品コードの不足情報だけを埋める。
   すでに値が入っている列は上書きしない。画像は images にだけ入れ、image_url
   （人が指定したメイン画像）は触らない。実在庫（inventory_items）は作らない。';

-- ------------------------------------------------------------
-- 30-1b) 楽天の画像同期の対象を出す（「楽天商品を同期」のまとめ実行用）
--
--     楽天に掲載している商品（inventory_channel_listings.channel='rakuten' で
--     itemCode か掲載URLが分かっているもの）を、同期の対象として返す。
--       p_scope='missing' … まだ写真が1枚も無い商品だけ（既定）
--       p_scope='all'     … 楽天に掲載している商品すべて
--     Edge Function（rakuten-product-sync）がこれを読み、楽天APIから
--     写真を取ってきて商品マスターへ入れる。公開ページは商品マスターだけを
--     読むので、8ECの表示のたびに楽天APIを呼ぶことはない。
-- ------------------------------------------------------------
create or replace function public.inv_rakuten_sync_targets(p_scope text default 'missing')
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v jsonb;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if coalesce(p_scope,'') not in ('missing','all') then
    raise exception '知らない範囲です（%）。missing か all を指定してください', p_scope;
  end if;

  select coalesce(jsonb_agg(t order by t->>'code'), '[]'::jsonb) into v
    from (
      select jsonb_build_object(
               'code', p.code,
               'name', coalesce(p.name, p.model),
               'item_code', nullif(btrim(coalesce(l.external_item_code,'')), ''),
               'url', nullif(btrim(coalesce(l.url,'')), ''),
               'image_count', jsonb_array_length(coalesce(p.images,'[]'::jsonb)),
               'has_main_image', nullif(p.image_url,'') is not null) as t
        from public.inventory_channel_listings l
        join public.inventory_products p on p.code = l.product_code
       where l.channel = 'rakuten'
         and (nullif(btrim(coalesce(l.external_item_code,'')), '') is not null
              or nullif(btrim(coalesce(l.url,'')), '') is not null)
         and (p_scope = 'all'
              or (jsonb_array_length(coalesce(p.images,'[]'::jsonb)) = 0
                  and nullif(p.image_url,'') is null))
    ) x;
  return v;
end $$;

comment on function public.inv_rakuten_sync_targets is
  '楽天の画像同期の対象商品を返す。missing=写真が無い商品だけ／all=楽天に掲載している商品すべて。
   itemCode か掲載URLのどちらかが分かっている商品だけを対象にする（URLは推測しない）。';

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
--     チャネルの役割
--       楽天 … 販売チャネル（購入は楽天市場の商品ページで完結する）
--       8EC  … レンタルチャネル（8ECトップ・8RENT がレンタルの入口）
--     同じ商品・同じ実在庫を両方のチャネルに出す。ただし「販売できるか」と
--     「レンタルできるか」は別々に判定する。8ECでレンタル対象にしても
--     楽天の掲載（listing）は解除しない。
--
--     公開条件：kind='individual' かつ rental_enabled = true
--       8ECはレンタルサイトなので、楽天に出品中かどうかは公開条件にしない。
--       楽天だけで売る商品（rental_enabled=false）はこのビューに出さない。
--
--     「掲載しているか」と「いま提供できる数量」を分けて持つ
--       available … status='在庫' の個体数（実在庫。予約中・貸出中・販売予約・
--             修理中などは含めない）
--       rental_available … そのうち rental_eligible=true の個体数。
--             レンタルを受け付けられるのは rental_enabled=true（商品を掲載する）
--             かつ この数が1以上（その1台を8RENTに回している）のときだけ。
--             同じ商品10台のうち3台だけレンタル、という運用ができる。
--       sale_listed / sale_enabled … 楽天に掲載中か（state='出品中' かつURLあり）。
--             貸出中の個体があっても掲載は維持するので、在庫数では変わらない。
--       sale_available … 楽天でいま購入できる数量。掲載中なら status='在庫' の
--             個体数、未掲載なら0。発送できない個体（予約中・貸出中・販売予約・
--             修理中）は含めないので、最後の1台が貸出中なら 掲載あり・数量0 になる。
--       購入ボタンを出してよいか＝ sale_listed、押せるか＝ sale_available > 0。
--
--     表示項目 → 取得元：
--       商品名・型番・メーカー・カテゴリ・スペック・説明 … inventory_products
--       代表画像 image_url … image_url（人が指定したメイン画像。楽天同期は空欄だけ埋める）
--                            → 無ければ images の1枚目
--       画像一覧 images     … inventory_products.images（楽天同期・手入力）
--       8RENT用画像         … rental_image_url / rental_images（空なら一般画像）
--       レンタル可否・月額   … rental_enabled / rental_price_month / rental_min_months
--       販売の掲載・購入先・価格 … inventory_channel_listings（channel='rakuten'、
--                            state='出品中'、url あり）。URLは登録済みのものだけ使い、
--                            商品コードから推測生成しない
--     含めない：シリアル・仕入価格・原価・販売予定価格・利用者・備考・保管場所
-- ------------------------------------------------------------
-- 公開画面の「カテゴリーから探す」。商品が0件のカテゴリーも消さないので、
-- 商品から category_id を逆算するのではなく、マスターをそのまま出す
drop view if exists public.inv_public_categories;
create view public.inv_public_categories as
with live as (
  -- 列は名前で並べる（表に列を足した順で定義が変わらないように）
  select c.id, c.name, c.parent_id, c.sort_no,
         c.public_name, c.public_icon, c.public_sort
    from public.inventory_categories c
   where c.enabled and c.public_listed
)
select l.id,
       coalesce(nullif(btrim(coalesce(l.public_name, '')), ''), l.name)            as name,
       coalesce(nullif(btrim(coalesce(l.public_icon, '')), ''), 'devices_other')   as icon,
       coalesce(l.public_sort, l.sort_no, 0)                                       as sort_no,
       l.parent_id
  from live l
 where l.parent_id is null
    or exists (select 1 from live p where p.id = l.parent_id)
 order by coalesce(l.public_sort, l.sort_no, 0), l.id;

comment on view public.inv_public_categories is
  '公開画面の「カテゴリーから探す」に出すカテゴリー。/zaiko と同じ1つのマスターから出す。
   商品が0件でも消えない。無効・非公開は返さない。親が出ていない子も返さない。
   parent_id が入っている行は子カテゴリーで、トップのタイルではなく親を選んだあとの
   絞り込みに使う。';

-- 先に互換ビューを落とす（inv_public_products に依存しているので、
-- 残したまま作り直そうとすると2回目以降の実行が止まる）
drop view if exists public.inv_public_catalog;
drop view if exists public.inv_public_products;
create view public.inv_public_products as
with avail as (
  select product_code,
         count(*) filter (where status = '在庫'
                            and coalesce(rental_eligible, false)) as rental_available,
         count(*) filter (where status = '在庫')                  as in_stock
    from public.inventory_items
   group by product_code
)
select
  p.code, p.name, p.model, p.maker, p.category_id, c.name as category_name,
  public.inv_model_key(p.maker, p.model, p.code)                    as model_key,
  p.spec,
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
  p.condition_note, p.office_supported,
  p.rental_form, p.rental_listing_type,
  -- レンタル（8RENT）。単品で公開してよいものだけ true
  (coalesce(p.rental_enabled, false)
     and coalesce(p.rental_listing_type, 'standalone') = 'standalone')  as rental_enabled,
  coalesce(p.procurement_available, false)                          as procurement_available,
  case when coalesce(a.rental_available, 0) > 0 then 'ご案内可能'
       when coalesce(p.procurement_available, false) then '取り寄せ可能'
       else 'ご相談ください' end                                    as availability,
  p.rental_price_month, p.rental_min_months, p.trial_eligible, p.rental_tags,
  nullif(btrim(coalesce(p.rental_description,'')), '')              as rental_description,
  -- 販売（8EC BUY）
  coalesce(p.sale_enabled, false)                                   as sale_enabled,
  p.sale_price,
  p.sale_condition,
  coalesce(p.sale_procurement_available, false)                     as sale_procurement_available,
  case when not coalesce(p.sale_enabled, false) then null
       when coalesce(a.in_stock, 0) > 0 then '在庫あり'
       when coalesce(p.sale_procurement_available, false) then '取り寄せ可能'
       else 'ご相談ください' end                                    as sale_availability,
  p.updated_at
from public.inventory_products p
left join public.inventory_categories c on c.id = p.category_id
left join avail a on a.product_code = p.code
where p.kind = 'individual'
  and (
        (coalesce(p.rental_enabled, false)
           and coalesce(p.rental_listing_type, 'standalone') = 'standalone')
     or coalesce(p.sale_enabled, false)
      );

comment on view public.inv_public_products is
  '公開画面（/ ・/rent ・/buy）が読む1つのカタログ。レンタルできる商品と販売する商品の両方を返す。
   同じ商品が両方に対応していれば、rental_enabled と sale_enabled の両方が true になる。
   在庫数は出さない（レンタルは availability、販売は sale_availability の言葉だけ）。
   楽天のURL・出品価格は出さない。社内で数量を見るときは inv_channel_stock_feed を使う。';

-- これまでの公開ビューは残す（8ECトップの旧版・外部からの参照が壊れないように）。
-- 中身は inv_public_products のレンタルぶんと同じ。列の並びもこれまでどおり。
create view public.inv_public_catalog as
select
  code, name, model, maker, category_id, category_name, model_key, spec,
  image_url, images, rental_image_url, rental_images,
  cpu, cpu_gen, memory_size, storage_type, storage_capacity,
  screen_size, os, webcam, wifi, bluetooth, numpad, accessories,
  condition_note, office_supported, rental_form, rental_listing_type,
  rental_enabled, procurement_available, availability,
  rental_price_month, rental_min_months, trial_eligible, rental_tags,
  rental_description, updated_at
from public.inv_public_products
where rental_enabled;

comment on view public.inv_public_catalog is
  '8RENT（レンタル）の公開カタログ。inv_public_products のレンタルぶん。
   列の並びは以前のままにしてある（既存のページがそのまま読めるように）。
   新しい画面は inv_public_products を読み、販売とレンタルを1枚のカードで出す。';

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

-- ------------------------------------------------------------
-- 30-7) inv_channel_stock_feed：販売チャネルへ送る「購入できる数量」
--
--     楽天など販売チャネルの商品ページ（listing）は、8ECでレンタル中でも
--     消さない。消すのは在庫数のほうで、物理的に発送できない個体
--     （予約中・貸出中・販売予約・修理中・故障・紛失）は数量に含めない。
--     最後の1台が貸出中なら「掲載は残す・購入できる数量は0」になる。
--
--       sale_qty … そのチャネルへ送る販売可能数量＝ status='在庫' の個体数。
--                  未掲載（state が '出品中' 以外）なら0。
--       listed   … 掲載中か。8ECのレンタルでは変えない（人が出品状態を
--                  変えたときだけ変わる）。
--
--     RMS WEB SERVICE 等のAPI連携が入るまでは、スタッフがこのビューを見て
--     楽天の在庫数を更新する。社内用なので anon には出さない。
-- ------------------------------------------------------------
drop view if exists public.inv_channel_stock_feed;
create view public.inv_channel_stock_feed as
with cnt as (
  select product_code,
         count(*) filter (where status = '在庫')                 as in_stock,
         count(*) filter (where status = '在庫'
                            and coalesce(rental_eligible, false)) as rental_eligible_in_stock,
         count(*) filter (where status = '予約中')               as rental_reserved,
         count(*) filter (where status = '貸出中')               as on_rent,
         count(*) filter (where status = '販売予約')             as sale_reserved,
         count(*) filter (where status in ('修理中','故障','紛失')) as unusable,
         count(*) filter (where status not in ('売却済','廃棄')) as total_owned
    from public.inventory_items
   group by product_code
)
select
  l.product_code,
  p.name, p.model,
  l.channel,
  l.state,
  (l.state = '出品中')                                           as listed,
  l.external_item_code, l.sku, l.url, l.price,
  case when l.state = '出品中' then coalesce(n.in_stock, 0) else 0 end::integer as sale_qty,
  coalesce(n.in_stock, 0)::integer        as in_stock,
  -- 在庫のうち8RENTに回している台数。在庫である間は楽天でも売れる（数量からは引かない）
  coalesce(n.rental_eligible_in_stock, 0)::integer as rental_eligible_in_stock,
  coalesce(n.rental_reserved, 0)::integer as rental_reserved,
  coalesce(n.on_rent, 0)::integer         as on_rent,
  coalesce(n.sale_reserved, 0)::integer   as sale_reserved,
  coalesce(n.unusable, 0)::integer        as unusable,
  coalesce(n.total_owned, 0)::integer     as total_owned,
  coalesce(p.rental_enabled, false)       as rental_enabled,
  l.updated_at
from public.inventory_channel_listings l
join public.inventory_products p on p.code = l.product_code
left join cnt n on n.product_code = l.product_code;

comment on view public.inv_channel_stock_feed is
  '楽天など販売チャネルへ送る販売可能数量（sale_qty＝status=在庫 の個体数）。掲載（listed）とは別に持つ。
   8ECでレンタル中・予約中・販売予約・修理中の個体は発送できないので数量に含めない。社内用（authenticatedのみ）。';

-- ============================================================
-- 31) 在庫一覧からのまとめて操作（個体を選んで一括で動かす）
--
--     /zaiko の在庫一覧（個体別）でチェックした個体に対して、
--     8RENTに出す・貸出・売却・修理・棚卸・廃棄 をまとめて行う。
--
--     ・1台ずつの検証と履歴はこれまでどおり inv_item_op() に任せる
--       （同じ規則を二重に書かない）。この関数はその繰り返しと、
--       1台ごとの成否・理由をまとめて返すことだけを行う。
--     ・1台が失敗しても他は進める（個体ごとにサブトランザクションで捕まえる）。
--       返り値の ng に「どの個体が・なぜ」を入れて画面に出す。
--     ・8RENT対象（rental_eligible）は個体の設定。商品を8ECに載せるかは
--       inventory_products.rental_enabled のままで、2段階で決まる。
--         8RENT対象にしたとき … その商品がまだ非掲載なら、あわせて掲載ONにする
--           （最初の1台を対象にしたら商品も自動で8RENTに出る。p_enable_product=false で止められる）
--         8RENT対象外にしたとき … 商品の掲載設定には触らない。
--           rental_enabled を落とすのは inv_product_rental_set()（人が商品詳細で切り替える）
--           だけ、というこれまでの決めかたを変えない。対象が0台になった商品は
--           products_empty で返すので、画面から知らせて人に判断してもらう
--           （8ECでは「在庫切れ」になり、申込はできない）。
--     ・8RENT対象外にできるのは、いま貸し出していない個体だけ。
--       予約中（申込が入って発送待ち）・貸出中は、レンタルの約束が生きているので外せない。
--
--     返り値：
--       { "action": "...", "total": 5, "ok": 4, "ng_count": 1,
--         "ng": [{"id":"00039769953","reason":"貸出中 のため売却できません…"}],
--         "products_enabled": 1,
--         "products_empty": [{"code":"P-00537","name":"ProBook 450 G9"}] }
-- ============================================================
create or replace function public.inv_items_bulk_op(
  p_ids            text[],
  p_action         text,
  p_value          text    default null,   -- 貸出先／売却価格
  p_note           text    default null,   -- 理由・メモ（履歴に残る）
  p_due            date    default null,   -- 貸出の予定返却日
  p_enable_product boolean default true    -- 8RENT対象にするとき、非掲載の商品を掲載ONにする
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_id       text;
  it         public.inventory_items;
  v_ok       integer := 0;
  v_ng       jsonb   := '[]'::jsonb;
  v_codes    text[]  := '{}';
  v_enabled  integer := 0;
  v_empty    jsonb   := '[]'::jsonb;
  v_note     text    := nullif(btrim(coalesce(p_note, '')), '');
  v_on       boolean;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then
    raise exception '個体が選ばれていません';
  end if;
  if p_action not in ('8RENT対象', '8RENT対象外', '貸出', '売却', '修理', '棚卸', '廃棄') then
    raise exception '知らない操作です（%）', p_action;
  end if;
  if p_action = '廃棄' and not public.inv_is_admin() then
    raise exception '廃棄は管理者だけができます';
  end if;
  if p_action = '貸出' and coalesce(btrim(p_value), '') = '' then
    raise exception '貸出先を入力してください';
  end if;
  v_on := (p_action = '8RENT対象');

  foreach v_id in array p_ids loop
    begin
      select * into it from public.inventory_items where id = v_id for update;
      if not found then
        raise exception '見つかりません';
      end if;

      if p_action in ('8RENT対象', '8RENT対象外') then
        -- 手元に無いものはレンタルに回せない
        if it.status in ('売却済', '廃棄') then
          raise exception '% なので8RENTには出せません', it.status;
        end if;
        -- レンタルの約束が生きている個体は外せない（先に返却・キャンセルしてもらう）
        if not v_on and it.status = '予約中' then
          raise exception '予約中 のため8RENTから外せません（先に申込をキャンセルしてください）';
        end if;
        if not v_on and it.status = '貸出中' then
          raise exception '貸出中 のため8RENTから外せません（先に返却してください）';
        end if;
        if coalesce(it.rental_eligible, false) = v_on then
          raise exception 'すでに%です', case when v_on then 'レンタル対象' else '対象外' end;
        end if;
        update public.inventory_items set rental_eligible = v_on where id = v_id;
        insert into public.inventory_transactions
          (actor, ref_kind, ref_id, label, action, before_value, after_value)
        values (public.inv_actor(), 'item', v_id, it.name, '8RENT対象',
                case when v_on then '対象外' else 'レンタル対象' end,
                (case when v_on then 'レンタル対象' else '対象外' end)
                  || coalesce('／' || v_note, ''));
        v_codes := array_append(v_codes, it.product_code);

      elsif p_action = '貸出' then
        perform public.inv_item_op(v_id, '貸出', btrim(p_value),
          concat_ws('／', v_note,
                    case when p_due is not null then '返却予定 ' || to_char(p_due, 'YYYY-MM-DD') end));
        if p_due is not null then
          update public.inventory_loans set due_on = p_due
           where item_id = v_id and returned_at is null;
        end if;

      elsif p_action = '売却' then
        -- 予約中（8RENTの申込）・貸出中はそのまま売れない。先に戻してもらう
        if it.status in ('売却済', '廃棄') then
          raise exception 'すでに%です', it.status;
        end if;
        if it.status in ('予約中', '貸出中') then
          raise exception '% のため売却できません（先に返却・キャンセルしてください）', it.status;
        end if;
        perform public.inv_item_op(v_id, '売却', p_value, v_note);

      elsif p_action = '修理' then
        if it.status in ('売却済', '廃棄') then
          raise exception 'すでに%です', it.status;
        end if;
        if it.status in ('予約中', '販売予約') then
          raise exception '% のため変更できません（先に予約を解除してください）', it.status;
        end if;
        if it.status = '修理中' then
          raise exception 'すでに修理中です';
        end if;
        perform public.inv_item_op(v_id, '状態変更', '修理中', v_note);

      elsif p_action = '棚卸' then
        -- 状態は変えない。「現物を確認した」ことだけを履歴と last_checked_at に残す
        if it.status in ('売却済', '廃棄') then
          raise exception '手元にないので棚卸できません（%）', it.status;
        end if;
        perform public.inv_item_op(v_id, '棚卸確認', null, v_note);

      elsif p_action = '廃棄' then
        if it.status = '廃棄' then
          raise exception 'すでに廃棄です';
        end if;
        perform public.inv_item_op(v_id, '廃棄', null, v_note);
      end if;

      v_ok := v_ok + 1;
    exception when others then
      v_ng := v_ng || jsonb_build_object('id', v_id, 'reason', sqlerrm);
    end;
  end loop;

  -- 最初の1台を8RENT対象にしたら、その商品も8ECに掲載する（非掲載のままだと出ないため）
  if p_action = '8RENT対象' and coalesce(p_enable_product, true) and coalesce(array_length(v_codes, 1), 0) > 0 then
    with up as (
      update public.inventory_products set rental_enabled = true
       where code = any(v_codes) and coalesce(rental_enabled, false) = false
      returning code, coalesce(name, model) as label
    ), tx as (
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      select public.inv_actor(), 'product', code, label, '8RENT公開', '非公開', '公開中' from up
      returning 1
    )
    select count(*)::integer into v_enabled from tx;
  end if;

  -- 8RENT対象が0台になった商品を知らせる。掲載（rental_enabled）は勝手に落とさない
  -- ＝8ECでは「在庫切れ」で残り、掲載を止めるかどうかは人が商品詳細で決める
  if p_action = '8RENT対象外' and coalesce(array_length(v_codes, 1), 0) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'name', coalesce(p.name, p.model))), '[]'::jsonb)
      into v_empty
      from public.inventory_products p
     where p.code = any(v_codes)
       and coalesce(p.rental_enabled, false)
       and not exists (select 1 from public.inventory_items i
                        where i.product_code = p.code and coalesce(i.rental_eligible, false));
  end if;

  return jsonb_build_object(
    'action', p_action,
    'total', coalesce(array_length(p_ids, 1), 0),
    'ok', v_ok,
    'ng_count', jsonb_array_length(v_ng),
    'ng', v_ng,
    'products_enabled', coalesce(v_enabled, 0),
    'products_empty', v_empty);
end $$;

comment on function public.inv_items_bulk_op is
  '在庫一覧で選んだ個体をまとめて動かす（8RENT対象／8RENT対象外／貸出／売却／修理／棚卸／廃棄）。
   1台ずつの検証と履歴は inv_item_op() に任せ、1台が失敗しても他は進める。
   成功件数と、失敗した個体・理由をまとめて返す。
   8RENT対象にしたときは非掲載の商品を掲載ONにする。8RENT対象外では商品設定に触らず、
   対象が0台になった商品を products_empty で返す（掲載を止めるかは人が決める）。
   予約中・貸出中の個体は8RENTから外せない。';


-- ============================================================
-- 32) モールの受注を在庫へつなぐ（楽天RMSなど）
--
--     商品・画像の同期（Rakuten Developers API）では注文は取れない。
--     受注は RMS WEB SERVICE の Order API から Edge Function
--     rakuten-order-sync が取り、ここの関数で在庫を確保する。
--
--       楽天で受注 → inv_sale_orders_apply（注文番号×明細番号×連番で冪等）
--                  → inv_sale_reserve → 在庫 から1台 販売予約
--                  → 発送の知らせが来たら 売却済（＝販売済み）
--                  → キャンセルの知らせが来たら 在庫 に戻す
--
--     確保は8RENTの申込と共通の inv_reserve_available_item を通るので、
--     予約中・貸出中の個体を楽天の受注で取ることはない。
-- ============================================================

-- ------------------------------------------------------------
-- 33-1) 内部用ビューを anon から見えないようにする
--
--     Supabaseの既定では、public スキーマに作ったビューに anon の
--     SELECT 権限が自動で付く（alter default privileges）。
--     grant を authenticated だけに書いても、その既定ぶんは消えないため、
--     社内用の在庫ビューが公開キーで読めてしまっていた。明示的に revoke する。
--     テーブルはRLSで守られているのでこの影響を受けない（ビューだけの話）。
-- ------------------------------------------------------------
revoke all on public.inv_channel_stock_feed from anon;

-- ------------------------------------------------------------
-- 33-2) モールの受注（楽天RMSなど）
--
--     同じ注文を何度取り込んでも在庫が二重に減らないよう、
--     「注文番号 × 明細番号 × 明細内の連番」で一意にする。
--     取り込み済みの行があれば、その明細はもう触らない。
--
--     実在庫の確保は inv_sale_reserve()（＝ inv_reserve_available_item）に任せる。
--     8RENTの予約中・貸出中は status が '在庫' ではないので、そもそも選ばれない。
-- ------------------------------------------------------------
create table if not exists public.inventory_sale_orders (
  id            bigint generated by default as identity primary key,
  channel       text not null default 'rakuten',
  order_number  text not null,                 -- モールの注文番号
  line_number   text not null,                 -- 明細番号
  unit_no       integer not null default 1,    -- 同じ明細で数量2以上のときの連番
  item_code     text,                          -- モール側の商品コード
  item_url      text,
  product_code  text references public.inventory_products(code) on delete set null,
  item_id       text references public.inventory_items(id) on delete set null,
  price         numeric,
  ordered_at    timestamptz,
  status        text not null default '受注',  -- 受注 / 発送済 / キャンセル / 未割当 / 在庫なし
  note          text,
  raw           jsonb,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  constraint inventory_sale_orders_uniq unique (channel, order_number, line_number, unit_no)
);

comment on table public.inventory_sale_orders is
  'モール（楽天など）の受注明細。注文番号×明細番号×連番で一意にしてあり、同じ注文を何度取り込んでも
   在庫は一度しか減らない。確保した個体は item_id に入る。';

create index if not exists inventory_sale_orders_status_idx
  on public.inventory_sale_orders (status, ordered_at desc);
create index if not exists inventory_sale_orders_item_idx
  on public.inventory_sale_orders (item_id);

drop trigger if exists inventory_sale_orders_touch on public.inventory_sale_orders;
create trigger inventory_sale_orders_touch before update on public.inventory_sale_orders
  for each row execute function public.inv_touch();

alter table public.inventory_sale_orders enable row level security;

drop policy if exists inventory_sale_orders_read on public.inventory_sale_orders;
create policy inventory_sale_orders_read on public.inventory_sale_orders
  for select to authenticated using (public.inv_role() in ('admin','member','viewer'));

-- ------------------------------------------------------------
-- 33-3) モールの商品コード・URLから商品を引く
--     推測はしない。external_item_code の一致か、正規化したURLの一致だけ。
-- ------------------------------------------------------------
create or replace function public.inv_listing_product(
  p_channel   text,
  p_item_code text,
  p_item_url  text
) returns text language sql stable set search_path = public as $$
  select l.product_code
    from public.inventory_channel_listings l
   where l.channel = p_channel
     and ((nullif(btrim(coalesce(p_item_code,'')),'') is not null
           and l.external_item_code = btrim(p_item_code))
      or (nullif(btrim(coalesce(p_item_url,'')),'') is not null
           and public.inv_norm_url(l.url) = public.inv_norm_url(p_item_url)))
   order by (l.external_item_code = btrim(coalesce(p_item_code,''))) desc nulls last, l.product_code
   limit 1;
$$;

comment on function public.inv_listing_product is
  'モールの商品コード（external_item_code）か掲載URLから商品コードを引く。
   商品コードの一致を優先し、どちらも当たらなければNULL（URLやSKUから推測はしない）。';

-- ------------------------------------------------------------
-- 33-4) 受注を取り込んで在庫を確保する
--
--     p_orders は Edge Function が整えた明細の配列：
--       [{ order_number, line_number, item_code, item_url, qty, price,
--          ordered_at, shipped (boolean), cancelled (boolean), raw }]
--
--     1明細ずつ、数量ぶんだけ個体を確保する。
--       取り込み済み        … 何もしない（冪等）
--       商品が引けない      … status='未割当' で記録して知らせる（在庫は動かさない）
--       在庫が足りない      … status='在庫なし' で記録して知らせる
--       確保できた          … 在庫 → 販売予約（inv_sale_reserve）
--       発送済みで来た      … 続けて 販売予約 → 売却済（＝販売済み）
--       キャンセルで来た    … 確保済みなら 販売予約 → 在庫 に戻す
-- ------------------------------------------------------------
create or replace function public.inv_sale_orders_apply(
  p_orders  jsonb,
  p_channel text default 'rakuten'
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  o            jsonb;
  v_order      text;
  v_line       text;
  v_qty        integer;
  v_unit       integer;
  v_code       text;
  v_item       public.inventory_items;
  v_row        public.inventory_sale_orders;
  v_shipped    boolean;
  v_cancelled  boolean;
  v_new        integer := 0;
  v_already    integer := 0;
  v_reserved   integer := 0;
  v_shippedn   integer := 0;
  v_cancelledn integer := 0;
  v_unmatched  jsonb := '[]'::jsonb;
  v_nostock    jsonb := '[]'::jsonb;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_orders is null or jsonb_typeof(p_orders) <> 'array' then
    raise exception '受注データがありません';
  end if;

  for o in select value from jsonb_array_elements(p_orders) loop
    v_order := nullif(btrim(coalesce(o->>'order_number','')), '');
    v_line  := coalesce(nullif(btrim(coalesce(o->>'line_number','')), ''), '1');
    if v_order is null then
      continue;   -- 注文番号が無いものは冪等にできないので取り込まない
    end if;
    v_qty       := greatest(coalesce((o->>'qty')::integer, 1), 1);
    v_shipped   := coalesce((o->>'shipped')::boolean, false);
    v_cancelled := coalesce((o->>'cancelled')::boolean, false);
    v_code      := public.inv_listing_product(p_channel, o->>'item_code', o->>'item_url');

    for v_unit in 1..v_qty loop
      -- 同じ注文が同時に2回届いても在庫を二重に減らさないため、明細ごとに
      -- 先に鍵をかけてから在庫を確保する。あとから来たほうはここで待たされ、
      -- 下の select で「取り込み済み」を見つけて何もしない。
      -- （鍵を取らずに進めると、両方が在庫を取りにいって、あとから来たほうの
      --   unique 違反でロールバックしたときに確保が巻き戻ってしまう）
      perform pg_advisory_xact_lock(hashtextextended(
        p_channel || '/' || v_order || '/' || v_line || '/' || v_unit::text, 0));

      -- すでに取り込んだ明細か（注文番号×明細番号×連番で見る）
      select * into v_row from public.inventory_sale_orders
       where channel = p_channel and order_number = v_order
         and line_number = v_line and unit_no = v_unit
       for update;

      if found then
        v_already := v_already + 1;
        -- 取り込み済みでも、発送・キャンセルの知らせは進める
        if v_cancelled and v_row.status <> 'キャンセル' then
          if v_row.item_id is not null then
            select * into v_item from public.inventory_items where id = v_row.item_id for update;
            if v_item.status = '販売予約' then
              perform public.inv_item_op(v_row.item_id, '予約解除', null,
                       p_channel || ' 注文 ' || v_order || ' のキャンセル');
            end if;
          end if;
          update public.inventory_sale_orders set status = 'キャンセル' where id = v_row.id;
          v_cancelledn := v_cancelledn + 1;
        elsif v_shipped and v_row.status = '受注' and v_row.item_id is not null then
          select * into v_item from public.inventory_items where id = v_row.item_id for update;
          if v_item.status = '販売予約' then
            -- 売却先（sold_channel）も残す。inv_item_op だけだと「どこへ売ったか」が
            -- 空のままになり、ダッシュボードの売却先が分からなくなる
            perform public.inv_item_sell(v_row.item_id, p_channel,
                     nullif(v_row.price, null)::text,
                     p_channel || ' 注文 ' || v_order || ' 発送');
          end if;
          update public.inventory_sale_orders set status = '発送済' where id = v_row.id;
          v_shippedn := v_shippedn + 1;
        end if;
        continue;
      end if;

      -- ここから新しい明細
      if v_code is null then
        insert into public.inventory_sale_orders
          (channel, order_number, line_number, unit_no, item_code, item_url, price,
           ordered_at, status, note, raw)
        values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url',
                (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, '未割当',
                'モールの商品コード・URLから商品を特定できませんでした', o)
        returning * into v_row;
        v_unmatched := v_unmatched || jsonb_build_object(
          'order_number', v_order, 'line_number', v_line,
          'item_code', o->>'item_code', 'item_url', o->>'item_url');
        v_new := v_new + 1;
        continue;
      end if;

      if v_cancelled then
        -- はじめからキャンセルの明細は、在庫を動かさずに記録だけ残す
        insert into public.inventory_sale_orders
          (channel, order_number, line_number, unit_no, item_code, item_url, product_code,
           price, ordered_at, status, raw)
        values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url', v_code,
                (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, 'キャンセル', o);
        v_new := v_new + 1;
        continue;
      end if;

      -- 実在庫の確保。8RENTの予約中・貸出中は status が '在庫' ではないので選ばれない
      begin
        v_item := public.inv_sale_reserve(v_code, p_channel,
                    v_order || '-' || v_line || '-' || v_unit,
                    p_channel || ' 注文 ' || v_order);
      exception when others then
        v_item := null;
      end;

      if v_item.id is null then
        insert into public.inventory_sale_orders
          (channel, order_number, line_number, unit_no, item_code, item_url, product_code,
           price, ordered_at, status, note, raw)
        values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url', v_code,
                (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, '在庫なし',
                '確保できる在庫がありませんでした', o);
        v_nostock := v_nostock || jsonb_build_object(
          'order_number', v_order, 'line_number', v_line, 'product_code', v_code);
        v_new := v_new + 1;
        continue;
      end if;

      insert into public.inventory_sale_orders
        (channel, order_number, line_number, unit_no, item_code, item_url, product_code,
         item_id, price, ordered_at, status, raw)
      values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url', v_code,
              v_item.id, (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, '受注', o)
      returning * into v_row;
      v_new := v_new + 1;
      v_reserved := v_reserved + 1;

      -- 取り込んだ時点ですでに発送済みなら、そのまま売却済へ進める
      if v_shipped then
        perform public.inv_item_sell(v_item.id, p_channel, (o->>'price'),
                 p_channel || ' 注文 ' || v_order || ' 発送');
        update public.inventory_sale_orders set status = '発送済' where id = v_row.id;
        v_shippedn := v_shippedn + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'channel', p_channel,
    'new', v_new, 'already', v_already,
    'reserved', v_reserved, 'shipped', v_shippedn, 'cancelled', v_cancelledn,
    'unmatched', v_unmatched, 'no_stock', v_nostock);
end $$;

comment on function public.inv_sale_orders_apply is
  'モールの受注明細を取り込み、在庫を1台ずつ確保する（在庫→販売予約、発送済みで届いたら売却済）。
   注文番号×明細番号×連番で冪等。商品を特定できない明細は在庫を動かさず「未割当」で記録する。
   確保は inv_sale_reserve（inv_reserve_available_item）を通すので、8RENTの申込と同じ1台を
   二重に取ることはない。security definer だが、操作できるのは inv_can_edit()（管理者・一般）だけ。';

-- ------------------------------------------------------------
-- 33-5) 取り込み後に人が直す（未割当の明細に商品を当てる）
-- ------------------------------------------------------------
create or replace function public.inv_sale_order_link(
  p_id   bigint,
  p_code text
) returns public.inventory_sale_orders
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  r      public.inventory_sale_orders;
  v_item public.inventory_items;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into r from public.inventory_sale_orders where id = p_id for update;
  if not found then
    raise exception '受注明細が見つかりません（%）', p_id;
  end if;
  if r.item_id is not null then
    raise exception 'この明細にはすでに個体が割り当たっています（%）', r.item_id;
  end if;
  if r.status = 'キャンセル' then
    raise exception 'キャンセル済みの明細です';
  end if;
  if not exists (select 1 from public.inventory_products where code = p_code) then
    raise exception '商品が見つかりません（%）', p_code;
  end if;

  v_item := public.inv_sale_reserve(p_code, r.channel,
              r.order_number || '-' || r.line_number || '-' || r.unit_no,
              r.channel || ' 注文 ' || r.order_number || '（手動で割り当て）');
  if v_item.id is null then
    raise exception 'この商品に確保できる在庫がありません（%）', p_code;
  end if;

  update public.inventory_sale_orders
     set product_code = p_code, item_id = v_item.id, status = '受注',
         note = null
   where id = p_id
  returning * into r;
  return r;
end $$;

comment on function public.inv_sale_order_link is
  '商品を特定できなかった受注明細に、人が商品を当てて在庫を確保する。確保は inv_sale_reserve を通す。
   security definer だが、操作できるのは inv_can_edit()（管理者・一般）だけ。';

-- 受注明細の表は読み取り専用。書き込みは inv_sale_orders_apply / inv_sale_order_link だけ
revoke insert, update, delete on public.inventory_sale_orders from authenticated;
grant select on public.inventory_sale_orders to authenticated;
grant execute on function public.inv_listing_product(text,text,text) to authenticated;
grant execute on function public.inv_sale_orders_apply(jsonb,text) to authenticated;
grant execute on function public.inv_sale_order_link(bigint,text) to authenticated;


-- ============================================================
-- 33) 売却の記録と、売却後の販売サイト対応
--
--     売却先・売却価格は選択式にして打ち間違いを減らす（画面側）。
--     どこへ売ったかは inventory_items.sold_channel に持ち、履歴だけ見ても
--     「どこへ・いくらで・原価は・利益は」が分かるようにする。
--
--     売れたあとは販売サイト側の在庫も直す必要がある。その管理画面URLは
--     店舗の契約や画面改定で変わるので、コードに直書きせず設定として持つ
--     （商品ごとの直リンク → チャネルのひな形 → 管理画面のトップ の順で使う）。
--     いまは人が管理画面で直す運用で、/zaiko 側は直したあとに
--     「販売サイト側の対応済み」を押して出品停止にする。将来モールのAPIで
--     在庫数を直せるようになったら inventory_channel_settings.auto_stock_update
--     を立てて自動化する（画面側の操作は変えなくてよい）。
-- ============================================================

-- ------------------------------------------------------------
-- 34-1) 売却の記録を増やす
--     どこへ売ったか（売却先）を個体に持たせる。履歴だけを見ても
--     「どこへ・いくらで・原価は・利益は」が分かるようにする。
-- ------------------------------------------------------------
alter table public.inventory_items add column if not exists sold_channel text;

comment on column public.inventory_items.sold_channel is
  'どこへ売ったか（楽天／Amazon／メルカリ／ヤフオク／Yahoo!フリマ／8EC・店頭／法人販売／自由入力）。
   出品先（inventory_channels）とは別で、実際に売れた先を1つだけ持つ。';

-- ------------------------------------------------------------
-- 34-2) 販売サイトの管理画面URL
--
--     売れたあと、販売サイト側の在庫を直しにいく導線をここから作る。
--     モールの管理画面URLは店舗の契約や画面改定で変わるので、
--     コードに直書きせず、店舗ごとに設定してもらう値として持つ。
--       admin_home_url          … 管理画面のトップ（ログイン先）
--       admin_item_url_template … 商品ごとの画面。{manage} {sku} {item_code} を差し替える
--     商品ごとに確実なURLが分かっているときは、listing の admin_url が最優先。
--
--     いまは人が管理画面で在庫を直す運用。将来モールのAPIで在庫数を
--     更新できるようになったら、この設定行に接続情報を足して自動化する
--     （画面側は「販売サイト側の対応済み」を押す操作のままでよい）。
-- ------------------------------------------------------------
alter table public.inventory_channel_listings add column if not exists admin_url text;

comment on column public.inventory_channel_listings.admin_url is
  'その商品の、販売サイト管理画面の直リンク（人が確認して入れる）。空ならチャネルの設定から組み立てる。';

create table if not exists public.inventory_channel_settings (
  channel                 text primary key,
  label                   text,
  admin_home_url          text,
  admin_item_url_template text,
  auto_stock_update       boolean not null default false,  -- 将来APIで在庫を自動更新するとき true
  note                    text,
  updated_at              timestamptz default now()
);

comment on table public.inventory_channel_settings is
  '販売サイトごとの設定。管理画面URLは店舗の契約や画面改定で変わるため、コードに直書きせずここに持つ。
   auto_stock_update は将来モールのAPIで在庫数を自動更新できるようになったときの切り替え用。';

drop trigger if exists inventory_channel_settings_touch on public.inventory_channel_settings;
create trigger inventory_channel_settings_touch before update on public.inventory_channel_settings
  for each row execute function public.inv_touch();

-- 既定はURL空。実際のURLは各店舗が管理画面で確かめて入れる（推測で入れない）
insert into public.inventory_channel_settings (channel, label, note) values
  ('rakuten',    '楽天',          '楽天RMSの商品管理画面。RMSにログインして対象商品を開き、そのURLを設定してください。'),
  ('amazon',     'Amazon',        'セラーセントラルの在庫管理画面のURLを設定してください。'),
  ('mercari',    'メルカリ',      'メルカリShopsの商品編集画面のURLを設定してください。'),
  ('yahuoku',    'ヤフオク',      'Yahoo!オークションの出品管理画面のURLを設定してください。'),
  ('yahoo_free', 'ヤフーフリマ',  'Yahoo!フリマの出品管理画面のURLを設定してください。'),
  ('other',      'その他',        null),
  ('notion',     'Notion',        null)
on conflict (channel) do nothing;

alter table public.inventory_channel_settings enable row level security;

drop policy if exists inventory_channel_settings_read on public.inventory_channel_settings;
create policy inventory_channel_settings_read on public.inventory_channel_settings
  for select to authenticated using (public.inv_role() in ('admin','member','viewer'));

create or replace function public.inv_channel_settings_set(
  p_channel  text,
  p_home     text default null,
  p_template text default null,
  p_note     text default null
) returns public.inventory_channel_settings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_settings;
begin
  if not public.inv_is_admin() then
    raise exception '販売サイトの設定は管理者だけが変えられます';
  end if;
  insert into public.inventory_channel_settings (channel, admin_home_url, admin_item_url_template, note)
  values (p_channel, nullif(btrim(coalesce(p_home,'')),''),
          nullif(btrim(coalesce(p_template,'')),''), nullif(btrim(coalesce(p_note,'')),''))
  on conflict (channel) do update
    set admin_home_url          = nullif(btrim(coalesce(p_home,'')),''),
        admin_item_url_template = nullif(btrim(coalesce(p_template,'')),''),
        note                    = coalesce(nullif(btrim(coalesce(p_note,'')),''), public.inventory_channel_settings.note)
  returning * into r;
  return r;
end $$;

comment on function public.inv_channel_settings_set is
  '販売サイトの管理画面URL（トップ・商品ごとのひな形）を設定する。管理者だけ。';

-- ------------------------------------------------------------
-- 34-3) 売却を記録する（売却先つき）
--     状態の変更と履歴は これまでどおり inv_item_op('売却') に任せる。
--     ここは「どこへ売ったか」を先に入れてから渡すだけで、規則は二重に持たない。
-- ------------------------------------------------------------
create or replace function public.inv_item_sell(
  p_item_id text,
  p_channel text default null,
  p_price   text default null,
  p_note    text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it public.inventory_items;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_items
     set sold_channel = nullif(btrim(coalesce(p_channel,'')),'')
   where id = p_item_id;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;
  it := public.inv_item_op(p_item_id, '売却', p_price, p_note);
  return it;
end $$;

comment on function public.inv_item_sell is
  '売却先つきで1台を売却済にする。状態変更と履歴は inv_item_op(''売却'') と同じものを通す。';

create or replace function public.inv_listing_admin_url_set(
  p_code    text,
  p_channel text,
  p_url     text
) returns public.inventory_channel_listings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_listings;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_channel_listings
     set admin_url = nullif(btrim(coalesce(p_url,'')),'')
   where product_code = p_code and channel = p_channel
  returning * into r;
  if not found then
    raise exception 'この商品の出品情報がありません（% / %）', p_code, p_channel;
  end if;
  return r;
end $$;

comment on function public.inv_listing_admin_url_set is
  'その商品の販売サイト管理画面URL（直リンク）を入れ直す。人が管理画面で確かめた値だけを入れる。';

grant execute on function public.inv_listing_admin_url_set(text,text,text) to authenticated;

grant select on public.inventory_channel_settings to authenticated;
grant execute on function public.inv_channel_settings_set(text,text,text,text) to authenticated;
grant execute on function public.inv_item_sell(text,text,text,text) to authenticated;


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
grant execute on function public.inv_items_bulk_op(text[],text,text,text,date,boolean) to authenticated;
grant execute on function public.inv_rakuten_apply_one(text,jsonb) to authenticated;
grant execute on function public.inv_rakuten_sync_targets(text) to authenticated;
grant execute on function public.inv_img_hires(text) to anon, authenticated;
grant execute on function public.inv_listing_from_items(text,text) to authenticated;
grant execute on function public.inv_listing_url_accept(text,text) to authenticated;
grant execute on function public.inv_listing_url_dismiss(text,text) to authenticated;
grant execute on function public.inv_rakuten_sync_apply(jsonb) to authenticated;
grant execute on function public.inv_rakuten_link_confirm(text,jsonb) to authenticated;
grant execute on function public.inv_product_images_set(text,text,jsonb) to authenticated;
-- anon（8RENT・8ECトップの一般訪問者）にはこの関数の実行だけを許可。テーブルへの直接書き込み権限は与えない
grant execute on function public.inv_rental_request_create(text[],text,integer,text,text,text,date,integer,boolean,text,jsonb) to anon;
grant execute on function public.inv_model_key(text,text,text) to anon, authenticated;
grant execute on function public.inv_rental_allocate(bigint) to authenticated;
grant execute on function public.inv_product_procurement_set(text,boolean) to authenticated;
revoke all on function public.inv_product_sale_set(text,boolean,integer,text,boolean) from public;
grant execute on function public.inv_product_sale_set(text,boolean,integer,text,boolean) to authenticated;
grant execute on function public.inv_rental_text(text) to authenticated;
-- 一括生成は authenticated だけに渡す（anon・PUBLIC には渡さない）。
-- 管理者以外のWebユーザーは、関数の中の inv_can_maintain() で弾かれる
revoke all on function public.inv_rental_text_fill(boolean) from public;
grant execute on function public.inv_rental_text_fill(boolean) to authenticated;
revoke all on function public.inv_is_db_session() from public;
revoke all on function public.inv_can_maintain() from public;
grant execute on function public.inv_is_db_session(), public.inv_can_maintain() to authenticated;
grant execute on function public.inv_product_rental_description_set(text,text,boolean) to authenticated;
grant execute on function public.inv_rental_form(public.inventory_products) to authenticated;
grant execute on function public.inv_product_rental_form_set(text,text,text,boolean) to authenticated;
grant execute on function public.inv_rental_unclassified() to authenticated;
grant execute on function public.inv_dashboard_stats(date) to authenticated;
grant usage on schema public to anon;
grant select on public.inv_rental_catalog to anon, authenticated;
grant select on public.inv_public_products to anon, authenticated;
grant select on public.inv_public_catalog to anon, authenticated;
grant select on public.inv_public_categories to anon, authenticated;
-- 販売チャネルへ送る数量は社内用（anonには出さない）
grant select on public.inv_channel_stock_feed to authenticated;
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
-- テーブルへの insert は許可しない＝新しい申込は inv_rental_apply()（security definer）経由だけ
drop policy if exists "inventory_rental_requests update" on public.inventory_rental_requests;
create policy "inventory_rental_requests update" on public.inventory_rental_requests
  for update to authenticated
  using (public.inv_can_edit()) with check (public.inv_can_edit());


-- ============================================================
-- 保管場所・カテゴリーのマスター管理（管理者だけ）
-- ============================================================

create or replace function public.inv_location_save(
  p_id      text default null,
  p_name    text default null,
  p_kind    text default 'shelf',
  p_parent  text default null,
  p_sort    integer default null,
  p_enabled boolean default true
) returns public.inventory_locations
language plpgsql
security invoker
set search_path = public
as $$
declare
  r      public.inventory_locations;
  v_id   text := nullif(btrim(coalesce(p_id, '')), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_par  text := nullif(btrim(coalesce(p_parent, '')), '');
  v_cur  text;
  n      integer;
begin
  if not public.inv_is_admin() then
    raise exception '保管場所を直せるのは管理者だけです';
  end if;
  if v_name is null then
    raise exception '名称を入れてください';
  end if;
  if p_kind not in ('site', 'room', 'shelf', 'other') then
    raise exception '種別は 拠点・倉庫・棚・その他 のどれかです（%）', p_kind;
  end if;
  if v_par is not null and not exists (select 1 from public.inventory_locations where id = v_par) then
    raise exception '親の保管場所が見つかりません（%）', v_par;
  end if;

  -- 自分自身・自分の子孫を親にしない（親をたどって自分に戻らないか見る）
  if v_id is not null and v_par is not null then
    if v_par = v_id then
      raise exception '自分自身を親にはできません';
    end if;
    v_cur := v_par;
    for n in 1..50 loop
      select parent_id into v_cur from public.inventory_locations where id = v_cur;
      exit when v_cur is null;
      if v_cur = v_id then
        raise exception '自分の下にある場所を親にはできません（入れ子が輪になります）';
      end if;
    end loop;
  end if;

  if exists (select 1 from public.inventory_locations
              where name = v_name
                and coalesce(parent_id, '') = coalesce(v_par, '')
                and (v_id is null or id <> v_id)) then
    raise exception '同じ場所の下に「%」がすでにあります', v_name;
  end if;

  if v_id is null then
    -- L1, L2 … と同じ形で採番する（棚QRのURLに入るキーなので短く保つ）
    select 'L' || (coalesce(max(nullif(regexp_replace(id, '^L', ''), '')::integer), 0) + 1)::text
      into v_id
      from public.inventory_locations
     where id ~ '^L[0-9]+$';
    insert into public.inventory_locations (id, parent_id, name, kind, sort_no, enabled)
    values (v_id, v_par, v_name, p_kind,
            coalesce(p_sort, (select coalesce(max(sort_no), 0) + 10 from public.inventory_locations
                               where coalesce(parent_id, '') = coalesce(v_par, ''))),
            coalesce(p_enabled, true))
    returning * into r;
  else
    update public.inventory_locations
       set name = v_name, kind = p_kind, parent_id = v_par,
           sort_no = coalesce(p_sort, sort_no), enabled = coalesce(p_enabled, enabled)
     where id = v_id
    returning * into r;
    if not found then
      raise exception '保管場所が見つかりません（%）', v_id;
    end if;
  end if;
  return r;
end $$;

comment on function public.inv_location_save is
  '保管場所を足す・直す（管理者だけ）。IDを渡さなければ新規、渡せば更新。
   自分自身や自分の子孫は親にできない。同じ親の下に同じ名前は作れない。';

create or replace function public.inv_location_delete_check(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  l       public.inventory_locations;
  reasons jsonb := '[]'::jsonb;
  n       integer;
  v_path  text;
begin
  select * into l from public.inventory_locations where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'found', false,
      'reasons', jsonb_build_array('この保管場所は見つかりません。'::text));
  end if;

  select count(*) into n from public.inventory_locations where parent_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('この下に保管場所が ' || n || '件あります。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  -- 個体の論理削除（deleted_at）は別のブランチで入る列なので、あっても無くても
  -- 同じように数えられる形にしている（列が無ければ to_jsonb に出てこない＝null）
  select count(*) into n from public.inventory_items i
   where i.location_id = p_id and (to_jsonb(i) ->> 'deleted_at') is null;
  if n > 0 then
    reasons := reasons || to_jsonb(('個体が ' || n || '台置かれています。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  select count(*) into n from public.inventory_products where location_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('数量管理の品目が ' || n || '件置かれています。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  -- 移動の履歴。inv_item_op('移動') は保管場所をフルパスの文字列で残すので、
  -- そのパスで引き当てる（履歴の表に保管場所IDを持たせていないため）
  v_path := public.inv_location_path(p_id);
  if coalesce(v_path, '') <> '' then
    select count(*) into n from public.inventory_transactions
     where ref_kind = 'item' and action = '移動'
       and (before_value = v_path or after_value = v_path or after_value like v_path || '／%');
    if n > 0 then
      reasons := reasons || to_jsonb(('移動の履歴が ' || n || '件あります。別の保管場所へ移動するか、無効にしてください。')::text);
    end if;
  end if;

  select count(*) into n from public.inventory_stocktakes where scope_location_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('棚卸の記録が ' || n || '件あります。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  return jsonb_build_object('ok', jsonb_array_length(reasons) = 0, 'found', true,
    'id', l.id, 'name', l.name, 'reasons', reasons);
end $$;

comment on function public.inv_location_delete_check is
  '保管場所を消してよいかを返す。だめなときは件数と「別の保管場所へ移動するか、無効にしてください」を返す。';

create or replace function public.inv_location_delete(p_id text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  l   public.inventory_locations;
  chk jsonb;
begin
  if not public.inv_is_admin() then
    raise exception '保管場所を消せるのは管理者だけです';
  end if;
  select * into l from public.inventory_locations where id = p_id for update;
  if not found then
    raise exception '保管場所が見つかりません（%）', p_id;
  end if;
  -- 押すまでのあいだに物が置かれていることがあるので、ここでもう一度見る
  chk := public.inv_location_delete_check(p_id);
  if not (chk ->> 'ok')::boolean then
    raise exception '%', (select string_agg(value, ' ') from jsonb_array_elements_text(chk -> 'reasons'));
  end if;
  delete from public.inventory_locations where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'name', l.name);
end $$;

comment on function public.inv_location_delete is
  '空で使われていない保管場所を消す（管理者だけ）。関連データは道連れにしない。';

create or replace function public.inv_category_save(
  p_id      text default null,
  p_name    text default null,
  p_kind    text default 'individual',
  p_parent  text default null,
  p_icon    text default null,
  p_sort    integer default null,
  p_enabled boolean default true,
  p_public  boolean default false,
  p_prefix  text default null
) returns public.inventory_categories
language plpgsql
security invoker
set search_path = public
as $$
declare
  r      public.inventory_categories;
  v_id   text := nullif(btrim(lower(coalesce(p_id, ''))), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_par  text := nullif(btrim(coalesce(p_parent, '')), '');
  v_cur  text;
  v_base text;
  n      integer;
begin
  if not public.inv_is_admin() then
    raise exception 'カテゴリーを直せるのは管理者だけです';
  end if;
  if v_name is null then
    raise exception '表示名を入れてください';
  end if;
  if p_kind not in ('individual', 'quantity') then
    raise exception '管理方式は 個体管理 か 数量管理 です（%）', p_kind;
  end if;
  if v_par is not null and not exists (select 1 from public.inventory_categories where id = v_par) then
    raise exception '親カテゴリーが見つかりません（%）', v_par;
  end if;

  if v_id is not null and v_par is not null then
    if v_par = v_id then
      raise exception '自分自身を親にはできません';
    end if;
    v_cur := v_par;
    for n in 1..50 loop
      select parent_id into v_cur from public.inventory_categories where id = v_cur;
      exit when v_cur is null;
      if v_cur = v_id then
        raise exception '自分の下にあるカテゴリーを親にはできません（入れ子が輪になります）';
      end if;
    end loop;
  end if;

  if exists (select 1 from public.inventory_categories
              where name = v_name
                and coalesce(parent_id, '') = coalesce(v_par, '')
                and (v_id is null or id <> v_id)) then
    raise exception '同じ場所に「%」がすでにあります', v_name;
  end if;

  if v_id is null or not exists (select 1 from public.inventory_categories where id = v_id) then
    -- 新規。IDは英数字とハイフンだけにする（URL・公開ビューに出るため）
    -- 名前からIDを作るのは、名前が英数字だけのときに限る。
    -- 「タブレットPC」から 'pc' を作ると、中身と合わない紛らわしいIDになるため。
    -- 日本語が混じる名前は cat-1, cat-2 … にする（IDはURLと公開ビューに出るので英数字だけにする）
    if v_id is null and v_name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]*$' then
      v_id := btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-');
    end if;
    v_id := btrim(regexp_replace(coalesce(v_id, ''), '[^a-z0-9-]+', '-', 'g'), '-');
    if v_id = '' or v_id !~ '^[a-z0-9][a-z0-9-]*$' then
      select 'cat-' || (coalesce(max(nullif(regexp_replace(id, '^cat-', ''), '')::integer), 0) + 1)::text
        into v_id
        from public.inventory_categories
       where id ~ '^cat-[0-9]+$';
    end if;
    -- 名前から作ったIDが埋まっていたら、末尾に番号を足す
    -- （「タブレットPC」→ pc が埋まっている → pc-2）。
    -- IDを人が指定したときだけは、黙って別のIDにせずエラーにする
    if exists (select 1 from public.inventory_categories where id = v_id) then
      if nullif(btrim(lower(coalesce(p_id, ''))), '') is not null then
        raise exception 'カテゴリーID「%」はすでに使われています。別のIDを指定してください', v_id;
      end if;
      v_base := v_id;
      for n in 2..99 loop
        v_id := v_base || '-' || n::text;
        exit when not exists (select 1 from public.inventory_categories where id = v_id);
      end loop;
      if exists (select 1 from public.inventory_categories where id = v_id) then
        raise exception 'カテゴリーIDを決められませんでした。IDを指定してください';
      end if;
    end if;
    insert into public.inventory_categories
      (id, name, kind, code_prefix, sort_no, parent_id, enabled, public_listed, public_icon)
    values
      (v_id, v_name, p_kind, nullif(btrim(coalesce(p_prefix, '')), ''),
       coalesce(p_sort, (select coalesce(max(sort_no), 0) + 10 from public.inventory_categories
                          where coalesce(parent_id, '') = coalesce(v_par, ''))),
       v_par, coalesce(p_enabled, true), coalesce(p_public, false),
       nullif(btrim(coalesce(p_icon, '')), ''))
    returning * into r;
  else
    update public.inventory_categories
       set name = v_name, kind = p_kind, parent_id = v_par,
           code_prefix = coalesce(nullif(btrim(coalesce(p_prefix, '')), ''), code_prefix),
           sort_no = coalesce(p_sort, sort_no),
           enabled = coalesce(p_enabled, enabled),
           public_listed = coalesce(p_public, public_listed),
           public_icon = coalesce(nullif(btrim(coalesce(p_icon, '')), ''), public_icon)
     where id = v_id
    returning * into r;
  end if;
  return r;
end $$;

comment on function public.inv_category_save is
  'カテゴリーを足す・直す（管理者だけ）。IDは作るときだけ決まり、あとから変えられない
   （変えると商品・個体・URL・公開側の紐付けが一斉に切れるため）。表示名を変えても
   商品はIDで紐づいているので切れない。';

create or replace function public.inv_category_delete_check(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  c       public.inventory_categories;
  reasons jsonb := '[]'::jsonb;
  n       integer;
  n_pub   integer;
begin
  select * into c from public.inventory_categories where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'found', false,
      'reasons', jsonb_build_array('このカテゴリーは見つかりません。'::text));
  end if;

  select count(*) into n from public.inventory_categories where parent_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('この下にカテゴリーが ' || n || '件あります。先に付け替えるか、無効にしてください。')::text);
  end if;

  select count(*) into n from public.inventory_products where category_id = p_id;
  select count(*) into n_pub from public.inventory_products
   where category_id = p_id and coalesce(rental_enabled, false);
  if n_pub > 0 then
    reasons := reasons || to_jsonb(('公開中・8RENT対象の商品が ' || n_pub || '件あります。別のカテゴリーへ移すか、無効にしてください。')::text);
  elsif n > 0 then
    reasons := reasons || to_jsonb(('商品が ' || n || '件ぶら下がっています。別のカテゴリーへ移すか、無効にしてください。')::text);
  end if;

  select count(*) into n from public.inventory_items i
   where i.category_id = p_id and (to_jsonb(i) ->> 'deleted_at') is null;
  if n > 0 then
    reasons := reasons || to_jsonb(('個体が ' || n || '台ぶら下がっています。別のカテゴリーへ移すか、無効にしてください。')::text);
  end if;

  return jsonb_build_object('ok', jsonb_array_length(reasons) = 0, 'found', true,
    'id', c.id, 'name', c.name,
    'products', (select count(*) from public.inventory_products where category_id = p_id),
    'reasons', reasons);
end $$;

comment on function public.inv_category_delete_check is
  'カテゴリーを消してよいかを返す。だめなときは紐付いている件数と、移し替えを促す文を返す。';

create or replace function public.inv_category_delete(p_id text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  c   public.inventory_categories;
  chk jsonb;
begin
  if not public.inv_is_admin() then
    raise exception 'カテゴリーを消せるのは管理者だけです';
  end if;
  select * into c from public.inventory_categories where id = p_id for update;
  if not found then
    raise exception 'カテゴリーが見つかりません（%）', p_id;
  end if;
  chk := public.inv_category_delete_check(p_id);
  if not (chk ->> 'ok')::boolean then
    raise exception '%', (select string_agg(value, ' ') from jsonb_array_elements_text(chk -> 'reasons'));
  end if;
  delete from public.inventory_categories where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'name', c.name);
end $$;

comment on function public.inv_category_delete is
  '空で使われていないカテゴリーを消す（管理者だけ）。商品や個体は道連れにしない。';

create or replace function public.inv_category_resolve(p_value text, p_kind text default null)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with v as (select btrim(coalesce(p_value, '')) as t)
  select c.id
    from public.inventory_categories c, v
   where v.t <> ''
     and (p_kind is null or c.kind = p_kind)
     and (lower(c.id) = lower(v.t)
          or c.name = v.t
          or exists (select 1 from unnest(c.aliases) a where btrim(a) = v.t))
   order by (lower(c.id) = lower(v.t)) desc, (c.name = v.t) desc, c.sort_no
   limit 1;
$$;

comment on function public.inv_category_resolve is
  'CSVなどに書かれたカテゴリーの値（ID・表示名・別名）をカテゴリーIDへ寄せる。
   見つからなければ null。知らないカテゴリーを自動で作ることはしない。';

revoke all on function public.inv_location_save(text,text,text,text,integer,boolean) from public;
revoke all on function public.inv_location_delete_check(text) from public;
revoke all on function public.inv_location_delete(text) from public;
revoke all on function public.inv_category_save(text,text,text,text,text,integer,boolean,boolean,text) from public;
revoke all on function public.inv_category_delete_check(text) from public;
revoke all on function public.inv_category_delete(text) from public;
revoke all on function public.inv_category_resolve(text,text) from public;

grant execute on function public.inv_location_save(text,text,text,text,integer,boolean) to authenticated;
grant execute on function public.inv_location_delete_check(text) to authenticated;
grant execute on function public.inv_location_delete(text) to authenticated;
grant execute on function public.inv_category_save(text,text,text,text,text,integer,boolean,boolean,text) to authenticated;
grant execute on function public.inv_category_delete_check(text) to authenticated;
grant execute on function public.inv_category_delete(text) to authenticated;
grant execute on function public.inv_category_resolve(text,text) to authenticated;


-- ============================================================
-- 法人ITまるごと見積（/quote）の案件
-- ============================================================

-- ------------------------------------------------------------
-- 44-1) 案件
--
--     商品は決まっていなくてよい（product_code を持たない）。
--     公開側は「何が要るか」を書くだけで、何をどう用意するかは社内で決める。
--
--     状態は、レンタル申込（inventory_rental_requests）と同じ言葉から始めて、
--     見積・承認・契約まで伸ばしている。Phase 1 で使うのは 希望受付 だけで、
--     先の状態は画面から進められるようにしてある。
-- ------------------------------------------------------------
create table if not exists public.inventory_deals (
  id            bigint generated by default as identity primary key,
  -- どこから届いたか（top / quote / pc など。あとで導線ごとの成果を見るため）
  source        text not null default 'quote',
  status        text not null default '希望受付',

  -- お客様
  company       text,
  customer_name text not null,
  email         text,
  phone         text,

  -- 何に使うか
  purpose       text,                  -- 新入社員 / 短期プロジェクト / オフィス開設 …
  headcount     integer,               -- 人数
  qty           integer,               -- 希望台数
  start_date    date,                  -- 利用開始希望日
  months        integer,               -- 利用期間（月）。買い切り希望なら null

  -- どんなものが要るか。選択肢が増えても表を変えなくてよいよう jsonb で持つ
  --   spec      … cpu / memory / storage / screen / office / webcam / numpad
  --   services  … 初期設定・ネットワーク・セキュリティ・現地設置・研修 …
  --   grade     … budget（コスト重視）/ standard / latest（新品・最新）/ any（おまかせ）
  spec          jsonb not null default '{}'::jsonb,
  services      text[] not null default '{}',
  grade         text,
  message       text,                  -- その他のご希望

  -- 社内
  note          text,                  -- スタッフのメモ
  actor         text,                  -- 最後に動かした人

  -- 商品からの購入相談（product_code / want）は、この下の alter で足す
  -- （本番は 2026-09-21-deals.sql のあとに追補を当てているので、列の並びをそろえる）

  -- Stripe（Phase 3で使う。いまは入れない）
  stripe_customer_id     text,
  stripe_subscription_id text,
  stripe_invoice_id      text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.inventory_deals is
  '法人ITまるごと見積（/quote）から届く案件。商品が決まっていなくても受けられる。
   この時点では決済も個体の確保もしない（status=希望受付）。
   購入・レンタル・組み合わせのどれにするかは、社内で中身を見てから決める。';
comment on column public.inventory_deals.services is
  '希望する付帯作業。初期設定・キッティング・ネットワーク・セキュリティ・現地設置・研修 など。';
comment on column public.inventory_deals.grade is
  'budget（コスト重視・整備済み中心）/ standard / latest（新品・最新）/ any（おまかせ）。
   お客様に新品と中古を最初から選ばせるのではなく、方針だけ伺う。';
comment on column public.inventory_deals.spec is
  '希望スペックの控え（CPU・メモリ・ストレージ・画面・Office・カメラ・テンキー）。
   選択肢が増えても表を変えなくてよいように jsonb で持つ。';
comment on column public.inventory_deals.stripe_customer_id is
  'Phase 3 で使う。Phase 1 では常に NULL。決済はこの表では完結させず、
   請求・継続課金は別テーブル（Phase 3）で持つ。';

create index if not exists inventory_deals_status_idx
  on public.inventory_deals (status, created_at desc);
create index if not exists inventory_deals_created_idx
  on public.inventory_deals (created_at desc);

drop trigger if exists inventory_deals_touch on public.inventory_deals;
create trigger inventory_deals_touch before update on public.inventory_deals
  for each row execute function public.inv_touch();

-- 既存のレンタル申込からも案件をたどれるようにしておく（Phase 2 で使う）
alter table public.inventory_deals
  add column if not exists product_code text
    references public.inventory_products(code) on delete set null;
alter table public.inventory_deals add column if not exists want text;
alter table public.inventory_deals drop constraint if exists inventory_deals_want_chk;
alter table public.inventory_deals add constraint inventory_deals_want_chk
  check (want is null or want in ('購入希望', 'レンタル希望', '未定'));

comment on column public.inventory_deals.product_code is
  'どの商品を見て相談が始まったか。商品が決まっていない相談では null。';
comment on column public.inventory_deals.want is
  '購入希望 / レンタル希望 / 未定。お客様の希望で、確定ではない。
   購入とレンタルのどちらで出すかは、社内で中身を見てから決める。';

alter table public.inventory_rental_requests
  add column if not exists deal_id bigint references public.inventory_deals(id) on delete set null;

comment on column public.inventory_rental_requests.deal_id is
  'もとになった案件。機種指定の申込と、まるごと見積から始まった案件をつなぐ（Phase 2で使う）。';

-- ------------------------------------------------------------
-- 44-2) 公開側から希望を送る
--
--     匿名（anon）から呼べる唯一の書き込み口。security definer にして、
--     表そのものへの insert 権限は渡さない（列を選んで入れさせないため）。
--     決済もしないし、個体も押さえない。ここでやるのは保存だけ。
-- ------------------------------------------------------------
create or replace function public.inv_deal_create(
  p_name         text,
  p_company      text default null,
  p_email        text default null,
  p_phone        text default null,
  p_purpose      text default null,
  p_headcount    integer default null,
  p_qty          integer default null,
  p_start        date default null,
  p_months       integer default null,
  p_grade        text default null,
  p_spec         jsonb default '{}'::jsonb,
  p_services     text[] default '{}',
  p_message      text default null,
  p_source       text default 'quote',
  p_product_code text default null,
  p_want         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id   bigint;
  v_code text;
  v_want text;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'ご担当者名を入力してください';
  end if;
  if coalesce(p_qty, 0) < 0 or coalesce(p_qty, 0) > 5000 then
    raise exception '台数は0〜5000台でお願いします（それ以上はお電話でご相談ください）';
  end if;
  if coalesce(p_headcount, 0) < 0 or coalesce(p_headcount, 0) > 5000 then
    raise exception '人数は0〜5000名でお願いします';
  end if;
  if p_months is not null and (p_months < 0 or p_months > 120) then
    raise exception '利用期間は0〜120ヶ月でお願いします';
  end if;
  if p_grade is not null and p_grade not in ('budget', 'standard', 'latest', 'any') then
    raise exception 'ご希望の方針が正しくありません（%）', p_grade;
  end if;

  v_want := nullif(btrim(coalesce(p_want, '')), '');
  if v_want is not null and v_want not in ('購入希望', 'レンタル希望', '未定') then
    v_want := '未定';   -- 知らない値は落とさず「未定」にする（相談を取りこぼさない）
  end if;

  -- 知らない商品コードで落とさない。公開ページのリンクは古くなることがあるので、
  -- 見つからなければ商品を付けずに受け付ける（相談そのものは受ける）
  v_code := nullif(btrim(coalesce(p_product_code, '')), '');
  if v_code is not null
     and not exists (select 1 from public.inventory_products where code = v_code) then
    v_code := null;
  end if;

  insert into public.inventory_deals
    (source, status, company, customer_name, email, phone,
     purpose, headcount, qty, start_date, months, grade, spec, services, message,
     product_code, want)
  values
    (coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'quote'), '希望受付',
     nullif(btrim(coalesce(p_company, '')), ''), btrim(p_name),
     nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_phone, '')), ''),
     nullif(btrim(coalesce(p_purpose, '')), ''), p_headcount, p_qty, p_start, p_months,
     p_grade, coalesce(p_spec, '{}'::jsonb), coalesce(p_services, '{}'),
     nullif(btrim(coalesce(p_message, '')), ''),
     v_code, v_want)
  returning id into v_id;

  return jsonb_build_object('deal_id', v_id, 'status', '希望受付');
end $$;

comment on function public.inv_deal_create is
  '法人ITまるごと見積・商品からの購入相談の送信口。匿名から呼べる。
   保存するだけで、決済も個体の確保もしない。商品コードが付いていても在庫は押さえない。';

-- ------------------------------------------------------------
-- 44-3) 社内で案件を動かす
-- ------------------------------------------------------------
create or replace function public.inv_deal_set_status(
  p_id     bigint,
  p_status text
) returns public.inventory_deals
language plpgsql
security invoker
set search_path = public
as $$
declare r public.inventory_deals;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_status not in ('希望受付', '在庫・調達確認', '見積', '顧客承認', '契約準備',
                      '契約', '支払条件確定', '手配', '完了', 'ご縁なし') then
    raise exception '知らない状態です（%）', p_status;
  end if;
  update public.inventory_deals
     set status = p_status, actor = public.inv_actor()
   where id = p_id
  returning * into r;
  if not found then
    raise exception '案件が見つかりません（%）', p_id;
  end if;
  return r;
end $$;

comment on function public.inv_deal_set_status is
  '案件の状態を進める。希望受付 → 在庫・調達確認 → 見積 → 顧客承認 → 契約準備 →
   契約 → 支払条件確定 → 手配 → 完了。
   顧客が見積を承認したときは inv_quote_decide が「契約準備」へ進める。';

create or replace function public.inv_deal_note(
  p_id   bigint,
  p_note text
) returns public.inventory_deals
language plpgsql
security invoker
set search_path = public
as $$
declare r public.inventory_deals;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_deals
     set note = nullif(btrim(coalesce(p_note, '')), ''), actor = public.inv_actor()
   where id = p_id
  returning * into r;
  if not found then
    raise exception '案件が見つかりません（%）', p_id;
  end if;
  return r;
end $$;

comment on function public.inv_deal_note is '案件に社内メモを書く。';

-- ------------------------------------------------------------
-- 44-4) 権限
--
--     案件にはお客様の連絡先が入るので、anon には読ませない。
--     書き込みも表へ直接はさせず、inv_deal_create() だけを開ける。
-- ------------------------------------------------------------
alter table public.inventory_deals enable row level security;

drop policy if exists "inventory_deals read" on public.inventory_deals;
create policy "inventory_deals read" on public.inventory_deals
  for select to authenticated using (true);

drop policy if exists "inventory_deals write" on public.inventory_deals;
create policy "inventory_deals write" on public.inventory_deals
  for update to authenticated
  using (public.inv_can_edit()) with check (public.inv_can_edit());

grant select, update on public.inventory_deals to authenticated;

-- /quote の3分IT調達診断。ブラウザからは直接呼べない（必ず /api/quote を通す）
revoke all on function public.inv_deal_create(text,text,text,text,text,integer,integer,date,integer,text,jsonb,text[],text,text,text,text) from public, anon;
grant execute on function public.inv_deal_create(text,text,text,text,text,integer,integer,date,integer,text,jsonb,text[],text,text,text,text) to authenticated, service_role;
revoke all on function public.inv_deal_set_status(bigint,text) from public;
revoke all on function public.inv_deal_note(bigint,text) from public;
grant execute on function public.inv_deal_set_status(bigint,text) to authenticated;
grant execute on function public.inv_deal_note(bigint,text) to authenticated;


-- ============================================================
-- 46) 見積（希望受付 → 見積作成 → 顧客提示 → 顧客承認 → 契約準備）
--
--     案件（inventory_deals）1件に、版（rev）を持つ見積をぶら下げる。
--       ・提示済みの見積は編集しない（直すときは複製して新しい版を作る）
--       ・新しい版を提示したら、前の提示済みの版は自動で失効させる
--         （お客様が古いURLから承認してしまう事故を防ぐ）
--       ・明細は「そのときの内容」を写して持つ（品名・スペック・単価）
--       ・顧客の［この内容で進める］は契約ではなく意思表示。
--         **この時点で在庫（inventory_items）は一切動かさない**
--       ・Stripeはまだ入れない（Phase 3）
-- ============================================================

-- ------------------------------------------------------------
-- 46-1) 見積（案件 × 版）
-- ------------------------------------------------------------
create table if not exists public.inventory_quotes (
  id            bigint generated by default as identity primary key,
  deal_id       bigint not null references public.inventory_deals(id) on delete cascade,
  rev           integer not null default 1,
  status        text not null default '作成中',
  title         text,

  -- 有効期限。既定は提示した日から14日（提示のときに入れる）
  valid_until   date,
  tax_rate      numeric(5,2) not null default 10,

  note          text,          -- お客様向けの但し書き
  internal_note text,          -- 社内メモ（顧客ページには絶対に出さない）

  -- 顧客ページのURLの鍵。提示のときに作る
  token            text unique,
  token_expires_at timestamptz,

  presented_at  timestamptz,
  decided_at    timestamptz,
  decided_by    text,          -- お客様が入力したお名前
  customer_message text,       -- ［内容について相談する］で書かれた内容

  actor         text,          -- 最後に動かした社内の人
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (deal_id, rev)
);

comment on table public.inventory_quotes is
  '案件に対する見積。版（rev）を持ち、提示済みの版は編集しない（直すときは複製して新しい版を作る）。
   新しい版を提示すると、前の提示済みの版は自動で失効する。';
comment on column public.inventory_quotes.status is
  '作成中 / 提示済み / 承認 / 相談中 / 失効 / 取消。顧客が動かせるのは 承認 と 相談中 だけ。';
comment on column public.inventory_quotes.token is
  '顧客ページ（/q/:token）の鍵。提示のときに作る。推測できない長さにする。';
comment on column public.inventory_quotes.internal_note is
  '社内メモ。inv_quote_public() は返さないので、顧客ページには出ない。';

alter table public.inventory_quotes drop constraint if exists inventory_quotes_status_chk;
alter table public.inventory_quotes add constraint inventory_quotes_status_chk
  check (status in ('作成中', '提示済み', '承認', '相談中', '失効', '取消'));
alter table public.inventory_quotes drop constraint if exists inventory_quotes_tax_chk;
alter table public.inventory_quotes add constraint inventory_quotes_tax_chk
  check (tax_rate >= 0 and tax_rate <= 30);

create index if not exists inventory_quotes_deal_idx on public.inventory_quotes (deal_id, rev desc);
create index if not exists inventory_quotes_status_idx on public.inventory_quotes (status, created_at desc);

drop trigger if exists inventory_quotes_touch on public.inventory_quotes;
create trigger inventory_quotes_touch before update on public.inventory_quotes
  for each row execute function public.inv_touch();

-- 見積番号は Q-案件ID-版（画面と顧客ページで同じものを出す）
create or replace function public.inv_quote_no(p_deal bigint, p_rev integer)
returns text language sql immutable as $$
  select 'Q-' || lpad(p_deal::text, 5, '0') || '-' || p_rev::text
$$;

-- ------------------------------------------------------------
-- 46-2) 見積明細
--
--     kind（明細の種類）
--       sale            販売（機器）        一括
--       rental          レンタル（機器）    月額
--       setup           初期設定費          一括
--       kitting         キッティング費      一括
--       install         現地設置・配線費    一括
--       network         ネットワーク構築費  一括
--       service_monthly 月額サービス        月額
--       training        AI研修・Office研修  一括
--       other           その他              一括
--
--     金額は amount（生成列）。月額は 単価 × 数量 × 月数。
--     品名・スペック・単価は「そのときの内容」を写して持つ（スナップショット）。
-- ------------------------------------------------------------
create table if not exists public.inventory_quote_items (
  id           bigint generated by default as identity primary key,
  quote_id     bigint not null references public.inventory_quotes(id) on delete cascade,
  sort_no      integer not null default 0,
  kind         text not null default 'other',
  product_code text references public.inventory_products(code) on delete set null,
  name         text not null,
  spec         text,
  qty          integer not null default 1,
  unit_price   integer not null default 0,
  months       integer,
  billing      text not null default 'one_time',
  taxable      boolean not null default true,
  note         text,
  amount       integer generated always as
    (qty * unit_price * (case when billing = 'monthly' then greatest(coalesce(months, 1), 1) else 1 end)) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.inventory_quote_items is
  '見積の明細。販売・レンタル・設定費・設置費・月額サービス・研修を1つの見積に混在できる。
   品名・スペック・単価はそのときの内容を写して持つので、あとから商品マスタが変わっても見積は変わらない。';
comment on column public.inventory_quote_items.amount is
  '金額（税抜）。一括は 単価×数量、月額は 単価×数量×月数。';

alter table public.inventory_quote_items drop constraint if exists inventory_quote_items_kind_chk;
alter table public.inventory_quote_items add constraint inventory_quote_items_kind_chk
  check (kind in ('sale','rental','setup','kitting','install','network','service_monthly','training','other'));
alter table public.inventory_quote_items drop constraint if exists inventory_quote_items_billing_chk;
alter table public.inventory_quote_items add constraint inventory_quote_items_billing_chk
  check (billing in ('one_time','monthly'));
alter table public.inventory_quote_items drop constraint if exists inventory_quote_items_qty_chk;
alter table public.inventory_quote_items add constraint inventory_quote_items_qty_chk
  check (qty > 0 and qty <= 100000 and unit_price >= 0 and unit_price <= 1000000000
         and (months is null or (months >= 0 and months <= 120)));

create index if not exists inventory_quote_items_quote_idx on public.inventory_quote_items (quote_id, sort_no, id);

drop trigger if exists inventory_quote_items_touch on public.inventory_quote_items;
create trigger inventory_quote_items_touch before update on public.inventory_quote_items
  for each row execute function public.inv_touch();

-- ------------------------------------------------------------
-- 46-3) 合計
--
--     お客様には「初期費用」と「月額費用」を分けて見せる。
--     総額だけ出すと、月額の契約が総額に埋もれてしまうため。
-- ------------------------------------------------------------
drop view if exists public.inv_quote_totals;
create view public.inv_quote_totals as
select
  q.id as quote_id,
  q.deal_id,
  coalesce(sum(i.amount) filter (where i.billing = 'one_time'), 0)::bigint          as initial_total,
  coalesce(sum(i.qty * i.unit_price) filter (where i.billing = 'monthly'), 0)::bigint as monthly_total,
  max(i.months) filter (where i.billing = 'monthly')                                 as months,
  coalesce(sum(i.amount) filter (where i.billing = 'monthly'), 0)::bigint           as monthly_period_total,
  coalesce(sum(i.amount), 0)::bigint                                                 as subtotal,
  round(coalesce(sum(i.amount) filter (where i.taxable), 0) * q.tax_rate / 100)::bigint as tax,
  (coalesce(sum(i.amount), 0)
   + round(coalesce(sum(i.amount) filter (where i.taxable), 0) * q.tax_rate / 100))::bigint as total,
  count(i.id)::integer as line_count
from public.inventory_quotes q
left join public.inventory_quote_items i on i.quote_id = q.id
group by q.id, q.deal_id, q.tax_rate;

comment on view public.inv_quote_totals is
  '見積の合計。initial_total（初期費用・税抜）と monthly_total（月額・税抜）を分けて持ち、
   monthly_period_total は月額×期間。subtotal＝小計、tax＝消費税、total＝税込総額。';


-- ------------------------------------------------------------
-- 46-4) 社内の操作
-- ------------------------------------------------------------

/* 見積を作る。p_from があれば、その版の明細を写して新しい版にする（複製） */
create or replace function public.inv_quote_create(
  p_deal_id bigint,
  p_title   text default null,
  p_from    bigint default null
) returns public.inventory_quotes
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  q     public.inventory_quotes;
  v_rev integer;
  src   public.inventory_quotes;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if not exists (select 1 from public.inventory_deals where id = p_deal_id) then
    raise exception '案件が見つかりません（%）', p_deal_id;
  end if;

  select coalesce(max(rev), 0) + 1 into v_rev from public.inventory_quotes where deal_id = p_deal_id;

  insert into public.inventory_quotes (deal_id, rev, status, title, tax_rate, actor)
  values (p_deal_id, v_rev, '作成中',
          nullif(btrim(coalesce(p_title, '')), ''),
          10, public.inv_actor())
  returning * into q;

  if p_from is not null then
    select * into src from public.inventory_quotes where id = p_from and deal_id = p_deal_id;
    if not found then
      raise exception '複製元の見積が見つかりません（%）', p_from;
    end if;
    update public.inventory_quotes
       set title = coalesce(q.title, src.title), tax_rate = src.tax_rate,
           note = src.note, internal_note = src.internal_note
     where id = q.id
    returning * into q;
    insert into public.inventory_quote_items
      (quote_id, sort_no, kind, product_code, name, spec, qty, unit_price, months, billing, taxable, note)
    select q.id, sort_no, kind, product_code, name, spec, qty, unit_price, months, billing, taxable, note
      from public.inventory_quote_items where quote_id = src.id;
  end if;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'quote', q.id::text,
          public.inv_quote_no(q.deal_id, q.rev), '見積作成',
          case when p_from is null then null else '複製元 ' || p_from::text end, '作成中');
  return q;
end $$;

comment on function public.inv_quote_create is
  '案件に見積を1つ作る。版は自動で増える。p_from を渡すと、その版の明細を写して新しい版にする
   （提示済みの見積は直せないので、直したいときはこれで新しい版を作る）。';

/* 見積のヘッダを直す。提示済み以降は直せない */
create or replace function public.inv_quote_set(
  p_id          bigint,
  p_title       text    default null,
  p_valid       date    default null,
  p_tax         numeric default null,
  p_note        text    default null,
  p_internal    text    default null,
  p_clear_valid boolean default false
) returns public.inventory_quotes
language plpgsql security definer set search_path = public, pg_catalog as $$
declare q public.inventory_quotes;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into q from public.inventory_quotes where id = p_id for update;
  if not found then raise exception '見積が見つかりません（%）', p_id; end if;
  if q.status <> '作成中' then
    raise exception 'この見積は「%」なので直せません。複製して新しい版を作ってください', q.status;
  end if;
  update public.inventory_quotes
     set title = case when p_title is null then title else nullif(btrim(p_title), '') end,
         valid_until = case when coalesce(p_clear_valid, false) then null
                            else coalesce(p_valid, valid_until) end,
         tax_rate = coalesce(p_tax, q.tax_rate),
         note = case when p_note is null then note else nullif(btrim(p_note), '') end,
         internal_note = case when p_internal is null then internal_note
                              else nullif(btrim(p_internal), '') end,
         actor = public.inv_actor()
   where id = p_id
  returning * into q;
  return q;
end $$;

comment on function public.inv_quote_set is
  '見積の件名・期限・税率・但し書きを直す。渡さなかった項目はいまの値を残し、
   空文字を渡した項目だけ消す。有効期限を消すときは p_clear_valid を true にする。';

/* 明細の追加・書き換え。p_item_id が null なら追加 */
create or replace function public.inv_quote_item_save(
  p_quote_id  bigint,
  p_item_id   bigint default null,
  p_kind      text default 'other',
  p_name      text default null,
  p_spec      text default null,
  p_qty       integer default 1,
  p_unit      integer default 0,
  p_months    integer default null,
  p_billing   text default null,
  p_taxable   boolean default true,
  p_code      text default null,
  p_note      text default null,
  p_sort      integer default null
) returns public.inventory_quote_items
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  q   public.inventory_quotes;
  r   public.inventory_quote_items;
  v_billing text;
  v_sort integer;
  v_code text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into q from public.inventory_quotes where id = p_quote_id for update;
  if not found then raise exception '見積が見つかりません（%）', p_quote_id; end if;
  if q.status <> '作成中' then
    raise exception 'この見積は「%」なので直せません。複製して新しい版を作ってください', q.status;
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception '品名を入れてください';
  end if;

  -- 課金のしかたは種類から決める（レンタルと月額サービスだけ月額）
  v_billing := coalesce(nullif(btrim(coalesce(p_billing, '')), ''),
                        case when p_kind in ('rental', 'service_monthly') then 'monthly' else 'one_time' end);
  -- 知らない商品コードは付けない（見積そのものは作れるようにする）
  v_code := nullif(btrim(coalesce(p_code, '')), '');
  if v_code is not null and not exists (select 1 from public.inventory_products where code = v_code) then
    v_code := null;
  end if;

  if p_item_id is null then
    select coalesce(max(sort_no), 0) + 10 into v_sort from public.inventory_quote_items where quote_id = p_quote_id;
    insert into public.inventory_quote_items
      (quote_id, sort_no, kind, product_code, name, spec, qty, unit_price, months, billing, taxable, note)
    values (p_quote_id, coalesce(p_sort, v_sort), p_kind, v_code, btrim(p_name),
            nullif(btrim(coalesce(p_spec, '')), ''), greatest(coalesce(p_qty, 1), 1),
            greatest(coalesce(p_unit, 0), 0), p_months, v_billing, coalesce(p_taxable, true),
            nullif(btrim(coalesce(p_note, '')), ''))
    returning * into r;
  else
    update public.inventory_quote_items
       set kind = p_kind, product_code = v_code, name = btrim(p_name),
           spec = nullif(btrim(coalesce(p_spec, '')), ''),
           qty = greatest(coalesce(p_qty, 1), 1), unit_price = greatest(coalesce(p_unit, 0), 0),
           months = p_months, billing = v_billing, taxable = coalesce(p_taxable, true),
           note = nullif(btrim(coalesce(p_note, '')), ''),
           sort_no = coalesce(p_sort, sort_no)
     where id = p_item_id and quote_id = p_quote_id
    returning * into r;
    if not found then raise exception '明細が見つかりません（%）', p_item_id; end if;
  end if;
  return r;
end $$;

comment on function public.inv_quote_item_save is
  '見積明細の追加・書き換え。作成中のときだけ。レンタルと月額サービスは自動で月額扱いにする。';

create or replace function public.inv_quote_item_delete(p_quote_id bigint, p_item_id bigint)
returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare q public.inventory_quotes; n integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into q from public.inventory_quotes where id = p_quote_id for update;
  if not found then raise exception '見積が見つかりません（%）', p_quote_id; end if;
  if q.status <> '作成中' then
    raise exception 'この見積は「%」なので直せません', q.status;
  end if;
  delete from public.inventory_quote_items where id = p_item_id and quote_id = p_quote_id;
  get diagnostics n = row_count;
  return n;
end $$;

comment on function public.inv_quote_item_delete is '見積明細を消す。作成中のときだけ。';

/* お客様に提示する。
   ・tokenを発行して顧客ページを開けるようにする
   ・前に提示した版は、その場で失効させる（古いURLから承認されないように）
   ・案件の状態を「見積」へ進める */
create or replace function public.inv_quote_present(
  p_id    bigint,
  p_days  integer default 14
) returns public.inventory_quotes
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  q       public.inventory_quotes;
  v_token text;
  v_days  integer := greatest(coalesce(p_days, 14), 1);
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into q from public.inventory_quotes where id = p_id for update;
  if not found then raise exception '見積が見つかりません（%）', p_id; end if;
  if q.status <> '作成中' then
    raise exception 'この見積はすでに「%」です。直すときは複製して新しい版を作ってください', q.status;
  end if;
  if not exists (select 1 from public.inventory_quote_items where quote_id = p_id) then
    raise exception '明細が1行もありません。金額を入れてから提示してください';
  end if;

  -- 推測できない鍵。32文字以上になるよう、UUIDを2つつなげて記号を落とす
  v_token := replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  -- 先に、同じ案件で前に提示した版を失効させる
  update public.inventory_quotes
     set status = '失効', actor = public.inv_actor()
   where deal_id = q.deal_id and id <> q.id and status in ('提示済み', '相談中');

  update public.inventory_quotes
     set status = '提示済み',
         token = v_token,
         valid_until = coalesce(q.valid_until, (current_date + v_days)),
         token_expires_at = ((coalesce(q.valid_until, (current_date + v_days)) + 30)::timestamptz + interval '1 day' - interval '1 second'),
         presented_at = now(),
         actor = public.inv_actor()
   where id = p_id
  returning * into q;

  -- 案件は「見積」へ
  update public.inventory_deals
     set status = '見積', actor = public.inv_actor()
   where id = q.deal_id and status in ('希望受付', '在庫・調達確認');

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'quote', q.id::text, public.inv_quote_no(q.deal_id, q.rev),
          '見積提示', '作成中', '提示済み（有効期限 ' || q.valid_until::text || '）');
  return q;
end $$;

comment on function public.inv_quote_present is
  'お客様に見積を提示する。顧客ページの鍵（token）を作り、同じ案件で前に提示した版は失効させる。
   有効期限は既定14日、顧客ページはその30日後まで開ける（期限を過ぎたら承認ボタンは出さない）。';

create or replace function public.inv_quote_cancel(p_id bigint, p_reason text default null)
returns public.inventory_quotes
language plpgsql security definer set search_path = public, pg_catalog as $$
declare q public.inventory_quotes;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_quotes
     set status = '取消', actor = public.inv_actor(),
         internal_note = coalesce(internal_note || E'\n', '') || coalesce('取消：' || nullif(btrim(coalesce(p_reason,'')), ''), '取消')
   where id = p_id
  returning * into q;
  if not found then raise exception '見積が見つかりません（%）', p_id; end if;
  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'quote', q.id::text, public.inv_quote_no(q.deal_id, q.rev), '見積取消', null, '取消');
  return q;
end $$;

comment on function public.inv_quote_cancel is '見積を取り消す。顧客ページは開けなくなる。';

-- ------------------------------------------------------------
-- 46-5) 顧客ページ（匿名で呼べるのはこの2つだけ）
-- ------------------------------------------------------------

/* 顧客ページが読む見積。
   社内メモ・原価・在庫数・管理番号・シリアルは返さない。
   期限切れ・失効・取消でも「なぜ見られないか」を伝えるために、最低限は返す。 */
create or replace function public.inv_quote_public(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  q     public.inventory_quotes;
  d     public.inventory_deals;
  t     public.inv_quote_totals;
  v_new public.inventory_quotes;
  v_items jsonb;
begin
  if p_token is null or length(btrim(p_token)) < 20 then
    return jsonb_build_object('found', false);
  end if;
  select * into q from public.inventory_quotes where token = btrim(p_token);
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if q.token_expires_at is not null and now() > q.token_expires_at then
    return jsonb_build_object('found', true, 'viewable', false, 'reason', 'token_expired');
  end if;

  select * into d from public.inventory_deals where id = q.deal_id;
  select * into t from public.inv_quote_totals where quote_id = q.id;

  -- もっと新しい提示済みの版があるかどうか（古いURLを開いた人に知らせる）
  select * into v_new from public.inventory_quotes
   where deal_id = q.deal_id and rev > q.rev and status in ('提示済み', '相談中', '承認')
   order by rev desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', i.kind, 'name', i.name, 'spec', i.spec,
           'qty', i.qty, 'unit_price', i.unit_price, 'months', i.months,
           'billing', i.billing, 'taxable', i.taxable, 'amount', i.amount, 'note', i.note
         ) order by i.sort_no, i.id), '[]'::jsonb)
    into v_items
    from public.inventory_quote_items i where i.quote_id = q.id;

  return jsonb_build_object(
    'found', true,
    'viewable', true,
    'quote_no', public.inv_quote_no(q.deal_id, q.rev),
    'rev', q.rev,
    'status', q.status,
    'title', q.title,
    'company', d.company,
    'customer_name', d.customer_name,
    'valid_until', q.valid_until,
    'expired', (q.valid_until is not null and current_date > q.valid_until),
    'decidable', (q.status = '提示済み'
                  and (q.valid_until is null or current_date <= q.valid_until)),
    'newer_exists', (v_new.id is not null),
    'tax_rate', q.tax_rate,
    'note', q.note,
    'items', v_items,
    'totals', jsonb_build_object(
      'initial_total', coalesce(t.initial_total, 0),
      'monthly_total', coalesce(t.monthly_total, 0),
      'months', t.months,
      'monthly_period_total', coalesce(t.monthly_period_total, 0),
      'subtotal', coalesce(t.subtotal, 0),
      'tax', coalesce(t.tax, 0),
      'total', coalesce(t.total, 0)),
    'decided_at', q.decided_at,
    'presented_at', q.presented_at
  );
end $$;

comment on function public.inv_quote_public is
  '顧客ページ（/q/:token）が読む見積。社内メモ・原価・在庫数・管理番号は返さない。
   期限切れ・失効・取消のときは decidable=false で返し、ボタンを出さないようにする。';

/* お客様の［この内容で進める］［内容について相談する］。
   進める＝契約ではなく意思表示。**ここでは在庫を一切動かさない。**
   inv_sale_reserve も inv_rental_allocate も呼ばない（手配は契約と支払いが決まってから）。 */
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
-- 46-6) 権限
--
--     見積にはお客様の連絡先と金額が入るので、anon には表を読ませない。
--     匿名から呼べるのは inv_quote_public と inv_quote_decide だけ。
-- ------------------------------------------------------------
alter table public.inventory_quotes enable row level security;
alter table public.inventory_quote_items enable row level security;

drop policy if exists "inventory_quotes read" on public.inventory_quotes;
create policy "inventory_quotes read" on public.inventory_quotes
  for select to authenticated using (true);
drop policy if exists "inventory_quote_items read" on public.inventory_quote_items;
create policy "inventory_quote_items read" on public.inventory_quote_items
  for select to authenticated using (true);

revoke insert, update, delete on public.inventory_quotes from authenticated;
revoke insert, update, delete on public.inventory_quote_items from authenticated;
grant select on public.inventory_quotes to authenticated;
grant select on public.inventory_quote_items to authenticated;
grant select on public.inv_quote_totals to authenticated;

revoke all on function public.inv_quote_create(bigint,text,bigint) from public;
revoke all on function public.inv_quote_set(bigint,text,date,numeric,text,text,boolean) from public;
revoke all on function public.inv_quote_item_save(bigint,bigint,text,text,text,integer,integer,integer,text,boolean,text,text,integer) from public;
revoke all on function public.inv_quote_item_delete(bigint,bigint) from public;
revoke all on function public.inv_quote_present(bigint,integer) from public;
revoke all on function public.inv_quote_cancel(bigint,text) from public;
grant execute on function public.inv_quote_create(bigint,text,bigint) to authenticated;
grant execute on function public.inv_quote_set(bigint,text,date,numeric,text,text,boolean) to authenticated;
grant execute on function public.inv_quote_item_save(bigint,bigint,text,text,text,integer,integer,integer,text,boolean,text,text,integer) to authenticated;
grant execute on function public.inv_quote_item_delete(bigint,bigint) to authenticated;
grant execute on function public.inv_quote_present(bigint,integer) to authenticated;
grant execute on function public.inv_quote_cancel(bigint,text) to authenticated;

-- ------------------------------------------------------------
-- 47) 顧客見積APIは、サーバー経由だけにする
--
--     お客様のブラウザ → Vercel /api/* →（サーバー鍵）→ Supabase
--     見積の関数は service_role からしか呼べない。公開鍵はサイトのJSに
--     載っているので、anon に残すと /api を通さずに直接たたけてしまい、
--     Slack通知や今後の共通処理を迂回できるため。
-- ------------------------------------------------------------
create table if not exists public.inventory_public_access (
  client_key text        not null,
  window_at  timestamptz not null,
  tries      integer     not null default 0,
  misses     integer     not null default 0,
  -- 入口の種類（quote-view / quote-decide / form）。48で後から足した列
  kind       text        not null default 'quote-view',
  primary key (client_key, window_at)
);

comment on table public.inventory_public_access is
  '公開の入口（顧客見積ページ・診断フォーム・相談フォーム）へのアクセス回数を分単位で数える。
   総当たりと連打を止めるためだけに使う。client_key は「入口の種類:IPのsha256」で、
   IPそのものは保存しない。保持期間は既定30日（inv_public_access_cleanup で消える）。';

create index if not exists inventory_public_access_window_idx
  on public.inventory_public_access (window_at);

alter table public.inventory_public_access enable row level security;
revoke all on public.inventory_public_access from anon, authenticated;

create or replace function public.inv_public_access_cleanup(
  p_days integer default 30
) returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_days integer := greatest(coalesce(p_days, 30), 1);
  v_n    integer;
begin
  delete from public.inventory_public_access
   where window_at < now() - (v_days || ' days')::interval;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

comment on function public.inv_public_access_cleanup is
  'アクセス記録の掃除。既定30日より前を消して、消した件数を返す。
   inv_public_access_check が毎回呼ぶので、ふだんは手で実行しなくてよい。';

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

--     PostgreSQL は関数を作ると PUBLIC に実行権限が付くので、
--     anon から revoke するだけでは足りない。PUBLIC ごと落としてから配り直す。
revoke all on function public.inv_quote_public(text)                     from public, anon, authenticated;
revoke all on function public.inv_quote_decide(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.inv_quote_no(bigint,integer)               from public, anon;
revoke all on function public.inv_public_access_check(text,text,boolean) from public, anon, authenticated;
revoke all on function public.inv_public_access_cleanup(integer)         from public, anon, authenticated;

--     顧客見積の関数を呼べるのはサーバー（service_role）だけにする。
grant execute on function public.inv_quote_public(text)                     to service_role;
grant execute on function public.inv_quote_decide(text,text,text,text,text) to service_role;
grant execute on function public.inv_public_access_check(text,text,boolean) to service_role;
grant execute on function public.inv_public_access_cleanup(integer)         to service_role;
--     見積番号を作るだけの関数は、社内画面から使うこともあるので authenticated に残す
--     （中身は 'Q-00012-2' のような文字列を組み立てるだけで、データは読まない）。
grant execute on function public.inv_quote_no(bigint,integer)               to authenticated, service_role;



-- ------------------------------------------------------------
-- 49-1) 契約番号
-- ------------------------------------------------------------
create or replace function public.inv_contract_no(p_deal bigint, p_seq integer)
returns text language sql immutable as $$
  select 'C-' || lpad(p_deal::text, 5, '0') || '-' || p_seq::text
$$;

comment on function public.inv_contract_no is '契約番号を組み立てる。C-案件ID-枝番（例 C-00012-1）。';

-- ------------------------------------------------------------
-- 49-2) 契約ヘッダ
--
--     承認済み見積の中身を、ここへ写して固定します（スナップショット）。
--     見積があとから取り消されても、契約の中身は変わりません。
-- ------------------------------------------------------------
create table if not exists public.inventory_contracts (
  id          bigint generated by default as identity primary key,
  deal_id     bigint not null references public.inventory_deals(id) on delete cascade,
  quote_id    bigint references public.inventory_quotes(id) on delete set null,
  seq         integer not null default 1,

  -- 契約そのものの状態。支払い・手配とは別に動く
  status      text not null default '作成中',

  -- 契約時点のお客様（見積・案件から写す）
  company        text,
  customer_name  text,
  email          text,
  phone          text,

  -- 請求先。契約先と違うことがある（自治体・学校法人・親会社一括請求・経理部指定）
  billing_company     text,
  billing_department  text,
  billing_person      text,
  billing_postal_code text,
  billing_address     text,
  billing_email       text,
  billing_note        text,

  title         text,
  contract_date date,
  start_date    date,
  end_date      date,

  -- 支払い方（条件）。「決まったかどうか」は terms_confirmed_at で見る
  payment_method text,                       -- カード / 請求書払い / 銀行振込
  payment_timing text,                       -- 前払い / 後払い
  payment_terms  text,                       -- 月末締め翌月末払い など
  billing_day    integer,                    -- 月額の請求日（1〜31）。Phase 3-b の月次請求で使う
  terms_confirmed_at timestamptz,
  terms_confirmed_by text,

  -- 後払いで「入金前に手配してよい」と決める社内承認。管理者だけができる
  credit_approved_at timestamptz,
  credit_approved_by text,
  credit_note        text,

  -- お金の状態（入金）。契約の状態とは混ぜない
  payment_status     text not null default '未請求',
  -- モノの状態（手配）。明細の集約。契約・支払いとは混ぜない
  fulfillment_status text not null default '未手配',

  -- 見積から写した金額。確定したらもう動かさない
  tax_rate             numeric(5,2) not null default 10,
  initial_total        integer not null default 0,
  monthly_total        integer not null default 0,
  months               integer,
  monthly_period_total integer not null default 0,
  subtotal             integer not null default 0,
  tax                  integer not null default 0,
  total                integer not null default 0,

  -- Stripeは決済手段。契約の主データではないので、参照だけ持つ
  stripe_customer_id     text,
  stripe_subscription_id text,

  note          text,          -- お客様向けの但し書き
  internal_note text,          -- 社内メモ（顧客には出さない）

  confirmed_at timestamptz,
  confirmed_by text,
  actor        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- ここから下は Phase 3-d（顧客ページ /c/:token）で足した列
  public_token            text,    -- 顧客ページの鍵。契約ごとに1つだけ有効
  public_token_issued_at  timestamptz,
  public_token_expires_at timestamptz,
  public_token_revoked_at timestamptz,
  customer_confirmed_at   timestamptz,   -- お客様が「この内容で進めたい」と送ってきた記録
  customer_confirmed_by   text,
  customer_message        text,
  requested_payment_method text,          -- お客様が選んだ支払方法（希望）。確定値とは別
  allowed_payment_methods text[] not null default '{}'::text[],  -- 顧客ページに出してよいもの
  shipping_company     text,              -- お届け先（発送のPhaseで使う）
  shipping_department  text,
  shipping_person      text,
  shipping_postal_code text,
  shipping_address     text,
  shipping_phone       text,
  shipping_note        text,
  desired_delivery_date date,             -- お届け希望日。これだけでは納期確定ではない

  unique (deal_id, seq),
  constraint inventory_contracts_status_chk check
    (status in ('作成中', '確定', '履行中', '完了', '取消')),
  constraint inventory_contracts_pay_chk check
    (payment_status in ('未請求', '発行済み', '一部入金', '入金済み', '期限超過', '決済失敗', '取消')),
  constraint inventory_contracts_ful_chk check
    (fulfillment_status in ('未手配', '手配可', '手配中', '準備完了', '発送済み',
                            '貸出中', '完了', '返却待ち', '返却済み')),
  constraint inventory_contracts_method_chk check
    (payment_method is null or payment_method in ('カード', '請求書払い', '銀行振込')),
  constraint inventory_contracts_timing_chk check
    (payment_timing is null or payment_timing in ('前払い', '後払い')),
  constraint inventory_contracts_billing_day_chk check
    (billing_day is null or (billing_day between 1 and 31)),
  constraint inventory_contracts_req_method_chk check
    (requested_payment_method is null
     or requested_payment_method in ('カード', '請求書払い', '銀行振込')),
  constraint inventory_contracts_allowed_chk check
    (allowed_payment_methods <@ array['カード', '請求書払い', '銀行振込']::text[])
);

comment on table public.inventory_contracts is
  '契約。承認済み見積の中身を写して固定する。
   契約の状態(status)・入金(payment_status)・手配(fulfillment_status)は別々の列で持つ。
   支払条件が決まったかは terms_confirmed_at、後払いの社内承認は credit_approved_at で見る。';

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

create index if not exists inventory_contracts_deal_idx   on public.inventory_contracts (deal_id);
create index if not exists inventory_contracts_status_idx on public.inventory_contracts (status);

-- ------------------------------------------------------------
-- 49-3) 契約明細
--
--     見積明細をそのまま写します。
--     手配の状態は明細ごとに持ちます。1つの契約の中で
--       PCレンタルは割当済み／モニター販売は一部調達待ち／キッティングは作業待ち
--     が同時に起きるので、ヘッダだけでは表せません。
-- ------------------------------------------------------------
create table if not exists public.inventory_contract_items (
  id           bigint generated by default as identity primary key,
  contract_id  bigint not null references public.inventory_contracts(id) on delete cascade,
  quote_item_id bigint,                     -- どの見積明細から写したか（参照だけ）
  sort_no      integer not null default 0,
  kind         text not null default 'other',
  product_code text references public.inventory_products(code) on delete set null,
  name         text not null,
  spec         text,
  qty          integer not null default 1,
  unit_price   integer not null default 0,
  months       integer,
  billing      text not null default 'one_time',
  taxable      boolean not null default true,
  note         text,
  amount       integer generated always as
    (qty * unit_price * (case when billing = 'monthly' then greatest(coalesce(months, 1), 1) else 1 end)) stored,

  -- 手配（Phase 3-c）
  fulfillment_status text not null default '未手配',
  allocated_qty integer not null default 0,   -- 自社在庫で押さえた数
  procure_qty   integer not null default 0,   -- 外部調達が要る数（仮の個体は作らない）

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- この明細のレンタル申込。再手配のときは新しく作らずこれを使い回す
  rental_request_id bigint references public.inventory_rental_requests(id) on delete set null,

  constraint inventory_contract_items_kind_chk check
    (kind in ('sale', 'rental', 'setup', 'kitting', 'install', 'network',
              'service_monthly', 'training', 'other')),
  constraint inventory_contract_items_billing_chk check (billing in ('one_time', 'monthly')),
  constraint inventory_contract_items_ful_chk check
    (fulfillment_status in ('手配不要', '未手配', '手配中', '確保済み', '調達待ち',
                            '発送済み', '貸出中', '返却済み', '完了'))
);

comment on table public.inventory_contract_items is
  '契約明細。契約した時点の品名・スペック・単価・数量・期間を固定する。
   手配の状態は明細ごとに持つ（ヘッダの fulfillment_status はこれの集約）。
   allocated_qty は自社在庫で押さえた数、procure_qty は外部調達が要る数。';

create index if not exists inventory_contract_items_contract_idx
  on public.inventory_contract_items (contract_id, sort_no, id);

-- ------------------------------------------------------------
-- 49-4) 合計を計算しなおす（作成中のあいだだけ）
--
--     確定したら、もう触りません。
-- ------------------------------------------------------------
create or replace function public.inv_contract_recalc(p_id bigint)
returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c public.inventory_contracts;
  v_initial integer; v_monthly integer; v_months integer;
  v_period integer; v_taxable integer; v_subtotal integer;
begin
  select * into c from public.inventory_contracts where id = p_id;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;

  select
    coalesce(sum(case when billing = 'one_time' then amount else 0 end), 0),
    coalesce(sum(case when billing = 'monthly' then qty * unit_price else 0 end), 0),
    max(case when billing = 'monthly' then greatest(coalesce(months, 1), 1) else null end),
    coalesce(sum(case when billing = 'monthly' then amount else 0 end), 0),
    coalesce(sum(case when taxable then amount else 0 end), 0)
    into v_initial, v_monthly, v_months, v_period, v_taxable
    from public.inventory_contract_items where contract_id = p_id;

  v_subtotal := v_initial + v_period;

  update public.inventory_contracts
     set initial_total        = v_initial,
         monthly_total        = v_monthly,
         months               = v_months,
         monthly_period_total = v_period,
         subtotal             = v_subtotal,
         tax                  = round(v_taxable * c.tax_rate / 100)::integer,
         total                = v_subtotal + round(v_taxable * c.tax_rate / 100)::integer,
         updated_at           = now()
   where id = p_id
  returning * into c;
  return c;
end $$;

comment on function public.inv_contract_recalc is
  '契約の合計を明細から計算しなおす。初期費用と月額は分けたまま持つ。確定後は呼ばない。';

-- ------------------------------------------------------------
-- 49-5) 承認済みの見積から契約を作る
--
--     見積の中身を全部写します（スナップショット）。
--     あとで見積が取り消されても、契約はそのままです。
-- ------------------------------------------------------------
create or replace function public.inv_contract_create(p_quote_id bigint)
returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  q   public.inventory_quotes;
  d   public.inventory_deals;
  c   public.inventory_contracts;
  v_seq integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into q from public.inventory_quotes where id = p_quote_id;
  if not found then raise exception '見積が見つかりません（%）', p_quote_id; end if;
  if q.status <> '承認' then
    raise exception 'お客様が承認した見積からだけ契約を作れます（この見積は「%」）', q.status;
  end if;
  if exists (select 1 from public.inventory_contracts
              where quote_id = p_quote_id and status <> '取消') then
    raise exception 'この見積からはすでに契約を作っています';
  end if;

  select * into d from public.inventory_deals where id = q.deal_id;
  select coalesce(max(seq), 0) + 1 into v_seq
    from public.inventory_contracts where deal_id = q.deal_id;

  insert into public.inventory_contracts (
    deal_id, quote_id, seq, status,
    company, customer_name, email, phone,
    title, contract_date, start_date, end_date, months,
    tax_rate, note, internal_note, actor)
  values (
    q.deal_id, q.id, v_seq, '作成中',
    d.company, d.customer_name, d.email, d.phone,
    coalesce(q.title, d.company || ' 様 ご契約'), current_date, d.start_date,
    case when d.start_date is not null and coalesce(d.months, 0) > 0
         then (d.start_date + (d.months || ' months')::interval)::date else null end,
    d.months, q.tax_rate, q.note, q.internal_note, public.inv_actor())
  returning * into c;

  -- 見積明細をそのまま写す
  insert into public.inventory_contract_items (
    contract_id, quote_item_id, sort_no, kind, product_code, name, spec,
    qty, unit_price, months, billing, taxable, note, fulfillment_status)
  select c.id, i.id, i.sort_no, i.kind, i.product_code, i.name, i.spec,
         i.qty, i.unit_price, i.months, i.billing, i.taxable, i.note,
         -- 在庫を伴わない行は、はじめから「手配不要」
         case when i.kind in ('sale', 'rental') then '未手配' else '手配不要' end
    from public.inventory_quote_items i
   where i.quote_id = q.id
   order by i.sort_no, i.id;

  c := public.inv_contract_recalc(c.id);

  update public.inventory_deals
     set status = '契約', actor = public.inv_actor()
   where id = q.deal_id and status in ('顧客承認', '契約準備');

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '契約作成',
          public.inv_quote_no(q.deal_id, q.rev), '作成中');
  return c;
end $$;

comment on function public.inv_contract_create is
  'お客様が承認した見積から契約を作る。見積の明細・金額・税率・宛先をその場で写して固定するので、
   あとで見積が取り消されても契約は変わらない。在庫はここでは一切動かさない。';

-- ------------------------------------------------------------
-- 49-6) 契約の中身を直す（作成中のあいだだけ）
-- ------------------------------------------------------------
create or replace function public.inv_contract_set(
  p_id        bigint,
  p_title     text default null,
  p_contract_date date default null,
  p_start     date default null,
  p_end       date default null,
  p_method    text default null,
  p_timing    text default null,
  p_terms     text default null,
  p_billing_day integer default null,
  p_note      text default null,
  p_internal  text default null
) returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;
  if c.status not in ('作成中', '確定') then
    raise exception 'この契約は「%」なので直せません', c.status;
  end if;
  if c.status = '確定' and (p_title is not null or p_contract_date is not null
                            or p_start is not null or p_end is not null) then
    raise exception '確定した契約の件名・日付は直せません。取り消してから作り直してください';
  end if;
  if c.terms_confirmed_at is not null
     and (nullif(btrim(coalesce(p_method, '')), '') is not null
          or nullif(btrim(coalesce(p_timing, '')), '') is not null
          or nullif(btrim(coalesce(p_terms, '')), '') is not null) then
    raise exception '支払条件はもう確定しています。変えるときは担当者にご確認ください';
  end if;

  update public.inventory_contracts
     set title         = case when p_title is null then title else nullif(btrim(p_title), '') end,
         contract_date = coalesce(p_contract_date, contract_date),
         start_date    = coalesce(p_start, start_date),
         end_date      = coalesce(p_end, end_date),
         payment_method = case when p_method is null then payment_method
                               else nullif(btrim(p_method), '') end,
         payment_timing = case when p_timing is null then payment_timing
                               else nullif(btrim(p_timing), '') end,
         payment_terms  = case when p_terms is null then payment_terms
                               else nullif(btrim(p_terms), '') end,
         billing_day    = coalesce(p_billing_day, billing_day),
         note           = case when p_note is null then note else nullif(btrim(p_note), '') end,
         internal_note  = case when p_internal is null then internal_note
                                else nullif(btrim(p_internal), '') end,
         actor          = public.inv_actor(),
         updated_at     = now()
   where id = p_id
  returning * into c;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '契約変更', null,
          coalesce(c.payment_method, '支払方法なし')
            || coalesce('／' || c.payment_timing, '') || coalesce('／' || c.payment_terms, ''));
  return c;
end $$;

comment on function public.inv_contract_set is
  '契約の件名・日付・支払条件を直す。渡さなかった項目はいまの値を残す（空文字を渡すと消す）。
   確定後は支払条件まわりだけ。支払条件を確定したあとは支払方法・前後払い・支払条件を変えられない。';

-- ------------------------------------------------------------
-- 49-7) 請求先を入れる
--
--     契約先と請求先が違うことがある（自治体・学校法人・親会社一括請求・経理部指定）。
--     請求書を出すときに困らないよう、部署・郵便番号・請求先メールまで持つ。
-- ------------------------------------------------------------
create or replace function public.inv_contract_billing_set(
  p_id         bigint,
  p_company    text default null,
  p_department text default null,
  p_person     text default null,
  p_postal     text default null,
  p_address    text default null,
  p_email      text default null,
  p_note       text default null
) returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;
  if c.status in ('完了', '取消') then
    raise exception 'この契約は「%」なので直せません', c.status;
  end if;

  update public.inventory_contracts
     set billing_company     = case when p_company is null then billing_company
                                    else nullif(btrim(p_company), '') end,
         billing_department  = case when p_department is null then billing_department
                                    else nullif(btrim(p_department), '') end,
         billing_person      = case when p_person is null then billing_person
                                    else nullif(btrim(p_person), '') end,
         billing_postal_code = case when p_postal is null then billing_postal_code
                                    else nullif(btrim(p_postal), '') end,
         billing_address     = case when p_address is null then billing_address
                                    else nullif(btrim(p_address), '') end,
         billing_email       = case when p_email is null then billing_email
                                    else nullif(btrim(p_email), '') end,
         billing_note        = case when p_note is null then billing_note
                                    else nullif(btrim(p_note), '') end,
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into c;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '請求先変更', null,
          coalesce(c.billing_company, '（契約先と同じ）'));
  return c;
end $$;

comment on function public.inv_contract_billing_set is
  '請求先を入れる。渡さなかった項目はいまの値を残す（空文字を渡すと消す）。
   請求先の会社名が空なら「契約先と同じ」という意味になる。';

-- ------------------------------------------------------------
-- 49-8) 明細を直す・消す（作成中のあいだだけ）
--
--     基本は見積の写しですが、契約直前の直しは実務で起きるので、
--     作成中のあいだだけ触れるようにしておく。確定したら固定。
-- ------------------------------------------------------------
create or replace function public.inv_contract_item_save(
  p_contract_id bigint,
  p_item_id     bigint default null,
  p_kind        text    default 'other',
  p_name        text    default null,
  p_spec        text    default null,
  p_qty         integer default 1,
  p_unit        integer default 0,
  p_months      integer default null,
  p_billing     text    default null,
  p_taxable     boolean default true,
  p_code        text    default null,
  p_note        text    default null,
  p_sort        integer default null
) returns public.inventory_contract_items
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c public.inventory_contracts;
  r public.inventory_contract_items;
  v_billing text;
  v_sort    integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_contract_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;
  if c.status <> '作成中' then
    raise exception 'この契約は「%」なので明細を直せません', c.status;
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception '品名を入れてください';
  end if;

  -- レンタルと月額サービスは月額、それ以外は一括
  v_billing := coalesce(nullif(btrim(coalesce(p_billing, '')), ''),
                        case when p_kind in ('rental', 'service_monthly') then 'monthly' else 'one_time' end);

  if p_item_id is null then
    select coalesce(p_sort, coalesce(max(sort_no), 0) + 10) into v_sort
      from public.inventory_contract_items where contract_id = p_contract_id;
    insert into public.inventory_contract_items
      (contract_id, sort_no, kind, product_code, name, spec, qty, unit_price,
       months, billing, taxable, note, fulfillment_status)
    values (p_contract_id, v_sort, p_kind, nullif(btrim(coalesce(p_code, '')), ''),
            btrim(p_name), nullif(btrim(coalesce(p_spec, '')), ''),
            greatest(coalesce(p_qty, 1), 1), greatest(coalesce(p_unit, 0), 0),
            case when v_billing = 'monthly' then greatest(coalesce(p_months, 1), 1) else p_months end,
            v_billing, coalesce(p_taxable, true), nullif(btrim(coalesce(p_note, '')), ''),
            case when p_kind in ('sale', 'rental') then '未手配' else '手配不要' end)
    returning * into r;
  else
    update public.inventory_contract_items
       set kind = p_kind,
           product_code = nullif(btrim(coalesce(p_code, '')), ''),
           name = btrim(p_name),
           spec = nullif(btrim(coalesce(p_spec, '')), ''),
           qty = greatest(coalesce(p_qty, 1), 1),
           unit_price = greatest(coalesce(p_unit, 0), 0),
           months = case when v_billing = 'monthly' then greatest(coalesce(p_months, 1), 1) else p_months end,
           billing = v_billing,
           taxable = coalesce(p_taxable, true),
           note = nullif(btrim(coalesce(p_note, '')), ''),
           sort_no = coalesce(p_sort, sort_no),
           fulfillment_status = case when p_kind in ('sale', 'rental') then '未手配' else '手配不要' end,
           updated_at = now()
     where id = p_item_id and contract_id = p_contract_id
    returning * into r;
    if not found then raise exception '明細が見つかりません（%）', p_item_id; end if;
  end if;

  perform public.inv_contract_recalc(p_contract_id);
  return r;
end $$;

comment on function public.inv_contract_item_save is
  '契約明細を足す・直す。作成中のあいだだけ。在庫を伴わない種類は「手配不要」にしておく。';

create or replace function public.inv_contract_item_delete(p_contract_id bigint, p_item_id bigint)
returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_contract_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;
  if c.status <> '作成中' then
    raise exception 'この契約は「%」なので明細を消せません', c.status;
  end if;
  delete from public.inventory_contract_items where id = p_item_id and contract_id = p_contract_id;
  perform public.inv_contract_recalc(p_contract_id);
  return true;
end $$;

comment on function public.inv_contract_item_delete is '契約明細を消す。作成中のあいだだけ。';

-- ------------------------------------------------------------
-- 49-9) 契約を確定する
--
--     ここから先、金額と明細は動かしません。
--     まだ支払条件は決まっていなくてよいし、在庫も押さえません。
-- ------------------------------------------------------------
create or replace function public.inv_contract_confirm(p_id bigint)
returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;
  if c.status <> '作成中' then
    raise exception 'この契約はすでに「%」です', c.status;
  end if;
  if not exists (select 1 from public.inventory_contract_items where contract_id = p_id) then
    raise exception '明細が1行もありません';
  end if;
  if c.contract_date is null then
    raise exception '契約日を入れてください';
  end if;

  update public.inventory_contracts
     set status = '確定', confirmed_at = now(), confirmed_by = public.inv_actor(),
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into c;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '契約確定', '作成中',
          '確定（金額 ' || to_char(c.total, 'FM9,999,999,999') || '円・在庫はまだ確保していません）');
  return c;
end $$;

comment on function public.inv_contract_confirm is
  '契約を確定する。ここから明細と金額は動かせない。
   支払条件はまだでよく、在庫も一切確保しない（手配は Phase 3-c の別操作）。';

-- ------------------------------------------------------------
-- 49-10) 支払条件を確定する
--
--     「契約が決まった」とは別のことなので、別の操作にしてあります。
-- ------------------------------------------------------------
create or replace function public.inv_contract_terms_confirm(p_id bigint)
returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;
  if c.status not in ('作成中', '確定') then
    raise exception 'この契約は「%」なので支払条件を確定できません', c.status;
  end if;
  if c.terms_confirmed_at is not null then
    raise exception '支払条件はもう確定しています';
  end if;
  if c.payment_method is null then raise exception '支払方法を選んでください'; end if;
  if c.payment_timing is null then raise exception '前払いか後払いかを選んでください'; end if;
  if nullif(btrim(coalesce(c.payment_terms, '')), '') is null then
    raise exception '支払条件を入れてください（例：月末締め翌月末払い）';
  end if;
  -- 月額があるなら、毎月の請求日が要る（Phase 3-b の月次請求のため）
  if c.monthly_total > 0 and c.billing_day is null then
    raise exception '月額があるので、毎月の請求日を入れてください（1〜31）';
  end if;

  update public.inventory_contracts
     set terms_confirmed_at = now(), terms_confirmed_by = public.inv_actor(),
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into c;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '支払条件確定', null,
          c.payment_method || '／' || c.payment_timing || '／' || c.payment_terms);

  update public.inventory_deals
     set status = '支払条件確定', actor = public.inv_actor()
   where id = c.deal_id and status = '契約';
  return c;
end $$;

comment on function public.inv_contract_terms_confirm is
  '支払条件を確定する。契約の確定とは別の操作。ここでも在庫は動かさない。';

-- ------------------------------------------------------------
-- 49-11) 後払いの社内承認（管理者だけ）
--
--     後払い（請求書払い・銀行振込の後払い）は、入金より先に手配します。
--     つまり「入金前にモノを出してよいか」の与信判断なので、
--     ふつうの編集メンバーではなく管理者だけができるようにします。
-- ------------------------------------------------------------
create or replace function public.inv_contract_credit_approve(
  p_id   bigint,
  p_note text default null
) returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts;
begin
  if not public.inv_is_admin() then
    raise exception '後払いの社内承認は管理者だけができます';
  end if;
  select * into c from public.inventory_contracts where id = p_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;
  if c.status <> '確定' then
    raise exception '契約を確定してから承認してください（いまは「%」）', c.status;
  end if;
  if c.terms_confirmed_at is null then
    raise exception '支払条件を確定してから承認してください';
  end if;
  if c.payment_timing <> '後払い' then
    raise exception '後払いの契約だけ承認が要ります（この契約は「%」）', c.payment_timing;
  end if;
  if c.credit_approved_at is not null then
    raise exception 'この契約はもう承認済みです（% ）', c.credit_approved_by;
  end if;

  update public.inventory_contracts
     set credit_approved_at = now(), credit_approved_by = public.inv_actor(),
         credit_note = nullif(btrim(coalesce(p_note, '')), ''),
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into c;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '後払い社内承認', null,
          '入金前の手配を承認（' || c.payment_terms || '）'
            || coalesce('／' || c.credit_note, ''));
  return c;
end $$;

comment on function public.inv_contract_credit_approve is
  '後払いの契約について「入金前に手配してよい」と社内で承認する。管理者だけ。
   請求書払い・銀行振込の後払いは、これが与信判断そのものになる。';

-- ------------------------------------------------------------
-- 49-12) 契約を取り消す
-- ------------------------------------------------------------
create or replace function public.inv_contract_cancel(p_id bigint, p_reason text default null)
returns public.inventory_contracts
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c public.inventory_contracts;
  v_rel jsonb;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_id; end if;
  if c.status = '取消' then raise exception 'この契約はすでに取消です'; end if;

  -- 発送してしまった個体があるときは、実物の確認が要るので自動では取り消さない
  if exists (select 1 from public.inventory_contract_fulfillments f
               join public.inventory_items i on i.id = f.item_id
              where f.contract_id = p_id and f.status = '確保済み'
                and i.status in ('貸出中', '売却済')) then
    raise exception 'すでに発送・売却した個体があります。返品・返却の手続きをしてから取り消してください';
  end if;

  -- この契約が押さえたものだけを在庫へ戻す
  v_rel := public.inv_contract_fulfill_release(p_id, p_reason);

  update public.inventory_contracts
     set status = '取消',
         internal_note = coalesce(internal_note || E'\n', '')
           || coalesce('取消：' || nullif(btrim(coalesce(p_reason, '')), ''), '取消'),
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into c;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text,
          public.inv_contract_no(c.deal_id, c.seq), '契約取消', null,
          coalesce(nullif(btrim(coalesce(p_reason, '')), ''), '取消')
            || '／在庫へ戻した数 ' || coalesce(v_rel->>'released', '0'));

  perform public.inv_contract_payment_recalc(p_id);
  return c;
end $$;

comment on function public.inv_contract_cancel is
  '契約を取り消す。この契約が押さえた個体だけを在庫へ戻す（他の案件の予約には触らない）。
   すでに発送・売却した個体があるときは、実物の確認が要るので取り消せない。';

-- ------------------------------------------------------------
-- 49-13) 手配してよいかを判断する（読むだけ。ここでは在庫を動かさない）
--
--     Phase 3-c の［手配に進む］が、この判断をそのまま使います。
--     いま作っておくのは、画面に「なぜまだ押せないか」を出すためです。
--
--       前払い（カード・銀行振込前払い）… 入金済みになってから
--       後払い（請求書払い・銀行振込後払い）… 入金前でも、社内承認があれば手配できる
-- ------------------------------------------------------------
create or replace function public.inv_contract_can_fulfill(p_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare c public.inventory_contracts;
begin
  select * into c from public.inventory_contracts where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', '契約が見つかりません');
  end if;
  if c.status = '取消' then
    return jsonb_build_object('ok', false, 'reason', 'この契約は取消です');
  end if;
  if c.status = '作成中' then
    return jsonb_build_object('ok', false, 'reason', '契約を確定してください');
  end if;
  if c.terms_confirmed_at is null then
    return jsonb_build_object('ok', false, 'reason', '支払条件を確定してください');
  end if;
  if c.payment_timing = '後払い' and c.credit_approved_at is null then
    return jsonb_build_object('ok', false,
      'reason', '後払いなので、管理者の社内承認が要ります（入金前に手配してよいかの判断です）');
  end if;
  if c.payment_timing = '前払い' and c.payment_status <> '入金済み' then
    return jsonb_build_object('ok', false,
      'reason', '前払いの契約です。入金が確認できてから手配してください（いまは「'
                || c.payment_status || '」）');
  end if;
  return jsonb_build_object('ok', true, 'reason',
    case when c.payment_timing = '後払い'
         then '後払い・社内承認済みなので、入金前でも手配できます'
         else '入金済みなので手配できます' end);
end $$;

comment on function public.inv_contract_can_fulfill is
  '手配してよいかを返す（読むだけ）。前払いは入金済みが条件、後払いは社内承認が条件。
   「入金されるまで手配できない」という作りにしないための入口。Phase 3-c がこれを使う。';

-- ------------------------------------------------------------
-- 49-15) 権限
--
--     契約にはお客様の連絡先・請求先・金額が入るので、anon には一切見せない。
--     表は読み取りだけにして、書き込みは関数（security definer）を通す。
--     後払いの社内承認だけは管理者に限る（関数の中で inv_is_admin を見ている）。
-- ------------------------------------------------------------
alter table public.inventory_contracts      enable row level security;
alter table public.inventory_contract_items enable row level security;

drop policy if exists "inventory_contracts read" on public.inventory_contracts;
create policy "inventory_contracts read" on public.inventory_contracts
  for select to authenticated using (true);
drop policy if exists "inventory_contract_items read" on public.inventory_contract_items;
create policy "inventory_contract_items read" on public.inventory_contract_items
  for select to authenticated using (true);

revoke all on public.inventory_contracts      from anon, authenticated;
revoke all on public.inventory_contract_items from anon, authenticated;
grant select on public.inventory_contracts      to authenticated;
grant select on public.inventory_contract_items to authenticated;

revoke all on function public.inv_contract_no(bigint,integer)        from public, anon;
revoke all on function public.inv_contract_recalc(bigint)            from public, anon, authenticated;
revoke all on function public.inv_contract_create(bigint)            from public, anon;
revoke all on function public.inv_contract_set(bigint,text,date,date,date,text,text,text,integer,text,text) from public, anon;
revoke all on function public.inv_contract_billing_set(bigint,text,text,text,text,text,text,text) from public, anon;
revoke all on function public.inv_contract_item_save(bigint,bigint,text,text,text,integer,integer,integer,text,boolean,text,text,integer) from public, anon;
revoke all on function public.inv_contract_item_delete(bigint,bigint) from public, anon;
revoke all on function public.inv_contract_confirm(bigint)           from public, anon;
revoke all on function public.inv_contract_terms_confirm(bigint)     from public, anon;
revoke all on function public.inv_contract_credit_approve(bigint,text) from public, anon;
revoke all on function public.inv_contract_cancel(bigint,text)       from public, anon;
revoke all on function public.inv_contract_can_fulfill(bigint)       from public, anon;

grant execute on function public.inv_contract_no(bigint,integer)        to authenticated, service_role;
grant execute on function public.inv_contract_create(bigint)            to authenticated;
grant execute on function public.inv_contract_set(bigint,text,date,date,date,text,text,text,integer,text,text) to authenticated;
grant execute on function public.inv_contract_billing_set(bigint,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.inv_contract_item_save(bigint,bigint,text,text,text,integer,integer,integer,text,boolean,text,text,integer) to authenticated;
grant execute on function public.inv_contract_item_delete(bigint,bigint) to authenticated;
grant execute on function public.inv_contract_confirm(bigint)           to authenticated;
grant execute on function public.inv_contract_terms_confirm(bigint)     to authenticated;
grant execute on function public.inv_contract_credit_approve(bigint,text) to authenticated;
grant execute on function public.inv_contract_cancel(bigint,text)       to authenticated;
grant execute on function public.inv_contract_can_fulfill(bigint)       to authenticated;


-- ------------------------------------------------------------
-- 50-1) 請求番号の採番
--
--     予定（下書き）の段階では番号を付けません。
--     担当者が［発行する］を押したときに、はじめて正式採番します。
-- ------------------------------------------------------------
create sequence if not exists public.inventory_invoice_no_seq;

create or replace function public.inv_invoice_no_next(p_on date default null)
returns text language sql volatile set search_path = public, pg_catalog as $$
  select 'INV-' || to_char(coalesce(p_on, current_date), 'YYYY') || '-'
         || lpad(nextval('public.inventory_invoice_no_seq')::text, 6, '0')
$$;

comment on function public.inv_invoice_no_next is
  '請求番号を採番する。INV-2026-000123。発行したときだけ呼ぶ（予定の段階では番号を付けない）。';

-- ------------------------------------------------------------
-- 50-2) 「その月の○日」を出す
--
--     請求日が31日でも、2月は28日（閏年は29日）、4月は30日になるようにする。
--     月末の日数はDBに計算させるので、閏年も自然に正しくなる。
-- ------------------------------------------------------------
create or replace function public.inv_month_day(p_month date, p_day integer)
returns date language sql immutable as $$
  select (date_trunc('month', p_month)
          + ((least(greatest(coalesce(p_day, 1), 1),
                    extract(day from (date_trunc('month', p_month)
                                      + interval '1 month' - interval '1 day'))::integer) - 1)
             || ' days')::interval)::date
$$;

comment on function public.inv_month_day is
  'その月の○日を返す。31日を指定しても、2月なら28日（閏年は29日）、4月なら30日になる。';

-- ------------------------------------------------------------
-- 50-3) 請求書
--
--     kind
--       initial … 初期費用。契約につき1本
--       monthly … 月額。1か月につき1本
--       manual  … 追加や個別のもの（手で作る）
-- ------------------------------------------------------------
create table if not exists public.inventory_contract_invoices (
  id          bigint generated by default as identity primary key,
  contract_id bigint not null references public.inventory_contracts(id) on delete cascade,
  contract_item_id bigint references public.inventory_contract_items(id) on delete set null,
  kind        text not null default 'manual',
  sequence_no integer not null default 0,

  period_start date,
  period_end   date,
  scheduled_issue_date date,
  issued_at    timestamptz,
  due_date     date,

  amount_excl integer not null default 0,
  tax         integer not null default 0,
  amount_incl integer not null default 0,

  status      text not null default '下書き',
  invoice_no  text unique,
  stripe_invoice_id text,

  note          text,     -- お客様に見せてよい但し書き
  internal_note text,     -- 社内メモ
  actor      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint inventory_contract_invoices_kind_chk check (kind in ('initial', 'monthly', 'manual')),
  constraint inventory_contract_invoices_status_chk check
    (status in ('下書き', '発行待ち', '発行済み', '一部入金', '入金済み', '期限超過', '取消')),
  -- 発行したものには必ず番号と日時が付いている
  constraint inventory_contract_invoices_issued_chk check
    (status in ('下書き', '発行待ち', '取消') or (invoice_no is not null and issued_at is not null))
);

comment on table public.inventory_contract_invoices is
  '請求書。契約から予定として自動生成し、担当者が確認して発行する。
   状態は 下書き → 発行待ち → 発行済み → 一部入金 → 入金済み。
   「発行済み」が入金待ちを含む（請求済みと入金待ちは分けない）。
   請求番号は発行したときだけ付ける。';

create index if not exists inventory_contract_invoices_contract_idx
  on public.inventory_contract_invoices (contract_id, sequence_no, id);
create index if not exists inventory_contract_invoices_due_idx
  on public.inventory_contract_invoices (due_date) where status in ('発行済み', '一部入金');

-- 同じ契約・同じ請求期間で二重に作らない（取り消したものは数えない）
create unique index if not exists inventory_contract_invoices_initial_uk
  on public.inventory_contract_invoices (contract_id)
  where kind = 'initial' and status <> '取消';
create unique index if not exists inventory_contract_invoices_monthly_uk
  on public.inventory_contract_invoices (contract_id, period_start)
  where kind = 'monthly' and status <> '取消';

-- ------------------------------------------------------------
-- 50-4) 請求の内訳（どの契約明細から来たか）
--
--     初期費用の1本に複数の明細がまとまることがあるので、
--     まとめても元の明細をたどれるようにする。
-- ------------------------------------------------------------
create table if not exists public.inventory_contract_invoice_lines (
  id          bigint generated by default as identity primary key,
  invoice_id  bigint not null references public.inventory_contract_invoices(id) on delete cascade,
  contract_item_id bigint references public.inventory_contract_items(id) on delete set null,
  name        text not null,
  spec        text,
  qty         integer not null default 1,
  unit_price  integer not null default 0,
  amount_excl integer not null default 0,
  taxable     boolean not null default true,
  sort_no     integer not null default 0
);

comment on table public.inventory_contract_invoice_lines is
  '請求書の内訳。まとめて1本の請求にしても、どの契約明細のぶんかを追えるようにする。';

create index if not exists inventory_contract_invoice_lines_invoice_idx
  on public.inventory_contract_invoice_lines (invoice_id, sort_no, id);

-- ------------------------------------------------------------
-- 50-5) 入金
--
--     1つの請求に何回でも入金を登録できる（一部入金のため）。
-- ------------------------------------------------------------
create table if not exists public.inventory_contract_payments (
  id         bigint generated by default as identity primary key,
  invoice_id bigint not null references public.inventory_contract_invoices(id) on delete cascade,
  paid_on    date not null default current_date,
  amount     integer not null,
  method     text,          -- 銀行振込 / 請求書払い / カード / 相殺 など
  reference  text,          -- 振込名義・参照番号
  note       text,
  actor      text,
  created_at timestamptz not null default now(),
  constraint inventory_contract_payments_amount_chk check (amount <> 0)
);

comment on table public.inventory_contract_payments is
  '入金。1つの請求に何回でも登録できる（一部入金・分割入金のため）。
   返金はマイナスで入れる。過入金になっても自動では消さず、管理画面で警告する。';

create index if not exists inventory_contract_payments_invoice_idx
  on public.inventory_contract_payments (invoice_id, paid_on, id);

-- ------------------------------------------------------------
-- 50-6) 画面が読む一覧（入金合計と過入金つき）
-- ------------------------------------------------------------
create or replace view public.inv_contract_invoice_list as
select i.*,
       coalesce(p.paid_total, 0) as paid_total,
       greatest(i.amount_incl - coalesce(p.paid_total, 0), 0) as remaining,
       greatest(coalesce(p.paid_total, 0) - i.amount_incl, 0) as over_paid,
       (i.status in ('発行済み', '一部入金', '期限超過')
        and i.due_date is not null and i.due_date < current_date) as is_overdue
  from public.inventory_contract_invoices i
  left join (select invoice_id, sum(amount) as paid_total
               from public.inventory_contract_payments group by invoice_id) p
    on p.invoice_id = i.id;

comment on view public.inv_contract_invoice_list is
  '請求の一覧。入金合計・残額・過入金・期限超過かどうかを足して返す。';

-- ------------------------------------------------------------
-- 50-7) 請求1本の状態を計算しなおす
--
--     入金合計 = 0            → 発行済み（期限を過ぎていれば 期限超過）
--     0 < 入金合計 < 請求額   → 一部入金（期限を過ぎていれば 期限超過）
--     入金合計 >= 請求額      → 入金済み
--
--     過入金でも自動で消しません。画面に「過入金あり」と出します。
-- ------------------------------------------------------------
create or replace function public.inv_invoice_recalc(p_id bigint)
returns public.inventory_contract_invoices
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v   public.inventory_contract_invoices;
  v_paid integer;
  v_new  text;
begin
  select * into v from public.inventory_contract_invoices where id = p_id for update;
  if not found then raise exception '請求が見つかりません（%）', p_id; end if;
  -- まだ発行していないもの・取り消したものは、入金で状態が動かない
  if v.status in ('下書き', '発行待ち', '取消') then return v; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.inventory_contract_payments where invoice_id = p_id;

  if v_paid >= v.amount_incl and v.amount_incl > 0 then
    v_new := '入金済み';
  elsif v_paid > 0 then
    v_new := case when v.due_date is not null and v.due_date < current_date
                  then '期限超過' else '一部入金' end;
  else
    v_new := case when v.due_date is not null and v.due_date < current_date
                  then '期限超過' else '発行済み' end;
  end if;

  if v_new <> v.status then
    update public.inventory_contract_invoices
       set status = v_new, updated_at = now() where id = p_id returning * into v;
  end if;
  return v;
end $$;

comment on function public.inv_invoice_recalc is
  '請求1本の状態を、入金合計と支払期限から計算しなおす。
   下書き・発行待ち・取消は動かさない。過入金でも自動で消さない。';

-- ------------------------------------------------------------
-- 50-8) 契約全体の入金状態を、請求書たちから組み立てる（集約）
--
--     取消の請求は数えない。請求が1本も無ければ「未請求」。
-- ------------------------------------------------------------
create or replace function public.inv_contract_payment_recalc(p_contract_id bigint)
returns text
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c        public.inventory_contracts;
  v_all    integer; v_issued integer; v_paid_full integer;
  v_over   integer; v_paid_any integer; v_status text;
begin
  select * into c from public.inventory_contracts where id = p_contract_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;

  select count(*) filter (where status <> '取消'),
         count(*) filter (where status in ('発行済み', '一部入金', '入金済み', '期限超過')),
         count(*) filter (where status = '入金済み'),
         count(*) filter (where status = '期限超過'),
         count(*) filter (where status in ('一部入金', '入金済み'))
    into v_all, v_issued, v_paid_full, v_over, v_paid_any
    from public.inventory_contract_invoices where contract_id = p_contract_id;

  if c.status = '取消' then
    v_status := '取消';
  elsif v_all = 0 or v_issued = 0 then
    v_status := '未請求';
  elsif v_paid_full = v_all then
    v_status := '入金済み';
  elsif v_over > 0 then
    v_status := '期限超過';
  elsif v_paid_any > 0 then
    v_status := '一部入金';
  else
    v_status := '発行済み';
  end if;

  if v_status <> c.payment_status then
    update public.inventory_contracts
       set payment_status = v_status, updated_at = now() where id = p_contract_id;
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'contract', c.id::text,
            public.inv_contract_no(c.deal_id, c.seq), '入金状態', c.payment_status, v_status);
  end if;
  return v_status;
end $$;

comment on function public.inv_contract_payment_recalc is
  '契約全体の入金状態を、その契約の請求書たちから組み立てる。
   すべて入金済み → 入金済み、1本でも期限超過 → 期限超過、一部でも入金あり → 一部入金、
   発行しただけ → 発行済み、まだ発行していない → 未請求。';

-- ------------------------------------------------------------
-- 50-9) 契約の入金状態の言葉を、請求書と揃える
--
--     「請求済み」「入金待ち」は意味が重なるのでやめる。
--     決済失敗は Phase 3-e（カード）で使うので残しておく。
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 50-10) まとめて計算しなおす（期限超過の反映もここで）
--
--     支払期限を過ぎたかどうかは日が変わると変わるので、
--     画面を開いたときと、請求まわりを触ったときに呼び直す。
--     p_contract_id を省くと全件（あとで日次バッチに載せてもよい）。
-- ------------------------------------------------------------
create or replace function public.inv_contract_invoices_refresh(p_contract_id bigint default null)
returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare r record; n integer := 0;
begin
  for r in select id from public.inventory_contract_invoices
            where (p_contract_id is null or contract_id = p_contract_id)
              and status in ('発行済み', '一部入金', '入金済み', '期限超過')
  loop
    perform public.inv_invoice_recalc(r.id);
    n := n + 1;
  end loop;
  for r in select distinct contract_id from public.inventory_contract_invoices
            where (p_contract_id is null or contract_id = p_contract_id)
  loop
    perform public.inv_contract_payment_recalc(r.contract_id);
  end loop;
  return n;
end $$;

comment on function public.inv_contract_invoices_refresh is
  '請求の状態（期限超過を含む）と契約の入金状態を計算しなおす。
   引数なしで全件。画面を開いたときに呼ぶほか、日次バッチに載せてもよい。';

-- ------------------------------------------------------------
-- 50-11) 請求の予定をまとめて作る
--
--     契約確定 ＋ 支払条件確定 のあとに呼ぶ。
--       初期費用 … 一括の明細をまとめて1本
--       月額     … 1か月につき1本（12か月なら12本）
--
--     作るのは「下書き」までです。自動では発行しません。
--       自動生成 → 下書き → 担当者確認 → 発行待ち → 発行
--
--     日割りはしません。契約明細に固定された 単価×数量 を1か月分として立てます。
--     何度呼んでも、同じ契約・同じ請求期間のものは二重に作りません。
-- ------------------------------------------------------------
create or replace function public.inv_contract_invoices_generate(p_contract_id bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c        public.inventory_contracts;
  v_inv_id bigint;
  v_excl   integer; v_taxable integer;
  v_start  date; v_ps date; v_pe date; v_issue date; v_due date;
  v_made   integer := 0; v_skip integer := 0;
  n        integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_contract_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;
  if c.status <> '確定' then
    raise exception '契約を確定してから請求の予定を作ってください（いまは「%」）', c.status;
  end if;
  if c.terms_confirmed_at is null then
    raise exception '支払条件を確定してから請求の予定を作ってください';
  end if;

  -- ── 初期費用（一括の明細をまとめて1本） ──
  select coalesce(sum(amount), 0), coalesce(sum(amount) filter (where taxable), 0)
    into v_excl, v_taxable
    from public.inventory_contract_items
   where contract_id = p_contract_id and billing = 'one_time';

  if v_excl > 0 then
    if exists (select 1 from public.inventory_contract_invoices
                where contract_id = p_contract_id and kind = 'initial' and status <> '取消') then
      v_skip := v_skip + 1;
    else
      v_issue := coalesce(c.contract_date, current_date);
      -- 支払期限の既定は「発行する月の翌月末」。下書きのあいだは直せます
      v_due := (date_trunc('month', v_issue) + interval '2 months' - interval '1 day')::date;
      insert into public.inventory_contract_invoices
        (contract_id, kind, sequence_no, scheduled_issue_date, due_date,
         amount_excl, tax, amount_incl, status, actor)
      values (p_contract_id, 'initial', 0, v_issue, v_due,
              v_excl, round(v_taxable * c.tax_rate / 100)::integer,
              v_excl + round(v_taxable * c.tax_rate / 100)::integer, '下書き', public.inv_actor())
      returning id into v_inv_id;

      insert into public.inventory_contract_invoice_lines
        (invoice_id, contract_item_id, name, spec, qty, unit_price, amount_excl, taxable, sort_no)
      select v_inv_id, it.id, it.name, it.spec, it.qty, it.unit_price, it.amount, it.taxable, it.sort_no
        from public.inventory_contract_items it
       where it.contract_id = p_contract_id and it.billing = 'one_time'
       order by it.sort_no, it.id;
      v_made := v_made + 1;
    end if;
  end if;

  -- ── 月額（1か月につき1本） ──
  select coalesce(sum(qty * unit_price), 0),
         coalesce(sum(qty * unit_price) filter (where taxable), 0)
    into v_excl, v_taxable
    from public.inventory_contract_items
   where contract_id = p_contract_id and billing = 'monthly';

  if v_excl > 0 and coalesce(c.months, 0) > 0 then
    v_start := coalesce(c.start_date, c.contract_date, current_date);
    for n in 0 .. (c.months - 1) loop
      v_ps := (date_trunc('month', v_start) + (n || ' months')::interval)::date;
      -- 利用期間の開始日が月の途中なら、初月だけその日から
      if n = 0 then v_ps := v_start; end if;
      v_pe := (date_trunc('month', v_ps) + interval '1 month' - interval '1 day')::date;
      -- 請求日は支払条件を確定するときに必ず入れてもらうが、念のため既定は月末（31→その月の末日）
      v_issue := public.inv_month_day(v_ps, coalesce(c.billing_day, 31));
      v_due := (date_trunc('month', v_issue) + interval '2 months' - interval '1 day')::date;

      if exists (select 1 from public.inventory_contract_invoices
                  where contract_id = p_contract_id and kind = 'monthly'
                    and period_start = v_ps and status <> '取消') then
        v_skip := v_skip + 1;
      else
        insert into public.inventory_contract_invoices
          (contract_id, kind, sequence_no, period_start, period_end,
           scheduled_issue_date, due_date, amount_excl, tax, amount_incl, status, actor)
        values (p_contract_id, 'monthly', n + 1, v_ps, v_pe, v_issue, v_due,
                v_excl, round(v_taxable * c.tax_rate / 100)::integer,
                v_excl + round(v_taxable * c.tax_rate / 100)::integer, '下書き', public.inv_actor())
        returning id into v_inv_id;

        insert into public.inventory_contract_invoice_lines
          (invoice_id, contract_item_id, name, spec, qty, unit_price, amount_excl, taxable, sort_no)
        select v_inv_id, it.id, it.name, it.spec, it.qty, it.unit_price,
               it.qty * it.unit_price, it.taxable, it.sort_no
          from public.inventory_contract_items it
         where it.contract_id = p_contract_id and it.billing = 'monthly'
         order by it.sort_no, it.id;
        v_made := v_made + 1;
      end if;
    end loop;
  end if;

  if v_made > 0 then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'contract', c.id::text,
            public.inv_contract_no(c.deal_id, c.seq), '請求予定の作成', null,
            v_made || '本を下書きで作成（発行はしていません）');
  end if;
  perform public.inv_contract_payment_recalc(p_contract_id);
  return jsonb_build_object('created', v_made, 'skipped', v_skip);
end $$;

comment on function public.inv_contract_invoices_generate is
  '契約から請求の予定をまとめて作る。初期費用1本＋月額は月ごとに1本。
   作るのは下書きまでで、自動では発行しない。日割りはしない。
   何度呼んでも、同じ契約・同じ請求期間のものは二重に作らない。';

-- ------------------------------------------------------------
-- 50-12) 請求を手で1本足す
-- ------------------------------------------------------------
create or replace function public.inv_contract_invoice_add(
  p_contract_id bigint,
  p_title       text    default null,
  p_amount_excl integer default 0,
  p_taxable     boolean default true,
  p_issue       date    default null,
  p_due         date    default null,
  p_item_id     bigint  default null
) returns public.inventory_contract_invoices
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c public.inventory_contracts;
  v public.inventory_contract_invoices;
  v_tax integer;
  v_seq integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_contract_id;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;
  if c.status = '取消' then raise exception 'この契約は取消です'; end if;
  if nullif(btrim(coalesce(p_title, '')), '') is null then
    raise exception '請求の名前を入れてください';
  end if;

  v_tax := case when coalesce(p_taxable, true)
                then round(greatest(coalesce(p_amount_excl, 0), 0) * c.tax_rate / 100)::integer
                else 0 end;
  select coalesce(max(sequence_no), 0) + 1 into v_seq
    from public.inventory_contract_invoices where contract_id = p_contract_id;

  insert into public.inventory_contract_invoices
    (contract_id, contract_item_id, kind, sequence_no, scheduled_issue_date, due_date,
     amount_excl, tax, amount_incl, status, note, actor)
  values (p_contract_id, p_item_id, 'manual', v_seq,
          coalesce(p_issue, current_date),
          coalesce(p_due, (date_trunc('month', coalesce(p_issue, current_date))
                           + interval '2 months' - interval '1 day')::date),
          greatest(coalesce(p_amount_excl, 0), 0), v_tax,
          greatest(coalesce(p_amount_excl, 0), 0) + v_tax, '下書き', btrim(p_title), public.inv_actor())
  returning * into v;

  insert into public.inventory_contract_invoice_lines
    (invoice_id, contract_item_id, name, qty, unit_price, amount_excl, taxable, sort_no)
  values (v.id, p_item_id, btrim(p_title), 1, v.amount_excl, v.amount_excl, coalesce(p_taxable, true), 10);
  return v;
end $$;

comment on function public.inv_contract_invoice_add is '請求を手で1本足す（追加費用など）。下書きで作る。';

-- ------------------------------------------------------------
-- 50-13) 請求を直す（下書き・発行待ちのあいだだけ）
--
--     発行したあとは、金額・請求先・対象期間を直接書き換えられません。
--     直したいときは「取り消して、新しい請求を作る」形にします（履歴を壊さないため）。
--     発行後に触れるのは社内メモだけです。
-- ------------------------------------------------------------
create or replace function public.inv_contract_invoice_set(
  p_id          bigint,
  p_issue       date    default null,
  p_due         date    default null,
  p_amount_excl integer default null,
  p_taxable     boolean default null,
  p_note        text    default null,
  p_internal    text    default null
) returns public.inventory_contract_invoices
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v public.inventory_contract_invoices;
  c public.inventory_contracts;
  v_excl integer; v_tax integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into v from public.inventory_contract_invoices where id = p_id for update;
  if not found then raise exception '請求が見つかりません（%）', p_id; end if;

  -- 発行したあとは社内メモだけ
  if v.status not in ('下書き', '発行待ち') then
    if p_issue is not null or p_due is not null or p_amount_excl is not null or p_taxable is not null then
      raise exception '発行した請求の金額・日付は直せません（いまは「%」）。'
        '取り消して、新しい請求を作ってください', v.status;
    end if;
    if p_internal is not null then
      update public.inventory_contract_invoices
         set internal_note = nullif(btrim(p_internal), ''), updated_at = now()
       where id = p_id returning * into v;
    end if;
    return v;
  end if;

  select * into c from public.inventory_contracts where id = v.contract_id;
  v_excl := coalesce(p_amount_excl, v.amount_excl);
  v_tax  := case when coalesce(p_taxable, v.tax > 0 or v.amount_excl = 0)
                 then round(v_excl * c.tax_rate / 100)::integer else 0 end;

  update public.inventory_contract_invoices
     set scheduled_issue_date = coalesce(p_issue, scheduled_issue_date),
         due_date    = coalesce(p_due, due_date),
         amount_excl = v_excl,
         tax         = v_tax,
         amount_incl = v_excl + v_tax,
         note          = case when p_note is null then note else nullif(btrim(p_note), '') end,
         internal_note = case when p_internal is null then internal_note else nullif(btrim(p_internal), '') end,
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into v;
  return v;
end $$;

comment on function public.inv_contract_invoice_set is
  '請求を直す。下書き・発行待ちのあいだだけ金額と日付を直せる。
   発行したあとは社内メモだけ。直したいときは取り消して作り直す。';

-- ------------------------------------------------------------
-- 50-14) 下書き → 発行待ち（担当者が中身を確認した）
-- ------------------------------------------------------------
create or replace function public.inv_contract_invoice_ready(p_id bigint, p_back boolean default false)
returns public.inventory_contract_invoices
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v public.inventory_contract_invoices;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into v from public.inventory_contract_invoices where id = p_id for update;
  if not found then raise exception '請求が見つかりません（%）', p_id; end if;

  if coalesce(p_back, false) then
    if v.status <> '発行待ち' then
      raise exception '発行待ちの請求だけ下書きに戻せます（いまは「%」）', v.status;
    end if;
    update public.inventory_contract_invoices
       set status = '下書き', actor = public.inv_actor(), updated_at = now()
     where id = p_id returning * into v;
    return v;
  end if;

  if v.status <> '下書き' then
    raise exception '下書きの請求だけ発行待ちにできます（いまは「%」）', v.status;
  end if;
  if v.amount_incl <= 0 then raise exception '金額が0円です。中身を確認してください'; end if;
  update public.inventory_contract_invoices
     set status = '発行待ち', actor = public.inv_actor(), updated_at = now()
   where id = p_id returning * into v;
  return v;
end $$;

comment on function public.inv_contract_invoice_ready is
  '請求を 下書き → 発行待ち にする（担当者が中身を確認した印）。p_back を true にすると下書きへ戻す。';

-- ------------------------------------------------------------
-- 50-15) 発行する（ここで正式採番）
-- ------------------------------------------------------------
create or replace function public.inv_contract_invoice_issue(p_id bigint, p_on date default null)
returns public.inventory_contract_invoices
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v public.inventory_contract_invoices;
  c public.inventory_contracts;
  v_on date := coalesce(p_on, current_date);
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into v from public.inventory_contract_invoices where id = p_id for update;
  if not found then raise exception '請求が見つかりません（%）', p_id; end if;
  if v.status <> '発行待ち' then
    raise exception '発行待ちの請求だけ発行できます（いまは「%」）。'
      '先に中身を確認して［発行待ちにする］を押してください', v.status;
  end if;

  select * into c from public.inventory_contracts where id = v.contract_id;
  update public.inventory_contract_invoices
     set status = '発行済み',
         invoice_no = public.inv_invoice_no_next(v_on),
         issued_at  = now(),
         scheduled_issue_date = v_on,
         due_date = coalesce(due_date,
           (date_trunc('month', v_on) + interval '2 months' - interval '1 day')::date),
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into v;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'invoice', v.id::text, v.invoice_no, '請求発行', '発行待ち',
          to_char(v.amount_incl, 'FM9,999,999,999') || '円（税込）／支払期限 ' || v.due_date::text);

  perform public.inv_invoice_recalc(p_id);
  perform public.inv_contract_payment_recalc(v.contract_id);
  select * into v from public.inventory_contract_invoices where id = p_id;
  return v;
end $$;

comment on function public.inv_contract_invoice_issue is
  '請求を発行する。ここではじめて正式な請求番号を採番する。
   発行したあとは金額・日付を直せない（取り消して作り直す）。';

-- ------------------------------------------------------------
-- 50-16) 請求を取り消す
-- ------------------------------------------------------------
create or replace function public.inv_contract_invoice_cancel(p_id bigint, p_reason text default null)
returns public.inventory_contract_invoices
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v public.inventory_contract_invoices;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into v from public.inventory_contract_invoices where id = p_id for update;
  if not found then raise exception '請求が見つかりません（%）', p_id; end if;
  if v.status = '取消' then raise exception 'この請求はすでに取消です'; end if;
  if exists (select 1 from public.inventory_contract_payments where invoice_id = p_id) then
    raise exception '入金が記録されている請求は取り消せません。先に入金の記録を消してください';
  end if;

  update public.inventory_contract_invoices
     set status = '取消',
         internal_note = coalesce(internal_note || E'\n', '')
           || coalesce('取消：' || nullif(btrim(coalesce(p_reason, '')), ''), '取消'),
         actor = public.inv_actor(), updated_at = now()
   where id = p_id
  returning * into v;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'invoice', v.id::text, coalesce(v.invoice_no, '（未発行）'),
          '請求取消', null, coalesce(nullif(btrim(coalesce(p_reason, '')), ''), '取消'));

  perform public.inv_contract_payment_recalc(v.contract_id);
  return v;
end $$;

comment on function public.inv_contract_invoice_cancel is
  '請求を取り消す。入金が記録されているものは取り消せない（先に入金の記録を消す）。';

-- ------------------------------------------------------------
-- 50-17) 入金を記録する
--
--     1つの請求に何回でも登録できます（一部入金）。
--     過入金になっても自動では直しません。返り値と画面で知らせます。
-- ------------------------------------------------------------
create or replace function public.inv_contract_payment_add(
  p_invoice_id bigint,
  p_amount     integer,
  p_paid_on    date default null,
  p_method     text default null,
  p_reference  text default null,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v      public.inventory_contract_invoices;
  v_paid integer;
  v_id   bigint;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if coalesce(p_amount, 0) = 0 then raise exception '入金額を入れてください'; end if;
  select * into v from public.inventory_contract_invoices where id = p_invoice_id for update;
  if not found then raise exception '請求が見つかりません（%）', p_invoice_id; end if;
  if v.status in ('下書き', '発行待ち') then
    raise exception 'まだ発行していない請求には入金を記録できません（いまは「%」）', v.status;
  end if;
  if v.status = '取消' then raise exception '取り消した請求には入金を記録できません'; end if;

  insert into public.inventory_contract_payments
    (invoice_id, paid_on, amount, method, reference, note, actor)
  values (p_invoice_id, coalesce(p_paid_on, current_date), p_amount,
          nullif(btrim(coalesce(p_method, '')), ''),
          nullif(btrim(coalesce(p_reference, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), public.inv_actor())
  returning id into v_id;

  v := public.inv_invoice_recalc(p_invoice_id);
  select coalesce(sum(amount), 0) into v_paid
    from public.inventory_contract_payments where invoice_id = p_invoice_id;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'invoice', v.id::text, coalesce(v.invoice_no, '（未発行）'),
          '入金確認', null,
          to_char(p_amount, 'FM9,999,999,999') || '円'
            || coalesce('（' || nullif(btrim(coalesce(p_method, '')), '') || '）', '')
            || '／入金計 ' || to_char(v_paid, 'FM9,999,999,999') || '円'
            || '／' || v.status);

  perform public.inv_contract_payment_recalc(v.contract_id);

  return jsonb_build_object(
    'payment_id', v_id,
    'status', v.status,
    'paid_total', v_paid,
    'remaining', greatest(v.amount_incl - v_paid, 0),
    'over_paid', greatest(v_paid - v.amount_incl, 0),
    'warn', case when v_paid > v.amount_incl
                 then '過入金あり（' || to_char(v_paid - v.amount_incl, 'FM9,999,999,999')
                      || '円多く入っています）。返金・次回相殺の扱いを決めてください'
                 else null end);
end $$;

comment on function public.inv_contract_payment_add is
  '入金を記録する。1つの請求に何回でも登録できる（一部入金）。
   入金合計が請求額を超えても自動では直さず、「過入金あり」として知らせる。';

create or replace function public.inv_contract_payment_delete(p_id bigint)
returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_invoice bigint; v_contract bigint; v_amount integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select invoice_id, amount into v_invoice, v_amount
    from public.inventory_contract_payments where id = p_id;
  if v_invoice is null then raise exception '入金の記録が見つかりません（%）', p_id; end if;
  select contract_id into v_contract from public.inventory_contract_invoices where id = v_invoice;

  delete from public.inventory_contract_payments where id = p_id;
  perform public.inv_invoice_recalc(v_invoice);
  perform public.inv_contract_payment_recalc(v_contract);

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'invoice', v_invoice::text,
          (select coalesce(invoice_no, '（未発行）') from public.inventory_contract_invoices where id = v_invoice),
          '入金の取消', to_char(v_amount, 'FM9,999,999,999') || '円', '入金の記録を消しました');
  return true;
end $$;

comment on function public.inv_contract_payment_delete is '入金の記録を消す（入力間違いの取り消し）。';

-- ------------------------------------------------------------
-- 50-18) 見積の部分更新を直す（既存の不具合）
--
--     これまで inv_quote_set は、渡さなかった項目を NULL で上書きしていた。
--     画面がいつも全項目を送っていたので表面化していなかったが、
--     APIやこれからの自動処理から一部だけ直すと、件名や但し書きが消えてしまう。
--
--     これからは
--       渡さない（null）        … いまの値を残す
--       空文字（''）を渡す      … 消す
--     に統一する。inv_contract_set / inv_contract_billing_set も同じにする。
--
--     有効期限は日付なので空文字を渡せない。消したいときは p_clear_valid を true にする。
-- ------------------------------------------------------------


-- 契約も同じ考え方に揃える（渡さない＝残す、空文字＝消す）




-- ------------------------------------------------------------
-- 50-19) 権限
--
--     請求・入金にもお客様の金額が入るので、anon には一切見せない。
--     表は読み取りだけにして、書き込みは関数（security definer）を通す。
-- ------------------------------------------------------------
alter table public.inventory_contract_invoices      enable row level security;
alter table public.inventory_contract_invoice_lines enable row level security;
alter table public.inventory_contract_payments      enable row level security;

drop policy if exists "inventory_contract_invoices read" on public.inventory_contract_invoices;
create policy "inventory_contract_invoices read" on public.inventory_contract_invoices
  for select to authenticated using (true);
drop policy if exists "inventory_contract_invoice_lines read" on public.inventory_contract_invoice_lines;
create policy "inventory_contract_invoice_lines read" on public.inventory_contract_invoice_lines
  for select to authenticated using (true);
drop policy if exists "inventory_contract_payments read" on public.inventory_contract_payments;
create policy "inventory_contract_payments read" on public.inventory_contract_payments
  for select to authenticated using (true);

revoke all on public.inventory_contract_invoices      from anon, authenticated;
revoke all on public.inventory_contract_invoice_lines from anon, authenticated;
revoke all on public.inventory_contract_payments      from anon, authenticated;
grant select on public.inventory_contract_invoices      to authenticated;
grant select on public.inventory_contract_invoice_lines to authenticated;
grant select on public.inventory_contract_payments      to authenticated;
grant select on public.inv_contract_invoice_list        to authenticated;
revoke all on sequence public.inventory_invoice_no_seq from public, anon, authenticated;

revoke all on function public.inv_invoice_no_next(date)                     from public, anon;
revoke all on function public.inv_month_day(date,integer)                   from public, anon;
revoke all on function public.inv_invoice_recalc(bigint)                    from public, anon, authenticated;
revoke all on function public.inv_contract_payment_recalc(bigint)           from public, anon, authenticated;
revoke all on function public.inv_contract_invoices_refresh(bigint)         from public, anon;
revoke all on function public.inv_contract_invoices_generate(bigint)        from public, anon;
revoke all on function public.inv_contract_invoice_add(bigint,text,integer,boolean,date,date,bigint) from public, anon;
revoke all on function public.inv_contract_invoice_set(bigint,date,date,integer,boolean,text,text) from public, anon;
revoke all on function public.inv_contract_invoice_ready(bigint,boolean)    from public, anon;
revoke all on function public.inv_contract_invoice_issue(bigint,date)       from public, anon;
revoke all on function public.inv_contract_invoice_cancel(bigint,text)      from public, anon;
revoke all on function public.inv_contract_payment_add(bigint,integer,date,text,text,text) from public, anon;
revoke all on function public.inv_contract_payment_delete(bigint)           from public, anon;
revoke all on function public.inv_quote_set(bigint,text,date,numeric,text,text,boolean) from public, anon;

grant execute on function public.inv_month_day(date,integer)                   to authenticated;
grant execute on function public.inv_contract_invoices_refresh(bigint)         to authenticated;
grant execute on function public.inv_contract_invoices_generate(bigint)        to authenticated;
grant execute on function public.inv_contract_invoice_add(bigint,text,integer,boolean,date,date,bigint) to authenticated;
grant execute on function public.inv_contract_invoice_set(bigint,date,date,integer,boolean,text,text) to authenticated;
grant execute on function public.inv_contract_invoice_ready(bigint,boolean)    to authenticated;
grant execute on function public.inv_contract_invoice_issue(bigint,date)       to authenticated;
grant execute on function public.inv_contract_invoice_cancel(bigint,text)      to authenticated;
grant execute on function public.inv_contract_payment_add(bigint,integer,date,text,text,text) to authenticated;
grant execute on function public.inv_contract_payment_delete(bigint)           to authenticated;
grant execute on function public.inv_quote_set(bigint,text,date,numeric,text,text,boolean) to authenticated;


-- ------------------------------------------------------------
-- 51-1) 契約明細とレンタル申込のつなぎ
--
--     ［不足分を手配］を押すたびに新しい申込を作らないよう、
--     契約明細に「この明細のレンタル申込」を覚えておく。
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 51-2) 契約が確保した実物の記録
--
--     「どの契約の、どの明細が、どの実物を確保したか」を必ず追えるようにする。
--     取り消すときも、ここに記録されたものだけを戻す。
-- ------------------------------------------------------------
create table if not exists public.inventory_contract_fulfillments (
  id          bigint generated by default as identity primary key,
  contract_id bigint not null references public.inventory_contracts(id) on delete cascade,
  contract_item_id bigint not null references public.inventory_contract_items(id) on delete cascade,
  kind        text not null,
  item_id     text references public.inventory_items(id) on delete set null,
  rental_request_id bigint references public.inventory_rental_requests(id) on delete set null,
  qty         integer not null default 1,
  status      text not null default '確保済み',
  source      text not null default 'COMMERCE',
  reference   text,                     -- 契約番号など、あとで探すための手がかり
  actor       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint inventory_contract_fulfillments_kind_chk check (kind in ('sale', 'rental')),
  constraint inventory_contract_fulfillments_status_chk check
    (status in ('確保済み', '解除', '発送済み', '貸出中', '返却済み'))
);

comment on table public.inventory_contract_fulfillments is
  '契約が確保した実物の記録。どの契約のどの明細が、どの個体・どのレンタル申込を押さえたか。
   契約を取り消すときも、ここに載っているものだけを戻す（商品コード単位では戻さない）。';

create index if not exists inventory_contract_fulfillments_contract_idx
  on public.inventory_contract_fulfillments (contract_id, contract_item_id, id);
create index if not exists inventory_contract_fulfillments_item_idx
  on public.inventory_contract_fulfillments (item_id);

-- 同じ明細に同じ個体を二重に紐付けない
create unique index if not exists inventory_contract_fulfillments_item_uk
  on public.inventory_contract_fulfillments (contract_item_id, item_id)
  where item_id is not null and status <> '解除';
-- 1台の個体を、同時に2つの契約が押さえない
create unique index if not exists inventory_contract_fulfillments_item_once_uk
  on public.inventory_contract_fulfillments (item_id)
  where item_id is not null and status <> '解除';

-- ------------------------------------------------------------
-- 51-3) 明細と契約ヘッダの手配状態をまとめ直す
--
--     ヘッダは明細の集約。
--     「調達待ち」が1件でもあれば、ヘッダを準備完了にしない。
-- ------------------------------------------------------------
create or replace function public.inv_contract_fulfillment_recalc(p_contract_id bigint)
returns text
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c        public.inventory_contracts;
  it       public.inventory_contract_items;
  v_have   integer;
  v_stock  integer := 0;   -- 在庫を伴う明細の数
  v_done   integer := 0;   -- 必要数がそろった明細
  v_short  integer := 0;   -- 調達待ちの明細
  v_touch  integer := 0;   -- 少しでも確保した明細
  v_new    text;
begin
  select * into c from public.inventory_contracts where id = p_contract_id;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;

  for it in select * from public.inventory_contract_items
             where contract_id = p_contract_id order by sort_no, id
  loop
    if it.kind not in ('sale', 'rental') then
      -- 在庫を伴わない明細（キッティング・研修・月額サービスなど）
      if it.fulfillment_status <> '手配不要' then
        update public.inventory_contract_items
           set fulfillment_status = '手配不要', updated_at = now() where id = it.id;
      end if;
      continue;
    end if;

    v_stock := v_stock + 1;
    select count(*) into v_have
      from public.inventory_contract_fulfillments
     where contract_item_id = it.id and status <> '解除';

    if v_have >= it.qty then
      v_done := v_done + 1;
      v_new := '確保済み';
    elsif v_have > 0 or it.fulfillment_status in ('手配中', '調達待ち') then
      v_short := v_short + 1;
      v_new := '調達待ち';
    else
      v_new := '未手配';
    end if;
    if v_have > 0 then v_touch := v_touch + 1; end if;

    if v_new <> it.fulfillment_status or v_have <> it.allocated_qty then
      update public.inventory_contract_items
         set fulfillment_status = v_new,
             allocated_qty = v_have,
             procure_qty = greatest(it.qty - v_have, 0),
             updated_at = now()
       where id = it.id;
    end if;
  end loop;

  -- ヘッダは明細の集約
  if v_stock = 0 then
    -- 在庫を伴う明細が無い契約（作業と月額サービスだけ）
    v_new := case when c.fulfillment_status = '未手配' then '未手配' else '準備完了' end;
  elsif v_done = v_stock then
    v_new := '準備完了';
  elsif v_short > 0 or v_touch > 0 then
    v_new := '手配中';
  else
    -- 1台も押さえていない（まだ手配していない／全部戻した）
    v_new := '未手配';
  end if;

  -- 発送以降まで進んでいる契約は、ここでは戻さない
  if c.fulfillment_status in ('発送済み', '貸出中', '完了', '返却待ち', '返却済み') then
    return c.fulfillment_status;
  end if;

  if v_new <> c.fulfillment_status then
    update public.inventory_contracts
       set fulfillment_status = v_new, updated_at = now() where id = p_contract_id;
  end if;
  return v_new;
end $$;

comment on function public.inv_contract_fulfillment_recalc is
  '契約明細と契約ヘッダの手配状態をまとめ直す。ヘッダは明細の集約で、
   「調達待ち」が1件でも残っていれば準備完了にしない。';

-- ------------------------------------------------------------
-- 51-4) 手配に進む（在庫を実際に押さえる唯一の入口）
--
--     p_only_short = true にすると、足りない明細だけを対象にする
--     （［不足分を手配］。すでに確保できている個体には触らない）。
--
--     二重実行を止めるため、いちばん最初に契約行を for update で押さえる。
--     画面のボタンを disabled にするだけには頼らない。
--     手配してよいかも、ここでもう一度確かめる（画面を開いてから
--     状態が変わっているかもしれないため）。
-- ------------------------------------------------------------
create or replace function public.inv_contract_fulfill_start(
  p_contract_id bigint,
  p_only_short  boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c        public.inventory_contracts;
  it       public.inventory_contract_items;
  v_can    jsonb;
  v_need   integer;
  v_have   integer;
  v_item   public.inventory_items;
  v_req    jsonb;
  v_rr     public.inventory_rental_requests;
  v_ids    text[];
  v_id     text;
  v_no     text;
  v_got    integer;
  v_total  integer := 0;   -- このボタンで新しく確保できた数
  v_short  integer := 0;   -- 足りないままの数
  v_stop   text[]  := '{}';-- 自動手配できなかった明細のお知らせ
  i        integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  -- ここで直列化する。同時に2回押されても、片方は待たされてから走る
  select * into c from public.inventory_contracts where id = p_contract_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;
  v_no := public.inv_contract_no(c.deal_id, c.seq);

  -- 押すまでに状態が変わっているかもしれないので、ここでも確かめる
  v_can := public.inv_contract_can_fulfill(p_contract_id);
  if not (v_can->>'ok')::boolean then
    return jsonb_build_object('ok', false, 'reason', v_can->>'reason',
                              'allocated', 0, 'short', 0);
  end if;
  if c.fulfillment_status in ('発送済み', '貸出中', '完了', '返却待ち', '返却済み') then
    return jsonb_build_object('ok', false,
      'reason', 'この契約はすでに「' || c.fulfillment_status || '」です', 'allocated', 0, 'short', 0);
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'contract', c.id::text, v_no,
          case when p_only_short then '不足分の再手配' else '手配開始' end,
          c.fulfillment_status, '在庫の確保をはじめます');

  for it in select * from public.inventory_contract_items
             where contract_id = p_contract_id and kind in ('sale', 'rental')
             order by sort_no, id
             for update
  loop
    select count(*) into v_have
      from public.inventory_contract_fulfillments
     where contract_item_id = it.id and status <> '解除';
    v_need := greatest(it.qty - v_have, 0);

    if v_need = 0 then continue; end if;
    if p_only_short and it.fulfillment_status not in ('調達待ち', '手配中') then continue; end if;

    -- 契約はスナップショットなので、商品コードが残っていないことがある。
    -- 似た型番や後継機で勝手に代用しない。担当者に確認してもらう。
    if nullif(btrim(coalesce(it.product_code, '')), '') is null then
      v_stop := v_stop || (it.name || '：自動手配できません（商品コードを確認してください）');
      continue;
    end if;
    if not exists (select 1 from public.inventory_products where code = it.product_code) then
      v_stop := v_stop || (it.name || '：商品コード ' || it.product_code || ' が見つかりません');
      continue;
    end if;

    -- ここから実際に取りにいく。1台も取れなくても「試した」ことが分かるよう、
    -- 先に手配中にしておく（そうしないと未手配のままになり、調達待ちに見えない）
    update public.inventory_contract_items
       set fulfillment_status = '手配中', updated_at = now()
     where id = it.id and fulfillment_status in ('未手配', '手配中', '調達待ち');
    v_got := 0;

    if it.kind = 'sale' then
      -- ── 販売：必要数だけ販売予約する ──
      for i in 1 .. v_need loop
        begin
          v_item := public.inv_sale_reserve(it.product_code, 'COMMERCE', v_no,
                                            '契約 ' || v_no || ' / ' || it.name);
        exception when others then
          if sqlerrm like '%在庫がありません%' then
            exit;                      -- 在庫切れ。ここまでで止めて、残りは調達待ちにする
          else
            raise;
          end if;
        end;
        insert into public.inventory_contract_fulfillments
          (contract_id, contract_item_id, kind, item_id, qty, status, source, reference, actor)
        values (p_contract_id, it.id, 'sale', v_item.id, 1, '確保済み', 'COMMERCE', v_no, public.inv_actor());
        v_got := v_got + 1;
      end loop;

    else
      -- ── レンタル：申込を作って（あれば使い回して）個体を割り当てる ──
      if not exists (select 1 from public.inventory_products
                      where code = it.product_code and kind = 'individual'
                        and coalesce(rental_enabled, false)) then
        v_stop := v_stop || (it.name || '：この商品は8RENTの掲載が入っていないので自動手配できません');
        continue;
      end if;

      -- 前の申込が取り消されていたら、それは使い回せない（新しく作る）
      if it.rental_request_id is not null
         and not exists (select 1 from public.inventory_rental_requests
                          where id = it.rental_request_id
                            and status in ('希望受付', '在庫・調達確認', '個体割当')) then
        update public.inventory_contract_items
           set rental_request_id = null, updated_at = now() where id = it.id
        returning * into it;
      end if;

      if it.rental_request_id is null then
        v_req := public.inv_rental_request_create(
          array[it.product_code], coalesce(c.customer_name, c.company, 'ご契約者'),
          it.qty, c.company, c.email, c.phone, c.start_date, it.months, false,
          '契約 ' || v_no || ' からの手配', jsonb_build_object('contract_no', v_no));
        update public.inventory_contract_items
           set rental_request_id = (v_req->>'request_id')::bigint, updated_at = now()
         where id = it.id
        returning * into it;
        insert into public.inventory_transactions
          (actor, ref_kind, ref_id, label, action, before_value, after_value)
        values (public.inv_actor(), 'contract', c.id::text, v_no, 'レンタル申込作成', null,
                it.name || '：申込 #' || it.rental_request_id || '（' || it.qty || '台）');
      end if;

      v_rr := public.inv_rental_allocate(it.rental_request_id);
      v_ids := coalesce(v_rr.item_ids, '{}'::text[]);
      foreach v_id in array v_ids loop
        if not exists (select 1 from public.inventory_contract_fulfillments
                        where contract_item_id = it.id and item_id = v_id and status <> '解除') then
          insert into public.inventory_contract_fulfillments
            (contract_id, contract_item_id, kind, item_id, rental_request_id,
             qty, status, source, reference, actor)
          values (p_contract_id, it.id, 'rental', v_id, it.rental_request_id,
                  1, '確保済み', 'COMMERCE', v_no, public.inv_actor());
          v_got := v_got + 1;
        end if;
      end loop;
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values (public.inv_actor(), 'contract', c.id::text, v_no, 'レンタル割当', null,
              it.name || '：申込 #' || it.rental_request_id || ' に ' || v_got || '台割当');
    end if;

    v_total := v_total + v_got;
    if v_got < v_need then
      v_short := v_short + (v_need - v_got);
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values (public.inv_actor(), 'contract', c.id::text, v_no, '調達待ち', null,
              it.name || '：必要 ' || it.qty || '台／確保 ' || (v_have + v_got)
                || '台／調達 ' || (v_need - v_got) || '台');
    elsif v_got > 0 then
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values (public.inv_actor(), 'contract', c.id::text, v_no, '一部確保', null,
              it.name || '：' || v_got || '台を確保（必要 ' || it.qty || '台）');
    end if;
  end loop;

  perform public.inv_contract_fulfillment_recalc(p_contract_id);
  select * into c from public.inventory_contracts where id = p_contract_id;

  -- 実際に1台でも押さえたときだけ、契約を「履行中」へ進める。
  -- ボタンを押しただけで実態より先に進めない。
  if c.status = '確定' and exists (select 1 from public.inventory_contract_fulfillments
                                    where contract_id = p_contract_id and status <> '解除') then
    update public.inventory_contracts
       set status = '履行中', actor = public.inv_actor(), updated_at = now()
     where id = p_contract_id;
    update public.inventory_deals
       set status = '手配', actor = public.inv_actor()
     where id = c.deal_id and status in ('契約', '支払条件確定');
  end if;

  if c.fulfillment_status = '準備完了' then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'contract', c.id::text, v_no, '手配完了', null,
            '必要数がすべてそろいました');
  end if;

  return jsonb_build_object(
    'ok', true, 'allocated', v_total, 'short', v_short,
    'fulfillment_status', c.fulfillment_status,
    'stopped', to_jsonb(v_stop),
    'reason', case
      when array_length(v_stop, 1) > 0 then '自動手配できない明細があります'
      when v_short > 0 then '在庫が足りないぶんは調達待ちにしました'
      when v_total > 0 then '必要数を確保しました'
      else '新しく確保するものはありませんでした' end);
end $$;

comment on function public.inv_contract_fulfill_start is
  '契約の手配を始める（在庫を実際に押さえる唯一の入口）。
   販売は inv_sale_reserve、レンタルは inv_rental_request_create + inv_rental_allocate を通すので、
   最終的に共通ロック inv_reserve_available_item を必ず通る。
   足りないぶんは調達待ちとして残し、仮の個体は作らない。
   商品コードが無い・掲載が無い明細は、代わりの商品を推測せず担当者に止める。
   p_only_short = true で「不足分だけ」。契約行を for update で押さえるので二重実行に強い。';

-- ------------------------------------------------------------
-- 51-5) この契約が確保したものだけを戻す（発送前のみ）
--
--     商品コード単位では戻さない。同じ商品を別の案件が押さえていることがあるため。
--     発送済み・貸出中になった個体は、契約の取消だけを理由に自動で戻さない
--     （返品・返却の実物確認が要る）。
-- ------------------------------------------------------------
create or replace function public.inv_contract_fulfill_release(
  p_contract_id bigint,
  p_reason      text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  c      public.inventory_contracts;
  f      public.inventory_contract_fulfillments;
  it     public.inventory_items;
  v_no   text;
  v_back integer := 0;
  v_keep integer := 0;
  v_reqs bigint[] := '{}';
  v_req  bigint;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into c from public.inventory_contracts where id = p_contract_id for update;
  if not found then raise exception '契約が見つかりません（%）', p_contract_id; end if;
  v_no := public.inv_contract_no(c.deal_id, c.seq);

  for f in select * from public.inventory_contract_fulfillments
            where contract_id = p_contract_id and status = '確保済み'
            order by id
            for update
  loop
    select * into it from public.inventory_items where id = f.item_id;
    if it.id is null then
      update public.inventory_contract_fulfillments
         set status = '解除', updated_at = now() where id = f.id;
      continue;
    end if;
    -- 発送してしまったものは自動で戻さない
    if it.status in ('貸出中', '売却済') then
      v_keep := v_keep + 1;
      continue;
    end if;

    if f.kind = 'sale' then
      if it.status = '販売予約' then
        perform public.inv_item_op(f.item_id, '予約解除', null,
                                   '契約 ' || v_no || ' の取消');
      end if;
      update public.inventory_contract_fulfillments
         set status = '解除', updated_at = now() where id = f.id;
      v_back := v_back + 1;
    else
      -- レンタルは申込ごと取り消す（同じ申込の個体をまとめて戻す）
      if f.rental_request_id is not null and not (f.rental_request_id = any(v_reqs)) then
        v_reqs := v_reqs || f.rental_request_id;
      end if;
      update public.inventory_contract_fulfillments
         set status = '解除', updated_at = now() where id = f.id;
      v_back := v_back + 1;
    end if;
  end loop;

  foreach v_req in array v_reqs loop
    perform public.inv_rental_set_status(v_req, 'キャンセル');
    -- 取り消した申込は使い回せないので、明細とのつながりも切っておく
    update public.inventory_contract_items
       set rental_request_id = null, updated_at = now()
     where contract_id = p_contract_id and rental_request_id = v_req;
  end loop;

  if v_back > 0 then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'contract', c.id::text, v_no, '予約解除', null,
            v_back || '台を在庫へ戻しました'
              || coalesce('（' || nullif(btrim(coalesce(p_reason, '')), '') || '）', ''));
  end if;

  -- 1台も残っていない明細は「未手配」に戻す。
  -- 調達待ちのままだと「仕入れ待ち」に見えてしまうが、実際は意図して手放した状態なので。
  update public.inventory_contract_items ci
     set fulfillment_status = '未手配', updated_at = now()
   where ci.contract_id = p_contract_id
     and ci.kind in ('sale', 'rental')
     and ci.fulfillment_status in ('手配中', '調達待ち', '確保済み')
     and not exists (select 1 from public.inventory_contract_fulfillments cf
                      where cf.contract_item_id = ci.id and cf.status <> '解除');

  perform public.inv_contract_fulfillment_recalc(p_contract_id);

  -- 全部戻して何も押さえていないなら、契約は「確定」に戻す
  -- （履行中は、実際に何かを押さえているあいだの状態にしておく）
  if c.status = '履行中'
     and not exists (select 1 from public.inventory_contract_fulfillments
                      where contract_id = p_contract_id and status <> '解除') then
    update public.inventory_contracts
       set status = '確定', actor = public.inv_actor(), updated_at = now()
     where id = p_contract_id;
  end if;

  return jsonb_build_object('released', v_back, 'kept', v_keep,
    'reason', case when v_keep > 0
                   then v_keep || '台は発送済み・売却済みなので戻していません（返品・返却の手続きが要ります）'
                   else null end);
end $$;

comment on function public.inv_contract_fulfill_release is
  'この契約が確保した個体だけを在庫へ戻す。商品コード単位では戻さない
   （同じ商品を別の案件が押さえていることがあるため）。
   発送済み・貸出中・売却済みの個体は自動で戻さない。';

-- ------------------------------------------------------------
-- 51-6) 契約の取消に、確保したものを戻す処理をつなぐ
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 51-7) 画面が読む手配の一覧
-- ------------------------------------------------------------
create or replace view public.inv_contract_fulfillment_list as
select it.id            as contract_item_id,
       it.contract_id,
       it.sort_no, it.kind, it.name, it.spec, it.product_code, it.qty,
       it.fulfillment_status,
       it.rental_request_id,
       coalesce(f.got, 0) as allocated_qty,
       -- 在庫を伴わない明細（キッティング・研修など）は調達待ちにしない
       case when it.kind in ('sale', 'rental')
            then greatest(it.qty - coalesce(f.got, 0), 0) else 0 end as procure_qty
  from public.inventory_contract_items it
  left join (select contract_item_id, count(*) as got
               from public.inventory_contract_fulfillments
              where status <> '解除' group by contract_item_id) f
    on f.contract_item_id = it.id;

comment on view public.inv_contract_fulfillment_list is
  '契約明細ごとの手配の様子（必要数・確保できた数・調達待ちの数）。';

-- ------------------------------------------------------------
-- 51-8) 権限
-- ------------------------------------------------------------
alter table public.inventory_contract_fulfillments enable row level security;
drop policy if exists "inventory_contract_fulfillments read" on public.inventory_contract_fulfillments;
create policy "inventory_contract_fulfillments read" on public.inventory_contract_fulfillments
  for select to authenticated using (true);

revoke all on public.inventory_contract_fulfillments from anon, authenticated;
grant select on public.inventory_contract_fulfillments to authenticated;
grant select on public.inv_contract_fulfillment_list   to authenticated;

revoke all on function public.inv_contract_fulfillment_recalc(bigint)      from public, anon, authenticated;
revoke all on function public.inv_contract_fulfill_start(bigint,boolean)   from public, anon;
revoke all on function public.inv_contract_fulfill_release(bigint,text)    from public, anon;
grant execute on function public.inv_contract_fulfill_start(bigint,boolean) to authenticated;
grant execute on function public.inv_contract_fulfill_release(bigint,text)  to authenticated;


-- ------------------------------------------------------------
-- 52-1) 契約に、顧客ページ用の列を足す
--
--     顧客URLの鍵は、見積の鍵を使い回しません。契約ごとに別に発行します。
--     再発行したら前の鍵は使えなくなります。
-- ------------------------------------------------------------


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


-- ============================================================
-- 出品先の「管理画面で探す」導線
--
--   これまで /zaiko の出品先にあった「商品URL」は、お客様が見る
--   販売ページです。これはそのまま残します。
--   ここで足すのは、店舗の担当者が商品を探して登録・更新するための
--   「管理画面」への導線です。対象は楽天とAmazon。
--
--   大事なところ
--     ・モールの管理画面URL・検索URLの形はコードに直書きしない。
--       店舗の契約や画面改定で変わるので、設定として持つ
--       （inventory_channel_settings）。
--     ・検索語つきURLの形は、実際に管理画面で1度検索して確かめた
--       ものだけを入れる。楽天とAmazonは、ログイン済みの管理画面で
--       確かめた形を既定として入れてある（下の 53-2）。
--       設定が空のサイトでは、画面は「検索語をコピーして管理画面を開く」
--       に切り替わる。
--     ・管理画面の直リンク（admin_url）は人が管理画面で開いたURLを
--       貼るための欄。こちらで組み立てたり推測したりしない。
--       楽天なら item.rms.rakuten.co.jp、Amazonなら
--       sellercentral.amazon.co.jp のhttpsだけを受ける。
-- ============================================================

-- ------------------------------------------------------------
-- 53-1) 検索語つきURLのひな形を、販売サイトごとの設定に足す
--     {q} を検索語（URLエンコード済み）に差し替えて使う。
--     入れてよいのは、実際の管理画面で検索して確かめた形だけ。
-- ------------------------------------------------------------
alter table public.inventory_channel_settings
  add column if not exists admin_search_url_template text;

comment on column public.inventory_channel_settings.admin_search_url_template is
  'その販売サイトの管理画面で、検索語つきで検索結果を開くURLのひな形。{q} を検索語に差し替える。
   入れてよいのは、実際に管理画面で1度検索して確かめた形だけ（推測のURLは作らない）。
   空なら画面側は「検索語をコピーして管理画面のトップを開く」に切り替わる。';

-- ------------------------------------------------------------
-- 53-2) 管理画面のトップURLと、検索語つきURL。
--     まだ空の販売サイトにだけ既定を入れる。すでに店舗が入れている値は
--     上書きしない（画面が変わったとき店舗が入れ直せるようにするため）。
--
--     検索語つきURLは、ログイン済みの管理画面で実際に検索して確かめた形。
--       Amazon  … /product-search/keywords/search?q=…
--                 （過去のフォーラムにある /product-search/search?q=… ではない）
--       楽天RMS … ?type=keywordSearch&inventoryOutOfStock=INCLUDED-SKU&keyword=…
--                 在庫切れのSKUも含めて探す。出品を直しにいく用途では
--                 在庫0のものこそ見たいため。
--
--     楽天の店舗コード 439442 はこの店舗のもの。他店舗では設定画面から
--     入れ替えられるよう、コード側ではこの値を持たない。
-- ------------------------------------------------------------
update public.inventory_channel_settings
   set admin_home_url = 'https://item.rms.rakuten.co.jp/rms-sku/shops/439442/items'
 where channel = 'rakuten' and nullif(btrim(coalesce(admin_home_url, '')), '') is null;

update public.inventory_channel_settings
   set admin_search_url_template = 'https://item.rms.rakuten.co.jp/rms-sku/shops/439442/items'
       || '?type=keywordSearch&inventoryOutOfStock=INCLUDED-SKU&keyword={q}'
 where channel = 'rakuten' and nullif(btrim(coalesce(admin_search_url_template, '')), '') is null;

update public.inventory_channel_settings
   set admin_home_url = 'https://sellercentral.amazon.co.jp/product-search'
 where channel = 'amazon' and nullif(btrim(coalesce(admin_home_url, '')), '') is null;

update public.inventory_channel_settings
   set admin_search_url_template = 'https://sellercentral.amazon.co.jp/product-search/keywords/search?q={q}'
 where channel = 'amazon' and nullif(btrim(coalesce(admin_search_url_template, '')), '') is null;

-- ------------------------------------------------------------
-- 53-3) 管理画面URLの受け入れ規則
--
--     ・https だけ
--     ・楽天・Amazonは、その販売サイトの管理画面のドメインだけ
--     ・ログインセッションや認証トークンが載っている一時URLは断る
--       （貼った人のセッションが切れたあと使えないうえ、残すべきでない）
-- ------------------------------------------------------------
create or replace function public.inv_admin_url_check(
  p_channel text,
  p_url     text
) returns text
language plpgsql immutable set search_path = public, pg_catalog as $$
declare
  v_url  text := nullif(btrim(coalesce(p_url, '')), '');
  v_host text;
  v_want text;
begin
  if v_url is null then
    return null;                                   -- 空は「消す」の意味。素通し
  end if;
  if v_url !~* '^https://' then
    raise exception '管理画面URLは https:// で始まるものだけ登録できます';
  end if;
  -- https:// のうしろ、最初の / ? # までがホスト名
  v_host := lower(split_part(regexp_replace(v_url, '^https://', '', 'i'), '/', 1));
  v_host := split_part(split_part(v_host, '?', 1), '#', 1);
  v_host := split_part(v_host, '@', -1);           -- user:pass@host の形を除く
  v_host := split_part(v_host, ':', 1);            -- ポート番号を落とす

  v_want := case p_channel
              when 'rakuten' then 'item.rms.rakuten.co.jp'
              when 'amazon'  then 'sellercentral.amazon.co.jp'
              else null
            end;
  if v_want is not null and v_host <> v_want then
    raise exception '% の管理画面URLは % のものだけ登録できます（いまは %）',
      case p_channel when 'rakuten' then '楽天' else 'Amazon' end, v_want, v_host;
  end if;

  -- ログイン中だけ有効な一時URLは残さない
  if v_url ~* '(session[-_]?id|sessionid|access[-_]?token|id[-_]?token|refresh[-_]?token|auth[-_]?token|[?&]token=|[?&]code=|[?&]state=|jsessionid|sid=)' then
    raise exception 'ログイン中だけ有効なURL（セッションIDやトークンつき）は登録できません。
管理画面で商品を開いたあとの、毎回同じになるURLを貼ってください';
  end if;
  return v_url;
end $$;

comment on function public.inv_admin_url_check is
  '管理画面URLとして受けてよい形か確かめる。https のみ、楽天・Amazonはそのサイトの
   管理画面ドメインのみ、セッションIDやトークンつきの一時URLは断る。空は素通し（消す意味）。';

-- ------------------------------------------------------------
-- 53-4) 商品ごとの管理画面URL（人が管理画面で開いたURLを貼る欄）
--     受け入れ規則をDB側でも通す。
--
--     まだ出品していない商品でも、管理画面で先に商品を作ってURLが
--     分かっていることがある。その場合は掲載の行が無いので、
--     UPDATE だけだと保存できない。行が無ければ作る。
--     入れるのは admin_url だけで、出品状態・価格・SKU・商品URLは
--     触らない（作られた行は「未出品」のまま）。
-- ------------------------------------------------------------
create or replace function public.inv_listing_admin_url_set(
  p_code    text,
  p_channel text,
  p_url     text
) returns public.inventory_channel_listings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_listings;
  v text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if not exists (select 1 from public.inventory_products where code = p_code) then
    raise exception 'この型番は登録されていません（%）', p_code;
  end if;
  v := public.inv_admin_url_check(p_channel, p_url);

  update public.inventory_channel_listings
     set admin_url = v, updated_at = now()
   where product_code = p_code and channel = p_channel
  returning * into r;
  if found then
    return r;
  end if;

  -- 掲載の行が無いとき。消す指示（空）なら、空の行を作らずに終わる
  if v is null then
    return null;
  end if;
  insert into public.inventory_channel_listings (product_code, channel, admin_url)
  values (p_code, p_channel, v)
  on conflict (product_code, channel) do update
    set admin_url = excluded.admin_url, updated_at = now()
  returning * into r;
  return r;
end $$;

comment on function public.inv_listing_admin_url_set is
  'その商品の販売サイト管理画面URL（直リンク）を入れ直す。人が管理画面で確かめた値だけを入れる。
   https のみ、楽天・Amazonはそのサイトの管理画面ドメインのみ、一時URLは断る。';

-- ------------------------------------------------------------
-- 53-5) 販売サイトごとの設定。検索URLのひな形を足し、受け入れ規則を通す
--
--     引数が1つ増える。既定値つきで足すと4引数の呼び出しがどちらの関数か
--     決まらなくなるので、古い署名は先に落とす。
-- ------------------------------------------------------------
drop function if exists public.inv_channel_settings_set(text,text,text,text);

create or replace function public.inv_channel_settings_set(
  p_channel  text,
  p_home     text default null,
  p_template text default null,
  p_note     text default null,
  p_search   text default null
) returns public.inventory_channel_settings
language plpgsql security invoker set search_path = public as $$
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
   検索語つきのひな形は、実際の管理画面で検索して確かめた人だけが入れる。';

-- 関数は作った時点で PUBLIC（anon を含む）に EXECUTE が付くので、明示的に外す
revoke all on function public.inv_admin_url_check(text,text)                     from public, anon;
revoke all on function public.inv_listing_admin_url_set(text,text,text)          from public, anon;
revoke all on function public.inv_channel_settings_set(text,text,text,text,text) from public, anon;

grant execute on function public.inv_admin_url_check(text,text)                     to authenticated;
grant execute on function public.inv_listing_admin_url_set(text,text,text)          to authenticated;
grant execute on function public.inv_channel_settings_set(text,text,text,text,text) to authenticated;

-- ============================================================
-- 54) public スキーマのRPC権限を、意図したところだけに絞る
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


-- ============================================================
-- 55) 8RENT の申込を、ほかの公開フォームと同じ「API経由だけ」にする
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
-- 3) 公開カタログが読めるようにする
--
--     公開ビュー inv_public_products が中で呼ぶ inv_model_key は
--     security invoker で、その中でさらに inv_norm_model を呼びます。
--     invoker の関数は呼んだ人の権限で中を実行するので、anon には
--     両方の EXECUTE が要ります（片方だけだと、行の中身を作るときに
--     permission denied になります）。
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


-- ============================================================
-- 56) 8RENT：商品を決めずに申し込めるようにする
--
--   inv_rental_request_create() は「機種の指定が無くても受け付ける」
--   つもりで書いてありましたが、inventory_rental_requests.product_code が
--   NOT NULL だったため、実際には保存できませんでした。
--
--   8RENTの入口は「型番が分かる人」だけではありません。
--     必要な台数・利用期間・希望スペック・Office・用途・開始希望日
--   を伝えてもらい、在庫と取り寄せから提案するのが本来のやりかたです。
--   そのため、商品未指定の申込を正式に受けられるようにします。
--
--   決まっていないことは NULL で表します。
--   UNKNOWN / NO-MODEL / DUMMY のような架空の商品コードは入れません。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 商品コードを必須でなくする
--     外部キーはそのまま残します（入っているときは実在する商品だけ）。
--     NULL は外部キーの検査対象外なので、制約を緩めることにはなりません。
-- ------------------------------------------------------------
alter table public.inventory_rental_requests
  alter column product_code drop not null;

comment on column public.inventory_rental_requests.product_code is
  'お客様の申込で決まっている商品。決まっていなければ NULL（商品未指定・条件から提案）。
   お客様が書いた「希望モデル」は conditions->>''model'' に入っていて、これとは別物。
   ここを埋めるのは社内の選定（inv_rental_request_product_set）だけ。';

-- ------------------------------------------------------------
-- 2) 社内で商品を決める
--
--     お客様の「希望モデル」（conditions->>'model'）と、社内で確定する
--     product_code は別物です。似た型番や後継機をこちらで当てはめることは
--     しません。人が選んだ実在の商品だけを入れます。
--
--     ここで入れるのは商品だけで、個体は押さえません。
--     個体を押さえるのは、これまでどおり inv_rental_allocate() を
--     押したときだけです。
-- ------------------------------------------------------------
create or replace function public.inv_rental_request_product_set(
  p_request_id bigint,
  p_code       text
) returns public.inventory_rental_requests
language plpgsql security invoker set search_path = public as $$
declare
  r      public.inventory_rental_requests;
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_before text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into r from public.inventory_rental_requests where id = p_request_id for update;
  if not found then
    raise exception '申込が見つかりません（%）', p_request_id;
  end if;
  if r.status in ('返却済み', 'キャンセル') then
    raise exception 'この申込はすでに「%」で終わっています', r.status;
  end if;
  -- すでに個体を押さえた後で商品を変えると、押さえたものと食い違う
  if coalesce(array_length(r.item_ids, 1), 0) > 0 or r.item_id is not null then
    raise exception 'すでに個体を割り当てています。先に割当を解いてから商品を変えてください';
  end if;

  if v_code is not null then
    if not exists (select 1 from public.inventory_products where code = v_code) then
      raise exception 'この商品は登録されていません（%）', v_code;
    end if;
  end if;

  v_before := coalesce(r.product_code, '（商品未指定）');

  update public.inventory_rental_requests
     set product_code = v_code,
         -- 機種の候補をまとめる鍵。商品を外したら鍵も外す
         model_key    = case when v_code is null then null
                             else (select public.inv_model_key(p.maker, p.model, p.code)
                                     from public.inventory_products p where p.code = v_code) end,
         updated_at   = now()
   where id = p_request_id
  returning * into r;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'rental_request', p_request_id::text,
          r.customer_name, '申込の商品を決めた',
          v_before, coalesce(v_code, '（商品未指定）'));

  return r;
end $$;

comment on function public.inv_rental_request_product_set is
  '商品未指定の8RENT申込に、社内で商品を決めて入れる（外すときは空を渡す）。
   実在する商品だけ。個体は押さえない（押さえるのは inv_rental_allocate だけ）。
   すでに個体を割り当てている申込・終わった申込は変えられない。履歴に残す。';

revoke all   on function public.inv_rental_request_product_set(bigint,text) from public, anon, service_role;
grant execute on function public.inv_rental_request_product_set(bigint,text) to authenticated;

-- ------------------------------------------------------------
-- 3) 商品未指定のまま個体を割り当てない
--
--     inv_rental_allocate() はもともと
--       「model_key も product_code も無ければ断る」
--     と書いてありますが、断り文句が分かりにくいので言い直します。
--     中身（どの個体を押さえるか）の決まりは変えていません。
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.inv_rental_allocate(bigint)') is null then
    raise exception '関数 inv_rental_allocate が見つかりません。先に setup.sql を適用してください';
  end if;
end $$;

-- ------------------------------------------------------------
-- 確かめかた
--
--   1) 商品未指定で保存できるか
--        set role service_role;
--        select public.inv_rental_request_create(
--          '{}'::text[], '条件 太郎', 5, 'テスト株式会社', 't@example.test', null,
--          '2026-11-01', 6, true, 'Core i5以上でお願いします',
--          '{"cpu":"Core i5","memory_gb":16,"model":"HP ProBook 450 G9"}'::jsonb);
--        reset role;
--      → product_code が null、status が 希望受付 で入る
--
--   2) 商品未指定のまま割り当てようとすると断られるか
--        select public.inv_rental_allocate(<id>);
--      → 機種が決まっていません。先に商品を決めてから割り当ててください
--
--   3) 社内で商品を決めて、履歴が残るか
--        select public.inv_rental_request_product_set(<id>, 'P-00537');
--        select action, before_value, after_value from public.inventory_transactions
--         where ref_kind = 'rental_request' order by id desc limit 1;
--
--   4) 商品を決めただけでは個体が動いていないこと
--        select item_id, item_ids from public.inventory_rental_requests where id = <id>;
--      → null と {}
-- ------------------------------------------------------------


-- ============================================================
-- 57) レンタル申込を、商品マスタの削除で消さない
--
--   inventory_rental_requests.product_code の外部キーが
--   ON DELETE CASCADE になっていました。商品マスタを1件消しただけで、
--   その商品で来ていた過去のレンタル申込ごと消える状態です。
--
--     inventory_rental_requests_product_code_fkey
--       FOREIGN KEY (product_code) REFERENCES inventory_products(code)
--       ON DELETE CASCADE          ← これ
--
--   レンタル申込は、お客様の連絡先・希望台数・希望期間・希望スペック・
--   希望モデル・ご連絡事項を持つ、契約前の大事な記録です。
--   商品の整理と一緒に消えてよいものではありません。
--
--   2026-10-03 で product_code を NULL 可にしたので、
--   ON DELETE SET NULL に変えます。商品が消えても申込は残り、
--   「商品未指定（条件から提案）」として扱えます。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 外部キーを付け替える
--     参照先（inventory_products.code）も、列（product_code）も変えません。
--     変えるのは「参照先が消えたときどうするか」だけです。
-- ------------------------------------------------------------
alter table public.inventory_rental_requests
  drop constraint if exists inventory_rental_requests_product_code_fkey;

alter table public.inventory_rental_requests
  add constraint inventory_rental_requests_product_code_fkey
  foreign key (product_code) references public.inventory_products(code)
  on delete set null;

-- ------------------------------------------------------------
-- 2) 商品を消すときに、レンタル申込への影響を履歴へ残す
--
--     外部キーの ON DELETE SET NULL はDBが静かに行うので、それだけでは
--     inventory_transactions に何も残りません。あとから
--     「この申込はなぜ商品未指定なのか」が分からなくなります。
--     商品を消す前に、影響する申込の件数を履歴へ書きます。
--
--     inv_delete_products() の中身はここだけ足して、ほかは変えていません。
-- ------------------------------------------------------------
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
  n_rentals  integer := 0;
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
           (select count(*) from public.inventory_items i where i.product_code = pr.code) as units,
           (select count(*) from public.inventory_rental_requests r where r.product_code = pr.code) as rentals
      from public.inventory_products pr
     where pr.code = any(p_codes)
  loop
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values
      (public.inv_actor(), 'product', p.code, coalesce(nullif(p.name,''), p.model), '削除',
       format('%s（個体 %s台）', coalesce(nullif(p.model,''), p.code), p.units), '削除');

    -- レンタル申込は消さずに残す（商品だけ外れて「商品未指定」になる）。
    -- DBが静かに外すので、そのことをここで書いておく
    if p.rentals > 0 then
      n_rentals := n_rentals + p.rentals;
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values
        (public.inv_actor(), 'product', p.code, coalesce(nullif(p.name,''), p.model),
         'レンタル申込の商品を外した',
         format('%s（%s）の申込 %s件', p.code, coalesce(nullif(p.model,''), p.code), p.rentals),
         '申込は残し、商品未指定にしました');
    end if;
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

  return jsonb_build_object('products', n_products, 'units', n_units,
                            'channels', n_chans + n_listings, 'rentals', n_rentals);
end $$;

comment on function public.inv_delete_products is
  '選んだ商品を、ぶら下がる個体と販売情報ごと消す。管理者のみ。何を消したかは履歴に残す。
   レンタル申込は消さない（商品だけ外れて「商品未指定」になる）。外した件数も履歴に残す。';

-- 作り直したので権限を入れ直す（create or replace でも既定のPUBLICが付き直す）
revoke all   on function public.inv_delete_products(text[]) from public, anon, service_role;
grant execute on function public.inv_delete_products(text[]) to authenticated;

-- ------------------------------------------------------------
-- 確かめかた
--
--   1) 外部キーが SET NULL になったか
--        select conname, pg_get_constraintdef(oid) from pg_constraint
--         where conrelid = 'public.inventory_rental_requests'::regclass
--           and contype = 'f'
--           and pg_get_constraintdef(oid) ilike '%product_code%';
--      → ON DELETE SET NULL を含む
--
--   2) 商品を消しても申込が残るか
--        商品ありの申込を1件作ってから、その商品を消して
--        select id, product_code, customer_name, qty, conditions
--          from public.inventory_rental_requests where id = <id>;
--      → 行は残り、product_code だけ null。ほかはそのまま
--
--   3) 履歴に残るか
--        select action, before_value, after_value from public.inventory_transactions
--         where ref_kind = 'product' order by id desc limit 3;
--      → 「レンタル申込の商品を外した」が出る
-- ------------------------------------------------------------


-- ============================================================
-- 58) 販売サイトごとの「手数料・送料・目標利益」
--
--     仕入CSVから6チャネル（楽天・Amazon・メルカリ・ヤフオク・Yahooフリマ・自社EC）の
--     出品価格を計算するための設定。手数料率や送料は契約で変わるので、
--     **初期値は入れずNULLから始める**（推測で埋めない）。
--
--     管理画面URLの inv_channel_settings_set() とは別の関数で保存する。
--     既存の関数の引数も挙動も変えない。
--
--     migration: zaiko/migrations/2026-10-05-channel-pricing.sql
-- ============================================================
-- ------------------------------------------------------------
-- 58-1) 値段を決めるための5列
--
--     fee_rate            … 販売手数料率。0.10 なら10%。0以上1未満
--     fixed_cost          … 1件ごとの固定費（決済手数料・梱包材など）
--     shipping_cost       … 送料
--     target_profit_rate  … 目標利益率。0.20 なら原価の20%
--     minimum_profit_yen  … 最低利益額。目標利益率で足りないときの下限
--
--     すべてNULL可。NULLは「まだ決めていない」という意味で、
--     画面側はNULLのチャネルの価格を出さない（0として計算しない）。
-- ------------------------------------------------------------
alter table public.inventory_channel_settings
  add column if not exists fee_rate           numeric;
alter table public.inventory_channel_settings
  add column if not exists fixed_cost         numeric;
alter table public.inventory_channel_settings
  add column if not exists shipping_cost      numeric;
alter table public.inventory_channel_settings
  add column if not exists target_profit_rate numeric;
alter table public.inventory_channel_settings
  add column if not exists minimum_profit_yen numeric;

comment on column public.inventory_channel_settings.fee_rate is
  '販売手数料率。0.10 で10%。0以上1未満。NULLは未設定で、価格計算をしない。';
comment on column public.inventory_channel_settings.fixed_cost is
  '1件ごとの固定費（決済手数料・梱包材など）。NULLは未設定。';
comment on column public.inventory_channel_settings.shipping_cost is
  '送料。NULLは未設定。';
comment on column public.inventory_channel_settings.target_profit_rate is
  '目標利益率。0.20 で原価の20%。チャネルごとに変えられる。NULLは未設定。';
comment on column public.inventory_channel_settings.minimum_profit_yen is
  '最低利益額（円）。目標利益率で足りないときの下限。NULLは未設定。';

-- ------------------------------------------------------------
-- 58-2) 自社EC（own）の設定行
--
--     いまは**価格計算のためだけ**に使う。
--     在庫一覧の出品先タブには出さず、inventory_channel_listings の
--     実際の出品処理にもつながない（将来、自社EC出品を作るときに接続する）。
-- ------------------------------------------------------------
insert into public.inventory_channel_settings (channel, label, note) values
  ('own', '自社EC',
   'いまは出品価格の計算にだけ使う設定です。在庫一覧の出品先タブには出さず、実際の出品処理にもつないでいません。')
on conflict (channel) do nothing;

-- ------------------------------------------------------------
-- 58-3) 価格設定を保存する
--
--     既存の inv_channel_settings_set()（管理画面URL用）とは**別の関数**にする。
--     既存の引数・挙動を変えないため、呼び出し側の互換性が壊れない。
--
--     入れられるのは管理者だけ。表は読み取り専用のままなので security definer。
--     NULL を渡した項目は「未設定に戻す」。0 と NULL は別物として扱う
--     （0円の送料と、送料を決めていないことは意味が違う）。
-- ------------------------------------------------------------
create or replace function public.inv_channel_pricing_settings_set(
  p_channel            text,
  p_fee_rate           numeric default null,
  p_fixed_cost         numeric default null,
  p_shipping_cost      numeric default null,
  p_target_profit_rate numeric default null,
  p_minimum_profit_yen numeric default null
) returns public.inventory_channel_settings
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_ch  text := nullif(btrim(coalesce(p_channel, '')), '');
  before public.inventory_channel_settings;
  r     public.inventory_channel_settings;
  fmt   text := 'FM9,999,999,999';
begin
  if not public.inv_is_admin() then
    raise exception '販売価格の設定は管理者だけが変えられます';
  end if;
  if v_ch is null then
    raise exception '販売サイトを選んでください';
  end if;
  -- 価格設定をするのはこの6サイトだけ。打ち間違いで知らない行が増えないよう、
  -- 画面だけでなくここでも止める（inventory_channel_settings は upsert のため）
  if v_ch not in ('rakuten', 'amazon', 'mercari', 'yahuoku', 'yahoo_free', 'own') then
    raise exception '価格設定の対象ではない販売サイトです：%（rakuten / amazon / mercari / yahuoku / yahoo_free / own のどれかです）', v_ch;
  end if;

  -- 手数料率が1以上だと、最低販売価格の割り算（1 - fee_rate）が0や負になる
  if p_fee_rate is not null and (p_fee_rate < 0 or p_fee_rate >= 1) then
    raise exception '手数料率は0以上1未満で入れてください（0.10 で10%%）。いまは %', p_fee_rate;
  end if;
  if p_target_profit_rate is not null and p_target_profit_rate < 0 then
    raise exception '目標利益率にマイナスは入れられません（いまは %）', p_target_profit_rate;
  end if;
  if p_fixed_cost is not null and p_fixed_cost < 0 then
    raise exception '固定費にマイナスは入れられません（いまは %）', p_fixed_cost;
  end if;
  if p_shipping_cost is not null and p_shipping_cost < 0 then
    raise exception '送料にマイナスは入れられません（いまは %）', p_shipping_cost;
  end if;
  if p_minimum_profit_yen is not null and p_minimum_profit_yen < 0 then
    raise exception '最低利益額にマイナスは入れられません（いまは %）', p_minimum_profit_yen;
  end if;

  select * into before from public.inventory_channel_settings where channel = v_ch;

  insert into public.inventory_channel_settings
    (channel, fee_rate, fixed_cost, shipping_cost, target_profit_rate, minimum_profit_yen)
  values
    (v_ch, p_fee_rate, p_fixed_cost, p_shipping_cost, p_target_profit_rate, p_minimum_profit_yen)
  on conflict (channel) do update
    set fee_rate           = p_fee_rate,
        fixed_cost         = p_fixed_cost,
        shipping_cost      = p_shipping_cost,
        target_profit_rate = p_target_profit_rate,
        minimum_profit_yen = p_minimum_profit_yen
  returning * into r;

  -- 値付けの根拠になる設定なので、いつ誰が変えたかを履歴に残す
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (
    public.inv_actor(), 'channel', v_ch, coalesce(r.label, v_ch), '販売価格の設定を変えた',
    case when before.channel is null then '（設定なし）' else
      format('手数料 %s／固定費 %s／送料 %s／目標利益率 %s／最低利益 %s',
             coalesce(to_char(before.fee_rate * 100, fmt) || '%', '未設定'),
             coalesce(to_char(before.fixed_cost, fmt) || '円', '未設定'),
             coalesce(to_char(before.shipping_cost, fmt) || '円', '未設定'),
             coalesce(to_char(before.target_profit_rate * 100, fmt) || '%', '未設定'),
             coalesce(to_char(before.minimum_profit_yen, fmt) || '円', '未設定')) end,
    format('手数料 %s／固定費 %s／送料 %s／目標利益率 %s／最低利益 %s',
           coalesce(to_char(r.fee_rate * 100, fmt) || '%', '未設定'),
           coalesce(to_char(r.fixed_cost, fmt) || '円', '未設定'),
           coalesce(to_char(r.shipping_cost, fmt) || '円', '未設定'),
           coalesce(to_char(r.target_profit_rate * 100, fmt) || '%', '未設定'),
           coalesce(to_char(r.minimum_profit_yen, fmt) || '円', '未設定')));

  return r;
end $$;

comment on function public.inv_channel_pricing_settings_set is
  '販売サイトごとの手数料・固定費・送料・目標利益率・最低利益額を保存する。管理者だけ。
   管理画面URLの inv_channel_settings_set() とは別の関数で、そちらの引数も挙動も変えない。
   NULLは「未設定に戻す」。0円とNULLは別物として扱う。
   この関数は在庫も出品情報も変更しない。';

-- ------------------------------------------------------------
-- 58-4) 権限
--
--     関数を作り直すと PUBLIC への EXECUTE が既定で付き直るので、
--     ここで必ず外してから社員向けに配り直す（2026-10-01 と同じ考えかた）。
-- ------------------------------------------------------------
revoke all on function public.inv_channel_pricing_settings_set(
  text, numeric, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.inv_channel_pricing_settings_set(
  text, numeric, numeric, numeric, numeric, numeric) to authenticated;


-- ============================================================
-- 59) 手数料の内訳・プランと、配送サイズ
--
--     手数料を「1つの率」だけでなく、プラン（ヤフオクのストア契約）や
--     内訳の合算（楽天）でも決められるようにする。
--     送料は販売サイトではなく「配送会社 × サイズ × 地域」で決まるので、
--     配送サイズは商品に持たせる（金額はまだ持たない）。
--
--     migration: zaiko/migrations/2026-10-06-channel-pricing-rules.sql
-- ============================================================
-- ------------------------------------------------------------
-- 59-1) 手数料の内訳・プランを持つ列
--
--     入れかた（すべて任意。無ければ fee_rate 列がそのまま使われる）
--       plan          … いま契約しているプランの名前
--       plans         … プランごとの手数料率。plan で選ぶ
--       pricing_mode  … contract（実契約）/ conservative_estimate（保守的試算）
--                       / weighted_actual（実績で重みづけ。将来）
--       fee_parts     … 手数料の内訳。{min, max} の範囲で持てる
--       excluded      … わざと計算に入れていないもの（理由つき）
--       monthly_fixed_yen … 月額の固定費。**1件あたりには割らない**
--       by_category   … 商品カテゴリごとの上書き（将来のAmazonカテゴリ別料率用）
--
--     実効手数料率の決めかた（画面側）
--       ① plans[plan]  ② fee_parts の合算  ③ fee_rate 列
-- ------------------------------------------------------------
alter table public.inventory_channel_settings
  add column if not exists pricing_rules jsonb;

comment on column public.inventory_channel_settings.pricing_rules is
  '手数料の内訳・プラン・カテゴリ別の上書き。NULLなら fee_rate 列だけを使う。
   pricing_mode が conservative_estimate のときは、fee_parts の max を合算した
   「安全側の試算値」であって実契約料率ではない。';

-- ------------------------------------------------------------
-- 59-2) 配送サイズ（佐川急便の規格）
--
--     送料は販売サイトではなく「配送会社 × サイズ × 地域」で決まるので、
--     チャネルではなく**商品**に持たせる。
--     金額はまだ入れない（契約運賃表が無いため）。サイズだけ先に決めておく。
-- ------------------------------------------------------------
alter table public.inventory_products
  add column if not exists shipping_size text;

comment on column public.inventory_products.shipping_size is
  '配送サイズ（佐川急便）。60/80/100/120/140/160/170/180/200/custom。
   NULLは未設定。送料の金額はここには持たない（契約運賃表ができてから別に持つ）。';

-- ------------------------------------------------------------
-- 59-3) 確定した料率を入れる
--
--     **空いている項目だけ**入れる（coalesce）。すでに担当者が入れた値は
--     上書きしない。送料（shipping_cost）はどのサイトにも入れない。
-- ------------------------------------------------------------
update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.077),   -- Yahoo!オークションストア契約
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object(
    'plan', 'store',
    'pricing_mode', 'contract',
    'plans', jsonb_build_object('normal', 0.100, 'store', 0.077)))
 where channel = 'yahuoku';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.091),   -- 保守的試算（内訳の上限合算）
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  note               = coalesce(note, '') ||
    case when coalesce(note, '') = '' then '' else ' / ' end ||
    '手数料 9.1% は内訳の上限を足した【保守的試算】です。実契約料率ではありません。',
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object(
    'plan', 'standard',
    'pricing_mode', 'conservative_estimate',
    'fee_parts', jsonb_build_object(
      'システム利用料',                  jsonb_build_object('min', 0.020, 'max', 0.045,
        'note', 'PC 2.0〜4.0% / モバイル 2.5〜4.5%。月商帯とPC・モバイル比率で変わる'),
      '楽天ポイント原資',                jsonb_build_object('min', 0.010, 'max', 0.010),
      '安全性・利便性向上システム利用料', jsonb_build_object('min', 0.001, 'max', 0.001),
      '楽天ペイ',                        jsonb_build_object('min', 0.025, 'max', 0.035)),
    'excluded', jsonb_build_object(
      'アフィリエイト', '全注文に発生するわけではないので、基本の価格計算には入れない。実績利益で見る',
      '月額出店料',     '65,000円/月。1件あたりには割らない'),
    'monthly_fixed_yen', 65000))
 where channel = 'rakuten';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.084),   -- 主力商品向けの標準値
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object(
    'pricing_mode', 'contract',
    'by_category', '{}'::jsonb))   -- カテゴリ別料率はここへ足していく
 where channel = 'amazon';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.10),
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object('pricing_mode', 'contract'))
 where channel = 'mercari';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.05),
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object('pricing_mode', 'contract'))
 where channel = 'yahoo_free';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0),       -- 自社ECは販売手数料なし
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object('pricing_mode', 'contract'))
 where channel = 'own';

-- ------------------------------------------------------------
-- 59-4) pricing_rules を保存する
--
--     中身の形を確かめてから入れる。おかしな率が入ると、最低販売価格の
--     割り算（1 - 手数料率）が0や負になって、画面が黙って変な値を出す。
-- ------------------------------------------------------------
create or replace function public.inv_channel_pricing_rules_set(
  p_channel text,
  p_rules   jsonb default null
) returns public.inventory_channel_settings
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_ch   text := nullif(btrim(coalesce(p_channel, '')), '');
  v_mode text;
  before jsonb;
  r      public.inventory_channel_settings;
  k      text;
  v      jsonb;
  v_sum  numeric := 0;
begin
  if not public.inv_is_admin() then
    raise exception '販売価格の設定は管理者だけが変えられます';
  end if;
  if v_ch is null then
    raise exception '販売サイトを選んでください';
  end if;
  if v_ch not in ('rakuten', 'amazon', 'mercari', 'yahuoku', 'yahoo_free', 'own') then
    raise exception '価格設定の対象ではない販売サイトです：%（rakuten / amazon / mercari / yahuoku / yahoo_free / own のどれかです）', v_ch;
  end if;

  if p_rules is not null then
    if jsonb_typeof(p_rules) <> 'object' then
      raise exception '手数料の内訳は { } の形で入れてください';
    end if;
    -- 知らないキーは受け取らない（打ち間違いが黙って捨てられないように）
    for k in select jsonb_object_keys(p_rules) loop
      if k not in ('plan', 'plans', 'pricing_mode', 'fee_parts', 'excluded',
                   'monthly_fixed_yen', 'by_category') then
        raise exception '知らない項目です：%', k;
      end if;
    end loop;

    v_mode := p_rules ->> 'pricing_mode';
    if v_mode is not null and v_mode not in ('contract', 'conservative_estimate', 'weighted_actual') then
      raise exception 'pricing_mode は contract / conservative_estimate / weighted_actual のどれかです（いまは %）', v_mode;
    end if;

    -- プランごとの率
    if p_rules ? 'plans' then
      if jsonb_typeof(p_rules -> 'plans') <> 'object' then
        raise exception 'plans は { プラン名: 率 } の形で入れてください';
      end if;
      for k, v in select * from jsonb_each(p_rules -> 'plans') loop
        if jsonb_typeof(v) <> 'number' or (v)::numeric < 0 or (v)::numeric >= 1 then
          raise exception 'plans.% は0以上1未満の数で入れてください（0.077 で7.7%%）', k;
        end if;
      end loop;
      if p_rules ? 'plan' and not (p_rules -> 'plans' ? (p_rules ->> 'plan')) then
        raise exception 'plan「%」が plans にありません', p_rules ->> 'plan';
      end if;
    end if;

    -- 手数料の内訳
    if p_rules ? 'fee_parts' then
      if jsonb_typeof(p_rules -> 'fee_parts') <> 'object' then
        raise exception 'fee_parts は { 項目名: {min, max} } の形で入れてください';
      end if;
      for k, v in select * from jsonb_each(p_rules -> 'fee_parts') loop
        if jsonb_typeof(v) <> 'object' or not (v ? 'min') or not (v ? 'max') then
          raise exception 'fee_parts.% は {"min": 率, "max": 率} の形で入れてください', k;
        end if;
        if jsonb_typeof(v -> 'min') <> 'number' or jsonb_typeof(v -> 'max') <> 'number' then
          raise exception 'fee_parts.% の min と max は数で入れてください', k;
        end if;
        if (v ->> 'min')::numeric < 0 or (v ->> 'max')::numeric < (v ->> 'min')::numeric then
          raise exception 'fee_parts.% は 0 ≦ min ≦ max で入れてください', k;
        end if;
        v_sum := v_sum + (v ->> 'max')::numeric;
      end loop;
      if v_sum >= 1 then
        raise exception '内訳の上限を足すと100%% を超えます（合計 %）。1未満になるように入れてください', v_sum;
      end if;
    end if;

    if p_rules ? 'monthly_fixed_yen' then
      if jsonb_typeof(p_rules -> 'monthly_fixed_yen') <> 'number'
         or (p_rules ->> 'monthly_fixed_yen')::numeric < 0 then
        raise exception 'monthly_fixed_yen は0以上の数で入れてください';
      end if;
    end if;
  end if;

  select pricing_rules into before from public.inventory_channel_settings where channel = v_ch;

  insert into public.inventory_channel_settings (channel, pricing_rules)
  values (v_ch, p_rules)
  on conflict (channel) do update set pricing_rules = p_rules
  returning * into r;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'channel', v_ch, coalesce(r.label, v_ch), '手数料の内訳を変えた',
          coalesce(before::text, '（設定なし）'),
          coalesce(p_rules::text, '（設定なし）'));
  return r;
end $$;

comment on function public.inv_channel_pricing_rules_set is
  '販売サイトの手数料の内訳・プランを保存する。管理者だけ。
   実効手数料率の計算は画面側で行い、ここでは入れられる値かだけを確かめる。
   在庫も出品情報も変更しない。';

-- ------------------------------------------------------------
-- 59-5) 商品の配送サイズを保存する
-- ------------------------------------------------------------
create or replace function public.inv_product_shipping_size_set(
  p_code text,
  p_size text default null
) returns public.inventory_products
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_size text := nullif(btrim(coalesce(p_size, '')), '');
  before text;
  r      public.inventory_products;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if v_size is not null
     and v_size not in ('60','80','100','120','140','160','170','180','200','custom') then
    raise exception '知らない配送サイズです：%（60/80/100/120/140/160/170/180/200/custom）', v_size;
  end if;

  select shipping_size into before from public.inventory_products where code = p_code;

  update public.inventory_products set shipping_size = v_size
   where code = p_code returning * into r;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code, coalesce(nullif(r.name, ''), r.code),
          '配送サイズを決めた', coalesce(before, '未設定'), coalesce(v_size, '未設定'));
  return r;
end $$;

comment on function public.inv_product_shipping_size_set is
  '商品の配送サイズ（佐川急便の規格）を決める。送料の金額はここでは持たない。
   在庫も価格も変更しない。';

-- ------------------------------------------------------------
-- 59-6) 権限
--     作り直すと PUBLIC への EXECUTE が既定で付き直るので、必ず外してから配る。
-- ------------------------------------------------------------
revoke all on function public.inv_channel_pricing_rules_set(text, jsonb) from public, anon;
grant execute on function public.inv_channel_pricing_rules_set(text, jsonb) to authenticated;
revoke all on function public.inv_product_shipping_size_set(text, text) from public, anon;
grant execute on function public.inv_product_shipping_size_set(text, text) to authenticated;


-- ============================================================
-- 60) 配送の運賃表（佐川急便）
--
--     送料は「配送会社 × 便 × 支払 × サイズ × 地域」で決まる。
--     運賃表は**税別**で持ち、価格計算には税込にした金額を使う。
--     いま入っているのは過去の契約資料からの**暫定（provisional）**で、
--     現行契約の表が確認できたら inv_shipping_tariff_set() で入れ替える。
--
--     migration: zaiko/migrations/2026-10-07-shipping-rates.sql
-- ============================================================
-- ------------------------------------------------------------
-- 60-1) 運賃表
--
--     1行が「配送会社 × 便 × 支払 × 表の版」1つぶん。
--     現行契約の表が来たら、新しい行として入れて active を切り替える。
--     古い行は消さずに残すので、いつどの表で計算したかを追える。
-- ------------------------------------------------------------
create table if not exists public.inventory_shipping_tariffs (
  id             bigint generated by default as identity primary key,
  carrier        text not null,                  -- sagawa
  service        text not null,                  -- 陸便
  payment        text not null,                  -- 元払
  rate_status    text not null,                  -- provisional（暫定）/ contract（現行契約）
                                                 -- ※ 版の識別子ではなく「状態」だけを表す
  label          text,
  source_note    text,
  effective_from date not null,                  -- この表がいつからのものか。版の識別子
  effective_to   date,                           -- いつまで。まだ決まっていなければ NULL
  tax_rate       numeric not null default 0.10,  -- 運賃は税別なので、税込にするための税率
  active         boolean not null default false,
  sizes          jsonb   not null default '[]'::jsonb,   -- ["60","80",…]
  regions        jsonb   not null default '{}'::jsonb,   -- {"東京":"関東",…}
  rates          jsonb   not null default '{}'::jsonb,   -- {"60":{"関東":560,…},…} 税別
  excluded       jsonb   not null default '{}'::jsonb,   -- 自動計算しないもの（理由つき）
  source_meta    jsonb   not null default '{}'::jsonb,   -- 元資料の注意書き・サイズごとの重量上限など
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  -- 版は「いつからの表か」で決める。rate_status では決めない
  -- （同じ contract の新しい表を入れたときに、古い contract を上書きしてしまうため）
  unique (carrier, service, payment, effective_from)
);

-- 前の版のこの migration を当てていたときのために、列と制約をそろえ直す
alter table public.inventory_shipping_tariffs add column if not exists effective_to date;
alter table public.inventory_shipping_tariffs
  add column if not exists source_meta jsonb not null default '{}'::jsonb;
alter table public.inventory_shipping_tariffs
  drop constraint if exists inventory_shipping_tariffs_carrier_service_payment_rate_stat_key;

comment on table public.inventory_shipping_tariffs is
  '配送会社の運賃表。1行＝1つの版（effective_from で識別）。
   rates は**税別**で、税込は tax_rate から出す。
   rate_status は版の識別子ではなく状態だけを表す
   （provisional＝過去資料・暫定／contract＝現行契約）。
   新しい版は**別の行として足す**。古い版は消さずに残し、いつどの表で計算したかを追えるようにする。';
comment on column public.inventory_shipping_tariffs.effective_from is
  'この運賃表がいつからのものか。版の識別子で、同じ 配送会社×便×支払 では重複しない。';
comment on column public.inventory_shipping_tariffs.effective_to is
  'いつまでのものか。まだ決まっていなければ NULL。';
comment on column public.inventory_shipping_tariffs.source_meta is
  '元資料の注意書き（沖縄・離島・着払など）と、サイズごとの重量上限。価格計算には使わないが、
   重量が分かっているときに上限を超えていないか確かめるために持つ。';

-- 同じ 配送会社×便×支払 で「使う表」は1つだけ
create unique index if not exists inventory_shipping_tariffs_active_idx
  on public.inventory_shipping_tariffs (carrier, service, payment) where active;

drop trigger if exists inventory_shipping_tariffs_touch on public.inventory_shipping_tariffs;
create trigger inventory_shipping_tariffs_touch before update on public.inventory_shipping_tariffs
  for each row execute function public.inv_touch();

alter table public.inventory_shipping_tariffs enable row level security;
drop policy if exists inventory_shipping_tariffs_read on public.inventory_shipping_tariffs;
create policy inventory_shipping_tariffs_read on public.inventory_shipping_tariffs
  for select to authenticated using (public.inv_role() in ('admin','member','viewer'));
grant select on public.inventory_shipping_tariffs to authenticated;

-- ------------------------------------------------------------
-- 60-2) いただいた運賃表を「暫定」として入れる
--
--     過去の契約資料なので rate_status = 'provisional'。
--     すでに同じ行があれば中身は書き換えない（担当者が直したものを消さない）。
-- ------------------------------------------------------------
insert into public.inventory_shipping_tariffs
  (carrier, service, payment, rate_status, label, source_note, effective_from, effective_to,
   tax_rate, active, sizes, regions, rates, excluded, source_meta)
values (
  'sagawa', '陸便', '元払', 'provisional',
  '佐川急便 陸便・元払（2018-05-01〜2019-04-30）',
  '過去の契約資料（20260924_13132539-000_rikubin_tekiyo.pdf）から取り込み。現行契約の表が確認できたら新しい版として足す。',
  '2018-05-01'::date, '2019-04-30'::date,
  0.10, true,
  '["60","80","100","140","160","170","180","200","220","240","260"]'::jsonb,
  '{"熊本":"南九州","宮崎":"南九州","鹿児島":"南九州","福岡":"北九州","佐賀":"北九州","長崎":"北九州","大分":"北九州","徳島":"四国","香川":"四国","愛媛":"四国","高知":"四国","鳥取":"中国","島根":"中国","岡山":"中国","広島":"中国","山口":"中国","滋賀":"関西","京都":"関西","大阪":"関西","兵庫":"関西","奈良":"関西","和歌山":"関西","富山":"北陸","石川":"北陸","福井":"北陸","岐阜":"東海","静岡":"東海","愛知":"東海","三重":"東海","新潟":"信越","長野":"信越","茨城":"関東","栃木":"関東","群馬":"関東","埼玉":"関東","千葉":"関東","東京":"関東","神奈川":"関東","山梨":"関東","宮城":"南東北","山形":"南東北","福島":"南東北","青森":"北東北","岩手":"北東北","秋田":"北東北","北海道":"北海道"}'::jsonb,
  '{"60":{"南九州":880,"北九州":880,"四国":800,"中国":720,"関西":640,"北陸":560,"東海":560,"信越":560,"関東":560,"南東北":560,"北東北":640,"北海道":880},"80":{"南九州":1080,"北九州":1080,"四国":1000,"中国":920,"関西":840,"北陸":760,"東海":760,"信越":760,"関東":760,"南東北":760,"北東北":840,"北海道":1080},"100":{"南九州":1330,"北九州":1330,"四国":1250,"中国":1170,"関西":1090,"北陸":1010,"東海":1010,"信越":1010,"関東":1010,"南東北":1010,"北東北":1090,"北海道":1330},"140":{"南九州":1670,"北九州":1670,"四国":1590,"中国":1510,"関西":1430,"北陸":1350,"東海":1350,"信越":1350,"関東":1350,"南東北":1350,"北東北":1430,"北海道":1670},"160":{"南九州":2280,"北九州":2280,"四国":2180,"中国":2080,"関西":1980,"北陸":1880,"東海":1880,"信越":1880,"関東":1880,"南東北":1880,"北東北":1980,"北海道":2280},"170":{"南九州":3600,"北九州":3300,"四国":3100,"中国":3100,"関西":2850,"北陸":2850,"東海":2850,"信越":2850,"関東":2200,"南東北":2900,"北東北":3100,"北海道":3600},"180":{"南九州":4000,"北九州":3650,"四国":3400,"中国":3400,"関西":3100,"北陸":3100,"東海":3100,"信越":3100,"関東":2450,"南東北":3200,"北東北":3400,"北海道":4050},"200":{"南九州":5000,"北九州":4550,"四国":4150,"中国":4150,"関西":3800,"北陸":3800,"東海":3800,"信越":3800,"関東":2950,"南東北":3900,"北東北":4150,"北海道":5000},"220":{"南九州":5950,"北九州":5400,"四国":4950,"中国":4950,"関西":4450,"北陸":4450,"東海":4450,"信越":4450,"関東":3450,"南東北":4600,"北東北":4900,"北海道":6350},"240":{"南九州":7900,"北九州":7100,"四国":6450,"中国":6450,"関西":5800,"北陸":5800,"東海":5800,"信越":5800,"関東":4450,"南東北":6000,"北東北":6450,"北海道":7950},"260":{"南九州":9850,"北九州":8800,"四国":8000,"中国":8000,"関西":7150,"北陸":7150,"東海":7150,"信越":7150,"関東":5450,"南東北":7400,"北東北":8000,"北海道":9950}}'::jsonb,
  '{"沖縄":"別途料金のため自動計算しません。要確認","離島":"別途実費のため自動計算しません。要確認","着払":"正規運賃扱いのため自動計算しません。要確認","即日配送":"正規運賃扱いのため自動計算しません。要確認","夜間割増":"正規運賃扱いのため自動計算しません。要確認"}'::jsonb,
  '{"notes":{"沖縄":"別途料金","離島":"別途実費","着払":"正規運賃","即日":"正規運賃","夜間割増":"正規運賃","消費税":"別途","重量上限":"50kg","サイズ上限":"260","前提個数":"月間250個を前提","高額品":"30万円以上の商品は佐川へ連絡"},"size_weight_kg":{"60":2,"80":5,"100":10,"140":20,"160":30,"170":50},"max_weight_kg":50,"max_size":"260"}'::jsonb)
on conflict (carrier, service, payment, effective_from) do nothing;

-- ------------------------------------------------------------
-- 60-3) 運賃表を入れ替える
--
--     現行契約の表が来たら、これで入れて activate で切り替える。
--     形がおかしいものは受け取らない（表がずれたまま値段を出さないため）。
-- ------------------------------------------------------------
create or replace function public.inv_shipping_tariff_set(
  p_doc jsonb
) returns public.inventory_shipping_tariffs
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  r public.inventory_shipping_tariffs;
  k text;
  v jsonb;
  sz text;
  n  int;
begin
  if not public.inv_is_admin() then
    raise exception '運賃表は管理者だけが変えられます';
  end if;
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' then
    raise exception '運賃表は { } の形で渡してください';
  end if;
  foreach k in array array['carrier','service','payment','rate_status','effective_from',
                           'sizes','regions','rates'] loop
    if not (p_doc ? k) then raise exception '% がありません', k; end if;
  end loop;
  -- 版は effective_from で決まる。無いと古い表を上書きしてしまう
  if (p_doc ->> 'effective_from') is null or (p_doc ->> 'effective_from') = '' then
    raise exception 'effective_from（いつからの表か）を入れてください';
  end if;
  if p_doc ? 'effective_to' and (p_doc ->> 'effective_to') is not null
     and (p_doc ->> 'effective_to') <> ''
     and (p_doc ->> 'effective_to')::date < (p_doc ->> 'effective_from')::date then
    raise exception 'effective_to は effective_from より後にしてください';
  end if;
  if (p_doc ->> 'rate_status') not in ('provisional', 'contract') then
    raise exception 'rate_status は provisional か contract です（いまは %）', p_doc ->> 'rate_status';
  end if;
  if p_doc ? 'tax_rate' and ((p_doc ->> 'tax_rate')::numeric < 0 or (p_doc ->> 'tax_rate')::numeric >= 1) then
    raise exception '税率は0以上1未満で入れてください（0.10 で10%%）';
  end if;
  if jsonb_typeof(p_doc -> 'sizes') <> 'array' or jsonb_array_length(p_doc -> 'sizes') = 0 then
    raise exception 'sizes は1つ以上の配列で入れてください';
  end if;

  -- サイズごとに、地域と金額がそろっているか
  n := 0;
  for sz in select jsonb_array_elements_text(p_doc -> 'sizes') loop
    if not (p_doc -> 'rates' ? sz) then
      raise exception 'サイズ % の運賃がありません', sz;
    end if;
    for k, v in select * from jsonb_each(p_doc -> 'rates' -> sz) loop
      if jsonb_typeof(v) <> 'number' or (v)::numeric < 0 then
        raise exception 'サイズ % の % の運賃は0以上の数で入れてください', sz, k;
      end if;
      n := n + 1;
    end loop;
  end loop;
  if n = 0 then raise exception '運賃が1つも入っていません'; end if;

  -- 都道府県 → 地域。行き先の地域が運賃表に無いと、あとで黙って計算できなくなる
  for k, v in select * from jsonb_each(p_doc -> 'regions') loop
    if jsonb_typeof(v) <> 'string' then
      raise exception '都道府県「%」の地域は文字で入れてください', k;
    end if;
    if not (p_doc -> 'rates' -> (p_doc -> 'sizes' ->> 0) ? (v #>> '{}')) then
      raise exception '地域「%」（%）の運賃が表にありません', v #>> '{}', k;
    end if;
  end loop;

  -- 新しい版は**別の行**として足す。古い版は消さず、上書きもしない。
  -- 同じ effective_from で入れ直したときだけ、その版を直す。
  insert into public.inventory_shipping_tariffs
    (carrier, service, payment, rate_status, label, source_note,
     effective_from, effective_to, tax_rate, sizes, regions, rates, excluded, source_meta)
  values (
    p_doc ->> 'carrier', p_doc ->> 'service', p_doc ->> 'payment', p_doc ->> 'rate_status',
    p_doc ->> 'label', p_doc ->> 'source_note',
    (p_doc ->> 'effective_from')::date, nullif(p_doc ->> 'effective_to', '')::date,
    coalesce((p_doc ->> 'tax_rate')::numeric, 0.10),
    p_doc -> 'sizes', p_doc -> 'regions', p_doc -> 'rates',
    coalesce(p_doc -> 'excluded', '{}'::jsonb),
    coalesce(p_doc -> 'source_meta', '{}'::jsonb))
  on conflict (carrier, service, payment, effective_from) do update
    set rate_status = excluded.rate_status, label = excluded.label,
        source_note = excluded.source_note, effective_to = excluded.effective_to,
        tax_rate = excluded.tax_rate, sizes = excluded.sizes, regions = excluded.regions,
        rates = excluded.rates, excluded = excluded.excluded, source_meta = excluded.source_meta
  returning * into r;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'shipping', r.id::text, coalesce(r.label, r.carrier),
          '運賃表を入れた', '—',
          format('%s %s %s／%s〜%s（%s）サイズ%s件',
                 r.carrier, r.service, r.payment, r.effective_from,
                 coalesce(r.effective_to::text, '—'), r.rate_status, jsonb_array_length(r.sizes)));
  return r;
end $$;

comment on function public.inv_shipping_tariff_set is
  '運賃表の**版を足す**。管理者だけ。版は effective_from で決まり、
   新しい版を入れても古い版は消さないし上書きもしない（同じ effective_from のときだけ直す）。
   表の形が合わないものは受け取らない。
   入れただけでは使われない（inv_shipping_tariff_activate で切り替える）。';

-- ------------------------------------------------------------
-- 60-4) 使う運賃表を切り替える
-- ------------------------------------------------------------
create or replace function public.inv_shipping_tariff_activate(
  p_id bigint
) returns public.inventory_shipping_tariffs
language plpgsql security definer set search_path = public, pg_catalog as $$
declare r public.inventory_shipping_tariffs;
begin
  if not public.inv_is_admin() then
    raise exception '運賃表は管理者だけが変えられます';
  end if;
  select * into r from public.inventory_shipping_tariffs where id = p_id;
  if not found then raise exception '運賃表が見つかりません（%）', p_id; end if;

  update public.inventory_shipping_tariffs set active = false
   where carrier = r.carrier and service = r.service and payment = r.payment and id <> p_id;
  update public.inventory_shipping_tariffs set active = true
   where id = p_id returning * into r;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'shipping', r.id::text, coalesce(r.label, r.carrier),
          '使う運賃表を切り替えた', '—', format('%s（%s）', coalesce(r.label, r.carrier), r.rate_status));
  return r;
end $$;

comment on function public.inv_shipping_tariff_activate is
  'この運賃表を使う、に切り替える。同じ 配送会社×便×支払 のほかの表は使わなくなる。管理者だけ。';

-- ------------------------------------------------------------
-- 60-5) 配送サイズの検証を、運賃表のサイズに合わせる
--
--     運賃表を差し替えるとサイズも変わるので、決め打ちの一覧をやめる。
--     表が無いときだけ、これまでの一覧で受ける。
-- ------------------------------------------------------------
create or replace function public.inv_product_shipping_size_set(
  p_code text,
  p_size text default null
) returns public.inventory_products
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_size text := nullif(btrim(coalesce(p_size, '')), '');
  v_ok   jsonb;
  before text;
  r      public.inventory_products;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if v_size is not null and v_size <> 'custom' then
    select sizes into v_ok from public.inventory_shipping_tariffs
     where carrier = 'sagawa' and active limit 1;
    if v_ok is null then
      v_ok := '["60","80","100","120","140","160","170","180","200"]'::jsonb;
    end if;
    if not (v_ok ? v_size) then
      raise exception '運賃表にない配送サイズです：%（%、または custom）',
        v_size, (select string_agg(x, '/') from jsonb_array_elements_text(v_ok) as t(x));
    end if;
  end if;

  select shipping_size into before from public.inventory_products where code = p_code;
  update public.inventory_products set shipping_size = v_size
   where code = p_code returning * into r;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code, coalesce(nullif(r.name, ''), r.code),
          '配送サイズを決めた', coalesce(before, '未設定'), coalesce(v_size, '未設定'));
  return r;
end $$;

comment on function public.inv_product_shipping_size_set is
  '商品の配送サイズを決める。使える値は、いま使っている運賃表のサイズと custom。
   送料の金額はここでは持たない。在庫も価格も変更しない。';

-- ------------------------------------------------------------
-- 60-6) 権限
-- ------------------------------------------------------------
revoke all on function public.inv_shipping_tariff_set(jsonb) from public, anon;
grant execute on function public.inv_shipping_tariff_set(jsonb) to authenticated;
revoke all on function public.inv_shipping_tariff_activate(bigint) from public, anon;
grant execute on function public.inv_shipping_tariff_activate(bigint) to authenticated;
revoke all on function public.inv_product_shipping_size_set(text, text) from public, anon;
grant execute on function public.inv_product_shipping_size_set(text, text) to authenticated;




-- ============================================================
-- 61) 月次棚卸を「帳簿在庫と現物の照合」にする
--
--     対象（帳簿在庫）は inv_start_stocktake が status in ('在庫','出品中') で並べる。
--     棚卸の途中で帳簿に無い現物を読んだら、inv_item_op が expected=false で足す。
--     数え方は
--       帳簿在庫   expected = true
--       確認済み   expected = true  かつ checked_at is not null
--       未確認     帳簿在庫 − 確認済み
--       帳簿外現物 expected = false かつ checked_at is not null
--     stocktake_items の全件数を帳簿在庫として使わないこと。
-- ============================================================

-- ------------------------------------------------------------
-- 61-1) 棚卸確認を取り消す
--
--    画面から checked_at を直接 NULL にするだけでは足りない。
--      inventory_stocktake_items.checked_at  … 今回の確認
--      inventory_items.last_checked_at       … 最後に現物を見た日時（在庫一覧の色）
--      inventory_transactions                … 履歴
--    の3つが噛み合っているので、サーバー側でまとめて整合を取る。
--
--    last_checked_at の戻し方
--      inv_item_op は同じトランザクションの中で
--        update items set last_checked_at = now()
--        insert into transactions (occurred_at default now())
--      を実行する。plpgsql の now() はトランザクション開始時刻なので、
--      この2つは必ず同じ値になる。よって「今回の棚卸が始まる前の
--      いちばん新しい 棚卸確認 履歴の occurred_at」が、そのまま
--      前回の last_checked_at になる。
--      履歴が無ければ NULL（＝未確認）に戻す。
--
--    履歴は消さない。取り消したことも '棚卸確認取消' として追記する。
--    在庫の状態・在庫数・出品状態・8RENTは変えない。
-- ------------------------------------------------------------
create or replace function public.inv_stocktake_uncheck(
  p_stocktake_id bigint,
  p_item_id      text
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  st     public.inventory_stocktakes;
  it     public.inventory_items;
  v_row  public.inventory_stocktake_items;
  v_prev timestamptz;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into st from public.inventory_stocktakes where id = p_stocktake_id;
  if not found then
    raise exception '棚卸が見つかりません（%）', p_stocktake_id;
  end if;
  if st.status <> 'open' then
    raise exception '終了した棚卸は直せません';
  end if;

  select * into v_row from public.inventory_stocktake_items
   where stocktake_id = p_stocktake_id and item_id = p_item_id
   for update;
  if not found then
    raise exception 'この棚卸の対象ではありません（%）', p_item_id;
  end if;
  if v_row.checked_at is null then
    raise exception 'まだ確認していません（%）', p_item_id;
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  select max(t.occurred_at) into v_prev
    from public.inventory_transactions t
   where t.ref_kind = 'item'
     and t.ref_id   = p_item_id
     and t.action   = '棚卸確認'
     and t.occurred_at < st.started_at;

  update public.inventory_stocktake_items
     set checked_at = null
   where stocktake_id = p_stocktake_id and item_id = p_item_id;

  update public.inventory_items
     set last_checked_at = v_prev
   where id = p_item_id
  returning * into it;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '棚卸確認取消',
          to_char(v_row.checked_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI') || ' の確認',
          case when v_prev is null
               then '未確認（それ以前の棚卸確認の記録なし）'
               else '前回 ' || to_char(v_prev at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI')
          end);

  return it;
end $$;

comment on function public.inv_stocktake_uncheck is
  '実施中の棚卸で付けた「確認済み」を取り消す。checked_at を NULL に戻し、
   inventory_items.last_checked_at を今回の棚卸が始まる前の最新の棚卸確認へ戻す
   （記録が無ければ NULL）。''棚卸確認取消'' を履歴に追記する。履歴は消さない。
   在庫の状態・在庫数・出品状態・8RENT・価格は変えない。';


-- ------------------------------------------------------------
-- 61-2) 月次の照合結果（読み取り専用・1棚卸1行）
--
--    ブラウザで inventory_stocktake_items を何千行も読んで数えなくて済むように、
--    集計はDB側でやる。新しい列は作らず、既存の3つのテーブルだけで組み立てる。
--
--      帳簿在庫   expected = true
--      確認済み   expected = true  かつ checked_at is not null
--      未確認     帳簿在庫 − 確認済み
--      帳簿外現物 expected = false かつ checked_at is not null
--      不明へ変更 棚卸の期間中（started_at 〜 closed_at）に status を不明にした回数
--
--    「不明へ変更」は期間で切った近似。履歴に棚卸IDを持たせていないので、
--    棚卸中に別の理由で不明にしたものも混ざる。画面ではその旨を書く。
-- ------------------------------------------------------------
drop view if exists public.inv_stocktake_summary;
create view public.inv_stocktake_summary as
select
  s.id                as stocktake_id,
  s.started_at,
  s.closed_at,
  s.status,
  s.actor,
  s.scope_location_id,
  c.book::integer     as book_count,
  c.checked::integer  as checked_count,
  (c.book - c.checked)::integer as unchecked_count,
  c.extra::integer    as extra_count,
  u.unknown_count::integer      as unknown_count
from public.inventory_stocktakes s
left join lateral (
  select
    count(*) filter (where i.expected)                                  as book,
    count(*) filter (where i.expected and i.checked_at is not null)      as checked,
    count(*) filter (where not i.expected and i.checked_at is not null)  as extra
  from public.inventory_stocktake_items i
  where i.stocktake_id = s.id
) c on true
left join lateral (
  select count(*) as unknown_count
  from public.inventory_transactions t
  where t.ref_kind = 'item'
    and t.action   = '状態変更'
    and (t.after_value = '不明' or t.after_value like '不明／%')
    and t.occurred_at >= s.started_at
    and t.occurred_at <= coalesce(s.closed_at, now())
) u on true;

comment on view public.inv_stocktake_summary is
  '棚卸1回を1行にまとめた照合結果。帳簿在庫・確認済み・未確認・帳簿外現物・
   期間中に不明へ変更した数を返す。社内用（anonには出さない）。';


-- ------------------------------------------------------------
-- 61-3) 権限
--
--    2026-10-01-rpc-permission-hardening.sql の一括配り直しは
--    「そのとき存在した関数」に対する1回きりの処理なので、
--    あとから足した関数には効かない。既定では PUBLIC に EXECUTE が付き
--    anon からも呼べてしまうため、ここで明示的に落として配り直す。
-- ------------------------------------------------------------
revoke all on function public.inv_stocktake_uncheck(bigint, text) from public, anon, service_role;
grant execute on function public.inv_stocktake_uncheck(bigint, text) to authenticated;

revoke all on public.inv_stocktake_summary from public, anon;
grant select on public.inv_stocktake_summary to authenticated;


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
