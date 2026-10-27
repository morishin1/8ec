-- ============================================================
-- 月別在庫（月末在庫の復元・月次確定）
--
--   いまの在庫一覧は「今この瞬間」しか見られない。
--   毎月の棚卸しのために「その月の末日時点で、どの商品がどこに何点あったか」を
--   出せるようにする。
--
--   ■ ここで決めること（画面もダウンロードも、必ずこの決まりを通す）
--
--   1) 月末の瞬間は **日本時間（Asia/Tokyo）の、翌月1日 00:00 の直前**。
--      実装は半開区間 [当月1日 00:00 JST, 翌月1日 00:00 JST) で、
--      右端の瞬間そのものを「月末時点」として使う。
--      境界やタイムゾーンの取り違えを起こさないため、日付の文字列比較はしない。
--
--   2) 「在庫として数えるもの」は **売却済・廃棄 以外のすべて**。
--      在庫・出品中・予約中・販売予約・社内使用・貸出中・修理中・故障・紛失・不明。
--      管理者ホームの経営数値（inv_dashboard_stats）とまったく同じ決まりで、
--      「手元に持っているもの」を数える。
--      すぐ売れる台数（在庫・出品中）とは別物なので、画面では別の名前で出す。
--
--   3) 月末の状態は **いまの inventory_items を起点に、履歴を逆再生して**求める。
--      前から再生するのではなく後ろから巻き戻すのは、いまの値が正本で、
--      最初の状態を知らなくてよいから。
--      inventory_transactions は追記のみ（UPDATE/DELETE の権限を誰にも渡していない）で、
--      状態を変える経路はすべて before_value に「変える前の状態」を残している。
--
--   4) **復元できないものを「確定在庫」として出さない。**
--      下の3つは、推測で埋めずに「復元不可」として件数で知らせる。
--        ・レンタルの履歴（action が 'レンタル…'）は before_value が
--          申込の状態であって個体の状態ではないので、前の状態を読み取れない
--        ・保管場所の履歴は ID ではなく経路の文字列（例 '柏 / 倉庫'）なので、
--          保管場所を改名すると昔の経路を引けなくなる
--        ・個体が物理削除されると、いまの在庫表に行が残らないので巻き戻せない
--          （履歴だけは残るので「履歴にあるのに現存しない」件数は出せる）
--
--   5) 確定した月は、**あとから売れても動かさない。**
--      確定時の明細をそのまま別の表へ写し取り、以後はそれを読む。
--      訂正するときは版（revision）を上げ、前の版も履歴も消さない。
--
--   ■ DBの変更
--     新しい表3つ（月次確定のヘッダ・個体明細・数量品明細）と、読み取り用の関数。
--     既存の表・関数・トリガーには一切手を入れない。
--     在庫や売上を書き換える処理はこの migration には無い。
-- ============================================================


-- ------------------------------------------------------------
-- 1) 月の区切り（日本時間）
-- ------------------------------------------------------------

/* 'YYYY-MM' を受けて、その月の初日 00:00 JST を返す。
   形が違えば黙って別の月を返さず、その場で止める。 */
create or replace function public.inv_month_start_at(p_ym text)
returns timestamptz
language plpgsql immutable as $$
begin
  if p_ym !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '月の指定は YYYY-MM で入れてください（%）', coalesce(p_ym, 'null');
  end if;
  -- timestamp（タイムゾーンなし）として作ってから JST とみなして timestamptz にする
  return ((p_ym || '-01')::timestamp) at time zone 'Asia/Tokyo';
end $$;

/* その月の「月末時点」の瞬間。**翌月1日 00:00 JST** を返し、
   使うほうは必ず `occurred_at < この値` の半開区間で比べる。

   **1か月進めるのは「日本時間の暦の上で」。**
   timestamptz（UTCの瞬間）のまま + interval '1 month' をすると、
   2026-10-01 00:00 JST は UTC では 9月30日 15:00 なので、
   1か月足すと 10月30日 15:00 ＝ 10月31日 00:00 JST になってしまい、
   月末の1日ぶんがまるごと落ちる。先に暦を進めてから JST とみなす。 */
create or replace function public.inv_month_end_at(p_ym text)
returns timestamptz
language plpgsql immutable as $$
begin
  perform public.inv_month_start_at(p_ym);        -- 形の点検（違えばここで止まる）
  return (((p_ym || '-01')::timestamp + interval '1 month') at time zone 'Asia/Tokyo');
end $$;

/* いま（JST）の 'YYYY-MM'。未来月を出さないための上限に使う */
create or replace function public.inv_month_now()
returns text
language sql stable as $$
  select to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM')
$$;

/* 「手元に持っている」とみなす状態か。**この1か所だけで決める。**
   在庫一覧の IN_STOCK（在庫・出品中＝すぐ売れるもの）とは別の、
   経営数値と同じ「保有しているか」の判定。 */
