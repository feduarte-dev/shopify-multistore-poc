// Smoke test: starts the MCP server exactly as .mcp.json defines it, connects as an MCP client
// and checks store resolution, isolation, the write safety check, reads and live-mode errors.
// Uses a temporary state directory so the demo data stays clean.
// SAFETY: it always runs on a copy of stores.json with EVERY store forced to mock mode,
// so it never reads from or writes to a real Shopify store, even after you switch stores to live.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cfg = JSON.parse(fs.readFileSync(".mcp.json", "utf8")).mcpServers.shopify;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "poc-shopify-"));
const MOCK_STORES = path.join(TMP, "stores-mock.json");
const registry = JSON.parse(fs.readFileSync("stores.json", "utf8"));
const liveCount = registry.stores.filter((st) => st.mode === "live").length;
registry.stores.forEach((st) => (st.mode = "mock"));
fs.writeFileSync(MOCK_STORES, JSON.stringify(registry));
if (liveCount) console.log(`ℹ️  ${liveCount} live store(s) in stores.json: forced to mock for this test (use npm run check-live for live stores)\n`);
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "✅" : "❌"} ${msg}`); if (!ok) failures++; };
const parse = (r) => JSON.parse(r.content[0].text);

async function connect(extraEnv = {}) {
  const c = new Client({ name: "smoke-test", version: "1.0.0" });
  await c.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, STATE_DIR: TMP, STORES_FILE: MOCK_STORES, ...extraEnv }, stderr: "ignore" }));
  return c;
}
const c = await connect();
const call = async (name, args = {}) => c.callTool({ name, arguments: args });

// 1. Tools
const { tools } = await c.listTools();
check(tools.length === 10, `Single server exposes ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

// 2. Store resolution, including ambiguous cases
console.log("\n— resolve_store —");
const cases = [
  ["boston", "unique", ["boston-downtown"]],
  ["queens mall", "unique", ["nyc-queens-mall"]],
  ["flagship", "unique", ["nyc-downtown"]],
  ["store 02", "unique", ["nyc-queens-mall"]],
  ["downtown", "multiple", ["nyc-downtown", "boston-downtown"]],
  ["New York", "multiple", ["nyc-downtown", "nyc-queens-mall"]],
  ["all Northeast stores", "multiple", ["nyc-downtown", "nyc-queens-mall", "boston-downtown"]],
  ["Chicago", "none", []],
];
for (const [q, status, ids] of cases) {
  const r = parse(await call("resolve_store", { query: q }));
  const got = r.stores.map((s) => s.id);
  check(r.status === status && got.length === ids.length && ids.every((i) => got.includes(i)), `"${q}" → ${r.status} [${got.join(", ")}]`);
}

// 3. Same SKU, different store data (parallel, like the orchestrator does)
console.log("\n— multi-store read —");
const ids = ["nyc-downtown", "nyc-queens-mall", "boston-downtown"];
const hoodies = await Promise.all(ids.map(async (id) => [id, parse(await call("search_products", { store_id: id, query: "hooded" })).data[0]]));
for (const [id, p] of hoodies) console.log(`   ${id.padEnd(16)} ${p.title}  M: $${p.variants[1].price}  sku ${p.variants[1].sku}  stock ${p.variants[1].inventory_quantity}`);
const skus = new Set(hoodies.map(([, p]) => p.variants[1].sku));
const vids = new Set(hoodies.map(([, p]) => p.variants[1].id));
check(skus.size === 1 && vids.size === 3, "Same SKU in all 3 stores, but different variant IDs per store");

// 4. Isolation and validation
console.log("\n— isolation & safety —");
const [, hoodieNyc] = hoodies[0];
const cross = await call("get_product", { store_id: "boston-downtown", product_id: hoodieNyc.id });
check(cross.isError === true, "Boston cannot see a product ID from Downtown Manhattan");
const unknown = await call("get_shop_info", { store_id: "chicago" });
check(unknown.isError === true && unknown.content[0].text.includes("Valid ids"), "Unknown store_id is rejected with the list of valid ids");

