#!/bin/sh
# Local WooCommerce for development. Idempotent: safe to re-run.
set -eu

cd /var/www/html

echo "Waiting for WordPress files..."
until [ -f wp-config.php ]; do sleep 1; done
until wp db check >/dev/null 2>&1; do sleep 1; done

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$WP_URL" --title="Woolrus Dev Shop" \
    --admin_user=admin --admin_password=admin --admin_email=admin@example.test --skip-email
fi

wp rewrite structure '/%postname%/' >/dev/null

if ! wp plugin is-active woocommerce 2>/dev/null; then
  wp plugin install woocommerce --activate
fi

# WooCommerce only accepts basic auth (consumer key/secret) over HTTPS. Production is HTTPS; this
# dev-only must-use plugin lets the plain-HTTP local store accept it for REST requests.
mkdir -p wp-content/mu-plugins
cat > wp-content/mu-plugins/woolrus-dev-rest-auth.php <<'PHP'
<?php
// Woolrus local development only: treat REST API requests as HTTPS so WooCommerce accepts basic auth.
if ( wp_get_environment_type() === 'local' && str_contains( $_SERVER['REQUEST_URI'] ?? '', '/wp-json/' ) ) {
	$_SERVER['HTTPS'] = 'on';
}
PHP

# US store: pounds, inches, dollars.
wp option update woocommerce_weight_unit lbs >/dev/null
wp option update woocommerce_dimension_unit in >/dev/null
wp option update woocommerce_currency USD >/dev/null
wp option update woocommerce_default_country "US:CA" >/dev/null
wp option update woocommerce_store_address "100 Warehouse Way" >/dev/null
wp option update woocommerce_store_city "Los Angeles" >/dev/null
wp option update woocommerce_store_postcode "90001" >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null

# Fixed REST API key so .env.example works without copying anything:
#   WOO_CONSUMER_KEY=ck_woolrus_dev_key / WOO_CONSUMER_SECRET=cs_woolrus_dev_secret
wp eval '
global $wpdb;
$table = $wpdb->prefix . "woocommerce_api_keys";
$key = "ck_woolrus_dev_key";
if (!$wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE truncated_key = %s", substr($key, -7)))) {
  $wpdb->insert($table, [
    "user_id" => 1,
    "description" => "Woolrus dev",
    "permissions" => "read_write",
    "consumer_key" => wc_api_hash($key),
    "consumer_secret" => "cs_woolrus_dev_secret",
    "truncated_key" => substr($key, -7),
  ]);
  echo "Created WooCommerce API key\n";
}
'

if [ "$(wp wc product list --user=admin --format=count)" = "0" ]; then
  echo "Seeding products..."
  SOAP=$(wp wc product create --user=admin --porcelain --name="Lavender Bar Soap" --type=simple \
    --regular_price=8.00 --sku=SOAP-LAV --weight=0.3 --dimensions='{"length":"3","width":"2","height":"1"}' \
    --manage_stock=true --stock_quantity=120)
  SERUM=$(wp wc product create --user=admin --porcelain --name="Vitamin C Serum 1oz" --type=simple \
    --regular_price=24.00 --sku=SERUM-VC-1 --weight=0.25 --dimensions='{"length":"2","width":"2","height":"4"}' \
    --manage_stock=true --stock_quantity=40)
  LOTION=$(wp wc product create --user=admin --porcelain --name="Body Lotion" --type=variable \
    --sku=LOTION --attributes='[{"name":"Size","options":["8oz","16oz"],"visible":true,"variation":true}]')
  wp wc product_variation create "$LOTION" --user=admin --porcelain --regular_price=14.00 --sku=LOTION-8 \
    --weight=0.6 --attributes='[{"name":"Size","option":"8oz"}]' >/dev/null
  wp wc product_variation create "$LOTION" --user=admin --porcelain --regular_price=22.00 --sku=LOTION-16 \
    --weight=1.1 --attributes='[{"name":"Size","option":"16oz"}]' >/dev/null
  LOTION8=$(wp wc product_variation list "$LOTION" --user=admin --sku=LOTION-8 --field=id)

  echo "Seeding orders..."
  ADDR='{"first_name":"Ana","last_name":"Lopez","address_1":"742 Evergreen Ter","city":"Springfield","state":"OR","postcode":"97477","country":"US","email":"ana@example.test","phone":"5555550100"}'
  wp wc shop_order create --user=admin --status=processing --billing="$ADDR" --shipping="$ADDR" \
    --line_items="[{\"product_id\":$SOAP,\"quantity\":3},{\"product_id\":$SERUM,\"quantity\":1}]" \
    --shipping_lines='[{"method_id":"flat_rate","method_title":"Standard","total":"6.00"}]' >/dev/null
  ADDR2='{"first_name":"Ben","last_name":"Okafor","address_1":"1 Main St","address_2":"Apt 4","city":"Austin","state":"TX","postcode":"78701","country":"US","email":"ben@example.test"}'
  wp wc shop_order create --user=admin --status=processing --billing="$ADDR2" --shipping="$ADDR2" \
    --customer_note="Please gift wrap" \
    --line_items="[{\"product_id\":$LOTION,\"variation_id\":$LOTION8,\"quantity\":2}]" \
    --shipping_lines='[{"method_id":"flat_rate","method_title":"Express","total":"18.00"}]' >/dev/null
  wp wc shop_order create --user=admin --status=on-hold --billing="$ADDR" --shipping="$ADDR" \
    --line_items="[{\"product_id\":$SERUM,\"quantity\":2}]" >/dev/null
fi

echo "WooCommerce ready at $WP_URL (admin / admin)"