create or replace function public.inv_month_held(p_status text)
returns boolean
language sql immutable as $$
  select coalesce(p_status, '') not in ('売却済', '廃棄')
$$;

comment on function public.inv_month_held(text) is
  '月別在庫で「保有している」と数える状態か（売却済・廃棄 以外すべて）。
   経営数値 inv_dashboard_stats と同じ決まり。すぐ売れる台数（在庫・出品中）とは別物。';


-- ------------------------------------------------------------
-- 2) 月末時点の個体を復元する（逆再生）
--
--    p_at（＝翌月1日 00:00 JST）の**直前**に、どの個体がどの状態で
--    どこにあったかを返す。いまの inventory_items が起点。
--
--    返すもの
--      item_id      管理番号
--      status       その時点の状態
--      location_id  その時点の保管場所（引けなければ null）
--      held         その時点で保有していたか（売却済・廃棄 以外）
--      ok           復元できたか。false なら数えずに「復元不可」として件数で出す
--      why          ok=false の理由
-- ------------------------------------------------------------

/* 履歴の before_value から状態だけを取り出す。
   '貸出中（山田 太郎）' のように括弧で補足が付くので、括弧の前だけを見る。
   知らない言葉だったら**勝手に直さず null を返す**（呼ぶ側で復元不可にする）。 */
create or replace function public.inv_month_status_of(p_text text)
returns text
language sql immutable as $$
  select case
    when btrim(split_part(coalesce(p_text, ''), '（', 1)) = any (array[
      '在庫','出品中','予約中','販売予約','社内使用','貸出中','修理中','故障','紛失','売却済','廃棄','不明'])
    then btrim(split_part(p_text, '（', 1))
    else null end
$$;

/* 状態を変える履歴のうち、**before_value が「変える前の個体の状態」である**もの。
   ここに無い action は状態を変えないか、前の状態を読み取れないもの。 */
create or replace function public.inv_month_rewind_actions()
returns text[]
language sql immutable as $$
  select array[
    '貸出',          -- before = 変える前の状態
    '返却',          -- before = '貸出中（利用者）'
    '社内使用',      -- before = 変える前の状態
    '売却',          -- before = 変える前の状態
    '売却取消',      -- before = '売却済'
    '予約解除',      -- before = '販売予約'
    '状態変更',      -- before = 変える前の状態
    '廃棄',          -- before = 変える前の状態
    '予約',          -- before = '在庫'
    '販売予約',      -- before = '在庫'
    '棚卸差異確定',  -- before = 変える前の状態
    '棚卸差異確定取消'  -- before = '不明'
  ]
$$;

create or replace function public.inv_month_items_at(p_at timestamptz)
returns table (
  item_id      text,
  status       text,
  location_id  text,
  held         boolean,
  ok           boolean,
  why          text
)
language sql stable security invoker set search_path = public as $$
  with
  -- 保管場所の経路 → ID。同じ経路が2つ以上あるとどちらか分からないので使わない
  loc as (
    select public.inv_location_path(id) as path, min(id) as id, count(*) as n
      from public.inventory_locations
     group by public.inv_location_path(id)
  ),
  -- その個体が在庫表に載った瞬間。履歴の「登録」が正、無ければ created_at
  reg as (
    select ref_id, min(occurred_at) as at
      from public.inventory_transactions
     where ref_kind = 'item' and action = '登録'
     group by ref_id
  ),
  -- p_at 以降で**最初に状態を変えた**履歴。その before_value が p_at 時点の状態
  st as (
    select distinct on (ref_id) ref_id, before_value
      from public.inventory_transactions
     where ref_kind = 'item'
       and occurred_at >= p_at
       and action = any (public.inv_month_rewind_actions())
     order by ref_id, occurred_at, id
  ),
  -- p_at 以降に、状態を変えたのに前の状態を読み取れない履歴があるか
  blocked as (
    select distinct ref_id
      from public.inventory_transactions
     where ref_kind = 'item'
       and occurred_at >= p_at
       and action like 'レンタル%'
  ),
  -- p_at 以降で**最初の移動**。その before_value（経路）が p_at 時点の保管場所
  mv as (
    select distinct on (ref_id) ref_id, before_value
      from public.inventory_transactions
     where ref_kind = 'item'
       and occurred_at >= p_at
       and action = '移動'
     order by ref_id, occurred_at, id
  )
  select
    i.id,
    coalesce(public.inv_month_status_of(st.before_value), i.status)        as status,
    case when mv.ref_id is null then i.location_id else l.id end           as location_id,
    public.inv_month_held(coalesce(public.inv_month_status_of(st.before_value), i.status)) as held,
    (blocked.ref_id is null)
      and (st.ref_id is null or public.inv_month_status_of(st.before_value) is not null)
      and (mv.ref_id is null or (l.id is not null and l.n = 1))            as ok,
    case
      when blocked.ref_id is not null then 'レンタルの履歴は前の状態を残していないため復元できません'
      when st.ref_id is not null and public.inv_month_status_of(st.before_value) is null
        then '履歴の状態を読み取れません（' || coalesce(st.before_value, '空') || '）'
      when mv.ref_id is not null and l.id is null
        then '当時の保管場所「' || coalesce(mv.before_value, '空') || '」がいまの保管場所に見つかりません'
      when mv.ref_id is not null and l.n > 1
        then '当時の保管場所「' || mv.before_value || '」と同じ名前の場所が複数あります'
      else null
    end                                                                    as why
  from public.inventory_items i
  left join reg     on reg.ref_id = i.id
  left join st      on st.ref_id  = i.id
  left join blocked on blocked.ref_id = i.id
  left join mv      on mv.ref_id  = i.id
  left join loc l   on l.path     = mv.before_value
  -- その瞬間より前に在庫表へ載っていたものだけ
  where coalesce(reg.at, i.created_at) < p_at
