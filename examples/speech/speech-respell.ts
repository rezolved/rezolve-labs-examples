/**
 * speech · Respell hard words before speech.
 *
 * The owner's `pronunciations[]` in site-assistant.yaml (or the example) say how to say a word: in the text sent to
 * speech, each `word` becomes its `sayAs`, as a whole word in any case ("Saltmarsh's" too), longest word first. The
 * speech request has no pronunciation field, so a respelling is how you steer it. Only the speech request gets it:
 * the text on screen, the agent's instructions and its knowledge keep the real spelling.
 *
 * Each line the assistant always says (the welcome, welcome back and acknowledgements) that has a hard word, or the
 * text you pass, is spoken as written and respelled into out/respell/, for the owner to compare.
 *
 * Run: npx tsx speech/speech-respell.ts ["text to say"]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(dirname(fileURLToPath(import.meta.url)), "..", "site-setup", "site-assistant.example.yaml");

type Pronunciation = { word: string; sayAs: string };

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

/** The text to send to speech: each `word` replaced by its `sayAs`, as a whole word in any case. */
function respell(text: string, pronunciations: Pronunciation[]): string {
  for (const p of [...pronunciations].sort((a, b) => b.word.length - a.word.length)) {
    const word = p.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, "giu"), () => p.sayAs);
  }
  return text;
}

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
console.log(`answers:   ${relative(process.cwd(), ANSWERS)}`);
const pronunciations: Pronunciation[] = site.pronunciations ?? [];
if (!pronunciations.length) fail("No pronunciations[] in the answers: nothing to respell.");
for (const p of pronunciations) console.log(`respell:   ${p.word} -> ${p.sayAs}`);

const said: string[] = [site.welcomeMessage, site.welcome?.back, ...(site.acknowledgements ?? [])];
const found = said.filter((s) => s && respell(s, pronunciations) !== s);
const lines = process.argv[2] !== undefined ? [process.argv[2]]
  : found.length ? found : pronunciations.map((p) => `${p.word}.`);

let voiceId: string = process.env.LABS_VOICE_ID || site.voiceId;
if (!voiceId) {
  const voices = (await data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")).items;
  voiceId = voices.find((v: any) => v.isPublic && v.status === "ready").id;
}
console.log(`voice:     ${voiceId}`);

mkdirSync("out/respell", { recursive: true });
for (const [i, line] of lines.entries()) {
  const n = i + 1;
  console.log(`line ${n}:    ${line}`);
  console.log(`respelled: ${respell(line, pronunciations)}`);
  const saved: string[] = [];
  for (const [suffix, text] of [["as-written", line], ["respelled", respell(line, pronunciations)]]) {
    const res = await labs("POST", `/voice-audio/voices/${voiceId}/speech`, { text, outputFormat: "mp3_44100_64" });
    if (res.status === 200) {
      writeFileSync(`out/respell/line-${n}-${suffix}.mp3`, Buffer.from(await res.arrayBuffer()));
      saved.push(`out/respell/line-${n}-${suffix}.mp3`);
    }
  }
  console.log(saved.length === 2 ? `listen:    ${saved.join(" and ")}` : "missing:   a clip was not made (see the body above)");
}
