/**
 * site-assistant · Your server (TypeScript).
 *
 * The browser's only way to Labs, as CONTRACT.md describes: a question answered as a stream of whole sentences, one
 * sentence as audio, cancel, live transcription and the transcript. It holds the secret key, checks the page's origin,
 * caps input, limits each visitor and the whole site, keeps to the owner's budget and turns Labs refusals into the
 * error codes the widget shows (see guard.ts; the counts are kept in this process's memory). It also serves the sample
 * site with the built widget (client/dist/), so one URL shows the whole thing.
 *
 * The owner's answers come from site-assistant.yaml (else site-setup/site-assistant.example.yaml). Clips made by
 * speech/speech-make-clips are served from out/clips/ when a line matches. Settings: PORT (8040), HOST (127.0.0.1),
 * ALLOWED_ORIGINS, TRUST_PROXY=1 behind a proxy, ALERT_WEBHOOK_URL, SITE_ANSWERS (another answers file).
 *
 * Run, from examples/: npx tsx site-assistant/server-node/server.ts      then open http://localhost:8040
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import YAML from "yaml";
import * as guard from "./guard.ts";
import {
  AGENT, FALLBACK, KEY, LIVE, READ_MORE, UA, clipKey, events, fail, labs, plain, respell, seal, sentences, speechBody,
  unseal, verdict, type Code, type SpeechBody,
} from "./labs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANSWERS = [process.env.SITE_ANSWERS || "site-assistant.yaml"].find(existsSync)
  ?? join(HERE, "..", "..", "site-setup", "site-assistant.example.yaml");
const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
const SITE_DIR: string = site.knowledge?.source || "site-setup/sample-site";
const CLIENT = join(HERE, "..", "client", "dist");
const CLIPS = "out/clips";
const HOST = process.env.HOST || "127.0.0.1";
const QUESTION_CHARS = 500, SPEECH_CHARS = 300, LISTEN_SECONDS = 60, FRAME_BYTES = 64 * 1024;
const LIVE_PATH = "/transcription/voices/transcriptions/live";

const rates = site.rateLimits ?? {}, money = site.budget ?? {};
const limits = new guard.Limits(
  { question: rates.questionsPerMinute ?? 6, clip: rates.clipsPerMinute ?? 12, listen: rates.questionsPerMinute ?? 6, read: 30 },
  { question: 40, clip: 100, listen: 20, read: 30 }); // the whole site: at most 230 Labs calls a minute (a question
// can take two), under the account's own limit, which `GET /api-keys/verify` shows (240 on Pro)
const budget = new guard.Budget(money.monthlyCredits ?? 50000, money.perVisitorCredits ?? 300);
Object.assign(guard.alertTo, site.alerts ?? {});

const STATUS: Record<Code, number> = {
  bad_request: 400, not_allowed: 403, not_found: 404, too_long: 413, slow_down: 429, budget_reached: 402, unavailable: 503,
};
const MESSAGES: Record<Code, string> = {
  bad_request: "Sorry, I couldn't read that. Please try again.",
  not_allowed: "The assistant isn't available on this page.",
  not_found: "That conversation has ended. Ask again to start a new one.",
  too_long: "That's a bit long for me. Please ask in fewer words.",
  slow_down: "One moment, please. Try again in a few seconds.",
  budget_reached: money.atLimitMessage || "The assistant has reached its limit for now.",
  unavailable: "The assistant can't answer right now. Please try again later, or use the contact page.",
};

const message = (code: Code) => ({ code, message: MESSAGES[code] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chars = (text: string) => [...text].length; // characters, not UTF-16 units, as Python counts them

/** A refusal in the contract's shape: thrown anywhere, answered by the request handler at the bottom. */
class Refused extends Error {
  constructor(public code: Code, public retryAfter?: number) { super(code); }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

function refusal(res: ServerResponse, code: Code, retryAfter?: number) {
  const body: Record<string, unknown> = message(code), headers: Record<string, string> = {};
  if (retryAfter) [body.retryAfter, headers["Retry-After"]] = [retryAfter, String(retryAfter)];
  json(res, STATUS[code], { error: body }, headers);
}

/** Throws the visitor's code for a Labs refusal, and alerts the owner when a person has to act. */
async function labsRefused(res: Response): Promise<never> {
  const [code, note] = verdict(res.status, await res.text());
  if (note) guard.alert(`labs ${res.status}`, note);
  throw new Refused(code, code === "slow_down" ? Number(res.headers.get("Retry-After") || 5) : undefined);
}

/** labs(), with what the call cost counted against the visitor's and the site's budget. */
async function call(who: string, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await labs(method, path, body);
  budget.spend(who, Number(res.headers.get("X-Credits-Charged") ?? 0));
  return res;
}

async function jsonOf(req: IncomingMessage, fields: string[]): Promise<Record<string, any>> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part);
  let body: any;
  try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Refused("bad_request"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !fields.includes(k))) {
    throw new Refused("bad_request");
  }
  return body;
}

