// READ-ONLY diagnostics for live stores. Never writes anything.
// For each store in stores.json with mode "live": checks credentials are present, obtains a token,
// reads shop info + granted scopes, and compares the domain and scopes with what the POC needs.
//   npm run check-live              -> checks live stores only
//   npm run check-live -- --all     -> also lists mock stores (skipped)
import { loadDotEnv } from "../server/env.js";
import { loadRegistry, envPrefix } from "../server/registry.js";
import { createLiveStore } from "../server/live-store.js";

loadDotEnv();
const REQUIRED_SCOPES = ["read_products", "write_products", "read_orders", "read_inventory"];
const OPTIONAL_SCOPES = { write_inventory: "initial stock in create_product, and set_inventory",
  read_locations: "initial stock in create_product", read_all_orders: "orders older than 60 days" };

const { stores } = loadRegistry();
const live = stores.filter((s) => s.mode === "live");
const showAll = process.argv.includes("--all");
if (showAll) for (const s of stores.filter((x) => x.mode === "mock")) console.log(`⏭️  ${s.id}: mock (skipped)`);
if (!live.length) {
  console.log('No stores with "mode": "live" in stores.json. Nothing to check.');
  process.exit(0);
}

let problems = 0;
for (const s of live) {
  const P = envPrefix(s.id);
  const hasCreds = process.env[`${P}_ACCESS_TOKEN`] || (process.env[`${P}_CLIENT_ID`] && process.env[`${P}_CLIENT_SECRET`]);
  console.log(`\n🔎 ${s.id} — ${s.name} (${s.domain})`);
  if (!hasCreds) {
    console.log(`   ❌ missing credentials: set ${P}_CLIENT_ID + ${P}_CLIENT_SECRET (or ${P}_ACCESS_TOKEN) in .env`);
    problems++;
    continue;
  }
  try {
    const r = await createLiveStore(s).checkAccess();
    console.log(`   ✅ connected as "${r.shop.name}" (${r.shop.myshopifyDomain}, ${r.shop.currencyCode}) via ${r.auth}, API ${r.api_version}`);
    if (r.shop.myshopifyDomain !== s.domain) {
      console.log(`   ❌ domain mismatch: stores.json says ${s.domain}, credentials belong to ${r.shop.myshopifyDomain}`);
      problems++;
    }
    const missing = REQUIRED_SCOPES.filter((x) => !r.scopes.includes(x));
    if (missing.length) {
      console.log(`   ❌ missing required scopes: ${missing.join(", ")}`);
      problems++;
    } else console.log(`   ✅ required scopes OK`);
    for (const [scope, why] of Object.entries(OPTIONAL_SCOPES))
      if (!r.scopes.includes(scope)) console.log(`   ⚠️  optional scope ${scope} not granted (${why})`);
  } catch (e) {
    console.log(`   ❌ ${e.message}`);
    problems++;
  }
}
console.log(problems ? `\n${problems} problem(s) found.` : "\nAll live stores OK ✔");
process.exit(problems ? 1 : 0);
