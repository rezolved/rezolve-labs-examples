/**
 * 07 · A voice agent in one file.
 *
 * 04 plus speech, in the agent's own voice. Each whole sentence goes to speech as soon as it is released, with at
 * most 2 speech calls in flight, and the clips play in the order of the text, not the order they finish. The first
 * clip waits until it holds more than 150 characters: cloned and designed voices generate a line of up to 150
 * characters whole before sending any audio, so a longer first clip starts sooner. Markdown is dropped before
 * speech, and a "Read more: /path" line is shown, not spoken. The clips are saved in order to out/07-voice-agent.mp3
 * and played with afplay, ffplay or mpg123 if one is installed (--no-play to skip).
 *
 * Run: npx tsx getting-started/07-voice-agent.ts ["your question"] [--no-play]
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const AGENT = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env (site-setup/setup-02-create-agent makes one).");
const UA = "labs-playbook-examples/1.0"; // any explicit User-Agent works
const FIRST_CLIP = 150; // characters the first clip must exceed (see above)
const PLAYERS = [["afplay"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"], ["mpg123", "-q"]];

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

/** Yields [event, data] from a text/event-stream answer, one event at a time. */
async function* events(res: Response): AsyncGenerator<[string, any]> {
  let buffer = "", event = "";
  for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
    buffer += chunk; // a chunk can end mid-line, so only whole lines are parsed
    for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
      const line = buffer.slice(0, i).replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) yield [event, JSON.parse(line.slice(5))];
    }
  }
}

const MARKER = /(^|\n)[ \t]*(?:[-*+•]|\d+[.)]|#{1,6})[ \t]+/g; // list and heading markers at a line start
const DONE = /^[\s\S]*(?:[.!?…]\s|\n)/; // everything up to the last sentence end or line break

/** Splits off the whole sentences in `pending`. Returns [sentences, what is left over]. */
function sentences(pending: string, final = false): [string[], string] {
  pending = pending.replace(MARKER, "$1");
  const cut = final ? pending.length : (pending.match(DONE)?.[0].length ?? 0);
  const ready = pending.slice(0, cut).replace(/\*\*|__|`/g, ""); // bold and code marks
  return [ready.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean), pending.slice(cut)];
}

const onPath = (name: string) => (process.env.PATH ?? "").split(delimiter).some((d) => existsSync(join(d, name)));
const question = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Tell me about your breads and when you are open.";
const player = process.argv.includes("--no-play") ? undefined : PLAYERS.find((p) => onPath(p[0]));
const agent = await data_of(labs("GET", `/developer-platform/agents/${AGENT}`), "Could not read the agent");
const voiceId: string = agent.voiceId
  ?? fail(`The agent has no voice. Set one: PATCH /developer-platform/agents/${AGENT} with {"voiceId": ...}.`);

const sent = Date.now();
const since = () => `[+${((Date.now() - sent) / 1000).toFixed(1)}s]`;
const clips: { text: string; audio: Promise<Buffer> }[] = []; // in the order of the text
let ended = false, wake = () => {};
let held: string[] | null = []; // sentences gathered for the first clip; null once it has gone
let inFlight = 0, credits = 0;
const waiting: (() => void)[] = [];

/** Runs a speech job once fewer than 2 are in flight. */
async function limited<T>(job: () => Promise<T>): Promise<T> {
  while (inFlight >= 2) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try { return await job(); } finally { inFlight--; waiting.shift()?.(); }
}

async function speak(text: string): Promise<Buffer> {
  const res = await labs("POST", `/voice-audio/voices/${voiceId}/speech`, { text, outputFormat: "mp3_44100_64" });
  credits += Number(res.headers.get("X-Credits-Charged") ?? 0);
  return res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
}

function queueClip(text: string) {
  clips.push({ text, audio: limited(() => speak(text)) });
  wake();
}

async function playInOrder() {
  mkdirSync("out", { recursive: true });
  writeFileSync("out/07-voice-agent.mp3", "");
  let n = 0;
  for (; ; n++) {
    while (n >= clips.length && !ended) await new Promise<void>((r) => (wake = r));
    if (n >= clips.length) break;
    const audio = await clips[n].audio; // waits for this clip, even if a later one is already done
    console.log(`${since()} play ${n + 1}: ${clips[n].text}`);
    appendFileSync("out/07-voice-agent.mp3", audio);
    if (player && audio.length) {
      writeFileSync("out/07-clip.mp3", audio);
      await new Promise((r) => spawn(player[0], [...player.slice(1), "out/07-clip.mp3"], { stdio: "ignore" }).on("exit", r));
    }
  }
  console.log(`${since()} done: ${n} clips, ${credits} speech credits, saved to out/07-voice-agent.mp3`);
}

function release(s: string) {
  if (s.startsWith("Read more:")) return console.log(`${since()} link: ${s.slice("Read more:".length).trim()}`);
  console.log(`${since()} text: ${s}`);
  if (!/[.!?…:;,]$/.test(s)) s += "."; // a list item has no full stop; without one, joined items run together
  if (held === null) return queueClip(s);
  held.push(s);
  if (held.join(" ").length > FIRST_CLIP) {
    queueClip(held.join(" "));
    held = null;
  }
}

const playing = playInOrder();
const chatId: string = (await data_of(labs("POST", "/developer-platform/chats", { agentId: AGENT }), "Could not open a chat")).chatId;
const res = await labs("POST", `/developer-platform/chats/${chatId}/messages`, { text: question });
let pending = "", ready: string[];
if (res.status === 200) {
  for await (const [event, data] of events(res)) {
    if (event !== "message.delta") continue;
    [ready, pending] = sentences(pending + data.text);
    ready.forEach(release);
  }
}
sentences(pending, true)[0].forEach(release);
if (held?.length) queueClip(held.join(" ")); // a short answer: everything is in the first clip
ended = true;
wake();
await playing;
