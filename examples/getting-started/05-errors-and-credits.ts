/**
 * 05 · Errors and credits.
 *
 * Makes one real answer and forces three refusals: a bad key (401), the edge block on Python's default
 * User-Agent (503) and the rate limit (429, from a burst of free calls). `verdict()` turns each into what a site
 * should do, including a 402 (out of credits) and the platform's fallback sentence, which arrives as an ordinary
 * answer. Then it reads the balance and today's usage (both free) and checks them against X-Credits-Charged.
 * If ALERT_WEBHOOK_URL is set, every failure that needs a person is posted to it as {"text": ...}.
 *
 * Run: npx tsx getting-started/05-errors-and-credits.ts      (the burst locks the key out for a few seconds)
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
const PYTHON_DEFAULT_UA = "Python-urllib/3.13"; // the edge refuses this User-Agent (Node's own default passes)
const FALLBACK = "Sorry, I couldn't put a reply together"; // how the platform's fallback sentence starts

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

type Answer = { status: number; headers: Headers; body: string };

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. */
async function labs(method: string, path: string, body?: unknown, key = KEY, ua = UA): Promise<Response> {
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": key, "Content-Type": "application/json", "User-Agent": ua },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let line = `[labs] ${method} ${path} -> ${res.status} credits=${res.headers.get("X-Credits-Charged") ?? "-"}`;
  if (!res.ok) line += " body=" + (await res.clone().text()).slice(0, 300).replace(/\n/g, " ");
  console.log(line);
  return res;
}

/** labs(), with the body read: for calls whose answer is short JSON. */
async function read(method: string, path: string, body?: unknown, key = KEY, ua = UA): Promise<Answer> {
  const res = await labs(method, path, body, key, ua);
  return { status: res.status, headers: res.headers, body: await res.text() };
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

/** What a Labs answer means for a site: [code, what to do]. Only "answer" is an answer. */
function verdict(status: number, headers: Headers, body: string, reply = "", failed = false): [string, string] {
  let err: any = {};
  try { if (status >= 400) err = JSON.parse(body); } catch { /* not JSON */ }
  const code: string = err.code ?? "-";
  if (status < 300) {
    if (failed) return ["-", "the turn failed part-way: show your own message, don't count it as an answer"];
    if (reply.startsWith(FALLBACK)) return ["-", "fallback sentence: show your own message, don't count it as an answer"];
    return ["-", "answer"];
  }
  if (status === 401) return [code, "bad key: check LABS_API_KEY"];
  if (status === 402 && code === "call_over_plan_limit") return [code, "costs more than the plan allows in one call: only a bigger plan helps"];
  if (status === 402) return [code, "out of credits: stop calling, tell the owner, show your limit message"];
  if (status === 403) return [code, `refused: ${err.detail ?? ""}`];
  if (status === 425) return [code, "knowledge base still indexing: wait until its documents are ready, then retry"];
  if (status === 429) return [code, `rate limited: wait ${headers.get("Retry-After") ?? "1"} s, then retry`];
  if (code === "upstream_edge_block") return [code, "edge block: send an explicit User-Agent; retrying won't help"];
  if (status >= 500) return [code, "service error: retry with a growing delay (never charged)"];
  return [code, `request refused, fix it: ${err.detail ?? ""}`];
}

/** Posts {"text": ...} to ALERT_WEBHOOK_URL, if one is set. */
async function alert(text: string) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ text }) });
  console.log(`[alert] POST ${new URL(url).hostname} -> ${res.status}`);
}

/** labs() that tries again while the answer is a 429 (after Retry-After) or a 5xx other than the edge block
 *  (after 1, 2, 4 and 8 s). One Retry-After wait is not always enough: the minute's window can still be full. */
