# Real-store test

Pulls a real WooCommerce store's orders and products into a throwaway database, so we can see how
real data maps before go-live (SPEC-store-sync open questions: bin locations, bundles / ACF, the
Rush Order flag, the first import window).

**What it does to the store:** only GET requests (the same ones sync makes). It registers no
webhooks and writes nothing. Use **read-only** API keys anyway, so that stays guaranteed.

**What it does here:** everything goes into a separate database, `woolrus_realtest`, on the v2 dev
Postgres (:5442). The dev database and the dev store are untouched. The imported data includes real
customers' names and addresses: keep it on this machine and drop it when done (`down`).

## Steps

1. Get read-only keys (see [For the store admin](#for-the-store-admin) below; send them that part).
2. `cp .env.realtest.example .env.realtest` and fill in the store URL and the two keys.
   `.env.realtest` is git-ignored.
3. Run, from the repo root:

   ```bash
   scripts/realtest/realtest.sh up         # create + migrate woolrus_realtest
   scripts/realtest/realtest.sh check      # reach the store, show units and how many orders a pull brings
   scripts/realtest/realtest.sh pull       # import the processing orders and their products
   scripts/realtest/realtest.sh products   # optional: the whole catalog (stock, bins, weights)
   scripts/realtest/realtest.sh report     # summary for the open questions
   scripts/realtest/realtest.sh dev        # optional: the app on it at http://localhost:3000, with a worker
   scripts/realtest/realtest.sh web        # optional: browse it at http://localhost:3300 (no worker)
   scripts/realtest/realtest.sh down       # drop the database when finished
   ```

- `pull` imports **every** `processing` order on its first run; `check` tells you how many first.
  Running `pull` again only fetches what changed in the store since (and shows edits and
  cancellations as they would appear on the floor).
- `web` serves a production build on :3300 against `woolrus_realtest`. Sign in with an address in
  `ADMIN_EMAILS` (root `.env`); the magic link is printed in that terminal.
- `dev` runs web and worker in dev mode on `woolrus_realtest`, so Sync orders now, Test connection and
  the nav indicator work, and the worker polls the store every sync interval (GET only). Stop your
  usual `pnpm dev` first (one `next dev` per folder). Don't use `pnpm dev` with an overridden
  `DATABASE_URL`: turbo's strict env mode drops it and the apps use the dev database.
- `dev` and `web` listen on 127.0.0.1 only, so the real customer data isn't reachable from the network.
- When finished, also ask the store admin to revoke the key.

## For the store admin

> **Creating a read-only WooCommerce API key for Woolrus**
>
> We'd like to test our new fulfilment app against the store's real orders. It only **reads**
> orders, products and the store's unit settings; it never changes anything. Please create a
> **read-only** REST API key:
>
> 1. Sign in to WordPress as an Administrator.
> 2. Go to **WooCommerce → Settings → Advanced → REST API** and click **Add key**
>    (or **Create an API key** if there are none yet).
> 3. Fill in:
>    - **Description:** `Woolrus test (read-only)`
>    - **User:** an Administrator or Shop Manager account. The key acts as that user, and reading
>      the store's weight / dimension units needs the "manage WooCommerce" capability that
>      those roles have.
>    - **Permissions:** **Read**. Not Write, not Read/Write.
> 4. Click **Generate API key**.
> 5. Copy the **Consumer key** (starts with `ck_`) and the **Consumer secret** (starts with `cs_`).
>    WooCommerce shows the secret **only once**; if it's lost, revoke the key and create a new one.
> 6. Send both, plus the store's address (e.g. `https://shop.example.com`), through a password
>    manager share or another encrypted channel. Please don't paste them into email or chat.
>
> Notes:
> - The site must be served over **HTTPS**; the key is sent with every request.
> - If a firewall or security plugin (Cloudflare, Wordfence, …) blocks `/wp-json/` requests, please
>   allow `/wp-json/wc/v3/*` for this test, or tell us so we can test from an allowed address.
> - We'll tell you when the test is done. Then revoke the key on the same screen (**Revoke** under
>   the key's description).
>
> If there's a staging copy of the store with recent orders, a key for staging works just as well
> and is preferable.