$$;

comment on function public.inv_month_items_at(timestamptz) is
  'その瞬間の直前に保有していた個体を、いまの在庫表から履歴を逆再生して復元する。
   復元できないものは ok=false と why で返す。推測では埋めない。';


/* 履歴には出てくるのに、いまの在庫表に行が無い個体。
   個体を物理削除（inv_delete_products / inv_wipe_inventory）すると起きる。
   その月の在庫に入っていたはずなので、**黙って無視せず件数で知らせる。** */
create or replace function public.inv_month_lost_at(p_at timestamptz)
returns table (item_id text, last_action text, last_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select distinct on (t.ref_id) t.ref_id, t.action, t.occurred_at
    from public.inventory_transactions t
   where t.ref_kind = 'item'
     and t.occurred_at < p_at
     and not exists (select 1 from public.inventory_items i where i.id = t.ref_id)
   order by t.ref_id, t.occurred_at desc, t.id desc
$$;


-- ------------------------------------------------------------
-- 3) 月末時点の数量管理品を復元する
--
--    数量は入庫・出庫・棚卸調整の履歴が before_value に「変える前の数」を
--    数字で残しているので、個体より素直に巻き戻せる。
-- ------------------------------------------------------------

create or replace function public.inv_month_products_at(p_at timestamptz)
returns table (product_code text, qty integer, ok boolean, why text)
language sql stable security invoker set search_path = public as $$
  with
  reg as (
    select ref_id, min(occurred_at) as at
      from public.inventory_transactions
     where ref_kind = 'product' and action = '登録'
     group by ref_id
  ),
  q as (
    select distinct on (ref_id) ref_id, before_value
      from public.inventory_transactions
     where ref_kind = 'product'
       and occurred_at >= p_at
       and action in ('入庫', '出庫', '棚卸調整')
     order by ref_id, occurred_at, id
  )
  select
    p.code,
    case when q.ref_id is null then coalesce(p.qty, 0)
         when q.before_value ~ '^-?[0-9]+$' then q.before_value::integer
         else null end                                        as qty,
    (q.ref_id is null or q.before_value ~ '^-?[0-9]+$')        as ok,
    case when q.ref_id is not null and q.before_value !~ '^-?[0-9]+$'
         then '履歴の数量を読み取れません（' || coalesce(q.before_value, '空') || '）'
         else null end                                        as why
  from public.inventory_products p
  left join reg on reg.ref_id = p.code
  left join q   on q.ref_id   = p.code
  where p.kind <> 'individual'
    and coalesce(reg.at, p.created_at) < p_at
$$;


-- ------------------------------------------------------------
-- 4) 月次確定を保存する表
--
--    確定したら、そのときの明細をそのまま写し取る。
--    あとで売れても移動しても、この表は動かない。
--    訂正は版（revision）を上げる。**前の版も履歴も消さない。**
-- ------------------------------------------------------------

