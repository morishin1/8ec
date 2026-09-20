-- ============================================================
-- 個体詳細に「編集」と「削除」を足す（管理者だけ）
--   2026-09-20（2026-09-20-public-categories.sql の後に流す追補）
--
--   これまで個体詳細でできたのは、貸出・返却・移動・修理・売却・棚卸確認・
--   8RENT対象・廃棄・値段を直す、という業務操作だけだった。
--   誤って登録した個体を直す／在庫から外す手段が無い。
--
--   入っているもの
--     inventory_items に deleted_at / deleted_by（論理削除。物理削除はしない）
--     参照RLSを「消していない個体だけ」にする
--       … 一覧・検索・KPI・在庫数・8RENT集計は、どれも authenticated として
--          読んでいるので、これだけで全部から消える
--     公開ビューとDB所有者権限で動くものには、明示的に同じ条件を足す
--       （ビューはRLSを通らないため）
--     inv_item_guard()        管理番号など、触ってはいけない列を守るトリガ
--     inv_item_admin_update() 管理者だけの個体編集（履歴つき）
--     inv_item_delete_check() 削除してよいかの判定（理由つき）
--     inv_item_admin_delete() 管理者だけの論理削除（同じ取引の中で再判定）
--
--   既存の「廃棄」は業務操作として残す。削除と統合しない。
--
--   何度流しても同じ結果になる。
--
--   実行後の確認
--     select public.inv_item_delete_check('（テスト個体の管理番号）');
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 42-1) 論理削除の列
--
--     物理削除はしない。履歴（inventory_transactions）は追記のみの表なので、
--     個体の行だけ消すと「誰が何をしたか」は残るのに対象が消え、監査が読めなくなる。
--     消した事実（いつ・誰が）を個体に持たせ、見えなくするだけにする。
-- ------------------------------------------------------------
alter table public.inventory_items add column if not exists deleted_at timestamptz;
alter table public.inventory_items add column if not exists deleted_by text;

comment on column public.inventory_items.deleted_at is
  '在庫管理から外した日時（論理削除）。入っている個体は一覧・検索・集計・公開側のどこにも出さない。
   通常の運用で不要になった機器は status=''廃棄'' を使う。これは誤登録を取り消すための列。';
comment on column public.inventory_items.deleted_by is
  '削除を実行した人（inv_actor）。誰が消したかを個体側にも残す。';

create index if not exists inventory_items_live_idx
  on public.inventory_items (status) where deleted_at is null;

-- ------------------------------------------------------------
-- 42-2) 触ってはいけない列を守る
--
--     inventory_items の update は一般メンバーにも開いている（貸出・移動・
--     値段を直す・売却などの関数が invoker 権限で通るため）。そのため
--     PostgREST から直接 PATCH すれば、いまは何の列でも書ける。
--
--     このトリガは、既存の操作が書かない列だけを管理者に限る。
--       id           … QR・URL・履歴の紐付けに使うので誰も変えられない
--       product_code / serial / source_id / purchased_on / created_at
--                    … 今回の「編集」でしか触らない列
--       deleted_at / deleted_by
--                    … 削除。管理者以外がRESTから消せないようにする
--     価格・販売予定価格・実売価格・備考は、既存の「値段を直す」「売却」が
--     一般メンバーの操作として書くので、ここでは止めない。
-- ------------------------------------------------------------
create or replace function public.inv_item_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- 管理番号は誰も変えられない。QRのURLと履歴（ref_id）がこれで紐づいている
  if new.id is distinct from old.id then
    raise exception '管理番号は変更できません（QR・履歴の紐付けに使っています）';
  end if;

  if public.inv_is_admin() or public.inv_is_db_session() then
    return new;
  end if;

  if new.deleted_at   is distinct from old.deleted_at
  or new.deleted_by   is distinct from old.deleted_by then
    raise exception '個体を削除できるのは管理者だけです';
  end if;

  if new.product_code is distinct from old.product_code
  or new.serial       is distinct from old.serial
  or new.source_id    is distinct from old.source_id
  or new.purchased_on is distinct from old.purchased_on
  or new.created_at   is distinct from old.created_at then
    raise exception '個体情報（商品の紐付け・シリアル番号・仕入元ID・仕入日）を編集できるのは管理者だけです';
  end if;

  return new;