// ── The owner's settings ─────────────────────────────────────────────────────────────────────────────────────────

const PUBLIC = ["name", "title", "storeName", "welcomeMessage", "welcome", "acknowledgements", "prompts", "routes",
  "contact", "mode", "bargeIn", "placement", "theme", "followUp", "navigation", "retention"];

/** The public part of the answers. Never the whole file: `alerts` holds addresses and maybe a webhook secret. */
async function siteSettings(_req: IncomingMessage, res: ServerResponse) {
  json(res, 200, {
    ...Object.fromEntries(PUBLIC.map((k) => [k, site[k] ?? null])),
    limits: { questionChars: QUESTION_CHARS, speechChars: SPEECH_CHARS, listenSeconds: LISTEN_SECONDS,
      questionsPerMinute: limits.perVisitor.question, clipsPerMinute: limits.perVisitor.clip },
    listen: { encoding: "pcm_s16le", sampleRates: [8000, 16000] },
    messages: MESSAGES,
  });
}

type Link = { path: string; label: string };

/** The owner's route a `Read more:` path names, or null: only pages the owner listed are offered. */
function routeFor(path: string): Link | null {
  const [base0, anchor] = [path.split("#")[0], path.includes("#")];
  const base = base0.replace(/\/+$/, "") || "/";
  for (const r of site.routes ?? []) {
    if (r.path === base && (!anchor || r.anchorsAllowed)) return { path: anchor ? path : base, label: r.label };
  }
  console.log(`[chat] dropped a link to ${path}: not one of the owner's routes`);
  return null;
}

/** One sentence of a reply as the browser gets it: ["link", {path, label}], ["sentence", text] or null. */
function tidy(sentence: string): ["link", Link] | ["sentence", string] | null {
  const m = sentence.match(READ_MORE);
  if (m) {
    const link = routeFor(m[1]);
    return link ? ["link", link] : null;
  }
  const text = plain(sentence);
  if (!text) return null;
  return ["sentence", ".!?…:;,".includes(text.at(-1)!) ? text : text + "."]; // a list item has no full stop of its own
}

// ── Chat: a question, answered as a stream of whole sentences ────────────────────────────────────────────────────

type Item = [string, unknown];

/** One answer being read from Labs. The reader put()s the browser's events; cancel() ends the browser's stream at
 * once, while the reader carries on to the end of the reply (Labs has no cancel). */
class Turn {
  private items: Item[] = [];
  private wake = () => {};
  cancelled = false;
  finish = () => {};
  finished = new Promise<void>((r) => (this.finish = r));

  put(item: Item) { this.items.push(item); this.wake(); }
  cancel() { this.cancelled = true; this.wake(); }

  /** The next event for the browser, or null once cancelled. */
  async next(): Promise<Item | null> {
    while (!this.items.length && !this.cancelled) await new Promise<void>((r) => (this.wake = r));
    return this.cancelled ? null : this.items.shift()!;
  }
}

const turns = new Map<string, Turn>(); // Labs chat id -> the Turn running on it: one answer at a time per chat

