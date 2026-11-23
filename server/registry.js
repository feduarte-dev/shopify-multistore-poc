// Store registry: the single source of truth for which stores exist and how to identify them.
// Loaded from stores.json (or the file in STORES_FILE).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = ["id", "name", "domain", "mode", "city", "region"];

export function loadRegistry(file = process.env.STORES_FILE || path.join(ROOT, "stores.json")) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const stores = raw.stores ?? [];
  const seen = new Set();
  for (const s of stores) {
    for (const k of REQUIRED) if (!s[k]) throw new Error(`stores.json: store ${JSON.stringify(s.id ?? s)} is missing "${k}"`);
    if (!/^[a-z0-9-]+$/.test(s.id)) throw new Error(`stores.json: invalid id "${s.id}" (use lowercase letters, digits and dashes)`);
    if (seen.has(s.id)) throw new Error(`stores.json: duplicate id "${s.id}"`);
    if (!["mock", "live"].includes(s.mode)) throw new Error(`stores.json: store "${s.id}" has invalid mode "${s.mode}"`);
    seen.add(s.id);
    s.tags ??= [];
    s.aliases ??= [];
    s.type ??= "";
  }
  return { brand: raw.brand ?? "", stores };
}

export const norm = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Words that carry no identifying information (English + Portuguese, since users may write either).
const STOP = new Set([
  "the", "a", "an", "of", "in", "at", "on", "for", "store", "stores", "shop", "shops", "location", "branch", "all", "every", "our",
  "loja", "lojas", "a", "o", "as", "os", "de", "do", "da", "dos", "das", "em", "no", "na", "todas", "todos", "unidade", "filial",
]);

const summary = (s) => ({ id: s.id, name: s.name, city: s.city, region: s.region, type: s.type, tags: s.tags, mode: s.mode });

/**
 * Resolves free text ("the Boston store", "downtown", "queens mall") to stores.
 *   status "unique"   -> exactly one store; safe to proceed
 *   status "multiple" -> several stores match; ask the user, unless they clearly meant a group ("all Northeast stores")
 *   status "none"     -> no match; ask the user, never guess
 */
export function resolveStore(registry, query) {
  const brand = norm(registry.brand);
  let q = norm(query);
  if (brand) q = q.replace(brand, " ").replace(/\s+/g, " ").trim();
  const { stores } = registry;

  // 1. Exact hit on id, full name or an alias
  const exact = stores.filter((s) =>
    [norm(s.id), norm(s.name), norm(s.name.replace(registry.brand, "")), ...s.aliases.map(norm)].includes(q)
  );
  if (exact.length === 1) return { query, status: "unique", matched_by: "exact", stores: exact.map(summary) };

  // 2. Every meaningful word must appear in the store's identifying fields
  const tokens = q.split(" ").filter((t) => t && !STOP.has(t));
  if (tokens.length === 0)
    return { query, status: "multiple", matched_by: "no identifying words — matches every store", stores: stores.map(summary) };

  const matches = stores.filter((s) => {
    const hay = norm([s.id, s.name, s.city, s.region, s.type, ...s.tags, ...s.aliases].join(" ")).split(" ");
    return tokens.every((t) => hay.some((h) => h === t || (t.length >= 4 && h.startsWith(t))));
  });

  if (matches.length === 0)
    return { query, status: "none", stores: [], hint: "No store matches. Ask the user, and offer list_stores." };
  return { query, status: matches.length === 1 ? "unique" : "multiple", matched_by: "keywords", stores: matches.map(summary) };
}

export function getStore(registry, storeId) {
  const s = registry.stores.find((x) => x.id === storeId);
  if (!s) throw new Error(`Unknown store_id "${storeId}". Valid ids: ${registry.stores.map((x) => x.id).join(", ")}. Use resolve_store first.`);
  return s;
}

// Env var prefix for a store's credentials: nyc-downtown -> SHOPIFY_NYC_DOWNTOWN
export const envPrefix = (storeId) => `SHOPIFY_${storeId.toUpperCase().replace(/-/g, "_")}`;