end $$;

comment on function public.inv_item_guard is
  '個体の列のうち、既存の操作が書かない（＝今回の管理者編集・削除でしか触らない）ものを守る。
   管理番号は管理者でも変更不可。判定はサーバー側の inv_is_admin() だけを見る。';

drop trigger if exists inv_item_guard_trg on public.inventory_items;
create trigger inv_item_guard_trg
  before update on public.inventory_items
  for each row execute function public.inv_item_guard();

-- ------------------------------------------------------------
-- 42-3) 消した個体は見せない
--
--     参照のRLSを「deleted_at が空のものだけ」にする。/zaiko も 8RENT も
--     authenticated として読むので、一覧・検索・KPI・在庫数・8RENT集計は
--     これだけで全部そろって消える（数え漏れの心配がない）。
-- ------------------------------------------------------------
drop policy if exists "inventory_items read" on public.inventory_items;
create policy "inventory_items read" on public.inventory_items
  for select to authenticated using (deleted_at is null);

comment on table public.inventory_items is
  '実物1台＝1行。deleted_at が入っている個体は参照RLSで見えなくなる（論理削除）。
   消した個体を読むのは inv_item_admin_delete の中（security definer）だけ。';

-- ------------------------------------------------------------
-- 42-4) ビューにも同じ条件を足す
--
--     ビューは（security_invoker を付けていないので）所有者の権限で動き、
--     RLSを通らない。公開カタログ・社内の在庫数・販売サイトへ送る数量は、
--     ここで明示的に「消していない個体だけ」にする。
--     定義そのものは setup.sql と同じものを置いている（差が出ないように）。
-- ------------------------------------------------------------

create or replace view public.inventory_stock_view as
select
  p.code,
  p.name,
  p.kind,
  case when p.kind = 'individual'
       then (select count(*) from public.inventory_items i
              where i.product_code = p.code and i.deleted_at is null
                and i.status in ('在庫','出品中'))
       else p.qty end                                   as in_stock,
  case when p.kind = 'individual'
       then (select count(*) from public.inventory_items i
              where i.product_code = p.code and i.deleted_at is null
                and i.status not in ('廃棄','売却済'))
       else p.qty end                                   as registered,
  case when p.kind = 'individual'
       then (select count(*) from public.inventory_items i
              where i.product_code = p.code and i.deleted_at is null)
       else 1 end                                       as total_units
from public.inventory_products p;


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
left join public.inventory_items i
       on i.product_code = p.code and i.deleted_at is null
where p.rental_enabled = true
group by p.code;


