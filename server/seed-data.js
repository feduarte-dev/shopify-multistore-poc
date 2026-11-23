// Generates fake data shaped roughly like the Shopify Admin API.
// All stores of the brand share the SAME catalog and SKUs (like a real retail chain),
// but each store has its own product/variant IDs, prices, inventory and orders.
// That is exactly why every operation must name the store explicitly.

const CATALOG = [
  ["Basic Cotton T-Shirt", "T-Shirts", ["S", "M", "L", "XL"], 19.9, ["basics", "cotton"]],
  ["Slim Fit Jeans", "Pants", ["30", "32", "34", "36"], 59.9, ["denim"]],
  ["Windbreaker Jacket", "Outerwear", ["M", "L"], 89.9, ["winter"]],
  ["Hooded Sweatshirt", "Outerwear", ["S", "M", "L"], 64.9, ["winter"]],
  ["Linen Button-Down Shirt", "Shirts", ["S", "M", "L"], 49.9, ["summer"]],
  ["Chino Shorts", "Pants", ["30", "32", "34"], 39.9, ["summer"]],
  ["Knit Beanie", "Accessories", ["One Size"], 17.9, ["winter", "accessory"]],
  ["Canvas Belt", "Accessories", ["S/M", "L/XL"], 24.9, ["accessory"]],
  ["Crew Socks (3-pack)", "Accessories", ["One Size"], 12.9, ["socks"]],
  ["Puffer Vest", "Outerwear", ["M", "L"], 79.9, ["winter", "new-arrival"]],
];

const FIRST = ["Anna", "Brian", "Carla", "David", "Emma", "Frank", "Grace", "Henry", "Isla", "Jack", "Laura", "Mark"];
const LAST = ["Smith", "Johnson", "Brown", "Miller", "Davis", "Garcia", "Wilson", "Moore"];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const hash = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const money = (n) => n.toFixed(2);

export function generateStore(store, now = new Date()) {
  const seed = hash(store.id);
  const rand = rng(seed);
  const idBase = 1000 + (seed % 9000);
  // Outlets sell ~15% cheaper; other stores get a small local price difference
  const priceFactor = store.tags?.includes("outlet") ? 0.85 : 1 + (rand() < 0.5 ? 0 : 0.05);

  let variantSeq = idBase * 100;
  const products = CATALOG.map(([title, type, options, basePrice, tags], i) => ({
    id: `gid://shopify/Product/${idBase * 100 + i + 1}`,
    title,
    handle: slug(title),
    vendor: "Urban Apparel",
    product_type: type,
    status: i === CATALOG.length - 1 && store.tags?.includes("outlet") ? "DRAFT" : "ACTIVE",
    tags,
    variants: options.map((opt) => {
      variantSeq += 1;
      const r = rand();
      const qty = r < 0.15 ? 0 : r < 0.3 ? Math.floor(rand() * 5) + 1 : Math.floor(rand() * 60) + 6;
      return {
        id: `gid://shopify/ProductVariant/${variantSeq}`,
        title: opt,
        sku: `UA-${slug(title).slice(0, 14).toUpperCase()}-${slug(opt).toUpperCase()}`, // same SKU in every store
        price: money(Math.round(basePrice * priceFactor) - 0.1),
        compare_at_price: rand() < 0.2 ? money(basePrice * 1.25) : null,
        inventory_quantity: qty,
      };
    }),
  }));

  const sellable = products.filter((p) => p.status === "ACTIVE");
  const orders = [];
  const nOrders = 25 + Math.floor(rand() * 15);
  for (let k = 0; k < nOrders; k++) {
    const daysAgo = Math.floor(rand() * 60);
    const created = new Date(now.getTime() - daysAgo * 86400000 - Math.floor(rand() * 86400000));
    const line_items = [];
    for (let j = 0, n = 1 + Math.floor(rand() * 3); j < n; j++) {
      const p = sellable[Math.floor(rand() * sellable.length)];
      const v = p.variants[Math.floor(rand() * p.variants.length)];
      line_items.push({ product_id: p.id, variant_id: v.id, sku: v.sku, title: `${p.title} - ${v.title}`, quantity: 1 + Math.floor(rand() * 2), price: v.price });
    }
    const fr = rand();
    orders.push({
      id: `gid://shopify/Order/${idBase * 1000 + k + 1}`,
      name: `#${store.id.split("-").map((w) => w[0].toUpperCase()).join("")}${1001 + k}`,
      created_at: created.toISOString(),
      financial_status: fr < 0.08 ? "REFUNDED" : fr < 0.18 ? "PENDING" : "PAID",
      fulfillment_status: daysAgo < 3 ? "UNFULFILLED" : "FULFILLED",
      customer: { name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`, city: store.city },
      total_price: money(line_items.reduce((s, li) => s + Number(li.price) * li.quantity, 0)),
      currency: "USD",
      line_items,
    });
  }
  orders.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    shop: { id: store.id, name: store.name, myshopify_domain: store.domain, currency: "USD", city: store.city, mode: "mock" },
    products,
    orders,
  };
}