async function chat(req: IncomingMessage, res: ServerResponse, _url: URL, who: string) {
  const body = await jsonOf(req, ["text", "chatId"]);
  const text = body.text;
  let chatId: string | null = null;
  if (typeof text !== "string" || !text.trim()) throw new Refused("bad_request");
  if (chars(text) > QUESTION_CHARS) throw new Refused("too_long");
  if (body.chatId && !(chatId = unseal(body.chatId))) throw new Refused("not_found");
  const wait = limits.take("question", who);
  if (wait) throw new Refused("slow_down", wait);
  if (!budget.allows(who)) throw new Refused("budget_reached");
  const turn = new Turn();
  if (chatId) {
    for (let running; (running = turns.get(chatId)); ) { // the last answer on this chat is still being written
      if (!(await Promise.race([running.finished.then(() => true), sleep(30_000).then(() => false)]))) {
        throw new Refused("slow_down", 5);
      }
    }
    turns.set(chatId, turn);
  }
  let newId: string, upstream: Response;
  try {
    [newId, upstream] = await ask(who, chatId, text.trim());
  } catch (e) {
    if (chatId) turns.delete(chatId);
    turn.finish(); // a question waiting for this chat may go ahead
    throw e;
  }
  if (chatId) turns.delete(chatId);
  turns.set(newId, turn);
  void readAnswer(turn, newId, upstream);
  await stream(res, turn, newId);
}

/** Sends the question, opening a chat first if there is none, or a new one if Labs says this one is gone or
 * full. Returns [chat id, the answer stream, unread]. */
async function ask(who: string, chatId: string | null, text: string): Promise<[string, Response]> {
  let res!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!chatId) {
      const opened = await call(who, "POST", "/developer-platform/chats", { agentId: AGENT });
      if (opened.status !== 201) await labsRefused(opened);
      chatId = (await opened.json()).data.chatId as string;
    }
    res = await call(who, "POST", `/developer-platform/chats/${chatId}/messages`, { text });
    if (res.status === 200) return [chatId, res];
    const body = await res.clone().text();
    if (res.status === 404 || body.includes("CHAT_CONTEXT_FULL")) chatId = null; // gone, or too long: only a new chat helps
    else if (res.status >= 500 && attempt === 0 && !body.includes("upstream_edge_block")) await sleep(1000); // brief, never charged
    else break;
  }
  return labsRefused(res);
}

/** Reads one answer from Labs to its end and puts the browser's events on the turn. */
async function readAnswer(turn: Turn, chatId: string, upstream: Response) {
  let pending = "", index = 0, failed = false;

  const release = (sentence: string) => {
    const item = failed ? null : tidy(sentence);
    if (!item) return;
    if (index === 0 && item[0] === "sentence" && item[1].startsWith(FALLBACK)) { // the fallback is a failure
      failed = true;
      return turn.put(["error", message("unavailable")]);
    }
    if (item[0] === "link") return turn.put(item);
    turn.put(["sentence", { index, text: item[1] }]);
    index++;
  };

  try {
    for await (const [event, data] of events(upstream)) {
      if (event === "tool.started") turn.put(["tool", { name: data.name ?? null }]);
      else if (event === "message.delta") {
        let ready: string[];
        [ready, pending] = sentences(pending + (data.text ?? ""));
        ready.forEach(release);
      } else if (event === "error" && !failed) {
        console.log(`[chat] the turn failed part-way: ${JSON.stringify(data)}`);
        failed = true;
        turn.put(["error", message("unavailable")]);
      }
    }
    sentences(pending, true)[0].forEach(release); // the stream ended: whatever is left is the last sentence
  } catch (e) {
    console.log(`[chat] the answer stream broke: ${(e as Error).name} ${(e as Error).message}`);
    if (!failed) turn.put(["error", message("unavailable")]);
  } finally {
    await upstream.body?.cancel().catch(() => {});
    turn.put(["done", { cancelled: false }]);
    turn.finish();
    if (turns.get(chatId) === turn) turns.delete(chatId);
    if (turn.cancelled) console.log(`[chat] a cancelled answer was read to its end: ${index} sentences, charged in full`);
  }
}

