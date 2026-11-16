/**
 * The Labs side of the server: the key, one logged call, the chat stream, the text tools, and what a Labs refusal
 * means for the visitor. server.ts uses these; nothing here talks to the browser.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
export const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
export const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
export const AGENT = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env (site-setup/setup-02-create-agent makes one).");
export const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
export const LIVE = API.replace("https://", "wss://") + "/transcription/voices/transcriptions/live";
export const FALLBACK = "Sorry, I couldn't put a reply together"; // how the platform's fallback sentence starts

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors.
 * The answer comes back unread, so a stream can be relayed as it arrives. */
export async function labs(method: string, path: string, body?: unknown): Promise<Response> {
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

/** Yields [event, data] from a text/event-stream answer, one event at a time. */
export async function* events(res: Response): AsyncGenerator<[string, any]> {
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

export type Code = "bad_request" | "not_allowed" | "not_found" | "too_long" | "slow_down" | "budget_reached" | "unavailable";

/** What a Labs refusal means for the visitor: [our error code, a note for the owner or null].
 * The same cases as getting-started/05; a note means a person has to act, so the server alerts the owner. */
export function verdict(status: number, body: string): [Code, string | null] {
  let err: any = {};
  try { err = JSON.parse(body || "{}"); } catch { /* not JSON */ }
  const code: string = err.code || (err.errors ?? []).map((e: any) => e.code).find(Boolean) || "-";
  if (status === 401) return ["unavailable", "bad key: check LABS_API_KEY"];
  if (status === 402) return ["budget_reached", `the account can't pay for this call (${code}): top up or change the plan`];
  if (status === 403) return ["unavailable", `refused (${code}): ${err.detail ?? ""}`];
  if (status === 404) return ["unavailable", "not found: check LABS_AGENT_ID and the agent's voice"];
  if (status === 425) return ["unavailable", "the knowledge base is still indexing: wait until its documents are ready"];
  if (status === 409 || status === 429) return ["slow_down", null];
  if (code === "upstream_edge_block") return ["unavailable", "edge block: send an explicit User-Agent"];
  if (status >= 500) return ["unavailable", null]; // brief: never charged, the next try usually works
  return ["bad_request", null];
}

// Chat ids go to the browser sealed: the id plus a signature only this server can make. The key can read every chat
// in the workspace, so the server reads back or continues only chats it opened itself.
const SEAL = createHmac("sha256", KEY).update("site-assistant chat ids").digest(); // derived from the key, never sent

export function seal(chatId: string): string {
  return chatId + "." + createHmac("sha256", SEAL).update(chatId).digest("hex").slice(0, 32);
}

/** The Labs chat id inside a sealed id, or null if this server didn't issue it. */
export function unseal(token: unknown): string | null {
  const text = String(token), chatId = text.slice(0, Math.max(text.lastIndexOf("."), 0));
  if (!chatId) return null;
  const want = Buffer.from(seal(chatId)), got = Buffer.from(text);
  return want.length === got.length && timingSafeEqual(want, got) ? chatId : null;
}

const MARKER = /(^|\n)[ \t]*(?:[-*+•]|\d+[.)]|#{1,6})[ \t]+/g; // list and heading markers at a line start
const DONE = /^[\s\S]*(?:[.!?…]\s|\n)/; // everything up to the last sentence end or line break
const LINK = /\[([^\]]*)\]\([^)]*\)/g; // [label](address)
export const READ_MORE = /^Read more:\s*(\/\S*?)[.!?]?$/; // the agent's last line names the page it used

/** Splits off the whole sentences in `pending`. Returns [sentences, what is left over]. */
export function sentences(pending: string, final = false): [string[], string] {
  pending = pending.replace(MARKER, "$1");
  const cut = final ? pending.length : (pending.match(DONE)?.[0].length ?? 0);
  const ready = pending.slice(0, cut).replace(/\*\*|__|`/g, ""); // bold and code marks
  return [ready.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean), pending.slice(cut)];
}

/** Text without markdown, for speech: list and heading markers, bold, code marks and link syntax removed. */
export function plain(text: string): string {
  return text.replace(MARKER, "$1").replace(LINK, "$1").replace(/\*\*|__|`/g, "").trim();
}

export type Pronunciation = { word: string; sayAs: string };

/** The text to send to speech: each `word` replaced by its `sayAs`, as a whole word in any case. */
export function respell(text: string, pronunciations: Pronunciation[]): string {
  for (const p of [...pronunciations].sort((a, b) => b.word.length - a.word.length)) {
    const word = p.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, "giu"), () => p.sayAs);
  }
  return text;
}

// speechBody() and clipKey() are copied from speech/speech-cache-key.ts, so a line matches its stored clip.
const SPACES = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g; // the same set in Python

export type SpeechBody = { text: string; outputFormat: string };

/** The speech request, tidied. Send exactly this body, and key the clip with clipKey(). */
export function speechBody(text: string, outputFormat = "mp3_44100_64"): SpeechBody {
  return { text: text.normalize("NFC").replace(SPACES, " ").replace(/^ | $/g, ""), outputFormat };
}

/** The clip's key: SHA-256 of the voice id and the request as canonical JSON. */
export function clipKey(voiceId: string, body: SpeechBody): string {
  const all: Record<string, string> = { voiceId: voiceId.trim().toLowerCase(), ...body };
  const canonical = `{${Object.keys(all).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(all[k])}`).join(",")}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
