-- ============================================================
-- 8RENT：レンタルを「個体在庫」から「条件で選ぶ商品」へ
--   2026-09-19（2026-09-19-rakuten-image-sync.sql の後に流す追補）
--
--   すでに本番へ適用済みのmigrationは書き換えず、差分だけをこのファイルに入れる。
--   何度流しても同じ結果になる（add column if not exists / create or replace）。
--
--   入っているもの
--     0) このmigrationが前提にする共通関数・列（inv_img_hires など）を先に作る
--        ※ 適用済みの 2026-09-19-rakuten-image-sync.sql は書き換えず、
--          そこに後から足した分をここで作り直している
--     1) 楽天から取り込み済みの画像URLを元サイズに直す（_ex= を外す）
--     2) inventory_products.procurement_available（在庫0でも申込を受ける＝取り寄せ）
--     3) inv_model_key()（メーカー＋型番で1機種にまとめるキー）
--     4) inventory_rental_requests に 台数・割当個体・Office・条件 を持たせる
--     5) inv_public_catalog に model_key / procurement_available を足す
--     6) inv_rental_apply()（条件と台数で申し込む。個体の割当はサーバー側）
--     7) inv_rental_request() を 6) の薄い包みにする
--     8) inv_rental_allocate()（取り寄せぶんに現物を割り当てる）
--     9) inv_rental_set_status()（複数台・取り寄せに対応）
--
--   実行後の確認（例）
--     select code, model_key, rental_available, procurement_available
--       from inv_public_catalog order by model_key, code;
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 32-0) このmigrationが前提にする共通関数・列（先に必ず作る）
--
--     本番の 2026-09-19-rakuten-image-sync.sql は、あとからこのファイルへ
--     足した分（inv_img_hires など）より前の版が当たっている。適用済みの
--     ファイルは書き換えない方針なので、足りない分をここで作り直す。
--     どれも setup.sql と同じ定義で、create or replace ／
--     add column if not exists なので、すでに入っていれば同じ内容で
--     置き換わるだけ（何度流しても同じ結果になる）。
--
--     この節より下の SQL は inv_img_hires() / inv_norm_model() /
--     inv_norm_url() を使うので、順番を入れ替えないこと。
-- ------------------------------------------------------------

-- 型番の表記ゆれをそろえる（inv_model_key が使う）
create or replace function public.inv_norm_model(s text)
returns text language sql immutable set search_path = public as $$
  select upper(regexp_replace(
           translate(normalize(coalesce(s, ''), NFKC), '‐‑‒–—―−', '-------'),
           '[[:space:]]', '', 'g'))
$$;

comment on function public.inv_norm_model is
  '型番の突き合わせ用に表記をそろえる（全角→半角・空白除去・大文字化）。';

-- URLを比較用に正規化する（掲載URLの突き合わせが使う）
create or replace function public.inv_norm_url(p_url text)
returns text language sql immutable as $$
  -- http/https・末尾スラッシュ・クエリ文字列の違いを無視して比べる
  select nullif(lower(regexp_replace(regexp_replace(split_part(coalesce(p_url,''), '?', 1),
                                     '/+$', ''), '^https?://', '')), '');
$$;

comment on function public.inv_norm_url is
  'URLを比較用に正規化する（http/https・末尾スラッシュ・クエリを無視）。Edge Function側の比較と同じ規則。';

-- 楽天の画像URLから縮小指定（_ex=幅x高さ）を外す
--   ここから下の「既存画像の高解像度化」と inv_rakuten_apply_one が使う
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

-- 掲載URLの更新候補（自動では書き換えず、人が採用・取り消しする）
alter table public.inventory_channel_listings add column if not exists url_candidate  text;
alter table public.inventory_channel_listings add column if not exists url_checked_at timestamptz;

comment on column public.inventory_channel_listings.url_candidate is
  'API同期でモール側の正式URLが保存済みURLと違ったときに入る更新候補。inv_listing_url_accept() で採用、
   inv_listing_url_dismiss() で取り消す。自動では書き換えない。';

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

-- 楽天から取った1商品ぶんで不足情報を埋める（画像は元サイズで入れる）
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
    description       = coalesce(nullif(description,''), nullif(p_item->>'caption','')),
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

-- 楽天同期の対象を返す
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

grant execute on function public.inv_norm_model(text) to authenticated;
grant execute on function public.inv_norm_url(text) to anon, authenticated;
grant execute on function public.inv_img_hires(text) to anon, authenticated;
grant execute on function public.inv_listing_url_accept(text,text) to authenticated;
grant execute on function public.inv_listing_url_dismiss(text,text) to authenticated;
grant execute on function public.inv_rakuten_apply_one(text,jsonb) to authenticated;
grant execute on function public.inv_rakuten_sync_targets(text) to authenticated;