create table if not exists public.inventory_month_closes (
  ym            text    not null,
  revision      integer not null default 1,
  confirmed_by  text,
  confirmed_at  timestamptz not null default now(),
  reason        text,                                   -- 訂正のときの理由（版2以降）
  note          text,
  basis         jsonb   not null default '{}'::jsonb,   -- 算出根拠（在庫の定義・件数・復元できなかった件数）
  primary key (ym, revision),
  constraint inventory_month_closes_ym_chk check (ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

comment on table public.inventory_month_closes is
  '月次確定のヘッダ。1つの月に版（revision）が積み上がる。最新版が「いまの確定値」。
   版は増えるだけで、前の版は消さない（訂正の跡をたどれるようにするため）。';

create table if not exists public.inventory_month_items (
  ym            text    not null,
  revision      integer not null,
  item_id       text    not null,
  name          text,
  product_code  text,
  model         text,
  maker         text,
  category_id   text,
  serial        text,
  purchased_on  date,
  location_id   text,
  location_path text,
  status        text,
  held          boolean not null,
  cost          numeric,
  primary key (ym, revision, item_id),
  foreign key (ym, revision) references public.inventory_month_closes (ym, revision) on delete cascade
);

comment on table public.inventory_month_items is
  '確定した月の個体明細。確定したときの姿をそのまま写したもの。
   商品名・型番は確定時点の値（さかのぼって直さない）。
   保管場所と状態は「その月末時点」のもの。';

create table if not exists public.inventory_month_products (
  ym           text    not null,
  revision     integer not null,
  product_code text    not null,
  name         text,
  model        text,
  maker        text,
  category_id  text,
  location_id  text,
  location_path text,
  qty          integer not null,
  unit_price   numeric,
  primary key (ym, revision, product_code),
  foreign key (ym, revision) references public.inventory_month_closes (ym, revision) on delete cascade
);

create index if not exists inventory_month_items_ym_idx
  on public.inventory_month_items (ym, revision, location_id);


-- ------------------------------------------------------------
-- 5) 権限
--
--    表は読むだけ渡す。書き込みは関数の中だけ（確定・訂正は管理者）。
--    匿名（anon）とサーバー鍵（service_role）には渡さない。
-- ------------------------------------------------------------

grant select on public.inventory_month_closes,
                public.inventory_month_items,
                public.inventory_month_products
  to authenticated;

revoke insert, update, delete on public.inventory_month_closes,
                                 public.inventory_month_items,
                                 public.inventory_month_products
  from authenticated, anon, service_role;

alter table public.inventory_month_closes   enable row level security;
alter table public.inventory_month_items    enable row level security;
alter table public.inventory_month_products enable row level security;

do $$
declare t text;
begin
  foreach t in array array['inventory_month_closes','inventory_month_items','inventory_month_products'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 6) 画面が読むもの
--
--    確定した月は**写し取った明細をそのまま読む**（二度と計算し直さない）。
--    確定していない月だけ、そのつど履歴から復元する。
--    どちらを読んだかは source で返すので、画面で「確定／暫定」を出し分けられる。
-- ------------------------------------------------------------

/* その月のいちばん新しい版。確定していなければ null */
create or replace function public.inv_month_revision(p_ym text)
returns integer
language sql stable security invoker set search_path = public as $$
  select max(revision) from public.inventory_month_closes where ym = p_ym
$$;

/* その月末時点の個体明細を**履歴から数え直す**。確定済みかどうかは見ない。
   月次確定・訂正はいつもこれを写し取る（前の版を写し直さない）。
   held=false（売却済・廃棄）は在庫ではないので返さない。 */
create or replace function public.inv_month_rebuild_rows(p_ym text)
returns table (
  item_id       text,
  name          text,
  product_code  text,
  model         text,
  maker         text,
  category_id   text,
  serial        text,
  purchased_on  date,
  location_id   text,
  location_path text,
  status        text,
  cost          numeric,
  source        text
)
language sql stable security invoker set search_path = public as $$
  select a.item_id, i.name, i.product_code, i.model, i.maker, i.category_id,
         i.serial, i.purchased_on, a.location_id,
         case when a.location_id is null then null else public.inv_location_path(a.location_id) end,
         a.status, i.cost,
         'rebuilt'::text
    from public.inv_month_items_at(public.inv_month_end_at(p_ym)) a
    join public.inventory_items i on i.id = a.item_id
   where a.held and a.ok
$$;

/* 画面が読むほう。**確定した月は写しをそのまま読み、二度と数え直さない。**
   未確定の月だけ、そのつど履歴から数え直す。 */
create or replace function public.inv_month_rows(p_ym text)
returns table (
  item_id       text,
  name          text,
  product_code  text,
  model         text,
  maker         text,
  category_id   text,
  serial        text,
  purchased_on  date,
  location_id   text,
  location_path text,
  status        text,
  cost          numeric,
  source        text
)
language sql stable security invoker set search_path = public as $$
  select m.item_id, m.name, m.product_code, m.model, m.maker, m.category_id,
         m.serial, m.purchased_on, m.location_id, m.location_path, m.status, m.cost,
         'confirmed'::text
    from public.inventory_month_items m
   where m.ym = p_ym
     and m.revision = public.inv_month_revision(p_ym)
     and m.held
  union all
  select r.* from public.inv_month_rebuild_rows(p_ym) r
   where public.inv_month_revision(p_ym) is null
$$;

/* その月末時点の数量管理品を**履歴から数え直す** */
create or replace function public.inv_month_rebuild_product_rows(p_ym text)
returns table (
  product_code  text,
  name          text,
  model         text,
  maker         text,
  category_id   text,
  location_id   text,
  location_path text,
  qty           integer,
  unit_price    numeric,
  source        text
)
language sql stable security invoker set search_path = public as $$
  select a.product_code, p.name, p.model, p.maker, p.category_id,
         p.location_id,
         case when p.location_id is null then null else public.inv_location_path(p.location_id) end,
         a.qty, p.unit_price, 'rebuilt'::text
    from public.inv_month_products_at(public.inv_month_end_at(p_ym)) a
    join public.inventory_products p on p.code = a.product_code
   where a.ok
$$;

/* 画面が読むほう。確定した月は写しをそのまま読む */
create or replace function public.inv_month_product_rows(p_ym text)
returns table (
  product_code  text,
  name          text,
  model         text,
  maker         text,
  category_id   text,
  location_id   text,
  location_path text,
  qty           integer,
  unit_price    numeric,
  source        text
)
language sql stable security invoker set search_path = public as $$
  select m.product_code, m.name, m.model, m.maker, m.category_id,
         m.location_id, m.location_path, m.qty, m.unit_price, 'confirmed'::text
    from public.inventory_month_products m
   where m.ym = p_ym and m.revision = public.inv_month_revision(p_ym)
  union all
  select r.* from public.inv_month_rebuild_product_rows(p_ym) r
   where public.inv_month_revision(p_ym) is null
$$;

/* 前月の 'YYYY-MM' */
create or replace function public.inv_month_prev(p_ym text)
returns text
language sql immutable as $$
  select to_char(public.inv_month_start_at(p_ym) at time zone 'Asia/Tokyo' - interval '1 month', 'YYYY-MM')
$$;


-- ------------------------------------------------------------
-- 7) 商品別・保管場所別の集計
--
--    当月入庫・当月出庫は**前月末と当月末の差**から出す。
--    こうすると `月末 = 前月末 + 入庫 − 出庫` が必ず成り立ち、
--    1つの出来事を二重に数えることがない。
--
--    倉庫間の移動は、個体の集合そのものは変わらないので
--    **全社の入庫・出庫には出てこない**（保管場所別にだけ現れる）。
-- ------------------------------------------------------------

