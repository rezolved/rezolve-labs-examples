/**
 * setup-02 · Create the agent, with a voice.
 *
 * Creates the agent from site-assistant.yaml (or the example) with its name, business, welcome line and a voice:
 * an agent created without `voiceId` is given a public voice, not the owner's. The voice
 * is `voiceId` from the YAML, or the first ready public voice. The new ids go into .env as LABS_AGENT_ID and
 * LABS_VOICE_ID. Then each of the owner's hard words is spoken twice, as written and as respelled, for the owner
 * to listen to in out/hard-words/. The instructions here are a stub: setup-03 builds the real ones.
 * If LABS_AGENT_ID is already set to a live agent, nothing is created.
 *
 * Run: npx tsx site-setup/setup-02-create-agent.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

let ENV = ".env";
for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { ENV = join(d, ".env"); process.loadEnvFile(ENV); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // any explicit User-Agent works
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(dirname(fileURLToPath(import.meta.url)), "site-assistant.example.yaml");

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

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
console.log(`answers:  ${relative(process.cwd(), ANSWERS)}`);
if (process.env.LABS_AGENT_ID) {
  const res = await labs("GET", `/developer-platform/agents/${process.env.LABS_AGENT_ID}`);
  if (res.status === 200) {
    const agent = (await res.json()).data;
    console.log(`agent:    ${agent.name} (${agent.id}) already exists. setup-03 changes its instructions; `
      + "to make a new agent, empty LABS_AGENT_ID in .env.");
    process.exit(0);
  }
}

let voiceId: string = site.voiceId;
if (!voiceId) {
  const voices = (await data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")).items;
  const voice = voices.find((v: any) => v.isPublic && v.status === "ready");
  voiceId = voice.id;
  console.log(`voice:    ${voice.name} (${voice.voiceType}, public), the first ready public voice`);
}

const res = await labs("POST", "/developer-platform/agents", {
  name: site.name,
  storeName: site.storeName,
  description: `Website assistant for ${site.storeName}`,
  welcomeMessage: site.welcomeMessage,
  voiceId,
  instructions: `You are the website assistant for ${site.storeName}. Answer in one or two short sentences.`,
});
if (res.status !== 201) fail("The agent was not created: see the body above.");
const agent = (await res.json()).data;
setEnv("LABS_AGENT_ID", agent.id);
setEnv("LABS_VOICE_ID", voiceId);
console.log(`agent:    ${agent.name} (${agent.id}), voice ${agent.voiceId}`);
console.log(`saved:    LABS_AGENT_ID and LABS_VOICE_ID in ${basename(ENV)}`);

mkdirSync("out/hard-words", { recursive: true });
for (const p of site.pronunciations ?? []) {
  const slug = p.word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let saved = 0;
  for (const [suffix, text] of [["as-written", p.word], ["respelled", p.sayAs]]) {
    const speech = await labs("POST", `/voice-audio/voices/${voiceId}/speech`, { text: `${text}.`, outputFormat: "mp3_44100_64" });
    if (speech.status === 200) {
      writeFileSync(`out/hard-words/${slug}-${suffix}.mp3`, Buffer.from(await speech.arrayBuffer()));
      saved++;
    }
  }
  if (saved === 2) console.log(`listen:   out/hard-words/${slug}-as-written.mp3 and ${slug}-respelled.mp3 ("${p.word}" said as "${p.sayAs}")`);
  else console.log(`missing:  a clip for "${p.word}" was not made (see the body above); run setup-02 again later`);
}
console.log("next:     setup-03-build-instructions writes the agent's real instructions from the answers");
