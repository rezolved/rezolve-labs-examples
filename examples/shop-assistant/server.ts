/**
 * shop-assistant · The shop page's server (TypeScript).
 *
 * Serves site/shop.html and the product photos, and is the page's only way to Labs: it holds the secret key and
 * relays four things. A shopper's message, answered as a stream of the agent's events (the reply as it is written,
 * the whole reply with its delivery cues for the voice, product cards, the basket); one line of the reply as speech
 * in the agent's voice; a short recording turned into text (push to talk); and the shop's name, welcome line and
 * products for the page.
 *
 * The platform searches the catalogue on every turn, even "hi", and sends a card for every product the search found.
 * The server keeps only the cards the reply names (the instructions tell the agent that only those are shown), and
 * adds the product's picture from your catalogue, matched by name.
 *
 * The stream leaves out the delivery cues the agent writes ("[warmly]"); the chat's transcript keeps them, so once the
 * reply is complete the server reads it back from there and sends it as `spoken`, for the voice. Input is capped and
 * only the page's own origin may call. For per-visitor limits and a credit budget, see
 * site-assistant/server-node/guard.ts.
 *
 * Settings: PORT (8050), HOST (127.0.0.1), SHOP_AGENT_ID (written by setup-shop).
 * Run, from examples/: npx tsx shop-assistant/server.ts      then open http://localhost:8050
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
for (let d = HERE; ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const AGENT = process.env.SHOP_AGENT_ID || fail("Set SHOP_AGENT_ID: run shop-assistant/setup-shop.ts first.");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const PORT = Number(process.env.PORT || 8050), HOST = process.env.HOST || "127.0.0.1";
const PICTURES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_TEXT = 500, MAX_SPEECH = 600, MAX_AUDIO = 2_000_000; // characters, characters, bytes (about a minute of 16 kHz WAV)

type Row = Record<string, string>;
if (!existsSync(join(HERE, "shop.yaml"))) fail("Copy shop-assistant/shop.example.yaml to shop-assistant/shop.yaml and run setup-shop first.");
const shop = YAML.parse(readFileSync(join(HERE, "shop.yaml"), "utf8"));
const CATALOGUE = join(HERE, shop.catalogue);
const products = csv(readFileSync(CATALOGUE, "utf8").replace(/^\uFEFF/, ""));
const byName = new Map(products.map((p) => [p.name.toLowerCase(), p]));
const voice = { id: null as string | null, read: 0 };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A CSV file as rows keyed by its header: commas inside double quotes stay, "" is a quote. */
function csv(text: string): Row[] {
  const rows: string[][] = [[""]];
  let quoted = false;
  text = text.replace(/^\uFEFF/, ""); // a byte-order mark, as some spreadsheets save one
  for (let i = 0; i < text.length; i++) { // read as Python's csv module reads it: a quoted field may hold , " and line breaks
    const c = text[i], row = rows[rows.length - 1];
    if (quoted && c === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === ",") row.push("");
    else if (!quoted && (c === "\n" || c === "\r")) { if (c === "\r" && text[i + 1] === "\n") i++; rows.push([""]); }
    else row[row.length - 1] += c;
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== ""); // blank lines and a last line break
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. */
async function labs(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const form = body instanceof FormData; // fetch writes the multipart Content-Type, with its boundary
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": KEY, "User-Agent": UA, ...(form ? {} : { "Content-Type": "application/json" }), ...headers },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let line = `[labs] ${method} ${path} -> ${res.status} credits=${res.headers.get("X-Credits-Charged") ?? "-"}`;
  if (res.status >= 400) line += " body=" + (await res.clone().text()).slice(0, 300).replace(/\n/g, " ");
  console.log(line);
  return res;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
function refuse(res: ServerResponse, status: number, code: string, message: string) {
  json(res, status, { error: code, message });
}

/** Only the page this server serves may call the API (no Origin header: a same-origin GET, or curl). */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${req.headers.host}`;
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/** The catalogue row a card or basket line names (the platform sends names, not our ids), or undefined. */
const product = (name?: string) => byName.get((name ?? "").trim().toLowerCase());

/** A product's picture: its `image_url` if it is a web address, a file next to the catalogue (served under
 * /catalogue/), or the platform's copy. */
function image(p?: Row, fallback: string | null = null) {
  const url = p?.image_url ?? "";
  return /^https?:\/\//.test(url) ? url : url ? `/catalogue/${url}` : fallback;
}

function card(c: any) {
  const p = product(c.name);
  return { id: p?.id ?? null, name: c.name, price: p?.price || c.priceDisplay, description: c.description,
           colour: p?.colour ?? null, sizes: p?.sizes ?? null, image: image(p, c.imageUrl ?? null), actions: c.actionButtons ?? [] };
}

function basket(data: any) {
  const items = (data.items ?? []).map((i: any) => ({ id: product(i.name)?.id ?? null, name: i.name, quantity: i.quantity ?? 1,
                                                       unitPrice: i.unitPrice, size: i.payload?.size ?? null,
                                                       image: image(product(i.name), i.payload?.imageUrl ?? null) }));
  const total = items.reduce((t: number, l: any) => t + Number(l.unitPrice || 0) * Number(l.quantity || 1), 0);
  return { items, total: total.toFixed(2), canCheckout: data.canCheckout ?? false };
}

function site(res: ServerResponse) {
  json(res, 200, { storeName: shop.storeName, welcome: shop.welcome, currencySymbol: shop.currencySymbol,
                   products: products.map((p) => ({ id: p.id, name: p.name, price: p.price, category: p.category ?? "",
                                                     colour: p.colour ?? "", sizes: p.sizes ?? "", image: image(p) })) });
}

/** POST {chatId?, text} -> text/event-stream: chat, tool, delta, spoken, cards, cart, error, done. */
async function chat(req: IncomingMessage, res: ServerResponse) {
  let input: any;
  try { input = JSON.parse(String(await body(req, 10_000))); } catch { return refuse(res, 400, "bad_request", "Send JSON."); }
  const text = String(input?.text ?? "").trim();
  let chatId: string | undefined = input?.chatId || undefined;
  if (!text || text.length > MAX_TEXT) return refuse(res, 400, "bad_request", `Send between 1 and ${MAX_TEXT} characters.`);
  if (!chatId) { // one chat per visit: the platform keeps its history and its basket
    const opened = await labs("POST", "/developer-platform/chats", { agentId: AGENT });
    const data = await opened.json();
    if (opened.status !== 201) return refuse(res, 502, "unavailable", data.message ?? "The assistant could not start.");
    chatId = data.data.chatId as string;
  }
  const upstream = await labs("POST", `/developer-platform/chats/${chatId}/messages`, { text }, { Accept: "text/event-stream" });
  if (upstream.status === 409) return refuse(res, 409, "busy", "Still answering the last message."); // one message at a time per chat
  if (upstream.status !== 200 || !upstream.body) return refuse(res, 502, "unavailable", "The assistant is not available right now.");

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("chat", { chatId });
  let event = "", reply = "", buf = "";
  try {
    for await (const chunk of upstream.body.pipeThrough(new TextDecoderStream())) { // SSE, relayed as it arrives
      buf += chunk;
      let cut: number;
      while ((cut = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, cut).replace(/\r$/, "");
        buf = buf.slice(cut + 1);
        if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
        if (!line.startsWith("data:")) continue;
        const data = JSON.parse(line.slice(5).trim() || "{}");
        if (event === "tool.started") send("tool", { name: data.name });
        else if (event === "message.delta") { reply += data.text ?? ""; send("delta", { text: data.text ?? "" }); }
        else if (event === "message.completed") send("spoken", { text: await withCues(chatId, data.text || reply) });
        else if (event === "cards.ready") { // arrives after the whole reply
          const named = (data.cards ?? []).filter((c: any) => reply.toLowerCase().includes((c.name ?? "").toLowerCase())).map(card);
          if (named.length) send("cards", { cards: named });
        }
        else if (event === "cart.updated") send("cart", basket(data));
        else if (event === "error") send("error", { code: data.code, message: data.message });
      }
    }
  } catch (e) {
    console.log(`[chat] the stream was cut short: ${(e as Error).message}`);
    send("error", { code: "unavailable", message: "The answer was cut short." });
  }
  send("done", {});
  res.end();
}

const CUE = /\[[a-z][a-z ]{0,20}\]\s*/gi;
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** The reply as the agent wrote it, delivery cues included. The stream leaves the cues out; the chat's transcript
 * keeps them, so the last reply is read back from it (free). Falls back to the streamed text. */
async function withCues(chatId: string, text: string): Promise<string> {
  const res = await labs("GET", `/developer-platform/conversations/${chatId}/transcript`);
  if (res.status !== 200) return text;
  const turns: any[] = (await res.json()).data.turns;
  const last: string = [...turns].reverse().find((t) => t.role === "bot" && t.text)?.text ?? "";
  return words(last.replace(CUE, "")) === words(text) ? last : text;
}

/** What a reply sounds like: no markdown markers, no links. */
const plain = (text: string) =>
  text.replace(/https?:\/\/\S+/g, "").replace(/[*_`#>]+|^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();

/** The agent's voice, read from the agent at most every 5 minutes. */
async function agentVoice() {
  if (Date.now() - voice.read > 300_000) {
    const res = await labs("GET", `/developer-platform/agents/${AGENT}`);
    voice.id = res.status === 200 ? (await res.json()).data.voiceId : null;
    voice.read = Date.now();
  }
  return voice.id;
}

/** GET ?text= -> audio/mpeg in the agent's voice, relayed as it arrives. */
async function speech(url: URL, res: ServerResponse) {
  const text = plain(url.searchParams.get("text") ?? "");
  if (!text || text.length > MAX_SPEECH) return refuse(res, 400, "bad_request", `Send between 1 and ${MAX_SPEECH} characters.`);
  const voiceId = await agentVoice();
  if (!voiceId) return refuse(res, 503, "unavailable", "The agent has no voice.");
  const upstream = await labs("POST", `/voice-audio/voices/${voiceId}/speech`, { text, outputFormat: "mp3_44100_64" });
  if (upstream.status !== 200 || !upstream.body) return refuse(res, 502, "unavailable", "No speech right now.");
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (e) {
    console.log(`[speech] cut short: ${(e as Error).message}`);
  }
  res.end();
}

/** POST audio/wav (push to talk) -> {"text"}: the recording, transcribed. */
async function listen(req: IncomingMessage, res: ServerResponse) {
  const audio = await body(req, MAX_AUDIO);
  if (!audio?.length || audio.subarray(0, 4).toString() !== "RIFF") return refuse(res, 400, "bad_request", "Send one WAV recording of under a minute.");
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "speech.wav");
  const upstream = await labs("POST", "/transcription/voices/transcriptions", form);
  const data = await upstream.json();
  if (upstream.status !== 200) return refuse(res, 502, "unavailable", "Could not hear that.");
  json(res, 200, { text: String(data.data.text ?? "").trim() });
}

function file(res: ServerResponse, path: string, type: string) {
  if (!existsSync(path)) return refuse(res, 404, "not_found", "No such file.");
  res.writeHead(200, { "Content-Type": type });
  createReadStream(path).pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/") && !sameOrigin(req)) return refuse(res, 403, "origin", "This page may not use the shop assistant.");
    if (req.method === "GET" && url.pathname === "/api/shop") return site(res);
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res);
    if (req.method === "GET" && url.pathname === "/api/speech") return await speech(url, res);
    if (req.method === "POST" && url.pathname === "/api/listen") return await listen(req, res);
    if (req.method === "GET" && url.pathname.startsWith("/catalogue/")) { // pictures next to your catalogue, never the catalogue itself
      const path = resolve(dirname(CATALOGUE), decodeURIComponent(url.pathname.slice(11)));
      const type = PICTURES[extname(path).toLowerCase()];
      if (!type || !path.startsWith(resolve(dirname(CATALOGUE)) + sep)) return refuse(res, 404, "not_found", "No such picture.");
      return file(res, path, type);
    }
    if (req.method === "GET" && url.pathname === "/") return file(res, join(HERE, "site", "shop.html"), "text/html; charset=utf-8");
    refuse(res, 404, "not_found", "No such page.");
  } catch (e) {
    console.log(`[server] ${req.method} ${url.pathname}: ${(e as Error).message}`);
    if (!res.headersSent) refuse(res, 502, "unavailable", "Something went wrong.");
    else res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`shop:      ${shop.storeName}, ${products.length} products, agent ${AGENT}`);
  console.log(`open:      http://localhost:${PORT}`);
});
