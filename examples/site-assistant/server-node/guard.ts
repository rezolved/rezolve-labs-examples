/**
 * Who may call and how much: allowed origins, the visitor's address, per-minute limits, the spend cap and alerts.
 *
 * Every count lives in this process's memory: it starts at zero when the server starts, and two processes (or two
 * machines behind a load balancer) each count on their own. For more than one process, keep the counts in a shared
 * store such as Redis, with the same rules.
 */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { UA } from "./labs.ts";

export const PORT = Number(process.env.PORT || 8040);
export const ORIGINS = new Set((process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
  .split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean));
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

/** The page's origin: Origin, or the origin of Referer when there is none (an <audio> element sends no Origin). */
export function originOf(headers: IncomingHttpHeaders): string | null {
  if (headers.origin) return headers.origin.replace(/\/$/, "");
  try { return headers.referer ? new URL(headers.referer).origin : null; } catch { return null; }
}

export function allowedOrigin(headers: IncomingHttpHeaders): string | null {
  const origin = originOf(headers);
  return origin && ORIGINS.has(origin) ? origin : null;
}

/** The visitor's address. Behind your own proxy (TRUST_PROXY=1) it is the last X-Forwarded-For entry, the one
 * your proxy added; without a proxy that header is whatever the visitor sent, so it is ignored. */
export function visitor(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (TRUST_PROXY && typeof forwarded === "string") return forwarded.split(",").at(-1)!.trim();
  return (req.socket.remoteAddress ?? "-").replace(/^::ffff:/, "");
}

/** Per-minute limits, per visitor and for the whole site, as a sliding 60-second window. */
export class Limits {
  private seen = new Map<string, number[]>(); // "bucket who" -> times of recent calls (ms)
  constructor(public perVisitor: Record<string, number>, public perSite: Record<string, number>) {}

  /** Counts one call. Returns 0 if it may go ahead, else the seconds until it may. */
  take(bucket: string, who: string): number {
    const now = performance.now(), waits: number[] = [];
    for (const [key, limit] of [[`${bucket} ${who}`, this.perVisitor[bucket]], [`${bucket} *site*`, this.perSite[bucket]]] as const) {
      const q = this.seen.get(key) ?? [];
      while (q.length && q[0] <= now - 60_000) q.shift();
      this.seen.set(key, q);
      if (limit !== undefined && q.length >= limit) waits.push(Math.ceil((q[0] + 60_000 - now) / 1000));
    }
    if (waits.length) return Math.max(...waits);
    this.seen.get(`${bucket} ${who}`)!.push(now);
    this.seen.get(`${bucket} *site*`)!.push(now);
    return 0;
  }
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** The owner's spend cap: `monthlyCredits` for the site in a calendar month, `perVisitorCredits` for each
 * visitor in a day. Credits are counted from X-Credits-Charged on every Labs answer. */
export class Budget {
  private month = thisMonth();
  monthSpent = 0;
  private visitors = new Map<string, [number, number][]>(); // who -> [time, credits] in the last day
  constructor(public monthly: number, public perVisitor: number) {}

  private visitorSpent(who: string): number {
    const q = (this.visitors.get(who) ?? []).filter(([t]) => t > Date.now() - 86_400_000);
    this.visitors.set(who, q);
    return q.reduce((sum, [, c]) => sum + c, 0);
  }

  allows(who: string): boolean {
    if (thisMonth() !== this.month) [this.month, this.monthSpent] = [thisMonth(), 0];
    if (this.monthSpent >= this.monthly) {
      alert("budget", `the month's budget of ${this.monthly} credits is spent: the assistant is refusing questions`);
      return false;
    }
    return this.visitorSpent(who) < this.perVisitor;
  }

  spend(who: string, credits: number) {
    if (!credits) return;
    this.monthSpent += credits;
    this.visitors.set(who, [...(this.visitors.get(who) ?? []), [Date.now(), credits]]);
  }
}

const ALERT_EVERY = 3_600_000; // ms: during an outage every visitor fails the same way, so one alert per kind an hour
const lastAlert = new Map<string, number>();
export const alertTo: { how?: string; who?: string[]; webhookUrl?: string } = { how: "email", who: [], webhookUrl: "" };

/** Tells the owner, at most once an hour per kind: posts {"text": ...} to the webhook, or logs who to email. */
export function alert(kind: string, text: string) {
  if (Date.now() - (lastAlert.get(kind) ?? 0) < ALERT_EVERY) return;
  lastAlert.set(kind, Date.now());
  const url = process.env.ALERT_WEBHOOK_URL || alertTo.webhookUrl;
  if (alertTo.how === "webhook" && url) void postAlert(url, text);
  else console.log(`[alert] for ${(alertTo.who?.length ? alertTo.who : ["the owner"]).join(", ")} (${alertTo.how}): Site assistant: ${text}`);
}

async function postAlert(url: string, text: string) {
  let status: number | string;
  try {
    status = (await fetch(url, {
      method: "POST", body: JSON.stringify({ text: `Site assistant: ${text}` }),
      headers: { "Content-Type": "application/json", "User-Agent": UA },
    })).status;
  } catch (e) { // an alert must never break a visitor's request
    status = (e as Error).name;
  }
  console.log(`[alert] POST ${new URL(url).hostname} -> ${status}`);
}
