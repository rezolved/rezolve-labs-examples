/**
 * shop-assistant · Set up the shop's agent: catalogue, instructions and basket.
 *
 * Loads your catalogue (the CSV that shop.yaml names, with at least `id`, `name` and `price` columns) into a product
 * search collection (a catalogue never goes in a knowledge base: those are for documents), builds the instructions
 * from instructions.txt and shop.yaml (store name, currency, store policies), and
 * creates an agent on that collection with a voice and the built-in `modify_cart` tool. No shop needs connecting: the
 * basket lives on the platform, one per chat. The collection's full name and the agent's id go into .env as
 * SHOP_COLLECTION and SHOP_AGENT_ID.
 *
 * Run it again after changing the catalogue, shop.yaml or instructions.txt: it loads the catalogue again (a product
 * whose id is already there is updated) and saves the new instructions as a new flow version of the same agent. Test
 * each change in a new chat. A product taken out of the catalogue stays in the collection: delete the collection to
 * start clean.
 *
 * Run, from examples/: npx tsx shop-assistant/setup-shop.ts [--dry-run]   (--dry-run prints the instructions only)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
let ENV = join(HERE, "..", "..", ".env");
for (let d = HERE; ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { ENV = join(d, ".env"); process.loadEnvFile(ENV); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const LIMIT = 20000; // characters of instructions, on create and on a flow save alike
const TOOLS = ["modify_cart"]; // built-in basket; the catalogue search comes with the collection. Not checkout: see the README
const REQUIRED = ["id", "name", "price"]; // every other column is stored with the product, and searched by meaning
const NOT_SEARCHED = ["image_url", "sizes"];

if (!existsSync(join(HERE, "shop.yaml"))) fail("Copy shop-assistant/shop.example.yaml to shop-assistant/shop.yaml and fill in your shop.");
const shop = YAML.parse(readFileSync(join(HERE, "shop.yaml"), "utf8"));
const CATALOGUE = join(HERE, shop.catalogue);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. */
async function labs(method: string, path: string, body?: unknown): Promise<Response> {
  const form = body instanceof FormData; // fetch writes the multipart Content-Type, with its boundary
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": KEY, "User-Agent": UA, ...(form ? {} : { "Content-Type": "application/json" }) },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
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

/** Sets NAME=value in .env, replacing the line if there is one. */
function setEnv(name: string, value: string) {
  const lines = (existsSync(ENV) ? readFileSync(ENV, "utf8") : "").split("\n").filter((l) => l && !l.startsWith(`${name}=`));
  writeFileSync(ENV, [...lines, `${name}=${value}`].join("\n") + "\n");
}

/** A CSV file as rows keyed by its header: commas inside double quotes stay, "" is a quote. */
function csv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n").map((line) =>
    [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replaceAll('""', '"')).slice(0, -1));
  const [head, ...body] = lines;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** instructions.txt with the shop's name, currency and policies filled in. */
function instructions(): string {
  const policies = shop.policies.map((p: string) => `- ${p}`).join("\n");
  return readFileSync(join(HERE, "instructions.txt"), "utf8")
    .replaceAll("{store}", shop.storeName).replaceAll("{currency}", shop.currency).replaceAll("{policies}", policies);
}

const text = instructions();
if (text.length > LIMIT) fail(`The instructions are ${text.length} characters; the limit is ${LIMIT}. Shorten instructions.txt or the policies.`);
if (process.argv.includes("--dry-run")) {
  console.log(text);
  console.log(`\n${text.length} of ${LIMIT} characters. Nothing was saved.`);
  process.exit(0);
}
if (!existsSync(CATALOGUE)) fail(`No catalogue at ${CATALOGUE}: put your CSV there, or set \`catalogue\` in shop.yaml.`);
const rows = csv(readFileSync(CATALOGUE, "utf8").replace(/^\uFEFF/, ""));
const columns = rows.length ? Object.keys(rows[0]) : [];
const missing = REQUIRED.filter((c) => !columns.includes(c));
if (missing.length) fail(`The catalogue needs the columns ${REQUIRED.join(", ")}; it has no ${missing.join(", ")}.`);
console.log(`catalogue: ${rows.length} products; instructions: ${text.length} of ${LIMIT} characters`);

// 1. The catalogue, as a product search collection. Its name starts with the account's collection prefix: the
// first ingest without it is refused with a 422 that names the prefix, and is sent again with it.
/** One catalogue row as a product: id, title, price and currency, then every other column as it is. An `image_url`
 * that is a web address goes along as the product's picture; a file path is for the page only. */
