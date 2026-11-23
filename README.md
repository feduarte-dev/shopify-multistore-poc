https://www.loom.com/share/cd930fa28fa14b5b9e41c19b3fc7e2ed - > Repo overview
https://www.loom.com/share/e0f2ca2954df473c978ec0d0d16bdded -> Product test

# POC — Shopify multi-store orchestrator (Claude Code + MCP)

Feasibility proof for a retail brand with several Shopify stores: you talk to **one orchestrator**, it figures out
**which store** you mean, and operates it through an MCP server. No logging out and back in to switch stores.

The demo brand has **3 apparel stores with deliberately similar names**, the same catalog and the **same SKUs**,
because that is the real problem: the data alone never tells you which store you are looking at.

| id | Full name | City | Type | Nicknames |
|---|---|---|---|---|
| `nyc-downtown` | Urban Apparel — Downtown Manhattan | New York | street, flagship | manhattan, downtown nyc, nyc flagship, store 01 |
| `nyc-queens-mall` | Urban Apparel — Queens Center Mall | New York | mall | queens, queens mall, store 02 |
| `boston-downtown` | Urban Apparel — Downtown Boston Outlet | Boston | street, outlet | boston, boston outlet, store 03 |

"Downtown" matches two stores, and so does "New York". The orchestrator has to ask.

```
You ──▶ Orchestrator (CLAUDE.md)
          │  1. resolve_store("downtown") → multiple → asks you which one
          │  2. delegates with store_id + full store name
          ├──▶ store-operator (store_id=nyc-downtown)    ─┐
          ├──▶ store-operator (store_id=boston-downtown) ─┼──▶ MCP "shopify" (one server) ──▶ stores.json
          └──▶ store-operator (store_id=nyc-queens-mall) ─┘        each store: mock | live (real Admin API)
```

## Running it

Requirements: Node 18+ and Claude Code (logged in).

```bash
npm install
npm test          # automated test: store resolution, isolation, write safety check, live-mode errors
claude            # opens the orchestrator; accept the folder "trust" prompt
```

Inside Claude Code, `/mcp` shows the `shopify` server connected. To see the subagent, ask Claude
"which subagents do you have?" (it should list `store-operator`).

You can talk in English or Portuguese; the orchestrator replies in your language.

### Demo script (for the client)

1. `How many hoodies do we have in stock at the downtown store?` → **ambiguous**: asks Manhattan or Boston
2. `Boston` → answers, and Boston stays **in focus** (📍 at the top of each reply)
3. `And what were its sales in the last 30 days?` → still Boston, no need to repeat it
4. `Compare the price and stock of the Hooded Sweatshirt across all stores` → 3 operators in parallel, one table
5. `Which New York store sold more this month?` → resolves the 2 NYC stores and compares them
6. `Set the medium hoodie at the Queens mall to $59.90` → preview with full store name → your "yes" → Claude Code permission prompt → done
7. `Show me the pending orders at the Chicago store` → no such store: it asks instead of guessing
8. `Create a product "Graphic Tee Limited" at Boston, sizes S/M/L, $29.90, 10 units each` → preview → confirm → created only in Boston
9. Open `data/nyc-queens-mall.audit.log`: the change is logged only for that store

`npm run reset` restores the mock data to its initial state.

## Files

| File | Role |
|---|---|
| `stores.json` | **Single source of truth**: each store's id, full name, domain, mode (`mock`/`live`), city, region, type, tags, nicknames |
| `server/index.js` | The single MCP server. 10 tools; every store tool requires `store_id`, and writes also require `confirm_store_name` |
| `server/registry.js` | Loads/validates `stores.json` and implements `resolve_store` (unique / multiple / none) |
| `server/mock-store.js` | Fake backend: state in `data/<store>.json` + audit log of writes |
| `server/seed-data.js` | Shared apparel catalog with shared SKUs; per-store IDs, prices (outlet −15%), stock and orders |
| `server/live-store.js` | Real backend (Admin GraphQL API, client credentials grant with auto-refresh). **Not yet run against a real store** |
| `server/env.js` | Loads credentials from `.env` |
| `.mcp.json` | Starts the one `shopify` server |
| `.claude/agents/store-operator.md` | Generic subagent that operates exactly one store per task |
| `CLAUDE.md` | Orchestrator rules: always resolve the store, ask when ambiguous, store in focus, preview → confirm → write |
| `.claude/settings.json` | Reads allowed; writes always trigger a Claude Code permission prompt |
| `.env.example` | Template for live credentials (copy to `.env`, never commit it) |
| `scripts/smoke-test.js` | `npm test` |
| `scripts/check-live.js` | `npm run check-live`: read-only diagnostics for live stores (credentials, domain, scopes) |
| `GO-LIVE.md` | Step-by-step guide to connect real stores (written so a Claude Code agent can follow it) |

Tools: `list_stores`, `resolve_store`, `get_shop_info`, `search_products`, `get_product`, `list_orders`,
`get_sales_summary`, `update_variant_price`, `create_product`, `set_inventory`.

## How "which store?" is kept unambiguous

1. **Resolution, not guessing:** every request goes through `resolve_store`. `multiple` or `none` means the orchestrator asks.
2. **Meaningful ids + nicknames** in `stores.json`, the words the team really uses.
3. **Store in focus:** once identified, a store stays in focus and is shown (📍) at the top of every reply.
4. **Full names in every confirmation** ("…at Urban Apparel — Downtown Boston Outlet?"), never just an id.
5. **Server-side lock on writes:** `confirm_store_name` must match the `store_id`'s full name, or the server refuses.
   A swapped id cannot change the wrong store, even if the model makes a mistake.
6. **Claude Code permission prompt** on every write (`ask` in `.claude/settings.json`).
7. **Audit log** per store (mock mode).

## Moving to real stores

Short version: fill `stores.json` with the real stores, put credentials in `.env`, switch stores to `"mode": "live"`
one at a time, and run `npm run check-live`. Mock and live stores can be mixed during the transition.

The full procedure (credentials in the Shopify Dev Dashboard, scopes, validation, what is still missing, where to
stop and ask) is in **[GO-LIVE.md](GO-LIVE.md)**. You can ask Claude Code: *"Read GO-LIVE.md and take this POC live
with our stores."*

## Scaling

Adding a store = one entry in `stores.json` + its credentials in `.env`. Nothing else changes: no new agent files,
no new MCP servers, no edits to `CLAUDE.md`. The same design works for 3 or 35 stores. For many users or a web UI,
the next step is moving the orchestrator to the Claude Agent SDK.
