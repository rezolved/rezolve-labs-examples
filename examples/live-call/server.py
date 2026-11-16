"""Live call · a voice call with your agent from a web page, without the key leaving your server.

The page in client/ asks this server for a call (POST /api/call). The server starts the session with the secret key
and answers with only what the page needs to join: the room's url, token and name, the session id and the owner's
barge-in answer. After the caller hangs up, the page tells the server (POST /api/call/<sessionId>/ended) and the
server reads the transcript back.

At start it checks that the agent has a voice (a call on an agent without one is refused). The owner's live-call
answers come from site-assistant.yaml in examples/, or site-setup/site-assistant.example.yaml: transportProviderId is
the LiveKit server saved in the workspace (the newest saved one if it is empty), and bargeIn keeps the microphone
open while the agent speaks.

Build the page once, run the server, then open http://localhost:8790:
  npx tsc -p live-call/client
  uv run python live-call/server.py [--port 8790]
"""
import json, os, pathlib, re, sys, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml

sys.stdout.reconfigure(line_buffering=True)  # a server's log is often piped: print each line as it happens
for d in pathlib.Path(__file__).resolve().parents:  # the nearest .env above this file
    if (d / ".env").exists():
        for line in (d / ".env").read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() and not k.lstrip().startswith("#"):
                os.environ.setdefault(k.strip(), v.strip())
        break
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
AGENT = os.environ.get("LABS_AGENT_ID") or sys.exit("Set LABS_AGENT_ID in .env (site-setup/setup-02-create-agent makes one).")
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8790
HERE = pathlib.Path(__file__).resolve().parent
PAGE = {"/": (HERE / "client" / "index.html", "text/html"), "/app.js": (HERE / "client" / "dist" / "app.js", "text/javascript")}
ANSWERS = pathlib.Path("site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = HERE.parent / "site-setup" / "site-assistant.example.yaml"

def labs(method, path, body=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp.read()
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data

def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]

site = yaml.safe_load(ANSWERS.read_text())
BARGE_IN = bool(site.get("bargeIn", False))
agent = data_of(labs("GET", f"/developer-platform/agents/{AGENT}"), "Could not read the agent")
if not agent["voiceId"]:
    sys.exit(f"{agent['name']} has no voice, so a live call on it is refused with 409 AGENT_HAS_NO_VOICE. "
             f"Give it one first: PATCH /developer-platform/agents/{AGENT} with a voiceId.")
SERVER_ID = site.get("transportProviderId") or ""
if not SERVER_ID:
    saved = data_of(labs("GET", "/developer-platform/livekit-servers"), "Could not list the saved LiveKit servers")
    if not saved:
        sys.exit("No LiveKit server is saved in this workspace. Save yours once with POST /developer-platform/livekit-servers.")
    newest = max(saved, key=lambda s: s["createdAt"])
    SERVER_ID = newest["id"]
    print(f"transportProviderId is empty in {ANSWERS.name}: using the newest saved LiveKit server, "
          f"{newest['label']} ({SERVER_ID}). Put its id in the answers to choose it yourself.")
started = set()  # the sessions this server started: the page may read back only these

def start_call():
    """Starts the session with the secret key; returns only what the page needs to join, or None."""
    status, _, body = labs("POST", "/developer-platform/start/session",
                           {"agentId": AGENT, "participantName": "Website visitor", "transportProviderId": SERVER_ID})
    if status != 201:
        return None
    session = json.loads(body)["data"]
    started.add(session["sessionId"])
    join = session["connection"]
    return {"sessionId": session["sessionId"], "url": join["url"], "token": join["token"], "roomName": join["roomName"],
            "bargeIn": BARGE_IN}

def read_transcript(session_id):
    """After the caller has left: asks every 3 s, for up to 2 minutes, until the call is no longer `pending`."""
    for _ in range(40):
        status, _, body = labs("GET", f"/developer-platform/sessions/{session_id}/transcript")
        transcript = json.loads(body)["data"] if status == 200 else None
        if transcript and transcript["status"] != "pending":  # completed, or unavailable: nothing was recorded
            print(f"session {session_id}: {transcript['status']}, {len(transcript['messages'])} messages")
            for m in transcript["messages"]:
                print(f"{m['role']:>9}: {m['content']}".replace("\n", " "))
            return transcript
        if status not in (200, 404):  # a 404 can also mean "not recorded yet": keep asking
            return None
        time.sleep(3)
    return None

class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        file, kind = PAGE.get(self.path, (None, None))
        if file is None or not file.exists():
            return self.send(404, {"error": "Not found. Build the page first: npx tsc -p live-call/client"})
        self.send(200, file.read_bytes(), kind)

    def do_POST(self):
        if self.path == "/api/call":
            call = start_call()
            return self.send(201, call) if call else self.send(503, {"error": "The call could not start. Try again."})
        ended = re.fullmatch(r"/api/call/([\w-]+)/ended", self.path)
        if ended and ended[1] in started:
            started.discard(ended[1])
            transcript = read_transcript(ended[1])
            return self.send(200, {"status": transcript["status"] if transcript else "unavailable",
                                   "messages": transcript["messages"] if transcript else []})
        self.send(404, {"error": "No such call."})

    def log_message(self, *args):  # keep the log to the Labs calls
        pass

print(f"Agent {agent['name']} has a voice. Barge-in {'on' if BARGE_IN else 'off'}. Open http://localhost:{PORT}")
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