drop view if exists public.inv_public_catalog;
create view public.inv_public_catalog as
with avail as (
  select product_code,
         count(*) filter (where status = '在庫'
                            and coalesce(rental_eligible, false)) as rental_available
    from public.inventory_items
   where deleted_at is null
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
  -- 事実としてのスペック（条件で選んでもらうために出す）
  p.cpu, p.cpu_gen, p.memory_size, p.storage_type, p.storage_capacity,
  p.screen_size, p.os, p.webcam, p.wifi, p.bluetooth, p.numpad, p.accessories,
  p.condition_note, p.office_supported,
  p.rental_form, p.rental_listing_type,
  -- レンタル（8EC）。台数は出さず、用意できるかどうかだけ
  coalesce(p.rental_enabled, false)                                 as rental_enabled,
  coalesce(p.procurement_available, false)                          as procurement_available,
  case when coalesce(a.rental_available, 0) > 0 then 'ご案内可能'
       when coalesce(p.procurement_available, false) then '取り寄せ可能'
       else 'ご相談ください' end                                    as availability,
  p.rental_price_month, p.rental_min_months, p.trial_eligible, p.rental_tags,
  -- 8ECが出す説明はレンタル向けの文だけ（楽天の販売用の文は出さない）
  nullif(btrim(coalesce(p.rental_description,'')), '')              as rental_description,
  p.updated_at
from public.inventory_products p
left join public.inventory_categories c on c.id = p.category_id
left join avail a on a.product_code = p.code
where p.kind = 'individual'
  and coalesce(p.rental_enabled, false) = true
  -- 単品でレンタルできる商品だけをカードに出す。
  -- option（PCレンタルのオプション。セキュリティワイヤーなど）と
  -- not_public は、商品カードとしては公開しない
  and coalesce(p.rental_listing_type, 'standalone') = 'standalone';


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
   where deleted_at is null
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


grant select on public.inventory_stock_view to authenticated;
grant select on public.inv_rental_catalog to anon, authenticated;
grant select on public.inv_public_catalog to anon, authenticated;
-- 販売チャネルへ送る数量は社内用（anonには出さない）
grant select on public.inv_channel_stock_feed to authenticated;

-- ------------------------------------------------------------
-- 42-5) 在庫を1台取る／出品情報の取込（どちらも security definer なのでRLSを通らない）
-- ------------------------------------------------------------
create or replace function public.inv_reserve_available_item(
  p_code       text,
  p_new_status text,
  p_rental_only boolean default false
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id text;
begin
  -- p_rental_only=true（8RENTの申込）… rental_eligible の個体だけを対象にする
  -- p_rental_only=false（楽天などの販売）… 在庫の個体すべて。ただし
  --   レンタル対象に選んだ個体は後回しにして、販売はまず対象外の個体から取る
  select id into v_item_id
    from public.inventory_items
   where product_code = p_code and status = '在庫' and deleted_at is null
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
-- 42-6) 管理者だけの個体編集
--
--     商品マスターに属する情報（商品名・メーカー・型番・スペック・画像）は
--     ここでは触らない。個体に属する項目だけを直す。
--     管理番号・在庫状態・保管場所・利用者・8RENT対象・出品先も対象外で、
--     それぞれ既存の操作（貸出・移動・8RENTに出す・出品先の編集…）を使う。
--
--     渡さなかった（null の）項目は「変えない」。空にしたいときは
--     p_clear に列名を入れてもらう（''（空文字）と「未指定」を区別するため）。
-- ------------------------------------------------------------
create or replace function public.inv_item_admin_update(
  p_item_id      text,
  p_product_code text default null,
  p_serial       text default null,
  p_source_id    text default null,
  p_purchased_on date default null,
  p_price        numeric default null,
  p_fee          numeric default null,
  p_plan         numeric default null,
  p_sold         numeric default null,
  p_note         text default null,
  p_clear        text[] default '{}'
) returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  it      public.inventory_items;
  nw      public.inventory_items;
  cl      text[] := coalesce(p_clear, '{}');
  chg     text[] := '{}';
  bef     text[] := '{}';
  aft     text[] := '{}';
  fmt     constant text := 'FM9,999,999,999';
  v_code  text;
  v_ser   text;
  v_src   text;
  v_buy   date;
  v_prc   numeric;
  v_fee   numeric;
  v_plan  numeric;
  v_sold  numeric;
  v_note  text;
