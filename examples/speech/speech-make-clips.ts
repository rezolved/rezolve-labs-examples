/**
 * speech · Make the welcome and acknowledgement clips once.
 *
 * The lines the assistant always says come from site-assistant.yaml (or the example): `welcomeMessage`,
 * `welcome.back` and `acknowledgements[]`, each respelled with `pronunciations[]` (see speech-respell). Each is spoken
 * once and stored as out/clips/<key>.mp3, where <key> is its cache key (see speech-cache-key), and
 * out/clips/manifest.json names them for your server. A run makes only the clips that are missing, so it costs
 * nothing when no line changed. The voice is part of the key, so a new voice makes new clips, and clips the manifest
 * no longer lists are removed.
 *
 * Every voice is cached. A stored clip is the take you keep: the same request can come back as another take
 * (the workspace's default voice gives a new one on every call), so back up out/clips/ rather than remaking clips
 * to check them.
 *
 * The voice: an id on the command line, else the agent's (LABS_AGENT_ID), else LABS_VOICE_ID, else `voiceId` in the
 * YAML, else the first ready public voice (as setup-02 picks).
 *
 * Run: npx tsx speech/speech-make-clips.ts [voiceId]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
for (let d = HERE; ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(HERE, "..", "site-setup", "site-assistant.example.yaml");
const CLIPS = "out/clips";
const FORMAT = "mp3_44100_64";
const SPACES = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g; // the same set in Python

type SpeechBody = { text: string; outputFormat: string; voiceSettings?: Record<string, unknown>; seed?: number; language?: string };
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

// speechBody(), canonical() and clipKey() are copied from speech-cache-key.ts; the vectors check below keeps them equal.
/** The speech request, tidied. Send exactly this body, and key the clip with clipKey(). */
function speechBody(text: string, outputFormat = FORMAT, voiceSettings?: Record<string, unknown> | null,
  seed?: number | null, language?: string | null): SpeechBody {
  const body: SpeechBody = { text: text.normalize("NFC").replace(SPACES, " ").replace(/^ | $/g, ""), outputFormat };
  const settings = Object.entries(voiceSettings ?? {}).filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (settings.length) body.voiceSettings = Object.fromEntries(settings);
  if (seed !== null && seed !== undefined) body.seed = seed;
  if (language) body.language = language;
  return body;
}

/** JSON with sorted keys and no spaces. JSON.stringify already writes 1.0 as 1 and keeps non-ASCII as it is. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The voice id and the request as one line of JSON: sorted keys, no spaces, non-ASCII kept as it is. */
function canonical(voiceId: string, body: SpeechBody): string {
  return sortedJson({ voiceId: voiceId.trim().toLowerCase(), ...body });
}

/** The clip's key: SHA-256 of canonical(), as 64 hex characters. Use it as the file name. */
function clipKey(voiceId: string, body: SpeechBody): string {
  return createHash("sha256").update(canonical(voiceId, body), "utf8").digest("hex");
}

/** The text to send to speech: each `word` replaced by its `sayAs`, as a whole word in any case. */
function respell(text: string, pronunciations: Pronunciation[]): string {
  for (const p of [...pronunciations].sort((a, b) => b.word.length - a.word.length)) {
    const word = p.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, "giu"), () => p.sayAs);
  }
  return text;
}

/** The voice the agent speaks with (see the order at the top of this file). */
async function pickVoice(site: any): Promise<string> {
  if (process.argv[2]) return process.argv[2];
  if (process.env.LABS_AGENT_ID) {
    const agent = await data_of(labs("GET", `/developer-platform/agents/${process.env.LABS_AGENT_ID}`), "Could not read the agent");
    return agent.voiceId || fail("The agent has no voice: give it one (setup-02) before making clips.");
  }
  if (process.env.LABS_VOICE_ID || site.voiceId) return process.env.LABS_VOICE_ID || site.voiceId;
  const voices = (await data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")).items;
  return voices.find((v: any) => v.isPublic && v.status === "ready").id;
}

/** A designed, cloned or default voice, in words. */
function describe(voice: any): string {
  let kind = ({ generated: "a designed voice", cloned: "a cloned voice" } as Record<string, string>)[voice.voiceType]
    ?? `a ${voice.voiceType} voice`;
  if (voice.isDefault) kind = "the workspace's default voice";
  return kind + (voice.isPublic ? ", public" : "");
}

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
console.log(`answers:   ${relative(process.cwd(), ANSWERS)}`);
const vectors = JSON.parse(readFileSync(join(HERE, "cache-key-vectors.json"), "utf8")).vectors;
const wrong = vectors.filter((v: any) => clipKey(v.voiceId, speechBody(
  v.text, v.outputFormat ?? FORMAT, v.voiceSettings, v.seed, v.language)) !== v.key).map((v: any) => v.name);
if (wrong.length) fail(`The key code here differs from speech-cache-key: ${wrong.join(", ")}`);
console.log(`key check: ${vectors.length} vectors pass`);

const voiceId = await pickVoice(site);
const voice = await data_of(labs("GET", `/voice-audio/voices/${voiceId}`), "Could not read the voice");
console.log(`voice:     ${voiceId} (${describe(voice)})`);

const lines: [string, string, string | undefined][] = [
  ["welcome", "welcomeMessage", site.welcomeMessage],
  ["welcome-back", "welcome.back", site.welcome?.back],
  ...(site.acknowledgements ?? []).map((a: string, i: number): [string, string, string] =>
    [`ack-${i + 1}`, `acknowledgements[${i}]`, a]),
];

mkdirSync(CLIPS, { recursive: true });
const clips: { name: string; text: string; spoken: string; key: string; file: string }[] = [];
for (const [name, field, text] of lines) {
  if (!text) {
    console.log(`skipped:   ${name} (${field} is empty)`);
    continue;
  }
  const body = speechBody(respell(text, site.pronunciations ?? []));
  const key = clipKey(voiceId, body);
  const path = join(CLIPS, `${key}.mp3`);
  if (existsSync(path)) {
    console.log(`kept:      ${name} ${key.slice(0, 12)}…`);
  } else {
    const res = await labs("POST", `/voice-audio/voices/${voiceId}/speech`, body);
    if (res.status !== 200) {
      console.log(`missing:   ${name} (see the body above); run again to retry`);
      continue;
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const part = join(CLIPS, `${key}.part`); // written whole, then renamed: a half-written clip is never served
    writeFileSync(part, audio);
    renameSync(part, path);
    console.log(`made:      ${name} ${key.slice(0, 12)}…`);
  }
  clips.push({ name, text, spoken: body.text, key, file: `${key}.mp3` });
}

const listed = new Set(clips.map((c) => c.file));
const stale = readdirSync(CLIPS).filter((f) => f.endsWith(".mp3") && !listed.has(f));
for (const f of stale) unlinkSync(join(CLIPS, f));
if (stale.length) console.log(`removed:   ${stale.length} clips no longer listed (an earlier voice or line)`);
const manifest = { voiceId, voiceType: voice.voiceType, outputFormat: FORMAT, clips };
writeFileSync(join(CLIPS, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest:  out/clips/manifest.json (${clips.length} clips)`);