create or replace function public.inv_month_by_product(p_ym text)
returns table (
  product_code text,
  name         text,
  model        text,
  maker        text,
  category_id  text,
  kind         text,
  prev_qty     integer,
  in_qty       integer,
  out_qty      integer,
  adj_qty      integer,
  end_qty      integer
)
language sql stable security invoker set search_path = public as $$
  with
  cur as (select * from public.inv_month_rows(p_ym)),
  prv as (select * from public.inv_month_rows(public.inv_month_prev(p_ym))),
  k as (
    select coalesce(c.product_code, p.product_code) as product_code,
           coalesce(c.item_id, p.item_id)           as item_id,
           (c.item_id is not null)                  as in_cur,
           (p.item_id is not null)                  as in_prv,
           coalesce(c.name,  p.name)                as name,
           coalesce(c.model, p.model)               as model,
           coalesce(c.maker, p.maker)               as maker,
           coalesce(c.category_id, p.category_id)   as category_id
      from cur c
      full outer join prv p on p.item_id = c.item_id
  ),
  -- 個体管理。入庫＝当月末にあって前月末に無かったもの、出庫はその逆
  ind as (
    select product_code,
           max(name) as name, max(model) as model, max(maker) as maker,
           max(category_id) as category_id,
           count(*) filter (where in_prv)                  as prev_qty,
           count(*) filter (where in_cur and not in_prv)    as in_qty,
           count(*) filter (where in_prv and not in_cur)    as out_qty,
           0                                                as adj_qty,
           count(*) filter (where in_cur)                   as end_qty
      from k
     group by product_code
  ),
  -- 数量管理。入庫・出庫・棚卸調整は、その月の履歴の増減をそのまま足す
  qmv as (
    select t.ref_id as code,
           -- 入庫・出庫の履歴は '50（+10）' '46（-4）' の形（括弧は全角）
           sum(case when t.action = '入庫'
                    then coalesce((regexp_match(t.after_value, '（\+([0-9]+)）'))[1]::integer, 0)
                    else 0 end)                                                     as in_qty,
           sum(case when t.action = '出庫'
                    then coalesce((regexp_match(t.after_value, '（-([0-9]+)）'))[1]::integer, 0)
                    else 0 end)                                                     as out_qty,
           -- 棚卸調整は before='数えるまえの数' after='数えた数（／備考）'
           sum(case when t.action = '棚卸調整'
                     and t.before_value ~ '^-?[0-9]+$'
                     and split_part(t.after_value, '／', 1) ~ '^-?[0-9]+$'
                    then split_part(t.after_value, '／', 1)::integer - t.before_value::integer
                    else 0 end)                                                     as adj_qty
      from public.inventory_transactions t
     where t.ref_kind = 'product'
       and t.occurred_at >= public.inv_month_start_at(p_ym)
       and t.occurred_at <  public.inv_month_end_at(p_ym)
     group by t.ref_id
  ),
  qty as (
    select c.product_code,
           c.name, c.model, c.maker, c.category_id,
           coalesce(p.qty, 0)        as prev_qty,
           coalesce(m.in_qty, 0)     as in_qty,
           coalesce(m.out_qty, 0)    as out_qty,
           coalesce(m.adj_qty, 0)    as adj_qty,
           c.qty                     as end_qty
      from public.inv_month_product_rows(p_ym) c
      left join public.inv_month_product_rows(public.inv_month_prev(p_ym)) p
             on p.product_code = c.product_code
      left join qmv m on m.code = c.product_code
  )
  select product_code, name, model, maker, category_id, '個体管理'::text,
         prev_qty::integer, in_qty::integer, out_qty::integer, adj_qty::integer, end_qty::integer
    from ind
  union all
  select product_code, name, model, maker, category_id, '数量管理'::text,
         prev_qty::integer, in_qty::integer, out_qty::integer, adj_qty::integer, end_qty::integer
    from qty
