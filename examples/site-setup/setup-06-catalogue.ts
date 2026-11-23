/**
 * setup-06 · Load the product catalogue and give it to a product desk; run it again when the catalogue changes.
 *
 * A catalogue goes in a product search collection, never in the knowledge base, and one step of an agent searches a
 * knowledge base or a collection, not both. So the site's pages stay with the agent's first step (setup-04), and the
 * catalogue goes to a second step, the product desk, which the first hands product questions to with
 * `transfer_to_product_desk`. This loads `catalogue.source` (Q5), a CSV with at least `id`, `name` and `price`
 * columns, into the collection in LABS_COLLECTION (made the first time, with the account's prefix, and saved to .env),
 * waits until it is searchable, then adds the product desk to the agent's flow, or points the one it has at the
 * collection. setup-03 writes both steps' instructions: run it after this one.
 *
 * Run: npx tsx site-setup/setup-06-catalogue.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

let ENV = ".env";
for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { ENV = join(d, ".env"); process.loadEnvFile(ENV); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const AGENT = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env (setup-02 makes one).");
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(dirname(fileURLToPath(import.meta.url)), "site-assistant.example.yaml");
const REQUIRED = ["id", "name", "price"]; // every other column is stored with the product, and searched by meaning
const DESK = "product_desk";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. */
async function labs(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA },
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

/** Sets NAME=value in .env, replacing the line if there is one. */
function setEnv(name: string, value: string) {
  const lines = (existsSync(ENV) ? readFileSync(ENV, "utf8") : "").split("\n").filter((l) => l && !l.startsWith(`${name}=`));
  writeFileSync(ENV, [...lines, `${name}=${value}`].join("\n") + "\n");
}

/** A CSV file's rows as objects, read as Python's csv module reads it: a quoted field may hold , " and line breaks. */
function csv(text: string): Record<string, string>[] {
  const rows: string[][] = [[""]];
  let quoted = false;
  text = text.replace(/^﻿/, ""); // a byte-order mark, as some spreadsheets save one
  for (let i = 0; i < text.length; i++) {
    const c = text[i], row = rows[rows.length - 1];
    if (quoted && c === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === ",") row.push("");
    else if (!quoted && (c === "\n" || c === "\r")) { if (c === "\r" && text[i + 1] === "\n") i++; rows.push([""]); }
    else row[row.length - 1] += c;
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== ""); // blank lines and a last line break
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
const catalogue = site.catalogue ?? {};
if (!catalogue.source) fail(`No catalogue: set catalogue.source in ${ANSWERS.split("/").pop()} (Q5) to the owner's CSV.`);
const rows = csv(readFileSync(catalogue.source, "utf8"));
const columns = rows.length ? Object.keys(rows[0]) : [];
const missing = REQUIRED.filter((c) => !columns.includes(c));
if (missing.length) fail(`The catalogue needs the columns ${REQUIRED.join(", ")}; it has no ${missing.join(", ")}.`);
const bad = rows.filter((r) => !/^[0-9]+(\.[0-9]+)?$/.test(r.price.trim())).map((r) => r.id);
if (bad.length) fail(`A price must be a plain number, such as 6.50, with no currency sign; not in ${bad.slice(0, 10).join(", ")}.`);

/** One catalogue row as a product: id, title, price and currency, then every other column as it is. An
 * `image_url` that is a web address goes along as the product's picture. */
function product(r: Record<string, string>) {
  const p: Record<string, unknown> = { product_id: r.id, title: r.name, price: Number(r.price), currency: catalogue.currency, in_stock: true };
  for (const [k, v] of Object.entries(r)) if (![...REQUIRED, "image_url"].includes(k) && v) p[k] = v;
  if (/^https?:\/\//.test(r.image_url ?? "")) p.main_image_url = r.image_url;
  return p;
}

const products = rows.map(product);
const searched = ["title", ...columns.filter((c) => ![...REQUIRED, "image_url"].includes(c))];
console.log(`catalogue: ${products.length} products from ${catalogue.source}, searched by ${searched.join(", ")}`);

// 1. The collection: its name needs the account's prefix, which the first refusal names
let collection: string = process.env.LABS_COLLECTION
  || site.storeName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") + "_catalogue";
let res: Response;
for (;;) {
  res = await labs("POST", "/developer-platform/vector/ingest", { collection_name: collection, products, embedding_fields: searched });
  const prefix = res.status === 422 ? (await res.clone().json()).context?.collection_prefix : null;
  if (!prefix || collection.toLowerCase().startsWith(prefix.toLowerCase())) break;
  collection = prefix + collection;
}
if (!res.ok) fail("The catalogue was refused: see the body above.");
const ingest = await res.json(), started = Date.now(); // the ingest answers are not wrapped in `data`
collection = ingest.collection_name;
setEnv("LABS_COLLECTION", collection);
let state: any;
for (;;) {
  const progress = await labs("GET", `/developer-platform/vector/ingest/progress/${ingest.progress_key}`);
  if (!progress.ok) fail("Could not read the ingest: see the body above.");
  state = await progress.json();
  if (["completed", "failed", "cancelled"].includes(state.status)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (state.status !== "completed") fail(`The ingest ended ${state.status}; the collection holds what it held before.`);
console.log(`ready:    ${collection}, searchable after ${Math.round((Date.now() - started) / 1000)} s (LABS_COLLECTION in .env)`);

// 2. The product desk: a second step on the collection, which the first step hands product questions to
for (const attempt of [1, 2]) { // a 409 means someone saved since we read: read again and reapply
  const flow = await data_of(labs("GET", `/developer-platform/agents/${AGENT}/flow`), "Could not read the agent's flow");
  const entry = flow.nodes.find((n: any) => n.type === "initial") ?? flow.nodes[0];
  let desk = flow.nodes.find((n: any) => n.id === DESK);
  if (desk?.data.product_search_collection === collection) {
    console.log(`agent:    the product desk already searches ${collection}`);
    break;
  }
  if (!desk) { // the step and its route, shaped as a manifest makes them; setup-03 writes its instructions
    desk = { id: DESK, type: "node", position: { x: 0, y: 160 },
      data: { name: DESK, factory: "tool_agent", description: "", tools: { local: ["search_knowledge"] },
        prompt: { type: "inline", value: `You answer questions about ${site.storeName}'s products.` } } };
    const route = { id: `route_${DESK}`, from: entry.id, to: DESK, kind: "route", trigger_tool: `transfer_to_${DESK}` };
    flow.nodes.push(desk);
    flow.edges.push({ id: route.id, source: entry.id, target: DESK, data: route }); // from/to must name the steps
  }
  desk.data.product_search_collection = collection;
  const saved = await labs("PUT", `/developer-platform/agents/${AGENT}/flow`, { baseVersion: flow.version, nodes: flow.nodes, edges: flow.edges });
  if (saved.status !== 409 || attempt === 2) {
    if (!saved.ok) fail("The product desk was not saved: see the body above.");
    console.log(`agent:    the product desk searches ${collection} (flow version ${(await saved.json()).data.version})`);
    break;
  }
}
console.log("next:     setup-03-build-instructions writes both steps' instructions");
