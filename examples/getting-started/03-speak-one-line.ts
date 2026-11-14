/**
 * 03 · Speak one line.
 *
 * One speech call, saved to out/03-speak-one-line.mp3. Uses LABS_VOICE_ID, or else the first ready public voice
 * in GET /voice-audio/voices/list. The answer is the audio itself (not JSON); its headers say what the call cost
 * (X-Credits-Charged) and what is left (X-Credits-Remaining). Speech costs 1 credit per 100 characters.
 *
 * Run: npx tsx getting-started/03-speak-one-line.ts ["text to say"]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // any explicit User-Agent works

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

const text = process.argv[2] ?? "Hello from Rezolve Labs. This line was spoken by your voice.";
let voiceId = process.env.LABS_VOICE_ID;
if (!voiceId) {
  const voices = (await data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")).items;
  const voice = voices.find((v: any) => v.isPublic && v.status === "ready");
  voiceId = voice.id;
  console.log(`voice:     ${voice.name} (${voice.voiceType}, public), ${voiceId}`);
}

const res = await labs("POST", `/voice-audio/voices/${voiceId}/speech`, { text, outputFormat: "mp3_44100_64" });
if (res.status !== 200) fail("Speech was refused: see the body above.");
mkdirSync("out", { recursive: true });
writeFileSync("out/03-speak-one-line.mp3", Buffer.from(await res.arrayBuffer()));
console.log(`saved:     out/03-speak-one-line.mp3 (${res.headers.get("Content-Type")}, ${text.length} characters)`);
console.log(`charged:   ${res.headers.get("X-Credits-Charged")} credits, ${res.headers.get("X-Credits-Remaining")} left`);