async function retrying(method: string, path: string, body?: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await labs(method, path, body);
    const text = res.ok ? "" : await res.clone().text();
    const wait = res.status === 429 ? Number(res.headers.get("Retry-After") ?? 1)
      : res.status >= 500 && attempt < 4 && !text.includes("upstream_edge_block") ? 2 ** attempt : 0;
    if (!wait || attempt >= 29) return res;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

async function usageToday(): Promise<[number, number]> {
  const usage = await retrying("GET", "/api-keys/usage?group_by=day");
  if (usage.status !== 200) fail("Could not read the usage: see the body above.");
  const u = await usage.json();
  const today = u.groups.find((g: any) => g.key === u.end.slice(0, 10)) ?? { calls: 0, credits: 0 };
  return [today.calls, today.credits];
}

const rows: [string, number, string, string, string][] = [];
let charged = 0;

async function record(name: string, a: Answer, reply = "", failed = false) {
  const [code, todo] = verdict(a.status, a.headers, a.body, reply, failed);
  const credits = a.headers.get("X-Credits-Charged") ?? "-";
  charged += /^\d+$/.test(credits) ? Number(credits) : 0;
  rows.push([name, a.status, code, credits, todo]);
  if (todo !== "answer" && a.status !== 429) await alert(`Site assistant: ${todo} (${name}, HTTP ${a.status})`);
}

const [, creditsBefore] = await usageToday();

// 1. A real answer. A 200 is not enough: an `error` event or the fallback sentence is still a failure.
const opened = await read("POST", "/developer-platform/chats", { agentId: AGENT });
if (opened.status !== 201) fail("Could not open a chat: see the body above.");
const chatId: string = JSON.parse(opened.body).data.chatId;
const res = await retrying("POST", `/developer-platform/chats/${chatId}/messages`, { text: "Are you open on Monday?" });
let reply = "", failed = false;
if (res.status === 200) {
  for await (const [event, data] of events(res)) {
    if (event === "message.completed") reply = data.text;
    else if (event === "error") failed = true;
  }
}
await record("answer", { status: res.status, headers: res.headers, body: res.status === 200 ? "" : await res.text() }, reply, failed);

// 2. A bad key, and 3. Python's default User-Agent.
await record("bad key", await read("GET", "/voice-audio/voices/list?pageSize=1", undefined, "rzlb_live_sk_not_a_real_key"));
await record("edge block", await read("GET", "/voice-audio/voices/list?pageSize=1", undefined, KEY, PYTHON_DEFAULT_UA));

// 4. The rate limit: free calls, 32 at a time, until the first 429.
const burst: Answer[] = [];
let stop = false;
await Promise.all(Array.from({ length: 32 }, async () => {
  while (!stop && burst.length < 600) {
    const a = await read("GET", "/voice-audio/voices/list?pageSize=1");
    burst.push(a);
    if (a.status === 429) stop = true;
  }
}));
const limited = burst.find((a) => a.status === 429);
if (limited) {
  await record("rate limit", limited);
  console.log(`burst: ${burst.filter((a) => a.status === 200).length} answered before the first 429`);
  const after = await retrying("GET", "/voice-audio/voices/list?pageSize=1"); // 5. wait, retry, repeat
  await record("after waiting", { status: after.status, headers: after.headers, body: await after.text() });
}

const balanceAnswer = await retrying("GET", "/api-keys/balance");
if (balanceAnswer.status !== 200) fail("Could not read the balance: see the body above.");
const balance = await balanceAnswer.json();
const [callsAfter, creditsAfter] = await usageToday();

console.log();
console.log(`${"case".padEnd(14)} ${"status".padEnd(7)} ${"code".padEnd(22)} ${"charged".padEnd(8)} verdict`);
for (const [name, status, code, credits, todo] of rows) {
  console.log(`${name.padEnd(14)} ${String(status).padEnd(7)} ${code.padEnd(22)} ${credits.padEnd(8)} ${todo}`);
}
console.log();
console.log(`balance:  ${balance.available} available, ${balance.held} held, `
  + `blocked: ${balance.blocked ? "yes" : "no"}, low balance: ${balance.low_balance ? "yes" : "no"}`);
console.log(`usage:    today ${callsAfter} calls, ${creditsAfter} credits`);
console.log(`check:    X-Credits-Charged added up to ${charged}; today's usage moved by ${creditsAfter - creditsBefore} credits`);
