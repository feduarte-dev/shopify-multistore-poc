# GO-LIVE — connecting this POC to real Shopify stores

**Audience:** a Claude Code agent (or a developer) taking this POC from mock data to the client's real stores.
Follow the phases in order. Each phase ends with a check. **Stop and ask the user** wherever this guide says 🛑.

## Ground rules (apply to every phase)

- **Never print, log, echo or commit secrets.** Credentials live only in `.env` (already in `.gitignore`).
  Never write them into `stores.json`, `.mcp.json`, code, commit messages or chat replies.
- **Real stores = real sales.** Until Phase 6 is signed off, only use read operations on production stores.
- **Never** run `update_variant_price` or `set_inventory` against a live store without an explicit "yes" from the user
  for that exact change. If possible, validate writes on a **development store** first.
- Keep the mock stores working: `npm test` must stay green after every phase.
- Read `README.md` first for the architecture.

## Phase 0 — Inventory of stores (🛑 needs the user)

Ask the user for, per store: the `*.myshopify.com` domain, the full name the team uses, city, region, type
(street/mall/outlet…), tags, and **the nicknames the team actually uses** ("the flagship", "store 07"…). The nicknames
are what makes store resolution work, so do not skip them.

## Phase 1 — Credentials (🛑 a human with owner access must do this)

You cannot create Shopify apps. Guide the user, per store:

1. Shopify admin → **Settings → Apps → Develop apps → Build apps in Dev Dashboard** → **Create app**.
   (Since Jan 1, 2026 new custom apps are created in the Dev Dashboard. A store that already has a *legacy*
   custom app with a `shpat_...` token can keep using it.)
2. Configure Admin API scopes. Start minimal:
   - required: `read_products`, `write_products`, `read_orders`, `read_inventory`
   - optional: `write_inventory` + `read_locations` (initial stock in `create_product`, and `set_inventory`),
     `read_all_orders` (orders older than 60 days)
   - for a read-only first rollout, grant only the `read_*` scopes.
3. Install the app on the store and copy the **client ID** and **client secret**.
   The app should be created by the organization that owns the store (client credentials grant). If the agency
   and the store owner are different organizations, confirm in Shopify's docs which flow applies before continuing.
4. The user (not you) puts them in `.env`, following `.env.example`. Variable names come from the store id:
   `nyc-downtown` → `SHOPIFY_NYC_DOWNTOWN_CLIENT_ID`, `SHOPIFY_NYC_DOWNTOWN_CLIENT_SECRET`
   (or `SHOPIFY_NYC_DOWNTOWN_ACCESS_TOKEN` for a legacy app).

**Check:** `.env` exists and has one block per store. Do not open it in the chat; `npm run check-live` will validate it.

## Phase 2 — Register the stores

Edit `stores.json`: replace the example stores with the real ones (from Phase 0), keeping `"mode": "mock"` for now.

- `id`: lowercase-with-dashes, meaningful (`sp-iguatemi`, not `store-17`). It defines the env var names, so if you
  rename an id, the `.env` variable names must change too.
- `name`: the full unambiguous name, including the brand (used in confirmations and in the write safety check).
- `aliases`: the team's nicknames, lowercase.

Update the store table/examples in `README.md` if needed. `CLAUDE.md` does not list stores (it reads them via tools).

**Check:** `npm test` still passes (it uses the stores from `stores.json`; if you changed the ids used in
`scripts/smoke-test.js`, update the test cases), and `resolve_store` returns `multiple` for names the team considers
ambiguous. Add those cases to the smoke test.

## Phase 3 — Connectivity check (read-only)

Switch ONE store to `"mode": "live"` in `stores.json`, then:

```bash
npm run check-live
```

It reads shop info and granted scopes only. Fix what it reports:

| Report | Typical fix |
|---|---|
| missing credentials | `.env` variable names don't match the store id |
| failed to obtain token (401/400) | wrong client id/secret, app not installed on that store, or the org mismatch from Phase 1 |
| domain mismatch | credentials of another store were pasted under this id: 🛑 tell the user |
| missing required scopes | user adds scopes in the Dev Dashboard and reinstalls/updates the app |
| GraphQL errors about unknown fields | API version drift; see Phase 4 |

Then switch the remaining stores to `live` one by one and re-run until **All live stores OK**.

## Phase 4 — Validate the live adapter (read-only)

`server/live-store.js` was written against the Admin GraphQL API docs but **never run against a real store**.
With Claude Code, call each read tool on one live store (`get_shop_info`, `search_products` with text / status /
`max_inventory`, `get_product` by ID and by handle, `list_orders` with filters, `get_sales_summary`) and compare
the results with the Shopify admin.

Known points to verify:
- `SHOPIFY_API_VERSION` (default `2026-07`): use a currently supported version; adjust field names if the schema changed.
- `productsCount` / `ordersCount` and the search syntax used in `query:` filters (`status:`, `inventory_total:`, `handle:`,
  `financial_status:`, `created_at:`).
- `get_sales_summary` only reads the last 250 paid orders: add cursor pagination if the client's volume is higher.
- Rate limits (GraphQL cost): add a retry with backoff on `THROTTLED` errors if parallel multi-store queries hit them.

**Check:** every read tool returns correct data for every live store. Record what you changed.

## Phase 5 — Writes (🛑 decisions + confirmation)

- `update_variant_price` is implemented (`productVariantsBulkUpdate`). Test it first on a development store, or on a
  real store only with the user's explicit "yes" for a specific, reversible change. Revert it afterwards.
- `create_product` is implemented (`productCreate` + `productVariantsBulkCreate` with `REMOVE_STANDALONE_VARIANT`).
  Without `write_inventory`/`read_locations` it creates the product without stock and returns a warning. Test on a dev store.
- `set_inventory` is **not implemented** in live mode. 🛑 Ask the user which inventory location(s) each store uses,
  then implement it with `inventorySetQuantities` (needs the variant's `inventoryItem.id` + a `location.id`), keeping
  the same `store_id` + `confirm_store_name` safety check, which lives in `server/index.js` and must not be removed.
- Live writes have no local audit log (the mock has one). If the client wants one, add it in `server/index.js` so it
  covers both modes.

## Phase 6 — Sign-off with the user

Run the demo script from `README.md` against the real stores (reads first), including the ambiguity cases.
🛑 Only after the user approves, consider the POC live.