-- ------------------------------------------------------------
-- 32-1) 楽天から取り込み済みの画像URLを元サイズに直す
--     `_ex=128x128` のような縮小指定が付いたまま保存された画像は、
--     商品カードや詳細で見ると粗い。規則は inv_img_hires と同じ。
--     人が指定した image_url / rental_image_url には触らない。
-- ------------------------------------------------------------
update public.inventory_products p
   set images = (select coalesce(jsonb_agg(u order by ord), '[]'::jsonb)
                   from (select public.inv_img_hires(x) as u, min(ord) as ord
                           from jsonb_array_elements_text(p.images) with ordinality t(x, ord)
                          where btrim(x) <> ''
                          group by 1) q)
 where jsonb_array_length(coalesce(p.images, '[]'::jsonb)) > 0
   and p.images::text like '%\_ex=%';

update public.inventory_products p
   set rental_images = (select coalesce(jsonb_agg(u order by ord), '[]'::jsonb)
                          from (select public.inv_img_hires(x) as u, min(ord) as ord
                                  from jsonb_array_elements_text(p.rental_images) with ordinality t(x, ord)
                                 where btrim(x) <> ''
                                 group by 1) q)
 where jsonb_array_length(coalesce(p.rental_images, '[]'::jsonb)) > 0
   and p.rental_images::text like '%\_ex=%';


-- ------------------------------------------------------------
-- 32-2) 取り寄せ（在庫が無くても申し込める）
--     在庫0でも仕入れて用意できる商品は、申込を受けて調達から始められる。
--     在庫が無いのに仮の個体を作って予約する、ということはしない
--     （実在庫と台数が合わなくなるため）。割り当ては現物が入ってから。
-- ------------------------------------------------------------
alter table public.inventory_products
  add column if not exists procurement_available boolean not null default false;

comment on column public.inventory_products.procurement_available is
  '在庫が無くてもレンタルの申込を受けられるか（取り寄せ）。true なら8RENTに「取り寄せ可能」として出て、
   申込は「調達確認」から始まる。仮の個体は作らない。';


-- ------------------------------------------------------------
-- 32-3) 機種のまとめかた（メーカー＋型番）
--     8RENTのお客様は管理番号でも商品コードでもなく「機種」を選ぶ。
--     同じメーカー・同じ型番なら、メモリ違い・Office有無などで商品コードが
--     分かれていても1つの機種として1枚のカードにまとめる。
--     型番が無い商品はまとめる根拠が無いので、商品コードをそのままキーにする。
-- ------------------------------------------------------------
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


-- ------------------------------------------------------------
-- 32-4) 申込に「条件」と「台数」を持たせる
--     1件の申込で複数台を借りられるようにし、割り当てた個体は item_ids に入れる。
--     item_id は最初の1台を指したまま残す（これまでの画面・履歴が読めるように）。
-- ------------------------------------------------------------
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


-- ------------------------------------------------------------
-- 32-5) 公開カタログに「機種キー」と「取り寄せ可否」を足す
--     8RENTのカードは model_key でまとめ、その中の1行1行が仕様違いの枝番になる。
--     rental_available が0でも procurement_available なら申込を受けられる。
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
  public.inv_model_key(p.maker, p.model, p.code)                    as model_key,
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
  -- 在庫が0でも申込を受けられるか（取り寄せ）
  coalesce(p.procurement_available, false)                          as procurement_available,
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
   （楽天に出品中かどうかは公開条件にしない）。1行は仕様違いの枝番で、8RENTのカードは model_key
   （メーカー＋型番）でまとめて1機種1枚にする。available は status=在庫 の個体数、
   rental_available はそのうち rental_eligible=true（8RENTに出すと選んだ）個体数、
   procurement_available は在庫0でも申込を受けられるか。
   楽天の掲載（sale_listed）と、楽天でいま購入できる数量（sale_available）は別の列で持つ。
   シリアル・仕入価格・利用者・備考・管理番号は含めない。';


