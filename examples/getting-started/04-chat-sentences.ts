/**
 * 04 · Chat in sentences.
 *
 * Sends one question and prints the answer one sentence per line as it arrives, with the time since sending.
 * `message.delta` events are sentence-sized chunks, but a chunk can hold two sentences or end mid-word, so the
 * deltas are joined raw and only whole sentences are released. Markdown list and heading markers are dropped on
 * the way, because replies keep them (and a voice would read them out).
 *
 * Run: npx tsx getting-started/04-chat-sentences.ts ["your question"]
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const AGENT = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env (site-setup/setup-02-create-agent makes one).");
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

const question = process.argv[2] ?? "Tell me about your breads, when you are open, and whether I can bring my dog.";
const chatId: string = (await data_of(labs("POST", "/developer-platform/chats", { agentId: AGENT }), "Could not open a chat")).chatId;
console.log(`chat: ${chatId}`);

const sent = Date.now();
const since = () => `[+${((Date.now() - sent) / 1000).toFixed(1)}s]`;
const res = await labs("POST", `/developer-platform/chats/${chatId}/messages`, { text: question });
if (res.status !== 200) fail("The message was refused: see the body above.");
let pending = "", count = 0, ready: string[];
for await (const [event, data] of events(res)) {
  if (event === "tool.started") console.log(`${since()} (the agent is using ${data.name})`);
  else if (event === "message.delta") {
    [ready, pending] = sentences(pending + data.text);
    for (const s of ready) { count++; console.log(`${since()} ${s}`); }
  } else if (event === "error") console.log(`${since()} error: ${JSON.stringify(data)}`);
}
for (const s of sentences(pending, true)[0]) { // the stream ended: whatever is left is the last sentence
  count++;
  console.log(`${since()} ${s}`);
}
console.log(`${count} sentences`);
