#!/usr/bin/env node
// Single multi-store "Shopify" MCP server.
// - stores.json lists the stores (id, name, domain, mode mock|live, aliases...)
// - every store tool takes a required store_id
// - write tools also require confirm_store_name, which must match the store's full name
//   (a wrong or swapped id can never change the wrong store)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadDotEnv } from "./env.js";
import { loadRegistry, resolveStore, getStore, norm } from "./registry.js";
import { createMockStore } from "./mock-store.js";
import { createLiveStore } from "./live-store.js";

loadDotEnv();
const registry = loadRegistry();

const backends = new Map();
function backendFor(storeId) {
  const store = getStore(registry, storeId);
  if (!backends.has(storeId)) backends.set(storeId, store.mode === "live" ? createLiveStore(store) : createMockStore(store));
  return { store, backend: backends.get(storeId) };
}

function assertConfirmedName(store, confirm_store_name) {
  if (norm(confirm_store_name) !== norm(store.name))
    throw new Error(
      `Write blocked: store_id "${store.id}" is "${store.name}", but confirm_store_name was "${confirm_store_name}". ` +
        `Re-run resolve_store and confirm the store with the user.`
    );
}

const server = new McpServer({ name: "shopify-multistore", version: "0.2.0" });
const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `error: ${e.message}` }] });

// --- Store discovery (no store_id) ---------------------------------------------------------
server.registerTool(
  "list_stores",
  {
    description: "List the stores in the registry (id, full name, city, region, type, tags). Optional filters.",
    inputSchema: { region: z.string().optional(), city: z.string().optional(), tag: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ region, city, tag }) =>
    ok(
      registry.stores
        .filter((s) => (!region || norm(s.region) === norm(region)) && (!city || norm(s.city) === norm(city)) && (!tag || s.tags.includes(tag)))
        .map(({ id, name, city, region, type, tags, mode }) => ({ id, name, city, region, type, tags, mode }))
    )
);

server.registerTool(
  "resolve_store",
  {
    description:
      "Turn the user's words about a store ('the Boston one', 'downtown', 'queens mall') into store ids. " +
      "status 'unique' = proceed; 'multiple' = ask the user which one (unless they clearly asked for a group); 'none' = ask, never guess. " +
      "Pass English words (store data is in English).",
    inputSchema: { query: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => ok(resolveStore(registry, query))
);

// --- Store tools (store_id required) -------------------------------------------------------
const STORE_ID = z.string().describe("Store id from resolve_store/list_stores, e.g. nyc-downtown");
const CONFIRM = z.string().describe("The store's FULL name exactly as returned by resolve_store (safety check for writes)");

function storeTool(name, description, shape, fn, { write = false } = {}) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: { store_id: STORE_ID, ...(write ? { confirm_store_name: CONFIRM } : {}), ...shape },
      annotations: { readOnlyHint: !write, destructiveHint: write },
    },
    async (args) => {
      try {
        const { store, backend } = backendFor(args.store_id);
        if (write) assertConfirmedName(store, args.confirm_store_name);
        const data = await fn(backend, args);
        return ok({ store: { id: store.id, name: store.name }, mode: store.mode, data });
      } catch (e) {
        return fail(e);
      }
    }
  );
}

storeTool("get_shop_info", "General info for one store (name, domain, currency, counts).", {}, (b) => b.getShopInfo());

storeTool(
  "search_products",
  "Search one store's products by text (title, type, tag or SKU), status and/or low inventory.",
  {
    query: z.string().optional().describe("Free text, in English"),
    status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
    max_inventory: z.number().int().optional().describe("Only products with at least one variant whose inventory is <= this value"),
    limit: z.number().int().min(1).max(100).optional(),
  },
  (b, a) => b.searchProducts(a)
);

storeTool("get_product", "Product details in one store, by ID (gid://...) or handle.", { product_id: z.string() }, (b, a) => b.getProduct(a));

storeTool(
  "list_orders",
  "List one store's recent orders, optionally filtered by financial status and a window of days.",
  {
    financial_status: z.enum(["PAID", "PENDING", "REFUNDED"]).optional(),
    days: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(250).optional(),
  },
  (b, a) => b.listOrders(a)
);

storeTool(
  "get_sales_summary",
  "Paid sales summary for one store: revenue, order count, average order value and top 5 products.",
  { days: z.number().int().min(1).optional().describe("Default 30") },
  (b, a) => b.getSalesSummary(a)
);

storeTool(
  "update_variant_price",
  "CHANGES the price of a variant in ONE store (by variant ID or SKU; SKUs are shared across stores, so store_id decides). Write action.",
  {
    variant_id: z.string().describe("gid://shopify/ProductVariant/... or SKU"),
    price: z.number().positive(),
    compare_at_price: z.number().positive().nullable().optional().describe("Compare-at (strikethrough) price; null removes it"),
  },
  (b, a) => b.updateVariantPrice(a),
  { write: true }
);

storeTool(
  "create_product",
  "CREATES a product with its variants in ONE store. Each variant is one value of a single option (default option: Size). Write action.",
  {
    title: z.string().min(1),
    product_type: z.string().optional(),
    vendor: z.string().optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(["ACTIVE", "DRAFT"]).optional().describe("Default ACTIVE"),
    option_name: z.string().optional().describe('Default "Size"'),
    variants: z
      .array(
        z.object({
          option_value: z.string().describe('e.g. "M", or "One Size" for single-variant products'),
          price: z.number().positive(),
          compare_at_price: z.number().positive().optional(),
          sku: z.string().optional(),
          inventory_quantity: z.number().int().min(0).optional(),
        })
      )
      .min(1)
      .max(100),
  },
  (b, a) => b.createProduct(a),
  { write: true }
);

storeTool(
  "set_inventory",
  "CHANGES the inventory quantity of a variant in ONE store (by variant ID or SKU). Write action.",
  { variant_id: z.string(), quantity: z.number().int().min(0) },
  (b, a) => b.setInventory(a),
  { write: true }
);

await server.connect(new StdioServerTransport());
console.error(`shopify-multistore MCP ready: ${registry.stores.map((s) => `${s.id}(${s.mode})`).join(", ")}`);
