/**
 * hosted-store · 03 Shop the store the way an assistant would: find, basket, demonstration checkout, order.
 *
 * Lists the departments, browses the first one that has products, tries a word search, reads a product, fills a
 * basket (add, change the quantity, add and remove a second product), checks out with the store's demonstration card
 * and reads the order back. Prices come back in minor units (4500 is 45.00).
 *
 * Checkout places a real order in the store (paid with the demonstration card, no money moves); it shows in the
 * store's console. --no-checkout stops before it.
 *
 * Run, from examples/: npx tsx hosted-store/store-03-shop.ts [--sku SKU] [--term "words"] [--no-checkout]
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
for (let d = HERE; ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const STORE = process.env.STORE_ID || fail("Set STORE_ID in .env (run hosted-store/store-01-create first).");
const S = `/commerce/stores/${STORE}`;
const SHOPPER = { emailAddress: "shopper@example.com", firstName: "Sam", lastName: "Shopper" };
const ADDRESS = { streetLine1: "1 High Street", city: "London", postalCode: "N1 1AA", countryCode: "GB" };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. */
async function labs(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": KEY, "User-Agent": UA, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let line = `[labs] ${method} ${path} -> ${res.status} credits=${res.headers.get("X-Credits-Charged") ?? "-"}`;
  if (!res.ok) line += " body=" + (await res.clone().text()).slice(0, 300).replace(/\n/g, " ");
  console.log(line);
  return res;
}

/** The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why). */
async function data_of(res: Response | Promise<Response>, what: string): Promise<any> {
  const answer = await res;
  if (!answer.ok) fail(`${what}: see the body above.`);
  return (await answer.json()).data;
}

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

function basket(cart: any, what: string) {
  const lines = cart.lines.map((l: any) => `${l.quantity} x ${l.name} (${l.sku})`).join(", ") || "empty";
  console.log(`  ${what}: ${lines}; total ${money(cart.totalWithTax, cart.currency)}`);
}

const { values: opts } = parseArgs({
  options: { sku: { type: "string" }, term: { type: "string" }, "no-checkout": { type: "boolean", default: false } },
});

// Find: departments come from the catalogue's `category`; browsing one needs no search set-up.
let found: any[] = [];
for (const dept of await data_of(labs("GET", `${S}/collections`), "Could not list departments")) {
  found = (await data_of(labs("POST", `${S}/search`, { collectionSlug: dept.slug }), "Browse failed")).items;
  if (found.length) {
    console.log(`Department ${dept.name}: ${found.length} products, such as ${found[0].name}`);
    break;
  }
}
if (!found.length) fail("The store has no products in any department: load a catalogue with hosted-store/store-02-catalogue.");
const pick = (opts.sku ? found.find((p) => p.sku === opts.sku) : found[0])
  ?? { sku: opts.sku, name: opts.sku, slug: null }; // not in this department: add it by SKU anyway
const other = found.find((p) => p.sku !== pick.sku);

const term = opts.term ?? pick.name.split(" ")[0];
const hits = (await data_of(labs("POST", `${S}/search`, { term }), "Search failed")).items;
console.log(`Search '${term}': ${hits.length} hits` + (hits.length ? "" : " (word search is off or still indexing; browse works)"));

if (pick.slug) { // read a product by its slug, not its product_id
  const product = await data_of(labs("GET", `${S}/products/${pick.slug}`), "Could not read the product");
  const v = product.variants[0];
  console.log(`Product ${product.name}: ${money(v.priceWithTax, v.currency)}, ${v.stockLevel},`
    + ` sizes ${product.customFields.sizes || "-"} (text only: a basket line has no size)`);
}

// Basket: one token per shopper; keep it in the shopper's session.
let cart = await data_of(labs("POST", `${S}/carts`, {}), "Could not create a basket");
const C = `${S}/carts/${cart.token}`;
cart = await data_of(labs("POST", `${C}/lines`, { sku: pick.sku, quantity: 1 }), "Could not add the product");
const line = cart.lines[0].id;
cart = await data_of(labs("PATCH", `${C}/lines/${line}`, { quantity: 2 }), "Could not change the quantity");
basket(cart, "after changing the quantity");
if (other) {
  cart = await data_of(labs("POST", `${C}/lines`, { sku: other.sku, quantity: 1 }), "Could not add a second product");
  basket(cart, "with a second product");
  const extra = cart.lines.find((l: any) => l.sku === other.sku).id;
  cart = await data_of(labs("DELETE", `${C}/lines/${extra}`), "Could not remove the line");
  basket(cart, "after removing it");
}
if (opts["no-checkout"]) {
  console.log(`Stopped before checkout. The basket ${cart.code} stays open.`);
  process.exit(0);
}

// Checkout, in this order: customer, address, shipping method, then checkout. Earlier answers 409.
await data_of(labs("PUT", `${C}/customer`, SHOPPER), "Could not set the customer");
await data_of(labs("PUT", `${C}/shipping-address`, ADDRESS), "Could not set the address");
const ship = (await data_of(labs("GET", `${C}/shipping-methods`), "Could not list shipping methods"))[0];
await data_of(labs("PUT", `${C}/shipping-method`, { shippingMethodId: ship.id }), "Could not choose shipping");
const pay = await data_of(labs("GET", `${C}/payment-methods`), "Could not list payment methods");
console.log(`  shipping ${ship.name} (${money(ship.priceWithTax, cart.currency)}), payment ${pay[0].name}`);
let order = await data_of(labs("POST", `${C}/checkout`, {}), "Checkout failed");
console.log(`Order ${order.code}: ${order.state}, total ${money(order.totalWithTax, order.currency)}`);
order = await data_of(labs("GET", `${S}/orders/${order.code}`), "Could not read the order back");
basket(order, `order ${order.code} as the store keeps it`);
