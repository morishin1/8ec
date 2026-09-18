-- ============================================================
-- 個体単位のレンタル対象（8RENTに出す1台を選ぶ）と、在庫一覧のまとめて操作
--
--   これまで「8RENTに出す」は商品単位（inventory_products.rental_enabled）
--   だけだったので、「同じ商品10台のうち3台だけレンタル、残り7台は販売優先」
--   という運用ができませんでした。個体側にレンタル対象フラグを足して、
--   2段階で決めるようにします。
--
--     商品 rental_enabled  … その商品を8EC（トップ＝8RENT）に掲載するか
--     個体 rental_eligible … この1台をレンタルに回すか
--     8ECのレンタル可能数 = status='在庫' かつ rental_eligible=true の個体数
--
--   楽天（販売）とは同じ実在庫を共有したまま：
--     rental_eligible=true でも status='在庫' の間は楽天でも売れる
--     8ECで予約が入れば 予約中（楽天の販売可能数量から外れる）
--     楽天で売れれば 販売予約（8ECのレンタル可能数から外れる）
--   販売の確保は「レンタル対象に選んでいない個体」から先に取るので、
--   8RENT用に確保した台数は最後まで残ります。
--
--   本番SupabaseのSQL Editorに貼って実行してください。何度実行しても安全です。
--
--     1. inventory_items.rental_eligible（個体のレンタル対象）を追加
--        ＋ inventory_loans.due_on（貸出の予定返却日）
--     2. inv_reserve_available_item を入れ直す（レンタルは対象個体だけ・
--        販売は対象外を先に。旧2引数版は削除するので 3・4 も必ず一緒に実行）
--     3. inv_rental_request（レンタル対象の個体だけ確保する）
--     4. inv_sale_reserve（レンタル対象は後回しにして確保する）
--     5. 【新規】inv_items_bulk_op：在庫一覧で選んだ個体のまとめて操作
--     6. inv_public_catalog / inv_channel_stock_feed を入れ直す
--     7. 権限
--
--   注意：追加した rental_eligible の既定値は false です。実行直後は
--   どの個体もレンタル対象ではないので、8ECのレンタル可能数は0になります。
--   /zaiko の在庫一覧で「8RENTに出す」個体を選んでください。
--
--   前提：zaiko/migrations/2026-09-19-rental-sale-channels.sql まで実行済み。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 列の追加
-- ------------------------------------------------------------
alter table public.inventory_items add column if not exists rental_eligible boolean default false;
comment on column public.inventory_items.rental_eligible is
  'この個体を8RENT（レンタル）に回すか。true でも status=''在庫'' の間は楽天でも売れる。
   8ECで予約されれば予約中、楽天で売れれば販売予約になり、どちらか一方にしか確保されない。';
create index if not exists inventory_items_rental_eligible_idx
  on public.inventory_items (product_code) where rental_eligible;

alter table public.inventory_loans add column if not exists due_on date;

-- ------------------------------------------------------------
-- 2) 在庫確保の共通処理（レンタルは対象個体だけ・販売は対象外から先に）
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


-- ------------------------------------------------------------
-- 3) 8RENTのレンタル申込（レンタル対象の個体だけを確保する）
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

  -- レンタル対象（rental_eligible）の在庫を1台、行ロックして予約中にする
  -- （楽天の販売予約と共通の処理を使う。管理番号の若いものから）
  v_item_id := public.inv_reserve_available_item(p_code, '予約中', true);

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


-- ------------------------------------------------------------
-- 4) 楽天など販売チャネルの受注（レンタル対象は後回しにして確保する）
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


-- ------------------------------------------------------------
-- 5) 在庫一覧のまとめて操作
-- ------------------------------------------------------------