-- ------------------------------------------------------------
-- 32-6) 条件から申し込む（公開ページから anon が呼ぶ）
--
--     お客様は「機種と条件と台数」だけを選ぶ。どの個体を貸すかはこの関数が決める
--     （管理番号は公開ページに出さないし、受け取りもしない）。
--
--     p_codes … 条件に合った商品コード。同じメーカー＋型番の枝番だけを受け付け、
--               レンタルを受け付けていないものは黙って落とす。
--     p_office … Officeを付けるか。Officeは別商品ではなく申込のオプションとして扱い、
--               true のときは office_supported の枝番からだけ割り当てる。
--
--     割り当て … 台数ぶん inv_reserve_available_item() を繰り返す。楽天の販売予約と
--               同じ入口なので、同じ1台が二重に確保されることはない。
--     足りないとき … 取り寄せできる商品なら「調達確認」で受け付け、足りないぶんを
--               procure_qty に残す。仮の個体は作らない。
--               取り寄せできないなら例外にして、確保した個体もまとめて戻す。
-- ------------------------------------------------------------
create or replace function public.inv_rental_apply(
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
  v_codes   text[] := '{}';
  v_keys    text[];
  v_key     text;
  v_code    text;
  v_item    text;
  v_items   text[] := '{}';
  v_alloc   integer;
  v_short   integer;
  v_status  text;
  v_procure boolean;
  v_req_id  bigint;
  v_label   text;
  i         integer;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'お名前を入力してください';
  end if;
  if coalesce(p_qty, 1) < 1 or coalesce(p_qty, 1) > 50 then
    raise exception '台数は1〜50台でお願いします（まとまった台数はご相談ください）';
  end if;
  if p_codes is null or coalesce(array_length(p_codes, 1), 0) = 0 then
    raise exception '機種が選ばれていません';
  end if;

  -- 公開していてレンタルを受け付けている枝番だけに絞る（Office希望ならOffice対応だけ）
  select array_agg(code order by code), array_agg(distinct public.inv_model_key(maker, model, code))
    into v_codes, v_keys
    from public.inventory_products
   where code = any(p_codes)
     and kind = 'individual'
     and coalesce(rental_enabled, false)
     and (not coalesce(p_office, false) or coalesce(office_supported, false));

  if coalesce(array_length(v_codes, 1), 0) = 0 then
    raise exception 'この条件でレンタルを受け付けている機種がありません';
  end if;
  if coalesce(array_length(v_keys, 1), 0) > 1 then
    raise exception '別々の機種はまとめて申し込めません';
  end if;
  v_key := v_keys[1];

  -- 在庫の多い枝番から順に確保する（同じ機種の中でどれになるかは在庫任せ）
  select array_agg(x.code order by x.n desc, x.code) into v_codes
    from (select p.code,
                 (select count(*) from public.inventory_items i
                   where i.product_code = p.code and i.status = '在庫'
                     and coalesce(i.rental_eligible, false)) as n
            from public.inventory_products p
           where p.code = any(v_codes)) x;

  for i in 1..p_qty loop
    v_item := null;
    foreach v_code in array v_codes loop
      v_item := public.inv_reserve_available_item(v_code, '予約中', true);
      exit when v_item is not null;
    end loop;
    exit when v_item is null;
    v_items := array_append(v_items, v_item);
  end loop;

  v_alloc := coalesce(array_length(v_items, 1), 0);
  v_short := p_qty - v_alloc;

  if v_short > 0 then
    select bool_or(coalesce(procurement_available, false)) into v_procure
      from public.inventory_products where code = any(v_codes);
    if not coalesce(v_procure, false) then
      -- 確保したぶんも含めて、この例外で全部もとに戻る
      raise exception 'あいにく、この機種はいまレンタルできる台数が足りません（ご希望 %台／ご用意できる %台）',
        p_qty, v_alloc;
    end if;
    v_status := '調達確認';
  else
    v_status := '申込';
  end if;

  select coalesce(name, model) into v_label
    from public.inventory_products
   where code = coalesce((select product_code from public.inventory_items where id = v_items[1]), v_codes[1]);

  if v_alloc > 0 then
    foreach v_item in array v_items loop
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values ('8RENT', 'item', v_item, v_label, '予約', '在庫', '予約中（' || btrim(p_name) || '）');
    end loop;
  end if;

  insert into public.inventory_rental_requests
    (product_code, item_id, item_ids, qty, procure_qty, office, model_key, conditions,
     customer_name, company, email, phone, start_date, months, message, status)
  values
    (coalesce((select product_code from public.inventory_items where id = v_items[1]), v_codes[1]),
     v_items[1], v_items, p_qty, v_short, coalesce(p_office, false), v_key,
     coalesce(p_conditions, '{}'::jsonb),
     btrim(p_name), nullif(btrim(coalesce(p_company,'')),''),
     nullif(btrim(coalesce(p_email,'')),''), nullif(btrim(coalesce(p_phone,'')),''),
     p_start, p_months, nullif(btrim(coalesce(p_message,'')),''), v_status)
  returning id into v_req_id;

  return jsonb_build_object(
    'request_id', v_req_id, 'status', v_status, 'qty', p_qty,
    'allocated', v_alloc, 'procure_qty', v_short,
    'item_count', v_alloc);
end $$;

comment on function public.inv_rental_apply is
  '8RENTからのレンタル申込。お客様は条件（機種の枝番）・台数・Office有無だけを選び、
   どの個体を貸すかはこの関数が在庫から決める（管理番号は受け取らない）。
   在庫が足りないときは、取り寄せできる商品なら「調達確認」で受け付け、
   足りないぶんを procure_qty に残す。仮の個体は作らない。
   確保には楽天の販売予約と共通の inv_reserve_available_item を使うので、二重に確保されることはない。';


-- ------------------------------------------------------------
-- 32-7) これまでの1台ぶんの申込は、条件申込の薄い包みにする
--     入口を2つ持つと割り当ての規則が二重になるため、中身は同じものを通す。
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
begin
  return public.inv_rental_apply(
    array[p_code], p_name, 1, p_company, p_email, p_phone, p_start, p_months, false, p_message);
