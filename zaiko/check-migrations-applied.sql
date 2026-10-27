-- ============================================================
-- 本番DBに、どのmigrationまで当たっているかを調べる
--
--   使いかた：Supabase の SQL Editor にこのファイルを丸ごと貼って実行するだけ。
--             読み取りだけで、DBは何も変わりません。
--
--   なぜ要るか：このリポジトリは migration を記録する表を持たない運用
--             （SQL Editor で人がファイル名順に流す）なので、どこまで
--             当たっているかはDBの中身から読むしかありません。
--             実際に 2026-09-19-sale-flow.sql の流し忘れが起きています。
--
--   考えかた：migration ごとに「そのファイルで初めて作られる物」（表・列・
--             関数・ビュー）を並べています。その物が無ければ、その migration は
--             まだ当たっていません。新しい物を作らないmigrationは、
--             security definer や外部キーの向きなど、別の目印で見ています。
--
--   読みかた：「★ 当たっていない」「△ 途中まで」の行を、上から順に流してください。
--             権限まわりの細かい点検は zaiko/check-rpc-permissions.sql です。
-- ============================================================

with want (mig, kind, obj, col) as (
  values
    ('2026-09-18-channel-listings-split.sql','table','inventory_channel_listings',null),
    ('2026-09-18-rakuten-external-item-code.sql','column','inventory_channel_listings','external_item_code'),
    ('2026-09-19-dashboard-data-quality.sql','function','inv_dashboard_stats',null),
    ('2026-09-19-item-rental-eligible.sql','column','inventory_items','rental_eligible'),
    ('2026-09-19-item-rental-eligible.sql','column','inventory_loans','due_on'),
    ('2026-09-19-item-rental-eligible.sql','function','inv_items_bulk_op',null),
    ('2026-09-19-item-rental-eligible.sql','view','inv_channel_stock_feed',null),
    ('2026-09-19-item-rental-eligible.sql','view','inv_public_catalog',null),
    ('2026-09-19-listings-from-items.sql','function','inv_listing_from_items',null),
    ('2026-09-19-public-catalog.sql','function','inv_product_images_set',null),
    ('2026-09-19-rakuten-image-sync.sql','column','inventory_channel_listings','url_candidate'),
    ('2026-09-19-rakuten-image-sync.sql','column','inventory_channel_listings','url_checked_at'),
    ('2026-09-19-rakuten-image-sync.sql','function','inv_img_hires',null),
    ('2026-09-19-rakuten-image-sync.sql','function','inv_listing_url_accept',null),
    ('2026-09-19-rakuten-image-sync.sql','function','inv_listing_url_dismiss',null),
    ('2026-09-19-rakuten-image-sync.sql','function','inv_norm_url',null),
    ('2026-09-19-rakuten-image-sync.sql','function','inv_rakuten_sync_targets',null),
    ('2026-09-19-rakuten-orders.sql','table','inventory_sale_orders',null),
    ('2026-09-19-rakuten-orders.sql','function','inv_listing_product',null),
    ('2026-09-19-rakuten-orders.sql','function','inv_sale_order_link',null),
    ('2026-09-19-rakuten-orders.sql','function','inv_sale_orders_apply',null),
    ('2026-09-19-rental-by-condition.sql','column','inventory_products','procurement_available'),
    ('2026-09-19-rental-by-condition.sql','column','inventory_rental_requests','qty'),
    ('2026-09-19-rental-by-condition.sql','function','inv_model_key',null),
    ('2026-09-19-rental-by-condition.sql','function','inv_product_procurement_set',null),
    ('2026-09-19-rental-by-condition.sql','function','inv_rental_allocate',null),
    ('2026-09-19-rental-form-master.sql','function','inv_rental_text',null),
    ('2026-09-19-rental-inquiry.sql','column','inventory_products','sale_description'),
    ('2026-09-19-rental-inquiry.sql','function','inv_product_rental_description_set',null),
    ('2026-09-19-rental-inquiry.sql','function','inv_rental_request_create',null),
    ('2026-09-19-rental-inquiry.sql','function','inv_rental_text_fill',null),
    ('2026-09-19-rental-text-by-category.sql','column','inventory_products','rental_form'),
    ('2026-09-19-rental-text-by-category.sql','function','inv_product_rental_form_set',null),
    ('2026-09-19-rental-text-by-category.sql','function','inv_rental_form',null),
    ('2026-09-19-rental-text-by-category.sql','function','inv_rental_unclassified',null),
    ('2026-09-19-rental-text-fill-admin-fix.sql','function','inv_can_maintain',null),
    ('2026-09-19-rental-text-fill-admin-fix.sql','function','inv_is_db_session',null),
    ('2026-09-19-sale-flow.sql','table','inventory_channel_settings',null),
    ('2026-09-19-sale-flow.sql','column','inventory_channel_listings','admin_url'),
    ('2026-09-19-sale-flow.sql','column','inventory_items','sold_channel'),
    ('2026-09-19-sale-flow.sql','function','inv_channel_settings_set',null),
    ('2026-09-19-sale-flow.sql','function','inv_item_sell',null),
    ('2026-09-19-sale-flow.sql','function','inv_listing_admin_url_set',null),
    ('2026-09-20-master-management.sql','column','inventory_categories','aliases'),
    ('2026-09-20-master-management.sql','column','inventory_categories','enabled'),
    ('2026-09-20-master-management.sql','column','inventory_categories','parent_id'),
    ('2026-09-20-master-management.sql','column','inventory_locations','enabled'),
    ('2026-09-20-master-management.sql','function','inv_category_delete',null),
    ('2026-09-20-master-management.sql','function','inv_category_delete_check',null),
    ('2026-09-20-master-management.sql','function','inv_category_resolve',null),
    ('2026-09-20-master-management.sql','function','inv_category_save',null),
    ('2026-09-20-master-management.sql','function','inv_location_delete',null),
    ('2026-09-20-master-management.sql','function','inv_location_delete_check',null),
    ('2026-09-20-master-management.sql','function','inv_location_save',null),
    ('2026-09-20-master-management.sql','view','inv_public_categories',null),
    ('2026-09-20-public-categories.sql','column','inventory_categories','public_icon'),
    ('2026-09-20-public-categories.sql','column','inventory_categories','public_listed'),
    ('2026-09-20-public-categories.sql','column','inventory_categories','public_name'),
    ('2026-09-20-public-categories.sql','column','inventory_categories','public_sort'),
    ('2026-09-21-deals.sql','table','inventory_deals',null),
    ('2026-09-21-deals.sql','column','inventory_rental_requests','deal_id'),
    ('2026-09-21-deals.sql','function','inv_deal_create',null),
    ('2026-09-21-deals.sql','function','inv_deal_note',null),
    ('2026-09-21-deals.sql','function','inv_deal_set_status',null),
    ('2026-09-21-sale-catalog.sql','column','inventory_deals','product_code'),
    ('2026-09-21-sale-catalog.sql','column','inventory_products','sale_enabled'),
    ('2026-09-21-sale-catalog.sql','function','inv_product_sale_set',null),
    ('2026-09-21-sale-catalog.sql','view','inv_public_products',null),
    ('2026-09-22-quotes.sql','table','inventory_quote_items',null),
    ('2026-09-22-quotes.sql','table','inventory_quotes',null),
    ('2026-09-22-quotes.sql','function','inv_quote_cancel',null),
    ('2026-09-22-quotes.sql','function','inv_quote_create',null),
    ('2026-09-22-quotes.sql','function','inv_quote_decide',null),
    ('2026-09-22-quotes.sql','function','inv_quote_item_delete',null),
    ('2026-09-22-quotes.sql','function','inv_quote_item_save',null),
    ('2026-09-22-quotes.sql','function','inv_quote_no',null),
    ('2026-09-22-quotes.sql','function','inv_quote_present',null),
    ('2026-09-22-quotes.sql','function','inv_quote_public',null),
    ('2026-09-22-quotes.sql','function','inv_quote_set',null),
    ('2026-09-22-quotes.sql','view','inv_quote_totals',null),
    ('2026-09-24-public-api-only.sql','table','inventory_public_access',null),
    ('2026-09-24-public-api-only.sql','column','inventory_public_access','kind'),
    ('2026-09-24-public-api-only.sql','function','inv_public_access_check',null),
    ('2026-09-24-public-api-only.sql','function','inv_public_access_cleanup',null),
    ('2026-09-25-contracts.sql','table','inventory_contract_items',null),
    ('2026-09-25-contracts.sql','table','inventory_contracts',null),
    ('2026-09-25-contracts.sql','function','inv_contract_billing_set',null),
    ('2026-09-25-contracts.sql','function','inv_contract_can_fulfill',null),
    ('2026-09-25-contracts.sql','function','inv_contract_cancel',null),
    ('2026-09-25-contracts.sql','function','inv_contract_confirm',null),
    ('2026-09-25-contracts.sql','function','inv_contract_create',null),
    ('2026-09-25-contracts.sql','function','inv_contract_credit_approve',null),
    ('2026-09-25-contracts.sql','function','inv_contract_item_delete',null),
    ('2026-09-25-contracts.sql','function','inv_contract_item_save',null),
    ('2026-09-25-contracts.sql','function','inv_contract_no',null),
    ('2026-09-25-contracts.sql','function','inv_contract_recalc',null),
    ('2026-09-25-contracts.sql','function','inv_contract_set',null),
    ('2026-09-25-contracts.sql','function','inv_contract_terms_confirm',null),
    ('2026-09-26-invoices.sql','table','inventory_contract_invoice_lines',null),
    ('2026-09-26-invoices.sql','table','inventory_contract_invoices',null),
    ('2026-09-26-invoices.sql','table','inventory_contract_payments',null),
    ('2026-09-26-invoices.sql','function','inv_contract_invoice_add',null),
    ('2026-09-26-invoices.sql','function','inv_contract_invoice_cancel',null),
    ('2026-09-26-invoices.sql','function','inv_contract_invoice_issue',null),
    ('2026-09-26-invoices.sql','function','inv_contract_invoice_ready',null),
    ('2026-09-26-invoices.sql','function','inv_contract_invoice_set',null),
    ('2026-09-26-invoices.sql','function','inv_contract_invoices_generate',null),
    ('2026-09-26-invoices.sql','function','inv_contract_invoices_refresh',null),
    ('2026-09-26-invoices.sql','function','inv_contract_payment_add',null),
    ('2026-09-26-invoices.sql','function','inv_contract_payment_delete',null),
    ('2026-09-26-invoices.sql','function','inv_contract_payment_recalc',null),
    ('2026-09-26-invoices.sql','function','inv_invoice_no_next',null),
    ('2026-09-26-invoices.sql','function','inv_invoice_recalc',null),
    ('2026-09-26-invoices.sql','function','inv_month_day',null),
    ('2026-09-26-invoices.sql','view','inv_contract_invoice_list',null),
    ('2026-09-27-contract-fulfillment.sql','table','inventory_contract_fulfillments',null),
    ('2026-09-27-contract-fulfillment.sql','column','inventory_contract_items','rental_request_id'),
    ('2026-09-27-contract-fulfillment.sql','function','inv_contract_fulfill_release',null),
    ('2026-09-27-contract-fulfillment.sql','function','inv_contract_fulfill_start',null),
    ('2026-09-27-contract-fulfillment.sql','function','inv_contract_fulfillment_recalc',null),
    ('2026-09-27-contract-fulfillment.sql','view','inv_contract_fulfillment_list',null),
    ('2026-09-28-contract-customer.sql','function','inv_contract_allowed_methods_set',null),
    ('2026-09-28-contract-customer.sql','function','inv_contract_customer_confirm',null),
    ('2026-09-28-contract-customer.sql','function','inv_contract_public',null),
    ('2026-09-28-contract-customer.sql','function','inv_contract_token_issue',null),
    ('2026-09-29-listing-admin-search.sql','column','inventory_channel_settings','admin_search_url_template'),
    ('2026-09-29-listing-admin-search.sql','function','inv_admin_url_check',null),
    ('2026-10-03-rental-no-product.sql','function','inv_rental_request_product_set',null)
),
mig (mig) as (
  values
    ('2026-09-18-channel-listings-split.sql'),
    ('2026-09-18-rakuten-external-item-code.sql'),
    ('2026-09-19-dashboard-data-quality.sql'),
    ('2026-09-19-dashboard-pl.sql'),
    ('2026-09-19-item-rental-eligible.sql'),
    ('2026-09-19-listings-from-items.sql'),
    ('2026-09-19-public-catalog.sql'),
    ('2026-09-19-rakuten-image-sync.sql'),
    ('2026-09-19-rakuten-orders.sql'),
    ('2026-09-19-rental-by-condition.sql'),
    ('2026-09-19-rental-form-master.sql'),
    ('2026-09-19-rental-inquiry.sql'),
    ('2026-09-19-rental-sale-channels.sql'),
    ('2026-09-19-rental-text-by-category.sql'),
    ('2026-09-19-rental-text-fill-admin-fix.sql'),
    ('2026-09-19-sale-flow.sql'),
    ('2026-09-20-master-management.sql'),
    ('2026-09-20-public-categories.sql'),
    ('2026-09-21-deals.sql'),
    ('2026-09-21-rakuten-order-sync.sql'),
    ('2026-09-21-sale-catalog.sql'),
    ('2026-09-22-quotes.sql'),
    ('2026-09-23-quote-api-only.sql'),
    ('2026-09-24-public-api-only.sql'),
    ('2026-09-25-contracts.sql'),
    ('2026-09-26-invoices.sql'),
    ('2026-09-27-contract-fulfillment.sql'),
    ('2026-09-28-contract-customer.sql'),
    ('2026-09-29-listing-admin-search.sql'),
    ('2026-09-30-listing-admin-anon-revoke.sql'),
    ('2026-10-01-rpc-permission-hardening.sql'),
    ('2026-10-02-rental-api-only.sql'),
    ('2026-10-03-rental-no-product.sql'),
    ('2026-10-04-rental-product-fk-set-null.sql')
),
-- 新しい物を作らないmigration（権限や定義だけを直すもの）は、別の目印で見る
special (mig, how, ok, memo) as (
  values
    ('2026-09-19-dashboard-pl.sql',
     'inv_dashboard_stats が gross_profit を返す',
     (select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname='public' and p.proname='inv_dashboard_stats'
                        and pg_get_functiondef(p.oid) like '%gross_profit%')), false),
    ('2026-09-19-rental-sale-channels.sql',
     'ビュー inv_public_catalog / inv_channel_stock_feed は、あとのmigrationで作り直されていて目印が残りません',
     null, true),
    ('2026-09-21-rakuten-order-sync.sql',
     'inv_sale_orders_apply が security definer',
     (select bool_or(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='inv_sale_orders_apply'), false),
    ('2026-09-23-quote-api-only.sql',
     'あとの 2026-09-24-public-api-only.sql に置き換わった（そちらの判定を見る）',
     null, true),
    ('2026-09-30-listing-admin-anon-revoke.sql',
     'あとの 2026-10-01-rpc-permission-hardening.sql に含まれる（そちらの判定を見る）',
     null, true),
    ('2026-10-01-rpc-permission-hardening.sql',
     'inv_channel_settings_set が security definer',
     (select bool_or(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='inv_channel_settings_set'), false),
    ('2026-10-02-rental-api-only.sql',
     'anon は inv_rental_request_create を呼べず、inv_norm_model は呼べる',
     (select to_regrole('anon') is not null
         and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname='public' and p.proname='inv_rental_request_create'
                            and has_function_privilege('anon', p.oid, 'execute'))
         and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname='public' and p.proname='inv_norm_model'
                        and has_function_privilege('anon', p.oid, 'execute'))), false),
    ('2026-10-04-rental-product-fk-set-null.sql',
     '外部キー inventory_rental_requests.product_code が ON DELETE SET NULL',
     (select bool_or(c.confdeltype = 'n') from pg_constraint c
       where c.conname = 'inventory_rental_requests_product_code_fkey'), false)
),
found as (
  select w.mig, w.kind, w.obj, w.col,
         case w.kind
           when 'table'  then to_regclass('public.' || w.obj) is not null
           when 'view'   then to_regclass('public.' || w.obj) is not null
           when 'column' then exists (
             select 1 from information_schema.columns c
              where c.table_schema = 'public' and c.table_name = w.obj
                and c.column_name = w.col)
           when 'function' then exists (
             select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = w.obj)
         end as ok
    from want w
)
select
  m.mig                                        as "migration",
  case when count(f.*) > 0 then count(f.*)::text else '—' end          as "確かめる物",
  case when count(f.*) > 0
       then count(*) filter (where not f.ok)::text else '—' end        as "足りない",
  case
    when count(f.*) = 0 and s.memo            then '— ' || s.how
    when count(f.*) = 0 and s.how is null     then '— 目印がありません'
    when count(f.*) = 0 and coalesce(s.ok, false) then '当たっている（' || s.how || '）'
    when count(f.*) = 0                       then '★ 当たっていない（' || s.how || '）'
    when count(*) filter (where not f.ok) = 0 then '当たっている'
    when count(*) filter (where f.ok) = 0     then '★ 当たっていない'
    else '△ 途中まで（部分適用のおそれ）'
  end                                          as "判定",
  coalesce(string_agg(
    f.obj || coalesce('.' || f.col, '') || '（' || f.kind || '）', '、'
    order by f.obj) filter (where not f.ok), '')  as "足りない物"
from mig m
left join found f   on f.mig = m.mig
left join special s on s.mig = m.mig
group by m.mig, s.ok, s.how, s.memo
order by m.mig;