/** The browser's side of the answer: each event written as soon as it is ready, never held back. */
async function stream(res: ServerResponse, turn: Turn, chatId: string) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no" }); // tells a proxy in front not to buffer it
  res.on("close", () => { if (!res.writableFinished) turn.cancel(); }); // the browser closed the stream: the same as cancel
  let item: Item = ["chat", { chatId: seal(chatId) }];
  for (;;) {
    res.write(`event: ${item[0]}\ndata: ${JSON.stringify(item[1])}\n\n`);
    if (item[0] === "done") return res.end();
    item = (await turn.next()) ?? ["done", { cancelled: true }];
  }
}

async function cancel(req: IncomingMessage, res: ServerResponse) {
  const chatId = unseal((await jsonOf(req, ["chatId"])).chatId || "");
  if (!chatId) throw new Refused("not_found");
  const turn = turns.get(chatId);
  if (!turn || turn.cancelled) return json(res, 200, { cancelled: false });
  turn.cancel();
  console.log("[chat] cancel: the stream to the browser ends now; Labs still finishes the reply and charges it");
  json(res, 200, { cancelled: true });
}

// ── Speech: one sentence as audio ────────────────────────────────────────────────────────────────────────────────

const voice = { id: null as string | null, read: 0 };

/** The agent's voice, read from the agent at most every 5 minutes, so a new voice is used without a restart. */
async function agentVoice(who: string): Promise<string> {
  if (Date.now() - voice.read > 300_000) {
    const res = await call(who, "GET", `/developer-platform/agents/${AGENT}`);
    if (res.status !== 200) await labsRefused(res);
    [voice.id, voice.read] = [(await res.json()).data.voiceId, Date.now()];
  }
  if (!voice.id) {
    guard.alert("no voice", "the agent has no voice: give it one (site-setup/setup-02)");
    throw new Refused("unavailable");
  }
  return voice.id;
}

const manifest = { mtime: -1, files: new Map<string, string>() };

/** The stored clip for exactly this request, if speech/speech-make-clips made one (out/clips/manifest.json). */
function cachedClip(voiceId: string, body: SpeechBody): string | null {
  const file = join(CLIPS, "manifest.json");
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  if (mtime !== manifest.mtime) { // re-read after each run of speech-make-clips
    const clips: { key: string; file: string }[] = JSON.parse(readFileSync(file, "utf8")).clips ?? [];
    [manifest.mtime, manifest.files] = [mtime, new Map(clips.map((c) => [c.key, join(CLIPS, c.file)]))];
  }
  const path = manifest.files.get(clipKey(voiceId, body));
  return path && existsSync(path) ? path : null;
}

async function speech(req: IncomingMessage, res: ServerResponse, url: URL, who: string) {
  const text = url.searchParams.get("text") ?? "";
  if (chars(text) > SPEECH_CHARS) throw new Refused("too_long");
  const spoken = plain(text);
  if (!spoken) throw new Refused("bad_request");
  const voiceId = await agentVoice(who);
  const body = speechBody(respell(spoken, site.pronunciations ?? []));
  const clip = cachedClip(voiceId, body);
  if (clip) return sendFile(req, res, clip, { "X-Clip": "cached", "Cache-Control": "public, max-age=86400" });
  const wait = limits.take("clip", who);
  if (wait) throw new Refused("slow_down", wait);
  if (!budget.allows(who)) throw new Refused("budget_reached");
  let upstream!: Response;
  for (let attempt = 0; attempt < 2; attempt++) {
    upstream = await call(who, "POST", `/voice-audio/voices/${voiceId}/speech`, body);
    if (upstream.status === 200) break;
    if (upstream.status < 500 || attempt || (await upstream.clone().text()).includes("upstream_edge_block")) await labsRefused(upstream);
    await sleep(1000); // brief, and never charged: try once more
  }
  res.writeHead(200, { "Content-Type": upstream.headers.get("Content-Type") ?? "audio/mpeg", "X-Clip": "live", "Cache-Control": "no-store" });
  let dropped = false;
  res.on("close", () => { dropped = !res.writableFinished; });
  try {
    for await (const chunk of upstream.body!) { // relayed as it arrives: playback starts on the first bytes
      if (dropped) {
        console.log("[speech] the browser dropped the clip part-way; it is charged in full");
        break;
      }
      res.write(chunk);
    }
  } catch (e) {
    console.log(`[speech] the audio was cut short: ${(e as Error).name} ${(e as Error).message}`);
  } finally {
    await upstream.body?.cancel().catch(() => {});
    res.end();
  }
}