begin
  if not public.inv_is_admin() then
    raise exception '個体情報を編集できるのは管理者だけです';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '個体が見つかりません（%）', p_item_id;
  end if;

  v_code := case when 'product_code' = any(cl) then null
                 else coalesce(nullif(btrim(coalesce(p_product_code,'')),''), it.product_code) end;
  v_ser  := case when 'serial'       = any(cl) then null
                 else coalesce(nullif(btrim(coalesce(p_serial,'')),''), it.serial) end;
  v_src  := case when 'source_id'    = any(cl) then null
                 else coalesce(nullif(btrim(coalesce(p_source_id,'')),''), it.source_id) end;
  v_buy  := case when 'purchased_on' = any(cl) then null else coalesce(p_purchased_on, it.purchased_on) end;
  v_prc  := case when 'price'        = any(cl) then null else coalesce(p_price, it.price) end;
  v_fee  := case when 'purchase_fee' = any(cl) then null else coalesce(p_fee,   it.purchase_fee) end;
  v_plan := case when 'plan_price'   = any(cl) then null else coalesce(p_plan,  it.plan_price) end;
  v_sold := case when 'sold_price'   = any(cl) then null else coalesce(p_sold,  it.sold_price) end;
  v_note := case when 'note'         = any(cl) then null
                 else coalesce(nullif(btrim(coalesce(p_note,'')),''), it.note) end;

  -- 入力の決まり
  if coalesce(v_prc,0) < 0 or coalesce(v_fee,0) < 0
  or coalesce(v_plan,0) < 0 or coalesce(v_sold,0) < 0 then
    raise exception 'マイナスの金額は入れられません';
  end if;
  if v_buy is not null and v_buy > current_date + 1 then
    raise exception '仕入日に未来の日付は入れられません（%）', to_char(v_buy, 'YYYY-MM-DD');
  end if;
  if v_code is not null and not exists (select 1 from public.inventory_products where code = v_code) then
    raise exception '商品が見つかりません（%）。一覧にある商品から選んでください', v_code;
  end if;

  -- 変わった項目だけを履歴に残す（変更項目・変更前・変更後が読めるように）
  if v_code is distinct from it.product_code then
    chg := chg || '商品'::text; bef := bef || ('商品 ' || coalesce(it.product_code,'—'));
    aft := aft || ('商品 ' || coalesce(v_code,'—'));
  end if;
  if v_ser is distinct from it.serial then
    chg := chg || 'シリアル番号'::text; bef := bef || ('シリアル ' || coalesce(it.serial,'—'));
    aft := aft || ('シリアル ' || coalesce(v_ser,'—'));
  end if;
  if v_src is distinct from it.source_id then
    chg := chg || '仕入元ID'::text; bef := bef || ('仕入元 ' || coalesce(it.source_id,'—'));
    aft := aft || ('仕入元 ' || coalesce(v_src,'—'));
  end if;
  if v_buy is distinct from it.purchased_on then
    chg := chg || '仕入日'::text;
    bef := bef || ('仕入日 ' || coalesce(to_char(it.purchased_on,'YYYY/MM/DD'),'—'));
    aft := aft || ('仕入日 ' || coalesce(to_char(v_buy,'YYYY/MM/DD'),'—'));
  end if;
  if v_prc is distinct from it.price then
    chg := chg || '仕入価格'::text;
    bef := bef || ('仕入 ' || coalesce(to_char(it.price,fmt)||'円','—'));
    aft := aft || ('仕入 ' || coalesce(to_char(v_prc,fmt)||'円','—'));
  end if;
  if v_fee is distinct from it.purchase_fee then
    chg := chg || '諸費用'::text;
    bef := bef || ('諸費用 ' || coalesce(to_char(it.purchase_fee,fmt)||'円','—'));
    aft := aft || ('諸費用 ' || coalesce(to_char(v_fee,fmt)||'円','—'));
  end if;
  if v_plan is distinct from it.plan_price then
    chg := chg || '販売予定価格'::text;
    bef := bef || ('予定 ' || coalesce(to_char(it.plan_price,fmt)||'円','未定'));
    aft := aft || ('予定 ' || coalesce(to_char(v_plan,fmt)||'円','未定'));
  end if;
  if v_sold is distinct from it.sold_price then
    chg := chg || '実際の販売価格'::text;
    bef := bef || ('実売 ' || coalesce(to_char(it.sold_price,fmt)||'円','—'));
    aft := aft || ('実売 ' || coalesce(to_char(v_sold,fmt)||'円','—'));
  end if;
  if v_note is distinct from it.note then
    chg := chg || '備考'::text;
    bef := bef || ('備考 ' || coalesce(nullif(left(coalesce(it.note,''),40),''),'—'));
    aft := aft || ('備考 ' || coalesce(nullif(left(coalesce(v_note,''),40),''),'—'));
  end if;

  if array_length(chg,1) is null then
    return it;                              -- 何も変わっていないなら履歴も残さない
  end if;

  update public.inventory_items
     set product_code = v_code, serial = v_ser, source_id = v_src,
         purchased_on = v_buy, price = v_prc, purchase_fee = v_fee,
         plan_price = v_plan, sold_price = v_sold, note = v_note,
         updated_at = now()
   where id = p_item_id
  returning * into nw;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values
    (public.inv_actor(), 'item', p_item_id, nw.name, '個体編集',
     array_to_string(bef, '／'),
     array_to_string(aft, '／') || '（変更項目：' || array_to_string(chg, '・') || '）');

  return nw;
end $$;

comment on function public.inv_item_admin_update is
  '管理者だけが個体の情報（商品の紐付け・シリアル・仕入元・仕入日・仕入価格・諸費用・
   販売予定価格・実売価格・備考）を直す。管理番号・在庫状態・保管場所・利用者・8RENT対象・
   出品先は対象外で、既存の操作を使う。変わった項目だけを inventory_transactions に残す。';

