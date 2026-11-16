// Live call page: joins the room the server started, keeps the microphone closed while the agent speaks (unless the
// owner turned barge-in on), lets the caller tap to interrupt, hangs up, then shows the transcript.
import { Room, RoomEvent, Track, createAudioAnalyser } from "livekit-client";
import type { RemoteAudioTrack } from "livekit-client";

type Call = { sessionId: string; url: string; token: string; roomName: string; bargeIn: boolean };
type AgentEvent = { type?: string; data?: { text?: string; final?: boolean; spoken?: boolean; state?: string } };
const LOUD = 0.02; // the agent's audio level (0 to 1) above which it is speaking; silence on a call reads 0
const TAIL_MS = 500; // the agent still counts as speaking this long after its voice drops

const $ = (id: string) => document.getElementById(id) as HTMLElement;
let room: Room | undefined;
let call: Call | undefined;
let voice: RemoteAudioTrack | undefined; // the agent's voice
let stopListening = () => {};
let micReady = false;
let agentSpeaking = false;
let interrupted = false; // the caller tapped: the agent is silenced on this page until it stops

function show(state: string, text: string) {
  document.body.dataset.state = state;
  $("state").textContent = text;
  $("call").hidden = state !== "idle";
  $("hangup").hidden = state === "idle" || state === "ended";
  $("interrupt").hidden = state !== "speaking";
}

function line(list: HTMLElement, who: string, text = "") {
  const item = document.createElement("li");
  item.dataset.who = who;
  item.textContent = text;
  list.append(item);
}

// The microphone is open unless the agent is speaking. Barge-in, or a tap, keeps it open.
async function setMic() {
  if (!room || !call || !micReady) return;
  const open = call.bargeIn || interrupted || !agentSpeaking;
  if (room.localParticipant.isMicrophoneEnabled !== open) await room.localParticipant.setMicrophoneEnabled(open);
}

// Follow the level of the agent's voice as it plays: that is what the caller hears, and what the microphone must not
// pick up again. The agent's own "stopped speaking" event arrives before its last words have played.
function hear(track: RemoteAudioTrack) {
  stopListening();
  voice = track;
  document.body.append(track.attach());
  const { calculateVolume, cleanup } = createAudioAnalyser(track);
  let lastLoud = -Infinity;
  const timer = setInterval(() => {
    if (calculateVolume() > LOUD) lastLoud = performance.now();
    const speaking = performance.now() - lastLoud < TAIL_MS;
    if (speaking === agentSpeaking) return;
    agentSpeaking = speaking;
    if (!speaking && interrupted) {
      interrupted = false;
      track.setVolume(1); // the next reply is heard again
    }
    show(speaking ? "speaking" : "listening", speaking ? "The assistant is speaking" : "Listening");
    void setMic();
  }, 50);
  stopListening = () => {
    clearInterval(timer);
    void cleanup();
  };
}

// The agent also sends small JSON events on the room's data channel: what the caller said, each sentence once it has
// been spoken, and when it is thinking. They are not in the API reference, so the call works without them.
function onEvent(payload: Uint8Array) {
  let event: AgentEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  const text = event.data?.text?.trim();
  if (event.type === "user-transcription" && event.data?.final && text) line($("captions"), "caller", text);
  if (event.type === "bot-output" && event.data?.spoken && text) line($("captions"), "assistant", text);
  if (event.type === "server-message" && event.data?.state === "thinking") show("thinking", "Thinking");
}

async function start() {
  show("connecting", "Connecting");
  const res = await fetch("/api/call", { method: "POST" });
  if (!res.ok) return show("idle", (await res.json()).error);
  call = (await res.json()) as Call;
  room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) hear(track as RemoteAudioTrack);
  });
  room.on(RoomEvent.DataReceived, onEvent);
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (room && !room.canPlaybackAudio) show("blocked", "Tap anywhere to hear the assistant");
  });
  room.on(RoomEvent.Disconnected, () => void ended());
  try {
    await room.connect(call.url, call.token); // at once: the token is short-lived and works for this call only
  } catch {
    room = undefined;
    return show("idle", "Could not join the call. Try again.");
  }
  try {
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch {
    show("idle", "The microphone is blocked. Allow it for this site and call again.");
    return room.disconnect();
  }
  micReady = true;
  await setMic(); // closed again if the agent is already speaking its welcome
  if (!agentSpeaking) show("listening", "Listening");
}

// A tap silences the agent on this page and opens the microphone. Nothing stops the reply on the platform: the agent
// stops when it hears the caller speak.
async function interrupt() {
  interrupted = true;
  voice?.setVolume(0);
  show("listening", "Go ahead");
  await setMic();
}

async function ended() {
  const session = call?.sessionId;
  stopListening();
  room = undefined;
  micReady = agentSpeaking = interrupted = false;
  show("ended", "Call ended. Reading the transcript");
  const res = await fetch(`/api/call/${session}/ended`, { method: "POST" });
  const transcript = res.ok ? await res.json() : { status: "unavailable", messages: [] };
  for (const m of transcript.messages as { role: string; content: string }[]) line($("transcript"), m.role, m.content);
  show("idle", transcript.status === "completed" ? "Call ended." : "Call ended. No transcript was recorded.");
}

$("call").onclick = () => void start();
$("interrupt").onclick = () => void interrupt();
$("hangup").onclick = () => void room?.disconnect();
document.addEventListener("click", () => void room?.startAudio()); // a tap lets a blocked page play the agent
