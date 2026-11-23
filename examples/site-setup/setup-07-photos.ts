/**
 * setup-07 · Index the catalogue's photos, so a visitor can find a product by sending a photo of it.
 *
 * The catalogue's collection (setup-06, LABS_COLLECTION) holds each product's `image_url`. This asks Labs to add
 * those photos to a photo index named after the collection, waits until every photo is indexed, and saves the
 * index's name as LABS_PHOTO_INDEX in .env: the server then takes photos in the chat (site-assistant/CONTRACT.md).
 * Run it again after the catalogue gains products: only new photos are charged. Pass a photo, as a file or a web
 * address, to see which products it finds, and their scores: the server names only those above
 * `catalogue.photoMinScore`.
 *
 * Run: npx tsx site-setup/setup-07-photos.ts [photo]
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
const COLLECTION = process.env.LABS_COLLECTION || fail("Set LABS_COLLECTION in .env (setup-06 loads the catalogue).");
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const VS = "/product-discovery/visual-search";
const MODEL = "general-v1.5"; // kept for the index's life: to change it, delete the index and run this again
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(dirname(fileURLToPath(import.meta.url)), "site-assistant.example.yaml");
const MIN_SCORE: number | undefined = YAML.parse(readFileSync(ANSWERS, "utf8")).catalogue?.photoMinScore ?? undefined;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Ask for the collection's photos, then follow the sync: it starts within a minute
let sync = await data_of(labs("POST", `${VS}/collections/${COLLECTION}/photos`, { model: MODEL }), "The photos were not asked for");
const index: string = sync.indexName, started = Date.now();
while (!["done", "failed", "gave_up"].includes(sync.state)) {
  await sleep(5000);
  sync = await data_of(labs("GET", `${VS}/collections/${COLLECTION}/photos`), "Could not read the sync");
}
if (sync.state !== "done") fail(`The sync ended ${sync.state}: ${sync.error}`);
if (sync.error) console.log(`note:     ${sync.error}`);
if (!(sync.newPhotos + sync.updatedPhotos))
  fail("No product has a photo: give the catalogue an image_url column of web addresses, run setup-06, then this.");

// 2. Wait until every photo is downloaded and indexed
let state: any;
while ((state = await data_of(labs("GET", `${VS}/indexes/${index}`), "Could not read the index")).queuedPhotos) await sleep(3000);
console.log(`ready:    ${index}, ${state.photos} photos of ${state.products} products, model ${state.model}, `
  + `after ${Math.round((Date.now() - started) / 1000)} s (${sync.newPhotos} new)`);
if (state.failedPhotos)
  console.log(`note:     ${state.failedPhotos} photos could not be downloaded: check their image_url opens from anywhere`);
setEnv("LABS_PHOTO_INDEX", index);
console.log(`saved:    LABS_PHOTO_INDEX=${index} in .env`);

// 3. With a photo: the products it finds, closest first
const photo = process.argv[2];
if (photo) {
  const query = /^https?:\/\//.test(photo) ? { imageUrl: photo } : { imageBase64: readFileSync(photo).toString("base64") };
  // minScore 0 shows the closest three whatever they score; the server names only those above MIN_SCORE
  const found = await data_of(labs("POST", `${VS}/indexes/${index}/search`, { ...query, limit: 3, minScore: 0 }), "The search failed");
  const floor = MIN_SCORE ?? found.minScore;
  for (const m of found.results) {
    console.log(`found:    ${m.data.title} (${m.productId}), score ${m.score.toFixed(2)}`
      + (m.score >= floor ? "" : `, under ${floor}: the server leaves it out`));
  }
}
console.log("next:     setup-03-build-instructions tells the agent about photos");
