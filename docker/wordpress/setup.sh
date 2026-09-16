#!/bin/sh
# Installs WooCommerce + WPGraphQL + WooGraphQL, seeds products and a few
# processing orders, and prints the credentials Woolrus needs. Idempotent.
set -eu

cd /var/www/html

echo "==> Waiting for WordPress files and database"
until [ -f wp-config.php ] && wp db check >/dev/null 2>&1; do sleep 2; done

if ! wp core is-installed 2>/dev/null; then
  echo "==> Installing WordPress"
  wp core install \
    --url="$WP_URL" \
    --title="Woolrus Dev Shop" \
    --admin_user=admin \
    --admin_password=admin \
    --admin_email=admin@example.com \
    --skip-email
fi

# WPGraphQL serves /graphql only with pretty permalinks
wp rewrite structure '/%postname%/' --hard

echo "==> Installing plugins"
wp plugin install woocommerce wp-graphql wordpress-importer --activate

# Paid plugins (e.g. WooGraphQL Pro) or pinned versions go in
# docker/wordpress/plugins/ as <slug>.zip or <slug>-vX.Y.Z.zip. The version
# suffix is stripped so the plugin lands in wp-content/plugins/<slug>/ and
# replaces any existing copy instead of installing a duplicate beside it.
extra_slugs=""
mkdir -p /tmp/extra-plugins
for zip in /extra-plugins/*.zip; do
  [ -e "$zip" ] || continue
  slug=$(basename "$zip" .zip | sed 's/-v[0-9][0-9.]*$//')
  echo "==> Installing $slug from $(basename "$zip")"
  # Clean up versioned folders left by earlier runs of this script
  for stale in wp-content/plugins/"$slug"-v*; do
    if [ -d "$stale" ]; then rm -rf "$stale"; fi
  done
  cp "$zip" "/tmp/extra-plugins/$slug.zip"
  wp plugin install "/tmp/extra-plugins/$slug.zip" --force
  extra_slugs="$extra_slugs $slug"
done

if ! wp plugin is-installed wp-graphql-woocommerce; then
  wp plugin install https://github.com/wp-graphql/wp-graphql-woocommerce/releases/latest/download/wp-graphql-woocommerce.zip
fi
wp plugin activate wp-graphql-woocommerce
# shellcheck disable=SC2086
[ -z "$extra_slugs" ] || wp plugin activate $extra_slugs

wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_coming_soon no
wp option update woocommerce_default_country 'US:CA'
wp option update woocommerce_currency USD

if [ "$(wp post list --post_type=product --format=count)" -eq 0 ]; then
  echo "==> Importing WooCommerce sample products"
  wp import wp-content/plugins/woocommerce/sample-data/sample_products.xml --authors=skip
fi

if [ "$(wp wc shop_order list --user=admin --format=count)" -eq 0 ]; then
  echo "==> Creating sample processing orders"
  set -- $(wp wc product list --user=admin --type=simple --per_page=6 --format=ids)
  i=1
  while [ $# -ge 2 ]; do
    wp wc shop_order create --user=admin --status=processing --set_paid=true \
      --billing="{\"first_name\":\"Test\",\"last_name\":\"Customer $i\",\"email\":\"customer$i@example.com\",\"phone\":\"5555555555\",\"address_1\":\"1 Main St\",\"city\":\"San Francisco\",\"state\":\"CA\",\"postcode\":\"94103\",\"country\":\"US\"}" \
      --shipping="{\"first_name\":\"Test\",\"last_name\":\"Customer $i\",\"address_1\":\"1 Main St\",\"city\":\"San Francisco\",\"state\":\"CA\",\"postcode\":\"94103\",\"country\":\"US\"}" \
      --line_items="[{\"product_id\":$1,\"quantity\":1},{\"product_id\":$2,\"quantity\":2}]" \
      --porcelain
    shift 2
    i=$((i + 1))
  done
fi

echo "==> Application password for Woolrus"
wp user application-password delete admin --all >/dev/null 2>&1 || true
app_password=$(wp user application-password create admin woolrus --porcelain)

cat <<EOF

Done. WordPress admin: $WP_URL/wp-admin  (admin / admin)

Put these in your .env:
NEXT_PUBLIC_WOO_GRAPHQL_URL="$WP_URL/graphql"
WP_GRAPHQL_KEY="admin"
WP_GRAPHQL_SECRET="$app_password"
EOF
