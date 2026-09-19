-- ============================================================
-- 楽天の商品画像を商品マスターへ同期する（8ECは商品マスターだけを読む）
--
--   8ECの商品写真は「手で登録する」前提にせず、楽天に出品している商品は
--   楽天APIから取り込みます。ページ表示のたびに楽天APIを呼ぶことはしません。
--
--     inventory_channel_listings（channel='rakuten' の itemCode / 掲載URL）
--       → Edge Function rakuten-product-sync が楽天APIから画像を取得
--       → inventory_products.images に保存
--       → inv_public_catalog → 8ec.jp
--
--   画像の優先順位（公開ページ）
--     1. rental_image_url   … 8RENT用に指定したメイン画像
--     2. rental_images      … 8RENT用の画像一覧
--     3. image_url          … /zaikoで人が指定したメイン画像
--     4. images[0]          … 楽天同期などで入った画像の1枚目
--     5. 「画像準備中」
--
--   この migration で変えること
--     2. inv_rakuten_apply_one … 同期では image_url を触らない（人が指定した
--        メイン画像専用にする）。画像は images にだけ入れる。
--        返り値に images_added / image_count / external_item_code_saved を足す
--        （「画像取得成功 ○件」と、掲載URLしか無かった商品に正式なitemCodeを
--         保存できたかを数えられるようにする）
--     3. 【新規】inv_rakuten_sync_targets … 同期対象（楽天に掲載していて、
--        写真が無い商品／掲載中の全商品）を返す
--     1. 【新規】掲載URLの照合：inventory_channel_listings に url_candidate /
--        url_checked_at を足し、API同期でモール側の正式URLと違っていたら
--        「更新候補」として残す（自動では書き換えない）。
--        採用は inv_listing_url_accept()、取り消しは inv_listing_url_dismiss()
--     4. 権限
--
--   本番SupabaseのSQL Editorに貼って実行してください。何度実行しても安全です。
--   あわせて Edge Function を再デプロイしてください：
--     supabase functions deploy rakuten-product-sync
-- ============================================================


-- ------------------------------------------------------------
-- 1) 掲載URLの照合（列・正規化・採用/取り消し）
-- ------------------------------------------------------------
alter table public.inventory_channel_listings add column if not exists url_candidate text;
alter table public.inventory_channel_listings add column if not exists url_checked_at timestamptz;
comment on column public.inventory_channel_listings.url_candidate is
  'API同期でモール側の正式URLが保存済みURLと違ったときに入る更新候補。inv_listing_url_accept() で採用、
   inv_listing_url_dismiss() で取り消す。自動では書き換えない。';

-- ------------------------------------------------------------
-- 30-1c) 掲載URLの照合まわり
--
--     モール側で商品ページのURLが変わることがある（作り直し・番号の振り直し）。
--     保存済みURLが古いままだと、itemCodeが分かるまでAPIで商品を見つけられない
--     （P-00537：保存 …/l09150188/ ／ 実際 …/00039769233/ ）。
--     そこでAPI同期のたびに正式URLと見比べ、違えば url_candidate に置いて人に見せる。
--     自動で書き換えないのは、URLは人が入れた値でもあるため。
-- ------------------------------------------------------------
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
-- 2) 楽天から取り込んだ1商品を反映する（画像は images だけに入れる・URL差異を検知）
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
    description       = coalesce(nullif(description,''), nullif(p_item->>'caption','')),
    -- 画像は images（楽天から取り込んだ写真）にだけ入れる。image_url は
    -- 「人が/zaikoで指定したメイン画像」専用にして、同期では一切触らない。
    -- 公開ページは image_url → images[0] の順に見るので、これで写真は出る
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
-- 3) 同期対象の商品を返す
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
-- 4) 権限
-- ------------------------------------------------------------
grant execute on function public.inv_rakuten_apply_one(text,jsonb) to authenticated;
grant execute on function public.inv_rakuten_sync_targets(text) to authenticated;
grant execute on function public.inv_listing_url_accept(text,text) to authenticated;
grant execute on function public.inv_listing_url_dismiss(text,text) to authenticated;

-- ------------------------------------------------------------
-- 確認：楽天に掲載している商品と、写真の有無
-- ------------------------------------------------------------
select count(*) filter (where nullif(btrim(coalesce(l.url_candidate,'')),'') is not null) as "掲載URLの更新候補",
       count(*) as "楽天に掲載中",
       count(*) filter (where jsonb_array_length(coalesce(p.images,'[]'::jsonb)) > 0
                           or nullif(p.image_url,'') is not null) as "写真あり",
       count(*) filter (where jsonb_array_length(coalesce(p.images,'[]'::jsonb)) = 0
                         and nullif(p.image_url,'') is null)      as "写真なし（同期の対象）"
  from public.inventory_channel_listings l
  join public.inventory_products p on p.code = l.product_code
 where l.channel = 'rakuten'
   and (nullif(btrim(coalesce(l.external_item_code,'')),'') is not null
        or nullif(btrim(coalesce(l.url,'')),'') is not null);