$$;

/* 保管場所別。**倉庫間の移動はここにだけ出る**ので、入出庫とは列を分ける。
   保管場所が入っていないものは黙って落とさず「未登録」としてまとめる。 */
create or replace function public.inv_month_by_location(p_ym text)
returns table (
  location_id   text,
  location_path text,
  prev_qty      integer,
  in_qty        integer,
  out_qty       integer,
  moved_in      integer,
  moved_out     integer,
  end_qty       integer
)
language sql stable security invoker set search_path = public as $$
  with
  cur as (select item_id, location_id from public.inv_month_rows(p_ym)),
  prv as (select item_id, location_id from public.inv_month_rows(public.inv_month_prev(p_ym))),
  j as (
    select coalesce(c.item_id, p.item_id) as item_id,
           c.location_id as cur_loc, p.location_id as prv_loc,
           (c.item_id is not null) as in_cur, (p.item_id is not null) as in_prv
      from cur c full outer join prv p on p.item_id = c.item_id
  ),
  ev as (
    -- 当月末にいる場所から見た出来事
    select cur_loc as loc,
           count(*) filter (where in_cur and not in_prv)                      as in_qty,
           0                                                                   as out_qty,
           count(*) filter (where in_cur and in_prv and cur_loc is distinct from prv_loc) as moved_in,
           0                                                                   as moved_out,
           count(*) filter (where in_cur)                                      as end_qty,
           0                                                                   as prev_qty
      from j where in_cur group by cur_loc
    union all
    -- 前月末にいた場所から見た出来事
    select prv_loc,
           0,
           count(*) filter (where in_prv and not in_cur),
           0,
           count(*) filter (where in_cur and in_prv and cur_loc is distinct from prv_loc),
           0,
           count(*) filter (where in_prv)
      from j where in_prv group by prv_loc
  )
  select loc,
         case when loc is null then '未登録' else public.inv_location_path(loc) end,
         sum(prev_qty)::integer, sum(in_qty)::integer, sum(out_qty)::integer,
         sum(moved_in)::integer, sum(moved_out)::integer, sum(end_qty)::integer
    from ev
   group by loc
$$;


-- ------------------------------------------------------------
-- 8) その月の様子（画面のKPIと、確定してよいかの点検）
--
--    state
--      'confirmed'   確定済み。もう動かない
--      'current'     当月。**本日時点の暫定**
--      'provisional' 過ぎた月だが未確定。暫定
--      'future'      未来月。出さない
--
--    quality は「確定してよいか」を人が判断するための材料。
--    復元できなかった件数が1件でもあれば、確定値として出さない。
-- ------------------------------------------------------------

create or replace function public.inv_month_info(p_ym text)
returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_rev   integer := public.inv_month_revision(p_ym);
  v_end   timestamptz := public.inv_month_end_at(p_ym);
  v_now   text := public.inv_month_now();
  v_state text;
  v_bad   integer := 0;
  v_lost  integer := 0;
  v_noloc integer := 0;
  v_dup   integer := 0;
  v_end_n integer;
  v_prev_n integer;
  v_in    integer;
  v_out   integer;
  v_qty   integer;
