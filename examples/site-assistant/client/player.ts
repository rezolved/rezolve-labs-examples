/**
 * The voice: one <audio> element, unlocked inside the visitor's first tap and reused for every clip.
 *
 * A phone (Safari on iPhone above all) plays sound only from an element that a tap started, and an answer's audio
 * arrives seconds after the tap. So `unlock()` starts the element with a moment of silence inside the tap, and every
 * clip after that plays on the same element.
 *
 * Clips play in the order they were queued, never the order they arrive. A clip that is next with nothing playing
 * streams: the element points at /api/speech and starts on the first bytes. While a clip plays, the clips after it
 * are fetched, with at most 2 speech requests open at a time, so each is ready when its turn comes.
 */
import { speechUrl } from "./api.js";
import { mark } from "./debug.js";

export const MAX_IN_FLIGHT = 2;

export interface Clip {
  text: string;
  /** Its sound has started: the place to start showing its text. */
  onStart?(audio: HTMLAudioElement): void;
  /** It finished, was stopped, or could not be played. Called exactly once. */
  onEnd?(played: boolean): void;
}

interface Item extends Clip { url: string; file?: Promise<string | null>; abort?: AbortController; started?: boolean }

export class Player {
  readonly audio = new Audio();
  /** The browser refused to play (no tap yet). The next tap's `unlock()` clears it. */
  blocked = false;
  onBlocked = (): void => {};
  /** The system paused the sound (a phone call, the lock screen): everything queued was dropped. */
  onInterrupted = (): void => {};

  private queue: Item[] = [];
  private current: Item | null = null;
  private open = 0; // speech requests in flight
  private streaming = false; // the current clip is still arriving into the element

  /** Call inside a tap (click, key press). Later clips can then play without one. */
  unlock(): void {
    this.blocked = false;
    if (this.current) return; // something is playing, so the element is already allowed
    this.audio.src = SILENCE;
    this.audio.play().catch(() => {}); // a clip queued in the same tap replaces the silence at once
  }

  say(clip: Clip): void {
    this.queue.push({ ...clip, url: speechUrl(clip.text) });
    this.pump();
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** Stops the sound and drops every queued clip, cancelling their requests (an aborted clip isn't made). */
  stop(): void {
    const items = this.current ? [this.current, ...this.queue] : this.queue;
    this.queue = [];
    this.current = null;
    this.detach();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load(); // ends the request of a clip that is still streaming
    for (const item of items) {
      item.abort?.abort();
      item.file?.then((url) => url && URL.revokeObjectURL(url));
      item.onEnd?.(false);
    }
  }

  private pump(): void {
    if (!this.current && this.queue.length) this.next();
    for (const item of this.queue) { // fetch ahead while fewer than 2 requests are open
      if (this.open >= MAX_IN_FLIGHT) break;
      if (!item.file) item.file = this.fetchAhead(item);
    }
  }

  private next(): void {
    const item = (this.current = this.queue.shift()!);
    if (this.blocked) return this.end(item, false);
    if (!item.file) {
      this.open++; // streams straight into the element
      this.streaming = true;
      return this.play(item, item.url);
    }
    item.file.then((url) => {
      if (this.current !== item) return;
      if (url) this.play(item, url);
      else this.end(item, false);
    });
  }

  private async fetchAhead(item: Item): Promise<string | null> {
    this.open++;
    item.abort = new AbortController();
    try {
      const res = await fetch(item.url, { signal: item.abort.signal });
      mark(`clip fetched ${res.status} ${res.headers.get("X-Clip") ?? ""}: ${item.text.slice(0, 40)}`);
      return res.ok ? URL.createObjectURL(await res.blob()) : null;
    } catch {
      return null;
    } finally {
      this.open--;
      setTimeout(() => this.pump());
    }
  }

  private play(item: Item, src: string): void {
    const a = this.audio;
    a.onplaying = () => {
      if (item.started) return; // "playing" fires again after a stall
      item.started = true;
      item.onStart?.(a);
    };
    a.ondurationchange = () => { if (isFinite(a.duration)) this.arrived(); }; // a streamed clip has all arrived
    a.onended = () => this.end(item, true);
    a.onerror = () => this.end(item, false);
    a.onpause = () => {
      if (a.ended || this.current !== item) return;
      this.stop();
      this.onInterrupted();
    };
    a.src = src;
    a.play().catch((err: Error) => {
      if (this.current !== item) return;
      if (err.name !== "NotAllowedError") return this.end(item, false);
      this.blocked = true; // no tap has unlocked the element: drop this answer's voice, keep its text
      this.stop();
      this.onBlocked();
    });
  }

  private arrived(): void {
    if (!this.streaming) return;
    this.streaming = false;
    this.open--;
    this.pump();
  }

  private end(item: Item, played: boolean): void {
    if (this.current !== item) return;
    this.detach();
    this.current = null;
    item.file?.then((url) => url && URL.revokeObjectURL(url));
    item.onEnd?.(played);
    this.pump();
  }

  private detach(): void {
    const a = this.audio;
    if (this.streaming) this.arrived();
    a.onplaying = a.ondurationchange = a.onended = a.onerror = a.onpause = null;
  }
}

/** 0.1 s of silence as a WAV file: what the element plays inside the tap. */
const SILENCE = (() => {
  const n = 800; // samples: 0.1 s at 8 kHz, 8-bit mono, where 128 is silence
  const bytes = new Uint8Array(44 + n).fill(128, 44);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + n, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, "data"); view.setUint32(40, n, true);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
})();
