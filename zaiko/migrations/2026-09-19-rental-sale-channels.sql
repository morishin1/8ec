-- ============================================================
-- 楽天＝販売チャネル／8EC＝レンタルチャネル として整理する migration
--
--   これまで inv_public_catalog は「楽天に出品中 または レンタル公開」の
--   商品を出していた（＝8ECトップが楽天の販売商品一覧も兼ねていた）。
--   8ECはレンタルサイトなので、公開条件を rental_enabled=true だけにする。
--
--   あわせて「掲載しているか」と「いま提供できる数量」を分けて持つ。
--   8ECでレンタル中でも楽天の商品ページ（listing）は消さない。消すのは
--   数量のほうで、発送できない個体（予約中・貸出中・販売予約・修理中）は
--   楽天へ送る販売可能数量に含めない。最後の1台が貸出中なら
--   「掲載は残す・購入できる数量は0」になる。
--
--   このファイルは本番SupabaseのSQL Editorに貼って実行します。
--   何度実行しても安全です（ビューの入れ直しと権限付与だけ。データは触りません）。
--
--     1. inv_public_catalog を入れ直す
--          公開条件：kind='individual' かつ rental_enabled=true
--          追加列：rental_available（レンタル可能数）
--                  sale_listed（楽天に掲載中か）
--                  sale_available（楽天でいま購入できる数量）
--          sale_enabled は掲載中かどうか（従来どおり）。購入できるかは
--          sale_available > 0 で判定する
--     2. 【新規】inv_channel_stock_feed：販売チャネルへ送る販売可能数量（社内用）
--     3. 権限（公開カタログは anon、数量フィードは authenticated だけ）
--
--   前提：zaiko/migrations/2026-09-19-public-catalog.sql を先に実行していること
--   （rental_* 列・画像列・inventory_channel_listings が揃っている状態）。
-- ============================================================

-- ------------------------------------------------------------
-- 1) inv_public_catalog：8ECトップ／8RENT 共通の公開ビュー
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
--       available / rental_available … status='在庫' の個体数。予約中・貸出中・
--             販売予約・修理中などは含めない。レンタルを受け付けられるのは
--             rental_enabled=true かつ この数が1以上のときだけ。
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
  -- 実在庫（両チャネル共通。ここから二重に確保されることはない）
  coalesce(a.available, 0)::integer                                 as available,
  coalesce(a.total_owned, 0)::integer                               as total_owned,
  -- レンタル（8EC）
  coalesce(p.rental_enabled, false)                                 as rental_enabled,
  coalesce(a.available, 0)::integer                                 as rental_available,
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
   （楽天に出品中かどうかは公開条件にしない）。available/rental_available は status=在庫 の個体数。
   楽天の掲載（sale_listed）と、楽天でいま購入できる数量（sale_available）は別の列で持つ。
   シリアル・仕入価格・利用者・備考は含めない。';

-- ------------------------------------------------------------
-- 2) inv_channel_stock_feed：販売チャネルへ送る「購入できる数量」
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
-- 3) 権限
-- ------------------------------------------------------------
grant usage on schema public to anon;
grant select on public.inv_public_catalog to anon, authenticated;
-- 販売チャネルへ送る数量は社内用（anonには出さない）
grant select on public.inv_channel_stock_feed to authenticated;

-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select count(*)                                  as "公開中の商品（機種）",
       count(*) filter (where sale_listed)        as "うち楽天に掲載中",
       count(*) filter (where sale_available > 0) as "うち楽天で購入できる",
       count(*) filter (where rental_available > 0) as "うちレンタルできる"
  from public.inv_public_catalog;