begin
  if p_ym > v_now then
    return jsonb_build_object('ym', p_ym, 'state', 'future');
  end if;
  v_state := case when v_rev is not null then 'confirmed'
                  when p_ym = v_now then 'current'
                  else 'provisional' end;

  -- 履歴の質は**確定済みかどうかに関わらず**いつも見る。
  -- 確定済みの月は写しを読むのでこの数字は表示に使わないが、
  -- 「訂正（数え直し）してよいか」の判断にはこの数字が要る
  select count(*) into v_bad  from public.inv_month_items_at(v_end) where not ok;
  select count(*) into v_lost from public.inv_month_lost_at(v_end);

  select count(*) into v_end_n  from public.inv_month_rows(p_ym);
  select count(*) into v_prev_n from public.inv_month_rows(public.inv_month_prev(p_ym));
  select coalesce(sum(in_qty), 0), coalesce(sum(out_qty), 0)
    into v_in, v_out
    from public.inv_month_by_product(p_ym) where kind = '個体管理';
  select coalesce(sum(qty), 0) into v_qty from public.inv_month_product_rows(p_ym);

  select count(*) into v_noloc from public.inv_month_rows(p_ym) where location_id is null;
  select count(*) into v_dup from (
    select item_id from public.inv_month_rows(p_ym) group by item_id having count(*) > 1) d;

  return jsonb_build_object(
    'ym',        p_ym,
    'state',     v_state,
    'end_at',    v_end,
    'revision',  v_rev,
    'held_rule', '売却済・廃棄 以外すべて',
    'end_qty',   v_end_n,
    'prev_qty',  v_prev_n,
    'in_qty',    v_in,
    'out_qty',   v_out,
    'diff_qty',  v_end_n - v_prev_n,
    'product_qty', v_qty,
    'confirmed', case when v_rev is null then null else (
      select jsonb_build_object('by', confirmed_by, 'at', confirmed_at,
                                'revision', revision, 'reason', reason, 'note', note, 'basis', basis)
        from public.inventory_month_closes where ym = p_ym and revision = v_rev) end,
    'quality',   jsonb_build_object(
      'unrestorable',  v_bad,     -- 履歴から前の状態を読み取れなかった個体
      'lost',          v_lost,    -- 履歴にあるのに、いまの在庫表に無い個体（削除されたもの）
      'no_location',   v_noloc,   -- 保管場所が入っていない
      'duplicate_id',  v_dup,     -- 管理番号の重複
      'can_confirm',   (v_bad = 0 and v_lost = 0))
  );
end $$;

comment on function public.inv_month_info(text) is
  'その月の月末在庫のまとめ。確定済みなら写しを、未確定なら履歴から復元した値を返す。
   quality.can_confirm が false の月は、確定値として出してはいけない。';


/* 選べる月の一覧。いちばん古い履歴のある月から今月まで。未来月は出さない */
create or replace function public.inv_month_list()
returns table (ym text, state text, revision integer, confirmed_at timestamptz)
language sql stable security invoker set search_path = public as $$
  with b as (
    select least(
             coalesce((select min(occurred_at) from public.inventory_transactions), now()),
             coalesce((select min(created_at)  from public.inventory_items), now())
           ) as from_at
  ),
  m as (
    select to_char(g, 'YYYY-MM') as ym
      from b,
           generate_series(
             date_trunc('month', (b.from_at at time zone 'Asia/Tokyo')),
             date_trunc('month', (now() at time zone 'Asia/Tokyo')),
             interval '1 month') g
  )
  select m.ym,
         case when c.revision is not null then 'confirmed'
              when m.ym = public.inv_month_now() then 'current'
              else 'provisional' end,
         c.revision, c.confirmed_at
    from m
    left join lateral (
      select revision, confirmed_at from public.inventory_month_closes
       where ym = m.ym order by revision desc limit 1) c on true
   order by m.ym desc
$$;


-- ------------------------------------------------------------
-- 9) 月次確定・訂正（管理者だけ）
--
--    ・同じ月を二度確定しても、版が増えたり明細が重なったりしない（冪等）
--    ・同時に押されても1つしか通らない（助言ロック＋主キー）
--    ・復元できない個体がある月は確定させない（確かでない数を確定値にしない）
--    ・未来月・当月は確定させない（まだ終わっていない月を確定値にしない）
--    ・訂正は版を上げる。**前の版も履歴も消さない**
-- ------------------------------------------------------------

create or replace function public.inv_month_close(
  p_ym     text,
  p_note   text default null,
  p_reason text default null          -- 訂正のときだけ。null なら初回の確定
) returns jsonb
-- **security definer。** 月次確定の表は authenticated に INSERT を渡していないので、
-- 書き込みはこの関数の中だけに閉じる。中で inv_is_admin() を見ているので、
-- 管理者以外が呼んでも何も書けない。search_path は固定する。
language plpgsql security definer set search_path = public as $$
declare
  v_rev   integer;
  v_new   integer;
  v_info  jsonb;
  v_items integer;
  v_prods integer;