// ── Listen: live transcription, relayed ──────────────────────────────────────────────────────────────────────────

const listening = new Set<string>(); // visitors with a session open: one each
const LISTEN_ERRORS: Record<string, Code> = { bad_start: "bad_request" }; // Labs' codes on the socket -> ours; else "unavailable"
const closable = (code?: number) => (code && code !== 1005 && code !== 1006 ? code : 1000); // "no code" can't be sent
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

/** A WebSocket the browser can open without a key: the server opens Labs' with the key and relays both ways. */
async function listen(browser: WebSocket, who: string) {
  const early: [RawData, boolean][] = []; // frames that arrive while Labs' socket is still opening
  const keep = (data: RawData, binary: boolean) => early.push([data, binary]);
  browser.on("message", keep);
  browser.on("error", () => {});
  let refused: Code | null = null;
  if (listening.has(who)) refused = "slow_down";
  else if (limits.take("listen", who)) refused = "slow_down";
  else if (!budget.allows(who)) refused = "budget_reached";
  if (refused) {
    browser.send(JSON.stringify({ type: "error", ...message(refused) }));
    return browser.close(1008);
  }
  listening.add(who);
  try {
    await relay(browser, who, early, keep);
  } finally {
    listening.delete(who);
  }
}

async function relay(browser: WebSocket, who: string, early: [RawData, boolean][], keep: (d: RawData, b: boolean) => void) {
  const upstream = new WebSocket(LIVE, { headers: { "X-API-KEY": KEY, "User-Agent": UA }, maxPayload: 1 << 20 });
  upstream.on("error", () => {});
  const opened = await new Promise<number>((done) => {
    upstream.once("open", () => done(101));
    upstream.once("unexpected-response", (request, answer) => {
      console.log(`[labs] GET ${LIVE_PATH} -> ${answer.statusCode} credits=${answer.headers["x-credits-charged"] ?? "-"}`);
      request.destroy();
      done(answer.statusCode ?? 0);
    });
    upstream.once("error", (e) => {
      console.log(`[labs] GET ${LIVE_PATH} -> failed: ${e.name} ${e.message}`);
      done(0);
    });
  });
  if (opened !== 101) {
    const [code, note] = opened ? verdict(opened, "") : ["unavailable" as Code, null];
    if (note) guard.alert(`labs ${opened}`, note);
    browser.send(JSON.stringify({ type: "error", ...message(code) }));
    return browser.close(1011);
  }
  console.log(`[labs] GET ${LIVE_PATH} -> 101 credits=-`);
  const state = { rate: 16000, audio: 0, stopped: false };

  const up = (data: RawData, binary: boolean) => { // browser -> Labs
    if (!binary) {
      let frame: any = {};
      try { frame = JSON.parse(String(data)); } catch { /* not JSON: Labs refuses it */ }
      if (frame.type === "start" && [8000, 16000].includes(frame.sampleRate)) state.rate = frame.sampleRate;
      if (frame.type === "stop") {
        if (state.stopped) return; // the server already stopped the session at the cap
        state.stopped = true;
      }
      return upstream.send(String(data));
    }
    const audio = data as Buffer;
    if (audio.length > FRAME_BYTES) {
      browser.send(JSON.stringify({ type: "error", ...message("too_long") }));
      return browser.close(1009);
    }
    if (state.stopped) return;
    state.audio += audio.length;
    upstream.send(audio, { binary: true });
    if (state.audio >= LISTEN_SECONDS * state.rate * 2) { // the cap: stop as if the browser had
      state.stopped = true;
      upstream.send(JSON.stringify({ type: "stop" }));
    }
  };
  browser.off("message", keep);
  early.forEach(([data, binary]) => up(data, binary));
  browser.on("message", up);

  upstream.on("message", (data, binary) => { // Labs -> browser
    if (binary) return;
    const frame = JSON.parse(String(data));
    if (frame.type !== "error") return browser.send(String(data));
    console.log(`[listen] Labs refused: ${frame.code} ${frame.message}`); // Labs' own wording stays here; the browser gets ours
    browser.send(JSON.stringify({ type: "error", ...message(LISTEN_ERRORS[frame.code] ?? "unavailable") }));
  });

  const closedCode = await new Promise<number>((done) => { // whichever side ends first, close the other
    upstream.once("close", (code) => {
      if (browser.readyState === WebSocket.OPEN) browser.close(closable(code));
      done(code);
    });
    browser.once("close", (code) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close(closable(code));
    });
  });
  const seconds = state.audio / (state.rate * 2);
  const credits = state.audio ? Math.ceil((seconds * 5) / 60) : 0; // 5 credits a minute of audio, rounded up
  budget.spend(who, credits);
  console.log(`[labs] closed ${LIVE_PATH} ${closedCode} credits≈${credits}`
    + ` (${seconds.toFixed(1)} s of audio at 5 a minute: the socket sends no credit header)`);
}

