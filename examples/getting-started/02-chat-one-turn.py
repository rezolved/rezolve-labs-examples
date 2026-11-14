"""02 · Chat, one turn.

Opens a chat with LABS_AGENT_ID (free), sends one question (10 credits) and prints the chat id and the whole
answer. The answer arrives as server-sent events; this file waits for `message.completed`, which holds all of it.
Keep the chat id per visitor and send every later question to the same chat: a new chat has no memory.

Run: uv run python getting-started/02-chat-one-turn.py ["your question"]
"""
import json, os, pathlib, sys, urllib.error, urllib.request

sys.stdout.reconfigure(line_buffering=True)
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
UA = "labs-playbook-examples/1.0"  # any explicit User-Agent works; Python's default gets 503 upstream_edge_block


def labs(method, path, body=None, stream=False):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors.
    With stream=True a successful answer comes back unread, so its events can be taken as they arrive."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp if stream and resp.status < 400 else resp.read()
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


def events(resp):
    """Yields (event, data) from a text/event-stream answer, one event at a time."""
    event = None
    for raw in resp:
        line = raw.decode().rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            yield event, json.loads(line[5:])


question = sys.argv[1] if len(sys.argv) > 1 else "Are you open on Monday?"
chat_id = data_of(labs("POST", "/developer-platform/chats", {"agentId": AGENT}), "Could not open a chat")["chatId"]
print(f"chat:     {chat_id}")
print(f"question: {question}")

status, _, resp = labs("POST", f"/developer-platform/chats/{chat_id}/messages", {"text": question}, stream=True)
if status != 200:
    sys.exit("The message was refused: see the body above.")
answer = ""
for event, data in events(resp):
    if event == "message.completed":
        answer = data["text"]
    elif event == "error":
        print(f"error:    {data}")
print(f"answer:   {answer}")