create or replace function public.inv_items_bulk_op(
  p_ids            text[],
  p_action         text,
  p_value          text    default null,   -- 貸出先／売却価格
  p_note           text    default null,   -- 理由・メモ（履歴に残る）
  p_due            date    default null,   -- 貸出の予定返却日
  p_enable_product boolean default false   -- 8RENT対象にするとき、商品の掲載もONにする
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_id       text;
  it         public.inventory_items;
  v_ok       integer := 0;
  v_ng       jsonb   := '[]'::jsonb;
  v_codes    text[]  := '{}';
  v_enabled  integer := 0;
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

  -- 8RENT対象にした個体の商品を、あわせて8ECに掲載する（頼まれたときだけ）
  if p_action = '8RENT対象' and p_enable_product and coalesce(array_length(v_codes, 1), 0) > 0 then
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

  return jsonb_build_object(
    'action', p_action,
    'total', coalesce(array_length(p_ids, 1), 0),
    'ok', v_ok,
    'ng_count', jsonb_array_length(v_ng),
    'ng', v_ng,
    'products_enabled', coalesce(v_enabled, 0));
end $$;

comment on function public.inv_items_bulk_op is
  '在庫一覧で選んだ個体をまとめて動かす（8RENT対象／8RENT対象外／貸出／売却／修理／棚卸／廃棄）。
   1台ずつの検証と履歴は inv_item_op() に任せ、1台が失敗しても他は進める。
   成功件数と、失敗した個体・理由をまとめて返す。';


-- ------------------------------------------------------------
-- 6) 公開ビュー・数量フィードの入れ直し
-- ------------------------------------------------------------

drop view if exists public.inv_public_catalog;
create view public.inv_public_catalog as
with avail as (
  select product_code,
         count(*) filter (where status = '在庫')                 as available,
         count(*) filter (where status = '在庫'
                            and coalesce(rental_eligible, false)) as rental_available,
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
  -- 実在庫（両チャネル共通。ここから二重に確保されることはない）
  coalesce(a.available, 0)::integer                                 as available,
  coalesce(a.total_owned, 0)::integer                               as total_owned,
  -- レンタル（8EC）。掲載は商品の rental_enabled、貸せる台数は個体の rental_eligible
  coalesce(p.rental_enabled, false)                                 as rental_enabled,
  coalesce(a.rental_available, 0)::integer                          as rental_available,
  p.rental_price_month, p.rental_min_months, p.trial_eligible, p.rental_tags,
  coalesce(nullif(p.rental_description,''), p.description)          as rental_description,
  -- 販売（楽天）。掲載状態と購入できる数量を分けて出す
  coalesce(rk.state = '出品中' and nullif(rk.url,'') is not null, false) as sale_listed,
  coalesce(rk.state = '出品中' and nullif(rk.url,'') is not null, false) as sale_enabled,
  case when rk.state = '出品中' and nullif(rk.url,'') is not null
       then coalesce(a.available, 0)::integer else 0 end            as sale_available,
  case when rk.state = '出品中' and nullif(rk.url,'') is not null then 'rakuten' end as sale_channel,
  case when rk.state = '出品中' and nullif(rk.url,'') is not null then rk.url   end as sale_url,
  case when rk.state = '出品中' and nullif(rk.url,'') is not null then rk.price end as sale_price,
  p.updated_at
from public.inventory_products p
left join public.inventory_categories c on c.id = p.category_id
left join avail a on a.product_code = p.code
left join rk on rk.product_code = p.code
where p.kind = 'individual'
  and coalesce(p.rental_enabled, false) = true;

comment on view public.inv_public_catalog is
  '8ECトップと8RENTが共通で読む公開カタログ。8ECはレンタルサイトなので rental_enabled=true の商品だけを出す
   （楽天に出品中かどうかは公開条件にしない）。available は status=在庫 の個体数、
   rental_available はそのうち rental_eligible=true（8RENTに出すと選んだ）個体数。
   楽天の掲載（sale_listed）と、楽天でいま購入できる数量（sale_available）は別の列で持つ。
   シリアル・仕入価格・利用者・備考は含めない。';

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

-- ------------------------------------------------------------
-- 7) 権限
-- ------------------------------------------------------------
grant execute on function public.inv_items_bulk_op(text[],text,text,text,date,boolean) to authenticated;
grant execute on function public.inv_sale_reserve(text,text,text,text) to authenticated;
grant execute on function public.inv_rental_request(text,text,text,text,text,date,integer,text) to anon;
grant usage on schema public to anon;
grant select on public.inv_public_catalog to anon, authenticated;
grant select on public.inv_channel_stock_feed to authenticated;

-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select count(*) as "個体の総数",
       count(*) filter (where rental_eligible) as "うち8RENT対象",
       count(*) filter (where status='在庫' and rental_eligible) as "いまレンタルできる台数"
  from public.inventory_items;
