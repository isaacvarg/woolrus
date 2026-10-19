#!/usr/bin/env bash
# Pulls a real WooCommerce store into a throwaway database to check how real orders map
# (SPEC-store-sync open questions: bins, bundles/ACF, Rush Order, first import window).
# Read-only towards the store: it only runs the sync's GET requests. See README.md here.
#
#   scripts/realtest/realtest.sh up        create + migrate the woolrus_realtest database
#   scripts/realtest/realtest.sh check     Test connection: reach the store, read its units
#   scripts/realtest/realtest.sh pull      import the store's processing orders (+ their products)
#   scripts/realtest/realtest.sh products  sync the whole product catalog
#   scripts/realtest/realtest.sh report    summarise what came in
#   scripts/realtest/realtest.sh web       browse it at http://localhost:3300 (production build)
#   scripts/realtest/realtest.sh down      drop the database (deletes the imported customer data)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/realtest"
ENV_FILE="${REALTEST_ENV_FILE:-$ROOT/.env.realtest}"
DB_NAME="woolrus_realtest"
WEB_PORT=3300

die() { echo "realtest: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "no .env.realtest; copy .env.realtest.example and fill it in"
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

: "${REALTEST_DATABASE_URL:?set REALTEST_DATABASE_URL in .env.realtest}"
# Guard: this script drops its database, so it only ever touches one with this exact name.
db_path="${REALTEST_DATABASE_URL%%\?*}"
[[ "${db_path##*/}" == "$DB_NAME" ]] || die "REALTEST_DATABASE_URL must name the database $DB_NAME"
ADMIN_URL="${db_path%/*}/postgres"

# Everything below runs against the throwaway database and the real store. Exported variables win
# over the root .env that each app loads, so nothing here can reach the dev database.
export DATABASE_URL="$REALTEST_DATABASE_URL"

store_env() {
  : "${REALTEST_WOO_URL:?set REALTEST_WOO_URL in .env.realtest}"
  : "${REALTEST_WOO_CONSUMER_KEY:?set REALTEST_WOO_CONSUMER_KEY in .env.realtest}"
  : "${REALTEST_WOO_CONSUMER_SECRET:?set REALTEST_WOO_CONSUMER_SECRET in .env.realtest}"
  export WOO_URL="$REALTEST_WOO_URL"
  export WOO_CONSUMER_KEY="$REALTEST_WOO_CONSUMER_KEY"
  export WOO_CONSUMER_SECRET="$REALTEST_WOO_CONSUMER_SECRET"
  # No webhooks in this test: nothing is registered on the real store.
  export WOO_WEBHOOK_SECRET=""
}

psql_admin() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -Atq "$@"; }

case "${1:-}" in
  up)
    if [[ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" == "1" ]]; then
      echo "database $DB_NAME exists"
    else
      psql_admin -c "CREATE DATABASE $DB_NAME"
      echo "created database $DB_NAME"
    fi
    # Migrations only: no seed, so no demo orders mix with the real ones.
    pnpm --dir "$ROOT" --filter @woolrus/db migrate:deploy
    ;;
  check)
    store_env
    cd "$ROOT/apps/worker"
    NODE_ENV=development ./node_modules/.bin/tsx --env-file-if-exists=../../.env "$HERE/check.mts"
    ;;
  pull | products)
    store_env
    cd "$ROOT/apps/worker"
    NODE_ENV=development ./node_modules/.bin/tsx --env-file-if-exists=../../.env src/cli.ts "$1"
    ;;
  report)
    psql "$REALTEST_DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off -f "$HERE/report.sql"
    ;;
  web)
    # A production build: `next dev` can't run twice in one folder. Sign in with an ADMIN_EMAILS
    # address; the magic link is printed here.
    pnpm --dir "$ROOT" --filter @woolrus/web build
    export BETTER_AUTH_URL="http://localhost:$WEB_PORT"
    pnpm --dir "$ROOT" --filter @woolrus/web exec next start --port "$WEB_PORT"
    ;;
  down)
    read -r -p "Drop $DB_NAME and the store data in it? [y/N] " answer
    [[ "$answer" == "y" ]] || die "kept $DB_NAME"
    psql_admin -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)"
    echo "dropped $DB_NAME"
    ;;
  *)
    sed -n '5,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