function product(r: Record<string, string>) {
  const p: Record<string, unknown> = { product_id: r.id, title: r.name, price: Number(r.price), currency: shop.currencyCode, in_stock: true };
  for (const [k, v] of Object.entries(r)) if (![...REQUIRED, "image_url"].includes(k) && v) p[k] = v;
  if (/^https?:\/\//.test(r.image_url ?? "")) p.main_image_url = r.image_url;
  return p;
}

const products = rows.map(product);
const SEARCHED = ["title", ...columns.filter((c) => !REQUIRED.includes(c) && !NOT_SEARCHED.includes(c))];
let collection: string = process.env.SHOP_COLLECTION || shop.collection;
let answer: Response;
for (;;) {
  answer = await labs("POST", "/developer-platform/vector/ingest", { collection_name: collection, products, embedding_fields: SEARCHED });
  const prefix = answer.status === 422 ? (await answer.clone().json()).context?.collection_prefix : undefined;
  if (!prefix || collection.toLowerCase().startsWith(prefix.toLowerCase())) break;
  collection = prefix + collection;
}
if (!answer.ok) fail("The catalogue was refused: see the body above.");
const started = Date.now(), ingest = await answer.json();
collection = ingest.collection_name;
setEnv("SHOP_COLLECTION", collection);
let state: any;
for (;;) { // the ingest answers are not wrapped in `data`
  const progress = await labs("GET", `/developer-platform/vector/ingest/progress/${ingest.progress_key}`);
  if (!progress.ok) fail("Could not read the ingest: see the body above.");
  if (["completed", "failed", "cancelled"].includes((state = await progress.json()).status)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (state.status !== "completed") fail(`The ingest ended ${state.status}; the collection holds what it held before.`);
console.log(`catalogue: ${collection}, ${products.length} products searchable after ${Math.round((Date.now() - started) / 1000)} s`);

// 2. The agent: created once, then each run saves the instructions as a new flow version.
let agent = process.env.SHOP_AGENT_ID;
if (agent && (await labs("GET", `/developer-platform/agents/${agent}`)).status !== 200) agent = undefined;
if (agent) {
  const flow = await data_of(labs("GET", `/developer-platform/agents/${agent}/flow`), "Could not read the agent's flow");
  const entry = flow.nodes.find((n: any) => n.type === "initial") ?? flow.nodes[0];
  entry.data.prompt.value = text;
  const saved = await data_of(labs("PUT", `/developer-platform/agents/${agent}/flow`,
    { baseVersion: flow.version, nodes: flow.nodes, edges: flow.edges }), "The instructions were not saved");
  console.log(`agent:     ${agent}, instructions saved as flow version ${saved.version}`);
} else {
  let voice: string = shop.voiceId;
  if (!voice) {
    const voices = (await data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")).items;
    voice = voices.find((v: any) => v.isPublic && v.status === "ready").id;
  }
  const created = await data_of(labs("POST", "/developer-platform/agents", {
    name: shop.agentName, instructions: text, welcomeMessage: shop.welcome,
    storeName: shop.storeName, productSearchCollection: collection, voiceId: voice, tools: TOOLS,
  }), "Could not create the agent");
  agent = created.id as string;
  setEnv("SHOP_AGENT_ID", agent);
  console.log(`agent:     ${created.name} (${agent}), voice ${created.voiceId}, saved as SHOP_AGENT_ID`);
}

async function enabled(): Promise<Set<string>> {
  const nodes = await data_of(labs("GET", `/developer-platform/agents/${agent}/tools`), "Could not read the agent's tools");
  return new Set(nodes.filter((n: any) => n.entry).flatMap((n: any) => n.tools.map((t: any) => t.name)));
}

const have = await enabled(); // keep the built-ins in step with TOOLS; each change saves a flow version
for (const name of TOOLS.filter((t) => !have.has(t)).sort()) await labs("POST", `/developer-platform/agents/${agent}/tools`, { name });
for (const name of [...have].filter((t) => !TOOLS.includes(t) && t !== "search_knowledge").sort()) {
  await labs("DELETE", `/developer-platform/agents/${agent}/tools/${name}`);
}
console.log(`tools:     ${[...(await enabled())].sort().join(", ")}`);
console.log("next:      npx tsx shop-assistant/server.ts   then open http://localhost:8050");
