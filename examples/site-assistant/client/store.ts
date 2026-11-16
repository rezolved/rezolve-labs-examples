/**
 * What the widget keeps while the visitor moves between pages of the site, in this browser tab only
 * (sessionStorage): the chat id (the conversation itself is read back from GET /api/transcript), whether the panel
 * was open, whether the voice is off, whether the welcome has played, and the microphone answer.
 *
 * Nothing is written until storage is allowed: at once when the owner doesn't ask for consent, else when the
 * visitor agrees. Until then it is kept in memory for this page only. Arriving from another site, or typing the
 * address, starts afresh.
 */
const KEY = "site-assistant";

export interface Kept { chatId: string | null; open: boolean; muted: boolean; welcomed: boolean; micOk: boolean }

export class Store {
  readonly kept: Kept = { chatId: null, open: false, muted: false, welcomed: false, micOk: false };
  /** This visit started on this page: not a link from another page of the site, a reload or Back. */
  readonly fresh = freshArrival();
  allowed: boolean;

  constructor(askConsent: boolean) {
    const saved = this.fresh ? null : read();
    if (this.fresh) write(null);
    Object.assign(this.kept, saved);
    this.allowed = !askConsent || saved !== null; // something saved means the visitor agreed earlier
  }

  save(change: Partial<Kept>): void {
    Object.assign(this.kept, change);
    if (this.allowed) write(this.kept);
  }

  allow(): void {
    this.allowed = true;
    write(this.kept);
  }
}

function freshArrival(): boolean {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav && nav.type !== "navigate") return false; // a reload, Back or Forward
  try {
    return new URL(document.referrer).origin !== location.origin;
  } catch {
    return true; // no referrer: a typed address, a bookmark, a new tab
  }
}

function read(): Kept | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

function write(kept: Kept | null): void {
  try {
    if (kept) sessionStorage.setItem(KEY, JSON.stringify(kept));
    else sessionStorage.removeItem(KEY);
  } catch {
    // storage is blocked (some private modes): keep going in memory
  }
}
