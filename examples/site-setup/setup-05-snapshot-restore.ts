/**
 * setup-05 · Save the agent's configuration before a change, and put it back.
 *
 * Labs has no publish or roll-back yet: every flow save is live at once. So save a snapshot before each change
 * (setup-03, setup-04, a voice change) and restore it if the change goes wrong. A snapshot holds the agent's own
 * fields and its whole flow (instructions, tools, knowledge base). Restoring saves the old flow as a new version
 * (versions only count up) and puts the agent's fields back with PATCH. Restore the newest snapshot taken before
 * the change: an older one also undoes everything since, such as a knowledge base bound by setup-04.
 *
 * Run: npx tsx site-setup/setup-05-snapshot-restore.ts save
 *      npx tsx site-setup/setup-05-snapshot-restore.ts list
 *      npx tsx site-setup/setup-05-snapshot-restore.ts restore snapshots/<agent>/<file>.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const AGENT = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env (setup-02 makes one).");
const UA = "labs-playbook-examples/1.0"; // any explicit User-Agent works
const FIELDS = ["name", "description", "voiceId", "storeName", "status", "avatarId"]; // what PATCH can change
const SNAPSHOTS = "snapshots";

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

const readFlow = () => data_of(labs("GET", `/developer-platform/agents/${AGENT}/flow`), "Could not read the agent's flow");

const promptOf = (flow: any): string =>
  (flow.nodes.find((n: any) => n.type === "initial") ?? flow.nodes[0])?.data.prompt.value ?? "";
const stamp = (format: "file" | "iso") => {
  const iso = new Date().toISOString().slice(0, 19);
  return format === "iso" ? iso + "Z" : iso.replace(/-|:/g, "").replace("T", "-");
};

const [command = "list", file] = process.argv.slice(2);
if (command === "save") {
  const agent = await data_of(labs("GET", `/developer-platform/agents/${AGENT}`), "Could not read the agent");
  const flow = await readFlow();
  const path = join(SNAPSHOTS, AGENT, `${stamp("file")}-v${flow.version}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    savedAt: stamp("iso"),
    agent: Object.fromEntries(FIELDS.map((k) => [k, agent[k] ?? null])),
    flow: { version: flow.version, nodes: flow.nodes, edges: flow.edges, meta: flow.meta },
  }, null, 1));
  console.log(`saved:    ${path} (flow version ${flow.version}, ${[...promptOf(flow)].length}-character instructions)`);
} else if (command === "list") {
  const dir = join(SNAPSHOTS, AGENT);
  for (const name of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []) {
    const snap = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const entry = (snap.flow.nodes.find((n: any) => n.type === "initial") ?? { data: {} }).data;
    console.log(`${join(dir, name)}  ${snap.savedAt}  flow version ${snap.flow.version}  `
      + `${[...promptOf(snap.flow)].length}-character instructions  knowledge base ${entry.knowledge_base_id || "none"}  `
      + `voice ${snap.agent.voiceId}`);
  }
} else if (command === "restore" && file) {
  const snap = JSON.parse(readFileSync(file, "utf8"));
  // The agent's fields first: a PATCH can itself save a flow version, so the flow goes back last.
  const fields = Object.fromEntries(Object.entries(snap.agent).filter(([, v]) => v !== null));
  const patched = await labs("PATCH", `/developer-platform/agents/${AGENT}`, fields);
  if (patched.status !== 200) fail("Nothing was restored: see the body above.");
  const current = await readFlow();
  const res = await labs("PUT", `/developer-platform/agents/${AGENT}/flow`, {
    baseVersion: current.version, nodes: snap.flow.nodes, edges: snap.flow.edges, meta: snap.flow.meta,
  });
  if (res.status !== 200) fail("The agent's fields are restored, but the flow is not: see the body above.");
  console.log(`restored: agent fields put back; flow version ${snap.flow.version} saved again as version `
    + `${(await res.json()).data.version}`);
} else {
  fail("Usage: setup-05-snapshot-restore save | list | restore snapshots/<agent>/<file>.json");
}