-- ------------------------------------------------------------
-- 42-7) 削除してよいかの判定
--
--     「削除」は誤登録を取り消すための操作。通常の運用で不要になった機器は
--     status='廃棄'（既存の操作）を使う。だから、業務が動いた形跡のある個体は
--     削除させない。理由と、代わりに何をすればよいかを返す。
--
--     判定は画面と削除処理の両方から呼ぶ。実際に消すときは
--     inv_item_admin_delete が同じ取引の中でもう一度これを通す
--     （画面で確認してから押すまでのあいだに状態が変わることがあるため）。
-- ------------------------------------------------------------
create or replace function public.inv_item_delete_check(p_item_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  it      public.inventory_items;
  reasons jsonb := '[]'::jsonb;
  add     constant text := '';
  n       integer;
  v_chan  text;
begin
  select * into it from public.inventory_items where id = p_item_id;
  if not found then
    return jsonb_build_object('ok', false, 'found', false,
      'reasons', jsonb_build_array('この管理番号の個体は見つかりません。'::text));
  end if;
  if it.deleted_at is not null then
    return jsonb_build_object('ok', false, 'found', true, 'deleted', true,
      'reasons', jsonb_build_array('この個体はすでに削除されています。'::text));
  end if;

  -- 1) 進行中の業務状態
  if it.status in ('貸出中','予約中','販売予約','修理中','故障','社内使用') then
    reasons := reasons || to_jsonb((it.status || 'のため削除できません。先に返却・解除などで「在庫」に戻してから操作してください。')::text);
  end if;

  -- 2) 会計・売上集計に使われている
  if it.status = '売却済' or it.sold_price is not null then
    reasons := reasons || to_jsonb(('売却の記録があるため削除できません。売上・粗利の集計に使っています。')::text);
  end if;

  -- 3) 出品中の販売サイト
  select string_agg(distinct channel, '・') into v_chan
    from public.inventory_channels
   where item_id = p_item_id and state = '出品中';
  if v_chan is not null then
    reasons := reasons || to_jsonb((v_chan || 'で出品中のため削除できません。出品を終了してから再度操作してください。')::text);
  end if;

  -- 4) 8RENTの申込・契約との紐付け（キャンセル済み以外）
  select count(*) into n from public.inventory_rental_requests r
   where (r.item_id = p_item_id or p_item_id = any(r.item_ids))
     and r.status <> 'キャンセル';
  if n > 0 then
    reasons := reasons || to_jsonb(('8RENTの申込 ' || n || '件と紐づいているため削除できません。申込を取り消してから操作してください。')::text);
  end if;

  -- 5) 販売サイトの受注（キャンセル済み以外）
  select count(*) into n from public.inventory_sale_orders o
   where o.item_id = p_item_id and o.status <> 'キャンセル';
  if n > 0 then
    reasons := reasons || to_jsonb(('受注 ' || n || '件と紐づいているため削除できません。')::text);
  end if;

  -- 6) 貸出の履歴
  select count(*) into n from public.inventory_loans where item_id = p_item_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('貸出の履歴があるため削除できません。「廃棄」をお使いください。')::text);
  end if;

  -- 7) 棚卸で現物を確認した記録
  select count(*) into n from public.inventory_stocktake_items
   where item_id = p_item_id and checked_at is not null;
  if n > 0 then
    reasons := reasons || to_jsonb(('棚卸で確認した記録があるため削除できません。「廃棄」をお使いください。')::text);
  end if;

  -- 8) 登録・編集より後の業務履歴（移動・貸出・売却・棚卸確認など）
  select count(*) into n from public.inventory_transactions
   where ref_kind = 'item' and ref_id = p_item_id
     and action not in ('登録','個体編集');
  if n > 0 then
    reasons := reasons || to_jsonb(('操作履歴が ' || n || '件あるため削除できません。削除は誤って登録した直後の個体だけに使えます。'
      || '使い終わった機器は「廃棄」をお使いください。')::text);
  end if;

  return jsonb_build_object(
    'ok',      jsonb_array_length(reasons) = 0,
    'found',   true,
    'deleted', false,
    'item_id', it.id,
    'name',    it.name,
    'status',  it.status,
    'reasons', reasons);
end $$;

