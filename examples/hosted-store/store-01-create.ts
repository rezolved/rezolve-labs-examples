/**
 * hosted-store · 01 List, create or delete a store.
 *
 * With no arguments, lists your stores: your first store and the ones you added, each with its id and its page. With a
 * name, creates a store and saves its id in .env as STORE_ID. With --delete, deletes the store in STORE_ID, with its
 * catalogue and orders (this cannot be undone; your first store can't be deleted this way).
 *
 * To work on a store that already exists, put its id in .env as STORE_ID and skip the create.
 *
 * Run, from examples/: npx tsx hosted-store/store-01-create.ts ["My Shop" [--currency GBP]] [--delete]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
let ENV = join(HERE, "..", "..", ".env");
for (let d = HERE; ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { ENV = join(d, ".env"); process.loadEnvFile(ENV); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const SHOP_HOST = "https://commerce.rezolvelabs.com"; // where storefrontPath is served
const CURRENCIES = ["GBP", "EUR", "USD", "AUD"];

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
  const text = await answer.text();
  return text ? JSON.parse(text).data : null;
}

/** Sets NAME=value in .env (removes the line when value is null). */
function setEnv(name: string, value: string | null) {
  const lines = (existsSync(ENV) ? readFileSync(ENV, "utf8") : "").split("\n").filter((l) => l && !l.startsWith(`${name}=`));
  writeFileSync(ENV, [...lines, ...(value === null ? [] : [`${name}=${value}`])].join("\n") + "\n");
}

function show(store: any) {
  const counts = store.counts ?? {};
  console.log(`  ${store.id.padEnd(28)} ${store.name.padEnd(24)} ${store.currency}  products=${counts.products ?? 0}`
    + `  orders=${counts.orders ?? 0}  page=${SHOP_HOST}${store.storefrontPath}`);
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { currency: { type: "string", default: "GBP" }, delete: { type: "boolean", default: false } },
});
if (opts.delete) {
  const storeId = process.env.STORE_ID || fail("No STORE_ID in .env: nothing to delete.");
  await data_of(labs("DELETE", `/commerce/stores/${storeId}`), "Delete failed");
  setEnv("STORE_ID", null);
  console.log(`Deleted ${storeId} and removed STORE_ID from .env.`);
} else if (positionals[0]) {
  if (!CURRENCIES.includes(opts.currency!)) fail(`--currency must be one of ${CURRENCIES.join(", ")}.`);
  const store = await data_of(labs("POST", "/commerce/stores", { name: positionals[0], currency: opts.currency }), "Create failed");
  setEnv("STORE_ID", store.id);
  show(store);
  console.log("Saved STORE_ID in .env. Next: hosted-store/store-02-catalogue with your catalogue CSV.");
} else {
  console.log("Your stores:");
  show(await data_of(labs("GET", "/commerce/store"), "Could not read your first store"));
  for (const store of await data_of(labs("GET", "/commerce/stores"), "Could not list your stores")) show(store);
  console.log("Put the id of the store to work on in .env as STORE_ID, or pass a name to create one.");
}