const sku = hoodieNyc.variants[1].sku;
const wrong = await call("update_variant_price", { store_id: "boston-downtown", confirm_store_name: "Urban Apparel — Downtown Manhattan", variant_id: sku, price: 1 });
check(wrong.isError === true && wrong.content[0].text.includes("Write blocked"), "Write blocked when confirm_store_name does not match store_id");

const before = hoodies[2][1].variants[1].price;
const good = parse(await call("update_variant_price", { store_id: "boston-downtown", confirm_store_name: "urban apparel — downtown boston outlet", variant_id: sku, price: 49.9 }));
const nycAfter = parse(await call("search_products", { store_id: "nyc-downtown", query: "hooded" })).data[0].variants[1].price;
check(good.data.before.price === before && good.data.variant.price === "49.90", `Confirmed write on Boston: ${before} → ${good.data.variant.price} (same SKU)`);
check(nycAfter === hoodieNyc.variants[1].price && fs.existsSync(path.join(TMP, "boston-downtown.audit.log")) && !fs.existsSync(path.join(TMP, "nyc-downtown.audit.log")),
  "Same SKU in Manhattan untouched; audit log only for Boston");

// 5. Creating a product
console.log("\n— create_product —");
const blocked = await call("create_product", { store_id: "nyc-queens-mall", confirm_store_name: "Urban Apparel — Downtown Boston Outlet", title: "X", variants: [{ option_value: "M", price: 1 }] });
check(blocked.isError === true && blocked.content[0].text.includes("Write blocked"), "create_product blocked when the store name does not match");
const created = parse(await call("create_product", {
  store_id: "nyc-queens-mall", confirm_store_name: "Urban Apparel — Queens Center Mall",
  title: "Graphic Tee Limited", product_type: "T-Shirts", tags: ["new-arrival"],
  variants: [{ option_value: "S", price: 29.9, sku: "UA-GRAPHIC-TEE-S", inventory_quantity: 10 }, { option_value: "M", price: 29.9, sku: "UA-GRAPHIC-TEE-M", inventory_quantity: 15 }],
}));
const found = parse(await call("search_products", { store_id: "nyc-queens-mall", query: "graphic tee" })).data;
const notElsewhere = parse(await call("search_products", { store_id: "nyc-downtown", query: "graphic tee" })).data;
check(created.data.product.variants.length === 2 && found.length === 1 && found[0].total_inventory === 25 && notElsewhere.length === 0,
  `Created "${created.data.product.title}" (2 variants, stock 25) only in Queens`);

// 6. Business queries
console.log("\n— business queries —");
const summaries = await Promise.all(ids.map(async (id) => parse(await call("get_sales_summary", { store_id: id, days: 30 })).data));
for (const s of summaries) console.log(`   ${s.store.padEnd(16)} ${s.paid_orders} paid orders/30d, revenue $${s.revenue}, AOV $${s.average_order_value}`);
check(summaries.every((s) => Number(s.revenue) > 0), "Sales summary per store");
await c.close();

// 7. Live mode without credentials fails cleanly (no network call)
console.log("\n— live mode without credentials —");
const liveFile = path.join(TMP, "stores-live.json");
const reg = JSON.parse(fs.readFileSync(MOCK_STORES, "utf8"));
reg.stores[0].mode = "live";
reg.stores[0].domain = "no-credentials-test.invalid"; // never a real store
fs.writeFileSync(liveFile, JSON.stringify(reg));
// Empty values win over .env (the loader never overrides variables already set), so real credentials are ignored here
const env = { STORES_FILE: liveFile, SHOPIFY_NYC_DOWNTOWN_CLIENT_ID: "", SHOPIFY_NYC_DOWNTOWN_CLIENT_SECRET: "", SHOPIFY_NYC_DOWNTOWN_ACCESS_TOKEN: "" };
const cl = await connect(env);
const r = await cl.callTool({ name: "get_shop_info", arguments: { store_id: "nyc-downtown" } });
check(r.isError === true && r.content[0].text.includes("SHOPIFY_NYC_DOWNTOWN_CLIENT_ID"), "Live store without creds → clear error naming the env vars");
const r2 = await cl.callTool({ name: "get_shop_info", arguments: { store_id: "boston-downtown" } });
check(!r2.isError, "Other stores keep working (mock and live can be mixed)");
await cl.close();

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nAll good ✔");
process.exit(failures ? 1 : 0);
