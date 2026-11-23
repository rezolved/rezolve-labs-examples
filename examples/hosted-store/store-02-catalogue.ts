/**
 * hosted-store · 02 Load your catalogue into the store.
 *
 * Reads your catalogue CSV (a header row; `product_id`, `title`, `category` and `price` required), turns each row into
 * the JSON record the store takes, uploads them all with PUT …/catalog, and waits for the job. The upload REPLACES the
 * store's whole catalogue: on a store that already has products the script stops unless you pass --replace.
 *
 * Columns: `category` is up to three levels split by `>` ("Women > Dresses"); `price` and `original_price` are plain
 * numbers in --currency; `additional_image_url`, `sizes`, `colors` and `tags` take several values split by `|`;
 * `brand`, `gender`, `description`, `product_url` and `main_image_url` are optional text.
 *
 * Run, from examples/: npx tsx hosted-store/store-02-catalogue.ts my-catalogue.csv [--currency GBP] [--replace]
 */
import { existsSync, readFileSync } from "node:fs";
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
const REQUIRED = ["product_id", "title", "category", "price"];
const TEXT = ["brand", "gender", "description", "product_url", "main_image_url"];
const LISTS = ["additional_image_url", "sizes", "colors", "tags"];
const MOST = 20000; // products in one upload

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

/** A CSV file as rows keyed by its header: commas inside double quotes stay, "" is a quote. */
function csv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/).map((line) =>
    [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replaceAll('""', '"')).slice(0, -1));
  const [head, ...body] = lines;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const split = (value: string, by: string) => value.split(by).map((v) => v.trim()).filter(Boolean);

/** One CSV row as a catalogue record. The store refuses a bad record with only "Invalid input", so check here. */
function record(row: Record<string, string>, n: number, currency: string) {
  for (const col of REQUIRED) if (!row[col]?.trim()) fail(`Row ${n}: ${col} is required.`);
  const price = Number(row.price);
  if (!Number.isFinite(price)) fail(`Row ${n}: price must be a number, such as 49.95.`);
  const rec: Record<string, unknown> = {
    product_id: row.product_id.trim(), title: row.title.trim(),
    category: split(row.category, ">").slice(0, 3), // an array, not "A > B"
    price: [{ currency, value: price }], // a list of prices, not a number
  };
  if (row.original_price?.trim()) rec.original_price = [{ currency, value: Number(row.original_price) }];
  for (const col of TEXT) if (row[col]?.trim()) rec[col] = row[col].trim();
  for (const col of LISTS) if (row[col]?.trim()) rec[col] = split(row[col], "|");
  return rec;
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { currency: { type: "string", default: "GBP" }, replace: { type: "boolean", default: false } },
});
if (!positionals[0]) fail("Pass your catalogue CSV: hosted-store/store-02-catalogue.ts my-catalogue.csv");
if (!["GBP", "EUR", "USD", "AUD"].includes(opts.currency!)) fail("--currency must be one of GBP, EUR, USD, AUD.");
const records = csv(readFileSync(positionals[0], "utf8")).map((row, i) => record(row, i + 2, opts.currency!));
const ids = records.map((r) => r.product_id as string);
if (!records.length || records.length > MOST) fail(`The file has ${records.length} products; send 1 to ${MOST}.`);
const twice = ids.find((id, i) => ids.indexOf(id) !== i);
if (twice) fail(`product_id ${twice} appears twice.`);

const store = await data_of(labs("GET", `/commerce/stores/${STORE}`), "Could not read the store");
if (store.counts.products && !opts.replace) {
  fail(`${STORE} already has ${store.counts.products} products and the upload replaces them all. Pass --replace to go ahead.`);
}
const job = await data_of(labs("PUT", `/commerce/stores/${STORE}/catalog`, { records }), "Upload refused");
console.log(`Uploading ${job.records} products as job ${job.jobId}`);
let state;
while (!["COMPLETED", "FAILED"].includes((state = await data_of(labs("GET", `/commerce/stores/${STORE}/jobs/${job.jobId}`), "Could not read the job")).state)) {
  await new Promise((r) => setTimeout(r, 3000));
}
if (state.state === "FAILED") fail(`The job failed: ${state.error}`);
const result = state.result;
console.log(`Imported ${result.imported} (${result.forSale} for sale), ${result.collections} departments.`);
for (const c of await data_of(labs("GET", `/commerce/stores/${STORE}/collections`), "Could not list departments")) {
  console.log(`  department ${c.slug}: ${c.name}`);
}
if (!result.labsEnrichmentStarted) {
  console.log("Word search is not being set up for this store: searches with words will find nothing (browse works).");
}
