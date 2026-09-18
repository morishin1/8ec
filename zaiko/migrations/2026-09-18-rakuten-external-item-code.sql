-- ============================================================
-- 楽天の itemCode 用に専用列 external_item_code を追加する migration
--
--   背景：inventory_channel_listings.sku は元々スタッフが自由に入れる
--   商品コード欄だったが、楽天連携で楽天の itemCode（例: "8commerce:l09150188"）
--   もこの列に書いていた。モールのAPIが発行する識別子と、スタッフの入力欄を
--   同じ列に混在させると意味があいまいになるため、専用列 external_item_code
--   を追加して分離する。
--
--   このファイルは setup.sql 全体ではなく、今回分の変更だけを
--   本番Supabaseの SQL Editor に貼り付けて実行するためのものです
--   （2026-09-18-channel-listings-split.sql が適用済みであることが前提）。
--   実行後は、以後の運用のため zaiko/setup.sql も最新版を通しで
--   実行しておいてください（このmigrationの内容を含んでいるので
--   二重に実行しても安全です）。
--
--   このmigrationが変更するもの：
--     1. inventory_channel_listings に external_item_code 列を追加
--        （既存の sku 列の値は変更しない。移し替えもしない）
--     2. sku ベースだった索引を、external_item_code ベースに差し替え
--     3. inv_rakuten_apply_one / inv_rakuten_sync_apply を更新し、
--        楽天の itemCode を external_item_code に書き込むようにする。
--        再照合も external_item_code、無ければURL（表記ゆれを無視して
--        比較）で行うようにする
--        （例：P-00537は url = https://item.rakuten.co.jp/8commerce/l09150188/
--         のみ登録済みで sku/external_item_code は空。この状態でも
--         URLから同じ商品だと再照合できる）
--
--   何度実行しても安全です（適用済みなら何も変わりません）。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 列を追加し、sku と external_item_code の役割を明記する
-- ------------------------------------------------------------
alter table public.inventory_channel_listings add column if not exists external_item_code text;

comment on table public.inventory_channel_listings is
  '商品×販売チャネルの「掲載」情報（1つのURL・価格を、複数の実在庫個体が共有する）。
   個体ごとの出品状態は引き続き inventory_channels（item_id必須）で管理する。';
comment on column public.inventory_channel_listings.sku is
  'スタッフが自由に入れる商品コード欄。モールのAPIが発行する識別子は external_item_code を使う（混同しない）。';
comment on column public.inventory_channel_listings.external_item_code is
  'そのモールのAPIが発行する商品識別子（楽天なら itemCode。例: "shopCode:1234567"）。
   楽天連携の再照合はこの列（無ければurl）で行う。';

-- ------------------------------------------------------------
-- 2) sku ベースの索引を external_item_code ベースに差し替える
-- ------------------------------------------------------------
drop index if exists public.inventory_channel_listings_sku_idx;
create index if not exists inventory_channel_listings_extcode_idx
  on public.inventory_channel_listings (channel, external_item_code);

-- ------------------------------------------------------------
-- 3) 楽天連携の関数を更新（itemCodeの書き込み先・再照合の両方）
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
-- 確認用クエリ：P-00537の掲載情報（実行前後で見比べてください）
-- ------------------------------------------------------------
select product_code, channel, sku, external_item_code, url, api_synced_at, api_sync_status
  from public.inventory_channel_listings
 where product_code = 'P-00537';