// ── Transcript ───────────────────────────────────────────────────────────────────────────────────────────────────

async function transcript(_req: IncomingMessage, res: ServerResponse, url: URL, who: string) {
  const chatId = unseal(url.searchParams.get("chatId") ?? "");
  if (!chatId) throw new Refused("not_found");
  const wait = limits.take("read", who);
  if (wait) throw new Refused("slow_down", wait);
  const answer = await call(who, "GET", `/developer-platform/chats/${chatId}/messages`);
  if (answer.status === 404) throw new Refused("not_found");
  if (answer.status !== 200) await labsRefused(answer);
  const out: { role: string; text: string; link: Link | null }[] = [];
  for (const t of (await answer.json()).data.turns) {
    if (t.role === "user" && t.text) out.push({ role: "user", text: t.text, link: null });
    else if (t.role === "bot" && t.text) { // a bot turn with no text is a tool call: left out
      const items = sentences(t.text, true)[0].map(tidy).filter((i) => i !== null);
      out.push({
        role: "assistant",
        text: items.filter((i) => i[0] === "sentence").map((i) => i[1]).join(" "),
        link: (items.find((i) => i[0] === "link")?.[1] as Link | undefined) ?? null,
      });
    }
  }
  json(res, 200, { chatId: seal(chatId), turns: out });
}

// ── The sample site and the built widget ─────────────────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".wasm": "application/wasm",
};

