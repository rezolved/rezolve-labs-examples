/**
 * The calls the widget makes to your server (CONTRACT.md). The browser never calls Labs and never holds a key:
 * every path here is on the server that served this script.
 */
import { mark } from "./debug.js";

export const API = new URL("/api/", import.meta.url);

export interface Route { label: string; path: string; aliases: string[]; anchorsAllowed: boolean }
export interface Link { path: string; label: string }
export interface Turn { role: "user" | "assistant"; text: string; link: Link | null }

/** The owner's settings, from GET /api/site. */
export interface Site {
  name: string; title: string; storeName: string; welcomeMessage: string;
  welcome: { playOnFirstTap: boolean; autoListen: boolean; back: string };
  acknowledgements: string[]; prompts: string[]; routes: Route[];
  contact: { path: string; email: string };
  mode: string; bargeIn: boolean; placement: string[];
  theme: { inherit: boolean; colorScheme: "auto" | "light" | "dark"; animation: boolean };
  followUp: { offerNavigation: boolean }; navigation: { enabled: boolean };
  retention: { keepTranscripts: boolean; askMicConsent: boolean; askStorageConsent: boolean };
  limits: { questionChars: number; speechChars: number; listenSeconds: number };
  messages: Record<string, string>;
  clipVersion?: string;
}

export type ChatEvent =
  | { event: "chat"; data: { chatId: string } }
  | { event: "tool"; data: { name: string } }
  | { event: "sentence"; data: { index: number; text: string } }
  | { event: "link"; data: Link }
  | { event: "error"; data: { code: string; message: string } }
  | { event: "done"; data: { cancelled: boolean } };

/** A refusal: `code` from the contract's table, `message` ready to show the visitor. */
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfter?: number) { super(message); }
}

const FALLBACK = "Sorry, that didn't go through. Please try again in a moment.";
let messages: Record<string, string> = {};
let clipVersion = "";

/** The owner's wording for an error code, or a general one. */
export const messageFor = (code: string): string => messages[code] ?? messages.unavailable ?? FALLBACK;

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(new URL(path, API), init);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("unavailable", messageFor("unavailable"));
  }
  mark(`${init?.method ?? "GET"} /api/${path.split("?")[0]} -> ${res.status}`);
  if (res.ok) return res;
  const error = (await res.json().catch(() => ({}))).error ?? {};
  throw new ApiError(error.code ?? "unavailable", error.message ?? messageFor(error.code), error.retryAfter);
}

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

export async function getSite(): Promise<Site> {
  const site: Site = await (await call("site")).json();
  messages = site.messages ?? {};
  clipVersion = site.clipVersion ?? "";
  return site;
}

/**
 * Asks a question and yields the answer's events as the server sends them (`chat` first, `done` last). Nothing
 * waits for the whole answer: each sentence is yielded the moment its line arrives.
 */
export async function* chat(text: string, chatId: string | null, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const res = await post("chat", chatId ? { text, chatId } : { text }, signal);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", event = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value; // a chunk can end mid-line, so only whole lines are parsed
    for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
      const line = buffer.slice(0, i).replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) yield { event, data: JSON.parse(line.slice(5)) } as ChatEvent;
    }
  }
}

/** Stops the answer streaming on this chat. The agent still finishes it (and it is charged); the server stops sending. */
export async function cancel(chatId: string): Promise<boolean> {
  return (await (await post("cancel", { chatId })).json()).cancelled === true;
}

/** The conversation so far, oldest first. */
export async function transcript(chatId: string): Promise<Turn[]> {
  return (await (await call(`transcript?chatId=${encodeURIComponent(chatId)}`)).json()).turns;
}

/** The address of one clip: an <audio> element pointed at it starts playing on the first bytes. */
export function speechUrl(text: string): string {
  const url = new URL("speech", API);
  url.searchParams.set("text", text);
  if (clipVersion) url.searchParams.set("v", clipVersion);
  return url.href;
}

export function listenUrl(): string {
  const url = new URL("listen", API);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
