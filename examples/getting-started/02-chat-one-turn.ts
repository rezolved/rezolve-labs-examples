/**
 * 02 · Chat, one turn.
 *
 * Opens a chat with LABS_AGENT_ID (free), sends one question (10 credits) and prints the chat id and the whole
 * answer. The answer arrives as server-sent events; this file waits for `message.completed`, which holds all of it.
 * Keep the chat id per visitor and send every later question to the same chat: a new chat has no memory.
 *
 * Run: npx tsx getting-started/02-chat-one-turn.ts ["your question"]
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

const question = process.argv[2] ?? "Are you open on Monday?";
const chatId: string = (await data_of(labs("POST", "/developer-platform/chats", { agentId: AGENT }), "Could not open a chat")).chatId;
console.log(`chat:     ${chatId}`);
console.log(`question: ${question}`);

const res = await labs("POST", `/developer-platform/chats/${chatId}/messages`, { text: question });
if (res.status !== 200) fail("The message was refused: see the body above.");
let answer = "";
for await (const [event, data] of events(res)) {
  if (event === "message.completed") answer = data.text;
  else if (event === "error") console.log(`error:    ${JSON.stringify(data)}`);
}
console.log(`answer:   ${answer}`);
