// "Mock" backend: simulates a Shopify store with state persisted to JSON.
// Each store has its own state file => full isolation between stores.
import fs from "node:fs";
import path from "node:path";
import { generateStore } from "./seed-data.js";
import { ROOT } from "./registry.js";

export function createMockStore(store) {
  const storeId = store.id;
  const stateDir = process.env.STATE_DIR || path.join(ROOT, "data");
  const stateFile = path.join(stateDir, `${storeId}.json`);
  const logFile = path.join(stateDir, `${storeId}.audit.log`);

  function load() {
    if (!fs.existsSync(stateFile)) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(generateStore(store), null, 2));
    }
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  }
  function save(state) {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
  function audit(action, details) {
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), store: storeId, action, ...details }) + "\n");
  }
  function findVariant(state, variantId) {
    for (const p of state.products) {
      const v = p.variants.find((x) => x.id === variantId || x.sku === variantId); // SKU is shared across stores, ID is not
      if (v) return { product: p, variant: v };
    }
    throw new Error(`Variant not found in this store (${storeId}): ${variantId}`);
  }

  load(); // make sure state exists

  return {
    async getShopInfo() {
      const s = load();
      return { ...s.shop, product_count: s.products.length, order_count: s.orders.length };
    },

    async searchProducts({ query, status, max_inventory, limit = 20 }) {
      const q = (query || "").toLowerCase();
      return load()
        .products.filter((p) => {
          if (status && p.status !== status) return false;
          if (q) {
            const hay = [p.title, p.vendor, p.product_type, ...p.tags, ...p.variants.map((v) => v.sku)].join(" ").toLowerCase();
            if (!hay.includes(q)) return false;
          }
          if (max_inventory !== undefined && !p.variants.some((v) => v.inventory_quantity <= max_inventory)) return false;
          return true;
        })
        .slice(0, limit)
        .map((p) => ({ ...p, total_inventory: p.variants.reduce((s, v) => s + v.inventory_quantity, 0) }));
    },

    async getProduct({ product_id }) {
      const p = load().products.find((x) => x.id === product_id || x.handle === product_id);
      if (!p) throw new Error(`Product not found in this store (${storeId}): ${product_id}`);
      return p;
    },

    async updateVariantPrice({ variant_id, price, compare_at_price }) {
      const s = load();
      const { product, variant } = findVariant(s, variant_id);
      const before = { price: variant.price, compare_at_price: variant.compare_at_price };
      variant.price = Number(price).toFixed(2);
      if (compare_at_price !== undefined) variant.compare_at_price = compare_at_price === null ? null : Number(compare_at_price).toFixed(2);
      save(s);
      audit("update_variant_price", { product: product.title, variant: variant.sku, before, after: { price: variant.price, compare_at_price: variant.compare_at_price } });
      return { product: product.title, variant, before };
    },

    async setInventory({ variant_id, quantity }) {
      const s = load();
      const { product, variant } = findVariant(s, variant_id);
      const before = variant.inventory_quantity;
      variant.inventory_quantity = quantity;
      save(s);
      audit("set_inventory", { product: product.title, variant: variant.sku, before, after: quantity });
      return { product: product.title, variant, before };
    },

    async createProduct({ title, product_type, vendor, tags = [], status = "ACTIVE", option_name = "Size", variants }) {
      const s = load();
      const nextId = (prefix, items) =>
        `gid://shopify/${prefix}/${Math.max(0, ...items.map((x) => Number(x.id.split("/").pop()))) + 1}`;
      const allVariants = s.products.flatMap((p) => p.variants);
      let vSeq = Math.max(0, ...allVariants.map((v) => Number(v.id.split("/").pop())));
      const product = {
        id: nextId("Product", s.products),
        title,
        handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        vendor: vendor ?? s.shop.name,
        product_type: product_type ?? "",
        status,
        tags,
        options: [option_name],
        variants: variants.map((v) => ({
          id: `gid://shopify/ProductVariant/${++vSeq}`,
          title: v.option_value,
          sku: v.sku ?? null,
          price: Number(v.price).toFixed(2),
          compare_at_price: v.compare_at_price ? Number(v.compare_at_price).toFixed(2) : null,
          inventory_quantity: v.inventory_quantity ?? 0,
        })),
      };
      s.products.push(product);
      save(s);
      audit("create_product", { product: title, id: product.id, variants: product.variants.map((v) => `${v.title}:${v.price}`) });
      return { product, warnings: [] };
    },

    async listOrders({ financial_status, days, limit = 20 }) {
      const since = days ? Date.now() - days * 86400000 : 0;
      return load()
        .orders.filter((o) => (!financial_status || o.financial_status === financial_status) && Date.parse(o.created_at) >= since)
        .slice(0, limit);
    },

    async getSalesSummary({ days = 30 }) {
      const since = Date.now() - days * 86400000;
      const orders = load().orders.filter((o) => Date.parse(o.created_at) >= since && o.financial_status === "PAID");
      const byProduct = {};
      for (const o of orders)
        for (const li of o.line_items) {
          const key = li.title.split(" - ")[0];
          byProduct[key] ??= { product: key, units: 0, revenue: 0 };
          byProduct[key].units += li.quantity;
          byProduct[key].revenue += Number(li.price) * li.quantity;
        }
      const revenue = orders.reduce((s, o) => s + Number(o.total_price), 0);
      return {
        store: storeId,
        period_days: days,
        paid_orders: orders.length,
        revenue: revenue.toFixed(2),
        average_order_value: orders.length ? (revenue / orders.length).toFixed(2) : "0.00",
        currency: "USD",
        top_products: Object.values(byProduct)
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 5)
          .map((x) => ({ ...x, revenue: x.revenue.toFixed(2) })),
      };
    },
  };
}
