/**
 * The microphone, through your server's transcription relay (GET /api/listen, a WebSocket). Labs' live
 * transcription needs the secret key on the socket, which a browser can't send, so the server opens it and relays
 * frames both ways.
 *
 * `listen()` is one turn: it opens the microphone and the socket, streams 16 kHz 16-bit PCM, shows the words as they
 * come, and returns what the visitor said once they stop talking. The microphone is closed again before it returns,
 * so it is off while the answer plays and the assistant never hears itself.
 */
import { ApiError, listenUrl, messageFor } from "./api.js";
import { mark } from "./debug.js";

export const RATE = 16000;
/**
 * Quiet this long after a final segment: the visitor has finished. A final comes about 1 s after a phrase ends, and
 * the first words of the next phrase about 1.3 s after it starts, so 1.5 s lets the visitor pause for about a second.
 */
export const DONE_AFTER_FINAL_MS = 1500;
/** Words heard but not yet final, and nothing new for this long: finish anyway. */
export const DONE_AFTER_PARTIAL_MS = 2500;
/** No words at all for this long: a silent turn. */
export const NOTHING_HEARD_MS = 7000;

export interface Heard {
  text: string;
  /** spoke: they finished talking · silent: nothing heard · tapped: the visitor stopped it · limit: the server did */
  ended: "spoke" | "silent" | "tapped" | "limit";
}

export interface Listening {
  onWords(text: string): void; // everything heard so far, the last part not yet final
  onLevel(level: number): void; // 0..1, for the signal line
  stop: AbortSignal; // aborting it ends the turn; what was heard is still returned
  language?: string;
}

let context: AudioContext | null = null;
let worklet: Promise<void> | null = null;

/** Call inside a tap: a phone only starts an audio context from one. */
export function wakeMic(): void {
  context ??= new AudioContext();
  void context.resume();
}

/** Loads the resampler before the first turn needs it (part of the warm start). */
export function warmMic(): Promise<void> {
  context ??= new AudioContext();
  return (worklet ??= context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url).href));
}

/** True if the visitor has already allowed the microphone here, so listening starts with no prompt. */
export async function micAllowed(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted";
  } catch {
    return false; // this browser can't say
  }
}

export async function listen(o: Listening): Promise<Heard> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  await warmMic();
  const ctx = context!;
  void ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm16");
  const socket = new WebSocket(listenUrl());
  const early: ArrayBuffer[] = []; // audio from before the socket is ready, sent once it is
  let ready = false;
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    o.onLevel(level(e.data));
    if (ready) socket.send(e.data);
    else early.push(e.data);
  };
  source.connect(node);
  node.connect(ctx.destination); // it outputs silence; connected, it keeps running

  return new Promise<Heard>((resolve, reject) => {
    const finals: string[] = [];
    let partial = "", ended: Heard["ended"] = "spoke", stopping = false, timer = 0, failure: ApiError | null = null;
    const words = () => [...finals, partial].filter((s) => s.trim()).join(" ").trim();
    const after = (ms: number, why: Heard["ended"]) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => finish(why), ms);
    };
    const release = () => { // the microphone off, at once
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      o.onLevel(0);
    };
    const finish = (why: Heard["ended"]) => { // stop sending; the server answers with the last finals, then `end`
      if (stopping) return;
      stopping = true;
      ended = why;
      release();
      mark(`listen: stop (${why})`);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      clearTimeout(timer);
      timer = window.setTimeout(() => socket.close(), 4000); // `end` normally comes well before this
    };
    o.stop.addEventListener("abort", () => finish("tapped"));

    socket.onopen = () => socket.send(JSON.stringify({ type: "start", sampleRate: RATE, language: o.language ?? "en-US" }));
    socket.onmessage = (e: MessageEvent<string>) => {
      const m = JSON.parse(e.data);
      if (m.type === "ready") {
        ready = true;
        mark("listen: ready");
        early.splice(0).forEach((frame) => socket.send(frame));
        if (!stopping) after(NOTHING_HEARD_MS, "silent");
      } else if (m.type === "partial") {
        partial = m.text ?? "";
        if (partial.trim() && !stopping) after(DONE_AFTER_PARTIAL_MS, "spoke");
        o.onWords(words());
      } else if (m.type === "final") {
        mark(`listen: final "${m.text}"`);
        finals.push(m.text ?? "");
        partial = "";
        if (!stopping) after(DONE_AFTER_FINAL_MS, "spoke");
        o.onWords(words());
      } else if (m.type === "end") {
        if (!stopping) { // the server stopped it (limits.listenSeconds)
          stopping = true;
          ended = "limit";
          release();
        }
        socket.close(1000);
      } else if (m.type === "error") {
        failure = new ApiError(m.code, m.message ?? messageFor(m.code));
      }
    };
    socket.onclose = (e) => {
      clearTimeout(timer);
      if (!stopping) release();
      mark(`listen: closed ${e.code}`);
      const text = words();
      if (failure && !text) return reject(failure);
      if (!stopping && !text) return reject(new ApiError("unavailable", messageFor("unavailable")));
      resolve({ text, ended: text ? (ended === "silent" ? "spoke" : ended) : ended === "spoke" ? "silent" : ended });
    };
  });
}

/** The loudness of one frame, 0..1. */
function level(frame: ArrayBuffer): number {
  const samples = new Int16Array(frame);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) / 6000);
}