/** A file, whole or the byte range asked for (browsers ask media for ranges). */
function sendFile(req: IncomingMessage, res: ServerResponse, path: string, headers: Record<string, string> = {}) {
  const data = readFileSync(path);
  const type = TYPES[extname(path)] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && data.length) {
    const start = range[1] ? Number(range[1]) : Math.max(data.length - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    if (start <= end) {
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${data.length}`, ...headers });
      return res.end(data.subarray(start, end + 1));
    }
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Accept-Ranges": "bytes", ...headers });
  res.end(data);
}

/** A page of the sample site (/breads is breads.html), with the widget's tags added before </body>. */
function page(pathname: string, res: ServerResponse) {
  const name = pathname.replace(/^\/+|\/+$/g, "").replace(/\.html$/, "") || "index";
  const path = join(SITE_DIR, `${name}.html`);
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !existsSync(path)) return notFound(res);
  let html = readFileSync(path, "utf8");
  if (existsSync(join(CLIENT, "widget.js"))) {
    const tags = existsSync(join(CLIENT, "widget.css")) ? '<link rel="stylesheet" href="/assistant/widget.css">\n' : "";
    html = html.replace("</body>", tags + '<script type="module" src="/assistant/widget.js"></script>\n</body>');
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

function clientFile(req: IncomingMessage, pathname: string, res: ServerResponse) {
  const path = resolve(CLIENT, decodeURIComponent(pathname.slice("/assistant/".length)));
  const inside = relative(resolve(CLIENT), path);
  if (!inside || inside.startsWith("..") || inside.includes(`..${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
    return notFound(res);
  }
  sendFile(req, res, path);
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

// ── Every request ────────────────────────────────────────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, who: string) => Promise<unknown>;
const routes: Record<string, Handler> = {
  "GET /api/site": siteSettings,
  "POST /api/chat": chat,
  "POST /api/cancel": cancel,
  "GET /api/speech": speech,
  "GET /api/listen": async () => { throw new Refused("bad_request"); }, // only as a WebSocket (see the upgrade below)
  "GET /api/transcript": transcript,
};

/** Every /api/ request: the origin check, refusals in the contract's shape, and one log line. */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    return url.pathname.startsWith("/assistant/") ? clientFile(req, url.pathname, res) : page(url.pathname, res);
  }
  const who = guard.visitor(req);
  let code = "-";
  try {
    const origin = guard.allowedOrigin(req.headers);
    if (!origin) throw new Refused("not_allowed");
    res.setHeader("Access-Control-Allow-Origin", origin); // lets an allowed origin read the answer
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") { // a page on another allowed origin asks before it POSTs JSON
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" });
      res.end();
    } else {
      await (routes[`${req.method} ${url.pathname}`] ?? (async () => { throw new Refused("not_found"); }))(req, res, url, who);
    }
  } catch (e) {
    if (!(e instanceof Refused)) console.log(`[error] ${(e as Error).name} ${(e as Error).message}`); // Labs unreachable, or unexpected
    const refused = e instanceof Refused ? e : new Refused("unavailable");
    code = refused.code;
    if (res.headersSent) res.end();
    else refusal(res, refused.code, refused.retryAfter);
  }
  console.log(`[api] ${req.method} ${url.pathname} -> ${res.statusCode} ${code} visitor=${who}`);
});

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? "/", "http://localhost"), who = guard.visitor(req);
  const code: Code | null = url.pathname !== "/api/listen" ? "not_found" : guard.allowedOrigin(req.headers) ? null : "not_allowed";
  if (code) { // refused before any socket opens: a plain HTTP answer
    const body = JSON.stringify({ error: message(code) });
    socket.end(`HTTP/1.1 ${STATUS[code]} ${code === "not_found" ? "Not Found" : "Forbidden"}\r\nContent-Type: application/json; charset=utf-8\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    return console.log(`[api] GET ${url.pathname} -> ${STATUS[code]} ${code} visitor=${who}`);
  }
  sockets.handleUpgrade(req, socket, head, (browser) => {
    void listen(browser, who).finally(() => console.log(`[api] GET /api/listen -> 101 - visitor=${who}`));
  });
});

if (!existsSync(SITE_DIR)) fail(`No ${SITE_DIR}/ here: run the server from examples/.`);
const clipCount = existsSync(join(CLIPS, "manifest.json")) ? JSON.parse(readFileSync(join(CLIPS, "manifest.json"), "utf8")).clips.length : 0;
console.log(`answers:   ${relative(process.cwd(), ANSWERS)}`);
console.log(`site:      ${SITE_DIR}/, widget ${existsSync(join(CLIENT, "widget.js")) ? "client/dist/widget.js" : "not built yet (site-assistant/client)"}`);
console.log(`clips:     ${clipCount} in out/clips/ (speech/speech-make-clips makes them)`);
console.log(`origins:   ${[...guard.ORIGINS].sort().join(", ")}`);
console.log(`limits:    ${limits.perVisitor.question} questions and ${limits.perVisitor.clip} clips a minute per visitor, `
  + `${limits.perSite.question} and ${limits.perSite.clip} for the site (in this process's memory)`);
console.log(`budget:    ${budget.monthly} credits a month, ${budget.perVisitor} a day per visitor`);
console.log(`open:      http://localhost:${guard.PORT}`);
server.listen(guard.PORT, HOST);