begin
  if not public.inv_is_admin() then
    raise exception '月次確定ができるのは管理者だけです';
  end if;
  perform public.inv_month_start_at(p_ym);            -- 形の点検（違えばここで止まる）

  if p_ym >= public.inv_month_now() then
    raise exception 'まだ終わっていない月は確定できません（% は当月または未来です）', p_ym;
  end if;

  -- 同じ月への同時操作を1つに絞る
  perform pg_advisory_xact_lock(hashtextextended('inv_month_close:' || p_ym, 0));

  v_rev := public.inv_month_revision(p_ym);

  if v_rev is not null and p_reason is null then
    -- もう確定している月をもう一度押しただけ。**何も変えない**
    return jsonb_build_object('ym', p_ym, 'revision', v_rev, 'changed', false,
                              'message', 'すでに確定しています（' || v_rev || '版）');
  end if;
  if v_rev is null and p_reason is not null then
    raise exception 'まだ確定していない月は訂正できません（%）', p_ym;
  end if;

  v_info := public.inv_month_info(p_ym);
  if not (v_info -> 'quality' ->> 'can_confirm')::boolean then
    raise exception
      '履歴がそろっていないので確定できません（復元できない個体 %件／履歴にあるのに在庫表に無い個体 %件）。'
      '確かでない数を確定値にはしません',
      v_info -> 'quality' ->> 'unrestorable', v_info -> 'quality' ->> 'lost';
  end if;

  v_new := coalesce(v_rev, 0) + 1;

  insert into public.inventory_month_closes (ym, revision, confirmed_by, reason, note, basis)
  values (p_ym, v_new, public.inv_actor(), p_reason, p_note,
          jsonb_build_object(
            'held_rule',  '売却済・廃棄 以外すべて',
            'end_at',     public.inv_month_end_at(p_ym),
            'method',     'いまの在庫表から履歴を逆再生して復元',
            'end_qty',    v_info ->> 'end_qty',
            'prev_qty',   v_info ->> 'prev_qty',
            'in_qty',     v_info ->> 'in_qty',
            'out_qty',    v_info ->> 'out_qty',
            'quality',    v_info -> 'quality'));

  insert into public.inventory_month_items
    (ym, revision, item_id, name, product_code, model, maker, category_id,
     serial, purchased_on, location_id, location_path, status, held, cost)
  select p_ym, v_new, r.item_id, r.name, r.product_code, r.model, r.maker, r.category_id,
         r.serial, r.purchased_on, r.location_id, r.location_path, r.status, true, r.cost
    from public.inv_month_rebuild_rows(p_ym) r;    -- **いつも履歴から数え直す**
  get diagnostics v_items = row_count;

  insert into public.inventory_month_products
    (ym, revision, product_code, name, model, maker, category_id,
     location_id, location_path, qty, unit_price)
  select p_ym, v_new, r.product_code, r.name, r.model, r.maker, r.category_id,
         r.location_id, r.location_path, r.qty, r.unit_price
    from public.inv_month_rebuild_product_rows(p_ym) r;
  get diagnostics v_prods = row_count;

  -- 監査。履歴は追記のみなので、誰がいつ何版を作ったかが残る
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'month', p_ym, p_ym || ' の月末在庫',
          case when p_reason is null then '月次確定' else '月次訂正' end,
          case when v_rev is null then '未確定' else v_rev || '版' end,
          v_new || '版（個体 ' || v_items || '台／数量品 ' || v_prods || '品目）'
            || coalesce('／理由 ' || nullif(btrim(coalesce(p_reason, '')), ''), '')
            || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), ''));

  return jsonb_build_object('ym', p_ym, 'revision', v_new, 'changed', true,
                            'items', v_items, 'products', v_prods);
end $$;

comment on function public.inv_month_close(text, text, text) is
  '月次確定（管理者だけ）。p_reason を入れると訂正となり版が上がる。
   同じ月に二度押しても版は増えない。履歴がそろっていない月は確定できない。
   確定した明細はあとから売れても移動しても動かない。';


-- ------------------------------------------------------------
-- 10) 権限（関数）
--
--     読み取りはログインしていれば誰でも。確定は関数の中で管理者を見ている。
--     匿名（anon）とサーバー鍵（service_role）には渡さない。
-- ------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.inv_month_start_at(text)',
    'public.inv_month_end_at(text)',
    'public.inv_month_now()',
    'public.inv_month_prev(text)',
    'public.inv_month_held(text)',
    'public.inv_month_status_of(text)',
    'public.inv_month_rewind_actions()',
    'public.inv_month_items_at(timestamptz)',
    'public.inv_month_lost_at(timestamptz)',
    'public.inv_month_products_at(timestamptz)',
    'public.inv_month_revision(text)',
    'public.inv_month_rebuild_rows(text)',
    'public.inv_month_rebuild_product_rows(text)',
    'public.inv_month_rows(text)',
    'public.inv_month_product_rows(text)',
    'public.inv_month_by_product(text)',
    'public.inv_month_by_location(text)',
    'public.inv_month_info(text)',
    'public.inv_month_list()',
    'public.inv_month_close(text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
