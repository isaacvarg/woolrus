# Woolrus
Woolrus streamlines WooCommerce order fulfillment by providing warehouse staff with the ability to pick, pack, QA and generate shipping labels all in one place. 

# Dependencies

- WooCommerce
- [WPGraphQL](https://www.wpgraphql.com)
- [WooGraphQL](https://woographql.com)
- [WooGraphQL Pro](https://woographql.com)

# Getting Started

- Ensure dependencies installed on your Wordpress
- `pnpm install`
- `pnpm run dev`

Docker image coming. 

# Local Development

`docker-compose.yml` runs everything the app depends on (Postgres, S3 storage and a
WordPress/WooCommerce shop); the Next.js app itself runs on the host.

| Service     | URL                                                | Credentials                  |
| ----------- | -------------------------------------------------- | ---------------------------- |
| Postgres    | `localhost:5432`                                   | `woolrus` / `woolrus`        |
| RustFS (S3) | `localhost:9000` (console `http://localhost:9001`) | `woolrus` / `woolrus-secret` |
| WordPress   | `http://localhost:8080`                            | `admin` / `admin`            |

Requires Docker (with the Compose plugin), Node 20+ and pnpm.

### 1. Start the services

```bash
docker compose up -d
```

### 2. Set up WordPress

```bash
docker compose run --rm wp-setup
```

Installs WooCommerce, WPGraphQL and WooGraphQL, seeds sample products and orders, and
prints an application password. It is safe to re-run. Put WooGraphQL Pro's zip in
`docker/wordpress/plugins/` before running it if you have a licence, since paid plugins
can't be downloaded automatically. Name any zip you add `<slug>.zip` or
`<slug>-vX.Y.Z.zip`; the setup script strips the version so the plugin replaces the free
copy instead of installing a duplicate beside it (two copies fatal with
`Cannot redeclare ...`).

### 3. Configure the app

```bash
cp .env.example .env
```

Fill it in using the comments in the file and the credentials `wp-setup` printed. Keep
one variable per line — pasting the block from `wp-setup` onto the end of an existing
line silently swallows the next variable, and Prisma then fails with
`The datasource.url property is required in your Prisma config file`.

`WP_GRAPHQL_KEY`/`WP_GRAPHQL_SECRET` are a WordPress username and application password,
sent as Basic auth to both `/graphql` and the WooCommerce REST API. A live shop works the
same way: create a Shop Manager user and generate an application password on its profile.

`AUTH_SECRET` can be any random string (`openssl rand -base64 32`). Discord OAuth needs a
real app: add `http://localhost:3000/api/auth/callback/discord` as a redirect URL.

### 4. Set up the database and run

```bash
pnpm install
pnpm run prisma:migrate   # creates the schema
pnpm run s3:init          # creates the notes bucket
pnpm run sync:pull        # imports the seeded WooCommerce orders
pnpm run dev
```

Open `http://localhost:3000`. Before packing an order, add at least one box under
**Settings → Boxes**; the database ships with none and the packing screen has nothing to
offer without them.

### Resetting

`pnpm run sync:reset` clears order data but keeps boxes. `docker compose down -v` wipes
everything — Postgres, S3 and WordPress — so the steps above start from scratch.

# Development Scripts 

```bash
pnpm run sync:pull
```
- performs a manual sync from woocommerce to woolrus

```bash
pnpm run prisma:migrate
```
- performs prisma dev migration

```bash
pnpm run prisma:generate
```
- generates prisma client

```bash
pnpm run sync:reset
```
- deletes all data except boxes.
- great way to reset data during development
