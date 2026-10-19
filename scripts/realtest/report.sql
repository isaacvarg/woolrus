-- `realtest.sh report`: what a real store's data looks like once imported, aimed at
-- SPEC-store-sync's open questions. Counts and keys only, no customer data.

\echo '== Sync runs'
SELECT type, status, records_processed AS processed, records_failed AS failed,
       to_char(started_at, 'YYYY-MM-DD HH24:MI') AS started, error
FROM sync_runs ORDER BY started_at;

\echo '== Record errors (by message key)'
SELECT split_part(error, ': ', 1) AS error, count(*) AS records, min(external_id) AS example_id
FROM sync_run_errors GROUP BY 1 ORDER BY 2 DESC;

\echo '== Imported'
SELECT (SELECT count(*) FROM orders) AS orders,
       (SELECT count(*) FROM order_items) AS lines,
       (SELECT count(*) FROM products) AS products,
       (SELECT count(*) FROM product_variations) AS variations;

\echo '== Open question 4: first import window (orders by age)'
SELECT CASE
         WHEN ordered_at > now() - interval '7 days' THEN '1. under 7 days'
         WHEN ordered_at > now() - interval '30 days' THEN '2. 7-30 days'
         WHEN ordered_at > now() - interval '90 days' THEN '3. 30-90 days'
         ELSE '4. over 90 days'
       END AS age, count(*) AS orders,
       to_char(min(ordered_at), 'YYYY-MM-DD') AS oldest
FROM orders GROUP BY 1 ORDER BY 1;

\echo '== Product types (bundle / composite / grouped would show here)'
SELECT type, count(*) AS products, count(*) FILTER (WHERE NOT physical) AS not_physical
FROM products GROUP BY 1 ORDER BY 2 DESC;

\echo '== Open question 3: products sold but not physical (Rush Order should be here)'
SELECT p.name, p.sku, count(i.id) AS lines
FROM products p LEFT JOIN order_items i ON i.product_id = p.id
WHERE NOT p.physical GROUP BY p.id ORDER BY 3 DESC LIMIT 20;

\echo '== Physical lines with no weight (variant weight first, then the product)'
SELECT i.name, p.sku, count(*) AS lines
FROM order_items i JOIN products p ON p.id = i.product_id
LEFT JOIN product_variations v ON v.id = i.variation_id
WHERE p.physical AND coalesce(v.weight_oz, p.weight_oz) IS NULL
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15;

\echo '== Catalog completeness (products; variable products keep weight on their variations)'
SELECT count(*) AS products,
       count(*) FILTER (WHERE weight_oz IS NULL) AS no_weight,
       count(*) FILTER (WHERE length_in IS NULL) AS no_dimensions,
       count(*) FILTER (WHERE sku IS NULL) AS no_sku,
       count(*) FILTER (WHERE bin_location IS NOT NULL) AS with_bin,
       count(*) FILTER (WHERE barcode IS NOT NULL) AS with_barcode
FROM products;

\echo '== Lines without a product (deleted in the store)'
SELECT count(*) AS lines FROM order_items WHERE product_id IS NULL;

\echo '== Open question 1: product meta keys (a bin location field would show here)'
SELECT m->>'key' AS key, count(DISTINCT p.id) AS products,
       left(min(m->>'value'), 40) AS example_value
FROM products p, jsonb_array_elements(coalesce(p.raw_payload->'meta_data', '[]')) m
GROUP BY 1 ORDER BY 2 DESC LIMIT 40;

\echo '== Open question 2: line item meta keys (bundles: bundled_by / bundled_items; add-ons; ACF)'
SELECT m->>'key' AS key, count(*) AS lines
FROM order_items i, jsonb_array_elements(coalesce(i.meta_data, '[]')) m
GROUP BY 1 ORDER BY 2 DESC LIMIT 40;

\echo '== Lines linked to a bundle parent'
SELECT count(*) FILTER (WHERE bundle_parent_id IS NOT NULL) AS bundled_children FROM order_items;

\echo '== Open question 2: order meta keys (ACF and plugin fields show here; values not shown)'
SELECT m->>'key' AS key, count(*) AS orders
FROM orders o, jsonb_array_elements(coalesce(o.raw_payload->'meta_data', '[]')) m
GROUP BY 1 ORDER BY 2 DESC LIMIT 40;

\echo '== Order top-level fields beyond the standard ones (plugins adding their own)'
SELECT k AS field, count(*) AS orders
FROM orders o, jsonb_object_keys(o.raw_payload) k
WHERE k NOT IN ('id','parent_id','status','currency','version','prices_include_tax','date_created',
  'date_modified','discount_total','discount_tax','shipping_total','shipping_tax','cart_tax','total',
  'total_tax','customer_id','order_key','billing','shipping','payment_method','payment_method_title',
  'transaction_id','customer_ip_address','customer_user_agent','created_via','customer_note',
  'date_completed','date_paid','cart_hash','number','meta_data','line_items','tax_lines',
  'shipping_lines','fee_lines','coupon_lines','refunds','payment_url','is_editable','needs_payment',
  'needs_processing','date_created_gmt','date_modified_gmt','date_completed_gmt','date_paid_gmt',
  'currency_symbol','_links')
GROUP BY 1 ORDER BY 2 DESC;

\echo '== Shipping methods and currencies'
SELECT coalesce(shipping_method, '(none)') AS shipping_method, currency, count(*) AS orders
FROM orders GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;

\echo '== Orders with fees or coupons (not mapped today)'
SELECT count(*) FILTER (WHERE jsonb_array_length(coalesce(raw_payload->'fee_lines', '[]')) > 0) AS with_fees,
       count(*) FILTER (WHERE jsonb_array_length(coalesce(raw_payload->'coupon_lines', '[]')) > 0) AS with_coupons,
       count(*) FILTER (WHERE jsonb_array_length(coalesce(raw_payload->'refunds', '[]')) > 0) AS with_refunds
FROM orders;
