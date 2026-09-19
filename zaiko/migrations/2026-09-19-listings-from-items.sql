-- ============================================================
-- 個体別の出品情報（inventory_channels）から、商品単位の楽天listingを補う
--
--   中古は「実物1台ごとに出品」が基本なので、楽天の出品情報は個体別に
--   入っています。ところが同じ商品ページ（同じURL）に2台以上をぶら下げて
--   いる場合、商品単位の inventory_channel_listings に楽天の行が無いままで、
--   楽天APIの画像同期の対象から漏れていました。
--
--     例）P-00536 / PROBOOK445G11
--         個体 00039769953 → https://item.rakuten.co.jp/8commerce/00039769953/
--         個体 00039770113 → 同じURL（2台で1つの掲載を共有）
--         → 商品単位の楽天listingが無いので、画像同期の対象にならなかった
--
--   この migration は、同じ状況の商品をまとめて埋めます。
--     ・channel='rakuten' の個体別の行だけを見る
--     ・同じ商品で「同じURL・同じSKU」の行だけを1件にまとめる
--     ・違う掲載（URL・SKU）が混ざっている商品は【自動で作らず】要確認に出す。
--       どれが正しい掲載かは人にしか決められないため
--     ・すでに商品単位の楽天listingがある商品は作らない（重複させない）
--     ・url / state / sku と、price は inventory_channels.price（モールでの
--       販売価格）をそのまま引き継ぐ。自社の販売予定価格（plan_price）は
--       別概念なので使わない
--     ・external_item_code はURLやSKUから推測しない。次の楽天API同期が
--       成功したときに、APIが返す正式な itemCode を保存する
--     ・元の inventory_channels は消さない
--
--   本番SupabaseのSQL Editorに貼って実行してください。何度実行しても安全です
--   （すでに作られている商品は作り直しません）。
--   実行後に /zaiko の「楽天商品を同期」→「画像が未取得の商品だけ」を回すと、
--   補完された商品にも画像が入ります。
-- ============================================================

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


-- ------------------------------------------------------------
-- あとから増えた商品用：1商品ぶんだけ同じ補完をする関数
--   （/zaiko の商品詳細「販売情報」タブから呼ぶ。取り込み直後は個体別にしか
--     出品情報が無いことがあるため、同じ漏れを繰り返さないようにする）
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

grant execute on function public.inv_listing_from_items(text,text) to authenticated;

-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
-- 1) 楽天の商品単位listingができたか（P-00536 を含む）
select l.product_code, coalesce(p.name, p.model) as 商品, l.state, l.price, l.url,
       l.external_item_code as "正式itemCode（次の同期で入る）", l.note
  from public.inventory_channel_listings l
  join public.inventory_products p on p.code = l.product_code
 where l.channel = 'rakuten'
 order by l.created_at desc nulls last, l.product_code
 limit 30;

-- 2) 要確認：個体ごとに違う楽天の掲載が混ざっていて、自動では作らなかった商品
--    （どの掲載を商品の掲載にするかを決めて、販売サイトの編集で入れてください）
select c.product_code, coalesce(p.name, p.model) as 商品,
       count(*) as 掲載の種類,
       string_agg(distinct coalesce(nullif(btrim(c.url),''), '(URLなし)'), ' / ') as URL,
       string_agg(distinct coalesce(nullif(btrim(c.sku),''), '(SKUなし)'), ' / ') as SKU
  from public.inventory_channels c
  join public.inventory_products p on p.code = c.product_code
 where c.channel = 'rakuten'
   and (nullif(btrim(coalesce(c.url,'')),'') is not null or nullif(btrim(coalesce(c.sku,'')),'') is not null)
   and not exists (select 1 from public.inventory_channel_listings l
                    where l.product_code = c.product_code and l.channel = 'rakuten')
 group by c.product_code, 商品
having count(distinct (coalesce(nullif(btrim(c.url),''),'') || '｜' || coalesce(nullif(btrim(c.sku),''),''))) > 1
 order by c.product_code;

-- 3) 画像同期の対象になったか（写真がまだ無い掲載商品）
select count(*) as "楽天に掲載中",
       count(*) filter (where jsonb_array_length(coalesce(p.images,'[]'::jsonb)) = 0
                         and nullif(p.image_url,'') is null) as "写真なし（同期の対象）"
  from public.inventory_channel_listings l
  join public.inventory_products p on p.code = l.product_code
 where l.channel = 'rakuten'
   and (nullif(btrim(coalesce(l.external_item_code,'')),'') is not null
        or nullif(btrim(coalesce(l.url,'')),'') is not null);