comment on function public.inv_item_delete_check is
  '個体を削除してよいかを返す。だめなときは理由と、代わりにどうすればよいかを日本語で返す。
   読むだけなので security definer でよい（消した個体も「すでに削除されています」と答えられる）。';

-- ------------------------------------------------------------
-- 42-8) 管理者だけの論理削除
--
--     物理削除はしない。履歴は追記のみの表なので、個体の行を消すと
--     「誰が何をしたか」だけが残って対象が消え、監査が読めなくなる。
--     deleted_at / deleted_by を入れて見えなくし、消す直前の個体の内容を
--     履歴にスナップショットとして残す。
--
--     商品マスター・共通の商品画像・同じ商品の別個体には一切触らない。
--
--     参照RLSが「deleted_at is null」なので、更新して returning すると
--     invoker 権限では自分が入れた行を読み返せない。ここは security definer
--     にして、関数の中の inv_is_admin() だけを入口にする。
-- ------------------------------------------------------------
create or replace function public.inv_item_admin_delete(
  p_item_id text,
  p_confirm text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  it   public.inventory_items;
  chk  jsonb;
  snap text;
  fmt  constant text := 'FM9,999,999,999';
begin
  if not public.inv_is_admin() then
    raise exception '個体を削除できるのは管理者だけです';
  end if;
  if btrim(coalesce(p_confirm,'')) <> p_item_id then
    raise exception '確認のため、管理番号（%）をそのまま入力してください', p_item_id;
  end if;

  -- 行を押さえてから、同じ取引の中でもう一度判定する。
  -- 画面で確認してから押すまでのあいだに、貸出や出品が起きていることがある
  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '個体が見つかりません（%）', p_item_id;
  end if;
  if it.deleted_at is not null then
    raise exception 'この個体はすでに削除されています（%）', p_item_id;
  end if;

  chk := public.inv_item_delete_check(p_item_id);
  if not (chk ->> 'ok')::boolean then
    raise exception '%', (select string_agg(value, ' ') from jsonb_array_elements_text(chk -> 'reasons'));
  end if;

  -- 消す前の内容を履歴に残す（個体の行は見えなくなるので、ここが唯一の記録になる）
  snap := concat_ws('／',
    '商品 ' || coalesce(it.product_code, '—'),
    '名前 ' || coalesce(it.name, '—'),
    '状態 ' || coalesce(it.status, '—'),
    '保管 ' || coalesce(public.inv_location_path(it.location_id), '—'),
    'S/N ' || coalesce(it.serial, '—'),
    '仕入元 ' || coalesce(it.source_id, '—'),
    '仕入日 ' || coalesce(to_char(it.purchased_on, 'YYYY/MM/DD'), '—'),
    '仕入 ' || coalesce(to_char(it.price, fmt) || '円', '—'),
    '諸費用 ' || coalesce(to_char(it.purchase_fee, fmt) || '円', '—'),
    '予定 ' || coalesce(to_char(it.plan_price, fmt) || '円', '未定'),
    '備考 ' || coalesce(nullif(left(coalesce(it.note, ''), 60), ''), '—'));

  update public.inventory_items
     set deleted_at = now(), deleted_by = public.inv_actor(), updated_at = now()
   where id = p_item_id;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values
    (public.inv_actor(), 'item', p_item_id, it.name, '個体削除', snap,
     '在庫管理から削除（誤登録の取り消し）');

  return jsonb_build_object('ok', true, 'item_id', p_item_id, 'name', it.name);
end $$;

comment on function public.inv_item_admin_delete is
  '管理者だけが誤登録の個体を在庫管理から外す（論理削除）。確認のため管理番号の入力を求め、
   同じ取引の中で inv_item_delete_check をもう一度通す。消す前の内容は履歴に残す。
   通常の運用で不要になった機器は status=''廃棄''（既存の操作）を使う。';

revoke all on function public.inv_item_admin_update(text,text,text,text,date,numeric,numeric,numeric,numeric,text,text[]) from public;
revoke all on function public.inv_item_delete_check(text) from public;
revoke all on function public.inv_item_admin_delete(text,text) from public;
grant execute on function public.inv_item_admin_update(text,text,text,text,date,numeric,numeric,numeric,numeric,text,text[]) to authenticated;
grant execute on function public.inv_item_delete_check(text) to authenticated;
grant execute on function public.inv_item_admin_delete(text,text) to authenticated;

commit;
