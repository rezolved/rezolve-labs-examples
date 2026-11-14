/**
 * 06 · Read the transcript back.
 *
 * GET /developer-platform/chats/{chatId}/messages (free) returns every turn of a chat, oldest first, with `isError`
 * on each. GET /developer-platform/conversations/{chatId}/transcript returns the same: a chat id is its conversation id.
 * With a chat id argument this reads that chat; without one it makes a two-turn chat first.
 *
 * Run: npx tsx getting-started/06-transcript.ts [chatId]
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

let chatId = process.argv[2];
if (!chatId) {
  const agent = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env, or pass a chat id.");
  chatId = (await data_of(labs("POST", "/developer-platform/chats", { agentId: agent }), "Could not open a chat")).chatId;
  for (const question of ["Do you sell rye bread?", "How much is it?"]) { // "it" only works because it is the same chat
    await (await labs("POST", `/developer-platform/chats/${chatId}/messages`, { text: question })).text(); // wait for the end of the turn
  }
}

const transcript = await data_of(labs("GET", `/developer-platform/chats/${chatId}/messages`), "Could not read the transcript");
console.log(`chat:   ${chatId} (${transcript.turns.length} turns, ${transcript.status})`);
for (const turn of transcript.turns) {
  const flag = turn.isError ? " [error]" : "";
  console.log(`${turn.role.padStart(4)}:${flag} ${turn.text}`.replace(/\n/g, " "));
}
