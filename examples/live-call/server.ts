/**
 * Live call · a voice call with your agent from a web page, without the key leaving your server (TypeScript).
 *
 * The page in client/ asks this server for a call (POST /api/call). The server starts the session with the secret key
 * and answers with only what the page needs to join: the room's url, token and name, the session id and the owner's
 * barge-in answer. After the caller hangs up, the page tells the server (POST /api/call/<sessionId>/ended) and the
 * server reads the transcript back.
 *
 * At start it checks that the agent has a voice. The owner's live-call answers come from site-assistant.yaml in
 * examples/, or site-setup/site-assistant.example.yaml: transportProviderId is the LiveKit server saved in the
 * workspace (the newest saved one if it is empty), and bargeIn keeps the microphone open while the agent speaks.
 *
 * Build the page once, run the server, then open http://localhost:8790:
 *   npx tsc -p live-call/client
 *   npx tsx live-call/server.ts [--port 8790]
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const AGENT = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env (site-setup/setup-02-create-agent makes one).");
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const PORT = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 8790;
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE: Record<string, [string, string]> = {
  "/": [join(HERE, "client", "index.html"), "text/html"],
  "/app.js": [join(HERE, "client", "dist", "app.js"), "text/javascript"],
};
const ANSWERS = existsSync("site-assistant.yaml") ? "site-assistant.yaml"
  : join(HERE, "..", "site-setup", "site-assistant.example.yaml");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. */
async function labs(method: string, path: string, body?: unknown): Promise<Response> {
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

/** The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why). */
async function data_of(res: Response | Promise<Response>, what: string): Promise<any> {
  const answer = await res;
  if (answer.status >= 300) fail(`${what}: see the body above.`);
  return (await answer.json()).data;
}

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
const BARGE_IN = Boolean(site.bargeIn ?? false);
const agent = await data_of(labs("GET", `/developer-platform/agents/${AGENT}`), "Could not read the agent");
if (!agent.voiceId) {
  fail(`${agent.name} has no voice, so a live call on it is refused with 409 AGENT_HAS_NO_VOICE. `
    + `Give it one first: PATCH /developer-platform/agents/${AGENT} with a voiceId.`);
}
let SERVER_ID: string = site.transportProviderId || "";
if (!SERVER_ID) {
  const saved = await data_of(labs("GET", "/developer-platform/livekit-servers"), "Could not list the saved LiveKit servers");
  if (!saved.length) fail("No LiveKit server is saved in this workspace. Save yours once with POST /developer-platform/livekit-servers.");
  const newest = saved.reduce((a: any, b: any) => (b.createdAt > a.createdAt ? b : a));
  SERVER_ID = newest.id;
  console.log(`transportProviderId is empty in ${basename(ANSWERS)}: `
    + `using the newest saved LiveKit server, ${newest.label} (${SERVER_ID}). Put its id in the answers to choose it yourself.`);
}
const started = new Set<string>(); // the sessions this server started: the page may read back only these

/** Starts the session with the secret key; returns only what the page needs to join, or null. */
async function startCall() {
  const res = await labs("POST", "/developer-platform/start/session",
    { agentId: AGENT, participantName: "Website visitor", transportProviderId: SERVER_ID });
  if (res.status !== 201) return null;
  const session = (await res.json()).data;
  started.add(session.sessionId);
  const join = session.connection;
  return { sessionId: session.sessionId, url: join.url, token: join.token, roomName: join.roomName, bargeIn: BARGE_IN };
}

/** After the caller has left: asks every 3 s, for up to 2 minutes, until the call is no longer `pending`. */
async function readTranscript(sessionId: string) {
  for (let i = 0; i < 40; i++) {
    const res = await labs("GET", `/developer-platform/sessions/${sessionId}/transcript`);
    const transcript = res.status === 200 ? (await res.json()).data : null;
    if (transcript && transcript.status !== "pending") { // completed, or unavailable: nothing was recorded
      console.log(`session ${sessionId}: ${transcript.status}, ${transcript.messages.length} messages`);
      for (const m of transcript.messages) console.log(`${m.role.padStart(9)}: ${m.content}`.replace(/\n/g, " "));
      return transcript;
    }
    if (res.status !== 200 && res.status !== 404) return null; // a 404 can also mean "not recorded yet": keep asking
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

function send(res: ServerResponse, status: number, body: unknown, kind = "application/json") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": kind, "Cache-Control": "no-store", "Content-Length": data.length });
  res.end(data);
}

createServer(async (req, res) => {
  if (req.method === "GET") {
    const [file, kind] = PAGE[req.url ?? ""] ?? [];
    if (!file || !existsSync(file)) return send(res, 404, { error: "Not found. Build the page first: npx tsc -p live-call/client" });
    return send(res, 200, readFileSync(file), kind);
  }
  if (req.method === "POST" && req.url === "/api/call") {
    const call = await startCall();
    return call ? send(res, 201, call) : send(res, 503, { error: "The call could not start. Try again." });
  }
  const ended = req.method === "POST" ? /^\/api\/call\/([\w-]+)\/ended$/.exec(req.url ?? "") : null;
  if (ended && started.has(ended[1])) {
    started.delete(ended[1]);
    const transcript = await readTranscript(ended[1]);
    return send(res, 200, { status: transcript ? transcript.status : "unavailable", messages: transcript ? transcript.messages : [] });
  }
  send(res, 404, { error: "No such call." });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Agent ${agent.name} has a voice. Barge-in ${BARGE_IN ? "on" : "off"}. Open http://localhost:${PORT}`);
});
