// "Live" backend: talks to the real Shopify Admin GraphQL API.
// ⚠️ UNTESTED SKELETON against a real store — it shows that switching
// mock -> real is configuration only. Validate on a development store before use.
//
// Domain comes from stores.json. Credentials come from env vars (or .env), named after the store id:
//   nyc-downtown -> SHOPIFY_NYC_DOWNTOWN_CLIENT_ID + SHOPIFY_NYC_DOWNTOWN_CLIENT_SECRET   (Dev Dashboard apps, 2026+)
//                   token obtained via client credentials grant and refreshed automatically (~24h)
//               or SHOPIFY_NYC_DOWNTOWN_ACCESS_TOKEN                                     (legacy custom app, shpat_...)
//   SHOPIFY_API_VERSION (optional, global, default 2026-07)
import { envPrefix } from "./registry.js";

export function createLiveStore(store) {
  const storeId = store.id;
  const domain = store.domain;
  const version = process.env.SHOPIFY_API_VERSION || "2026-07";
  const P = envPrefix(storeId);

  let token = process.env[`${P}_ACCESS_TOKEN`] || null;
  let tokenExpiresAt = token ? Infinity : 0;

  // fetch with a readable error (DNS, TLS, proxy...) instead of a bare "fetch failed"
  async function http(url, init) {
    try {
      return await fetch(url, init);
    } catch (e) {
      const c = e.cause;
      throw new Error(`[${storeId}] network error reaching ${domain}: ${c?.code ?? ""} ${c?.message ?? e.message}`.trim());
    }
  }

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const client_id = process.env[`${P}_CLIENT_ID`];
    const client_secret = process.env[`${P}_CLIENT_SECRET`];
    if (!client_id || !client_secret)
      throw new Error(`[${storeId}] missing credentials: set ${P}_CLIENT_ID and ${P}_CLIENT_SECRET (or ${P}_ACCESS_TOKEN) in .env`);
    const res = await http(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      // Shopify expects a form-encoded body here (not JSON)
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id, client_secret }).toString(),
    });
    if (!res.ok) throw new Error(`[${storeId}] failed to obtain token: ${res.status} ${await res.text()}`);
    const data = await res.json();
    token = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in ?? 86399) * 1000; // ~24h
    return token;
  }

  async function gql(query, variables = {}) {
    const res = await http(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken() },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (!res.ok || body.errors) throw new Error(`[${storeId}] GraphQL: ${JSON.stringify(body.errors ?? body)}`);
    return body.data;
  }

  const PRODUCT_FIELDS = `id title handle vendor productType status tags totalInventory
    variants(first: 50) { nodes { id title sku price compareAtPrice inventoryQuantity } }`;
  const mapProduct = (p) => ({
    id: p.id, title: p.title, handle: p.handle, vendor: p.vendor, product_type: p.productType,
    status: p.status, tags: p.tags, total_inventory: p.totalInventory,
    variants: p.variants.nodes.map((v) => ({
      id: v.id, title: v.title, sku: v.sku, price: v.price, compare_at_price: v.compareAtPrice, inventory_quantity: v.inventoryQuantity,
    })),
  });

  return {
    // Read-only diagnostics used by `npm run check-live`
    async checkAccess() {
      const d = await gql(`{ shop { name myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }`);
      return { shop: d.shop, scopes: d.currentAppInstallation.accessScopes.map((s) => s.handle), api_version: version,
        auth: process.env[`${P}_ACCESS_TOKEN`] ? "static access token" : "client credentials grant" };
    },

    async getShopInfo() {
      const d = await gql(`{ shop { name myshopifyDomain currencyCode } productsCount { count } ordersCount { count } }`);
      return { id: storeId, name: d.shop.name, myshopify_domain: d.shop.myshopifyDomain, currency: d.shop.currencyCode,
        product_count: d.productsCount.count, order_count: d.ordersCount.count, mode: "live" };
    },

    async searchProducts({ query, status, max_inventory, limit = 20 }) {
      const parts = [];
      if (query) parts.push(query);
      if (status) parts.push(`status:${status.toLowerCase()}`);
      if (max_inventory !== undefined) parts.push(`inventory_total:<=${max_inventory}`);
      const d = await gql(`query($q: String, $n: Int!) { products(first: $n, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`,
        { q: parts.join(" ") || null, n: limit });
      return d.products.nodes.map(mapProduct);
    },

    async getProduct({ product_id }) {
      const d = product_id.startsWith("gid://")
        ? await gql(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id: product_id })
        : await gql(`query($q: String!) { products(first: 1, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`, { q: `handle:${product_id}` })
          .then((r) => ({ product: r.products.nodes[0] }));
      if (!d.product) throw new Error(`Product not found: ${product_id}`);
      return mapProduct(d.product);
    },

    async updateVariantPrice({ variant_id, price, compare_at_price }) {
      const v = await gql(`query($id: ID!) { productVariant(id: $id) { price compareAtPrice product { id title } } }`, { id: variant_id });
      if (!v.productVariant) throw new Error(`Variant not found: ${variant_id}`);
      const input = { id: variant_id, price: String(price) };
      if (compare_at_price !== undefined) input.compareAtPrice = compare_at_price === null ? null : String(compare_at_price);
      const d = await gql(
        `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $pid, variants: $v) {
           productVariants { id sku price compareAtPrice } userErrors { field message } } }`,
        { pid: v.productVariant.product.id, v: [input] });
      const r = d.productVariantsBulkUpdate;
      if (r.userErrors.length) throw new Error(JSON.stringify(r.userErrors));
      return { product: v.productVariant.product.title, variant: r.productVariants[0],
        before: { price: v.productVariant.price, compare_at_price: v.productVariant.compareAtPrice } };
    },

    async createProduct({ title, product_type, vendor, tags = [], status = "ACTIVE", option_name = "Size", variants }) {
      const warnings = [];
      // 1. Product with its option values. Shopify auto-creates one "standalone" variant.
      const c = await gql(
        `mutation($p: ProductCreateInput!) { productCreate(product: $p) { product { id } userErrors { field message } } }`,
        { p: { title, productType: product_type, vendor, tags, status,
               productOptions: [{ name: option_name, values: variants.map((v) => ({ name: v.option_value })) }] } });
      if (c.productCreate.userErrors.length) throw new Error(`productCreate: ${JSON.stringify(c.productCreate.userErrors)}`);
      const productId = c.productCreate.product.id;

      // 2. Location for initial stock (needs read_locations + write_inventory). Without it, create with no stock.
      const wantsStock = variants.some((v) => v.inventory_quantity !== undefined);
      let locationId = null;
      if (wantsStock) {
        try {
          locationId = (await gql(`{ locations(first: 1) { nodes { id name } } }`)).locations.nodes[0]?.id ?? null;
        } catch (e) {
          warnings.push(`Could not read locations (scope read_locations missing?): created without stock. ${e.message}`);
        }
      }

      // 3. All variants, replacing the standalone one
      const build = (withStock) => variants.map((v) => ({
        price: String(v.price),
        ...(v.compare_at_price ? { compareAtPrice: String(v.compare_at_price) } : {}),
        optionValues: [{ optionName: option_name, name: v.option_value }],
        inventoryItem: { tracked: true, ...(v.sku ? { sku: v.sku } : {}) },
        ...(withStock && v.inventory_quantity !== undefined ? { inventoryQuantities: [{ locationId, availableQuantity: v.inventory_quantity }] } : {}),
      }));
      const mutation = `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $pid, variants: $v, strategy: REMOVE_STANDALONE_VARIANT) {
          productVariants { id } userErrors { field message } } }`;
      let r;
      try {
        r = (await gql(mutation, { pid: productId, v: build(Boolean(locationId)) })).productVariantsBulkCreate;
      } catch (e) {
        if (!locationId) throw new Error(`Product ${productId} was created but its variants failed: ${e.message}`);
        r = { userErrors: [{ message: e.message }] };
      }
      if (r.userErrors.length && locationId) {
        warnings.push(`Setting stock failed (scope write_inventory missing?): created without stock. ${JSON.stringify(r.userErrors)}`);
        r = (await gql(mutation, { pid: productId, v: build(false) })).productVariantsBulkCreate;
      }
      if (r.userErrors.length)
        throw new Error(`Product ${productId} was created but its variants failed: ${JSON.stringify(r.userErrors)}. Fix or delete it in the Shopify admin.`);

      return { product: await this.getProduct({ product_id: productId }), warnings };
    },

    async setInventory() {
      // In the real API, inventory is per location (inventoryItem + location, inventorySetQuantities mutation).
      throw new Error("set_inventory is not implemented in live mode yet (POC). Agree on the inventory location rule with the client.");
    },

    async listOrders({ financial_status, days, limit = 20 }) {
      const parts = [];
      if (financial_status) parts.push(`financial_status:${financial_status.toLowerCase()}`);
      if (days) parts.push(`created_at:>=${new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)}`);
      const d = await gql(
        `query($q: String, $n: Int!) { orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) { nodes {
           id name createdAt displayFinancialStatus displayFulfillmentStatus
           totalPriceSet { shopMoney { amount currencyCode } }
           customer { displayName }
           lineItems(first: 20) { nodes { title sku quantity originalUnitPriceSet { shopMoney { amount } } } } } } }`,
        { q: parts.join(" ") || null, n: limit });
      return d.orders.nodes.map((o) => ({
        id: o.id, name: o.name, created_at: o.createdAt, financial_status: o.displayFinancialStatus,
        fulfillment_status: o.displayFulfillmentStatus, total_price: o.totalPriceSet.shopMoney.amount,
        currency: o.totalPriceSet.shopMoney.currencyCode, customer: { name: o.customer?.displayName ?? null },
        line_items: o.lineItems.nodes.map((li) => ({ title: li.title, sku: li.sku, quantity: li.quantity, price: li.originalUnitPriceSet.shopMoney.amount })),
      }));
    },

    async getSalesSummary({ days = 30 }) {
      const orders = await this.listOrders({ financial_status: "PAID", days, limit: 250 });
      const byProduct = {};
      for (const o of orders) for (const li of o.line_items) {
        byProduct[li.title] ??= { product: li.title, units: 0, revenue: 0 };
        byProduct[li.title].units += li.quantity;
        byProduct[li.title].revenue += Number(li.price) * li.quantity;
      }
      const revenue = orders.reduce((s, o) => s + Number(o.total_price), 0);
      return { store: storeId, period_days: days, paid_orders: orders.length, revenue: revenue.toFixed(2),
        average_order_value: orders.length ? (revenue / orders.length).toFixed(2) : "0.00",
        top_products: Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 5)
          .map((x) => ({ ...x, revenue: x.revenue.toFixed(2) })),
        note: "Computed from the last 250 paid orders (POC limit)." };
    },
  };
}
