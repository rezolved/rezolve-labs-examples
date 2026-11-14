/**
 * setup-04 · Upload the site's pages as knowledge; run it again on every publish.
 *
 * Reads the built HTML pages in `knowledge.source` (Q5) into one row per page: its address, title and text. A
 * .txt or .md upload is refused, so the rows go up as a CSV (also saved to out/knowledge.csv) to the knowledge base
 * in LABS_KB_ID, which is created and saved to .env the first time. When the new document is `ready`, the older
 * ones are deleted: while both are in the base, answers mix old and new. An agent that has no knowledge base yet is
 * bound to it through its flow (`knowledge_base_id` plus the `search_knowledge` tool), since PATCH can't do it.
 *
 * Run: npx tsx site-setup/setup-04-knowledge.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const UA = "labs-playbook-examples/1.0"; // any explicit User-Agent works
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(dirname(fileURLToPath(import.meta.url)), "site-assistant.example.yaml");
// html.unescape's most common entities; add any other your pages use.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©" };

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

/** The page's address: index.html -> /, breads.html -> /breads, visit/index.html -> /visit. */
const address = (relative: string) =>
  ("/" + relative.replace(/\.html?$/i, "").replace(/(^|\/)index$/, "")).replace(/\/+$/, "") || "/";

const clean = (text: string) => text
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] !== "#" ? ENTITIES[e.toLowerCase()] ?? m
    : String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)))
  .replace(/\s+/g, " ").trim();

/** [title, text] of an HTML page: its <main> (or <body>), without scripts, styles, navigation, header, footer. */
function page(source: string): [string, string] {
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const body = source.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ?? source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const text = (body ? body[1] : source).replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ");
  return [title ? clean(title[1]) : "", clean(text.replace(/<[^>]+>/g, " "))];
}

const csv = (rows: string[][]) => rows.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(",") + "\n").join("");

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
const source: string = site.knowledge.source;
const files = existsSync(source)
  ? (readdirSync(source, { recursive: true }) as string[]).map((f) => f.split("\\").join("/")).filter((f) => /\.html?$/i.test(f)).sort()
  : [];
if (!files.length) fail(`No .html pages in ${source} (knowledge.source in ${basename(ANSWERS)}).`);
const rows = [["page", "title", "text"], ...files.map((f) => [address(f), ...page(readFileSync(join(source, f), "utf8"))])];
const data = Buffer.from(csv(rows));
mkdirSync("out", { recursive: true });
writeFileSync("out/knowledge.csv", data);
console.log(`pages:    ${files.length} from ${source}: ${rows.slice(1).map((r) => r[0]).join(", ")} (${data.length} bytes, out/knowledge.csv)`);

let kb = process.env.LABS_KB_ID;
if (!kb) {
  kb = (await data_of(labs("POST", "/developer-platform/knowledge-bases", { name: `${site.storeName} site pages` }),
    "Could not create the knowledge base")).id as string;
  setEnv("LABS_KB_ID", kb);
  console.log(`created:  knowledge base ${kb}, saved as LABS_KB_ID in ${basename(ENV)}`);
}
const listed = await data_of(labs("GET", `/developer-platform/knowledge-bases/${kb}/documents?pageSize=100`), "Could not list the documents");
const older: string[] = listed.items.map((d: any) => d.id);

const form = new FormData();
form.append("file", new Blob([data], { type: "text/csv" }), "site-pages.csv");
const uploaded = await labs("POST", `/developer-platform/knowledge-bases/${kb}/documents`, form);
if (uploaded.status !== 202) fail("The upload was refused: see the body above.");
const doc: string = (await uploaded.json()).data.id;
const started = Date.now();
let state: any;
for (;;) { // accepted is not searchable: wait for `ready`
  state = await data_of(labs("GET", `/developer-platform/knowledge-bases/${kb}/documents/${doc}`), "Could not read the document");
  if (state.status === "ready" || state.status === "failed") break;
  await new Promise((r) => setTimeout(r, 5000));
}
if (state.status === "failed") fail(`Indexing failed (${state.error}); the previous pages are still in place.`);
console.log(`ready:    document ${doc} after ${Math.round((Date.now() - started) / 1000)} s`);
for (const old of older) await labs("DELETE", `/developer-platform/knowledge-bases/${kb}/documents/${old}`);
console.log(`removed:  ${older.length} older document(s)`);

const agent = await data_of(labs("GET", `/developer-platform/agents/${AGENT}`), "Could not read the agent");
if (agent.knowledgeBaseId === kb) {
  console.log("agent:    already searches this knowledge base");
} else {
  const flow = await data_of(labs("GET", `/developer-platform/agents/${AGENT}/flow`), "Could not read the agent's flow");
  const entry = flow.nodes.find((n: any) => n.type === "initial") ?? flow.nodes[0];
  entry.data.knowledge_base_id = kb;
  entry.data.tools ??= {};
  entry.data.tools.local ??= [];
  if (!entry.data.tools.local.includes("search_knowledge")) entry.data.tools.local.push("search_knowledge");
  const saved = await labs("PUT", `/developer-platform/agents/${AGENT}/flow`, { baseVersion: flow.version, nodes: flow.nodes, edges: flow.edges });
  if (saved.status !== 200) fail("The agent was not bound to the knowledge base: see the body above.");
  console.log(`agent:    now searches knowledge base ${kb} (flow version ${(await saved.json()).data.version})`);
}