end $$;

comment on function public.inv_rental_request is
  '商品コードを1つ指定する、1台ぶんのレンタル申込。中身は inv_rental_apply と同じ
   （割り当ての規則を二重に持たない）。';


-- ------------------------------------------------------------
-- 32-8) 取り寄せぶんに個体を割り当てる（社内・/zaiko側の操作）
--     調達した現物を /zaiko に登録して「8RENTに出す」としたあと、この関数で
--     申込に割り当てる。ここでも仮の個体は作らない。
--     台数がそろったら「申込」（＝発送待ち）に進む。
-- ------------------------------------------------------------
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
  if r.status not in ('調達確認', '申込') then
    raise exception '「%」の申込には個体を割り当てられません', r.status;
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
              '予約中（申込 #' || r.id || '／取り寄せぶん）');
    end loop;
  end if;

  update public.inventory_rental_requests
     set item_ids    = v_ids,
         item_id     = coalesce(v_ids[1], item_id),
         procure_qty = greatest(coalesce(r.qty, 1) - coalesce(array_length(v_ids, 1), 0), 0),
         status      = case when coalesce(array_length(v_ids, 1), 0) >= coalesce(r.qty, 1)
                            then '申込' else r.status end
   where id = p_request_id
  returning * into r;

  return r;
end $$;

comment on function public.inv_rental_allocate is
  '取り寄せ（調達確認）の申込に、8RENT対象の在庫から個体を割り当てる。
   台数がそろったら「申込」（発送待ち）に進む。在庫が無いときは仮の個体を作らず、
   割り当てられたぶんだけ進めて残りを procure_qty に残す。';


-- ------------------------------------------------------------
-- 32-9) 申込の状態を進める（複数台・取り寄せに対応）
--       申込に紐づく個体すべての状態を、同じトランザクションで連動させる。
--         貸出中   … 発送した（個体: 予約中 → 貸出中）＝貸出確定
--         返却済み … 戻ってきた（個体: 貸出中 → 在庫）
--         キャンセル … 申込を取り消す（予約中の個体だけ 在庫 に戻す）
-- ------------------------------------------------------------
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
  -- 「申込」へ戻す操作は無い（inv_rental_apply／inv_rental_allocate だけがその状態にする）
  if p_status not in ('貸出中','返却済み','キャンセル') then
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

  if p_status = '貸出中' then
    if r.status = '調達確認' then
      raise exception '取り寄せの確認中です。調達した個体を登録してから「個体を割り当てる」を先に行ってください';
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
    -- キャンセルは「発送前」だけ。発送済み（貸出中）はキャンセルではなく返却済みで扱う。
    -- 取り寄せ待ちで1台も割り当たっていない申込も、そのまま取り消せる。
    foreach v_id in array coalesce(v_ids, '{}'::text[]) loop
      select * into it from public.inventory_items where id = v_id for update;
      if coalesce(it.status, '') <> '予約中' then
        raise exception '予約中の個体だけキャンセルできます（発送済みは「返却済みにする」を使ってください。% は %）',
          v_id, coalesce(it.status, '個体なし');
      end if;
      update public.inventory_items set status = '在庫' where id = v_id;
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
  'レンタル申込の状態を進める。紐づく個体（複数台）の状態も同じトランザクションで連動させる。
   取り寄せ待ち（調達確認）は、個体を割り当ててからでないと貸出中にできない。';


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
-- 32-10) 権限
-- ------------------------------------------------------------
grant execute on function public.inv_model_key(text,text,text) to anon, authenticated;
grant execute on function public.inv_rental_apply(text[],text,integer,text,text,text,date,integer,boolean,text,jsonb) to anon;
grant execute on function public.inv_rental_allocate(bigint) to authenticated;
grant execute on function public.inv_product_procurement_set(text,boolean) to authenticated;
grant select on public.inv_public_catalog to anon, authenticated;

commit;
