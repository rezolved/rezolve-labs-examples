"""04 · Chat in sentences.

Sends one question and prints the answer one sentence per line as it arrives, with the time since sending.
`message.delta` events are sentence-sized chunks, but a chunk can hold two sentences or end mid-word, so the
deltas are joined raw and only whole sentences are released. Markdown list and heading markers are dropped on
the way, because replies keep them (and a voice would read them out).

Run: uv run python getting-started/04-chat-sentences.py ["your question"]
"""
import json, os, pathlib, re, sys, time, urllib.error, urllib.request

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
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent


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


MARKER = re.compile(r"(^|\n)[ \t]*(?:[-*+•]|\d+[.)]|#{1,6})[ \t]+")  # list and heading markers at a line start
DONE = re.compile(r"[\s\S]*(?:[.!?…]\s|\n)")  # everything up to the last sentence end or line break


def sentences(pending, final=False):
    """Splits off the whole sentences in `pending`. Returns (sentences, what is left over)."""
    pending = MARKER.sub(r"\1", pending)
    cut = len(pending) if final else (m.end() if (m := DONE.match(pending)) else 0)
    ready = re.sub(r"\*\*|__|`", "", pending[:cut])  # bold and code marks
    return [s.strip() for s in re.split(r"(?<=[.!?…])\s+|\n+", ready) if s.strip()], pending[cut:]


question = sys.argv[1] if len(sys.argv) > 1 else "Tell me about your breads, when you are open, and whether I can bring my dog."
chat_id = data_of(labs("POST", "/developer-platform/chats", {"agentId": AGENT}), "Could not open a chat")["chatId"]
print(f"chat: {chat_id}")

sent = time.time()
status, _, resp = labs("POST", f"/developer-platform/chats/{chat_id}/messages", {"text": question}, stream=True)
if status != 200:
    sys.exit("The message was refused: see the body above.")
pending, count = "", 0
for event, data in events(resp):
    if event == "tool.started":
        print(f"[+{time.time() - sent:.1f}s] (the agent is using {data['name']})")
    elif event == "message.delta":
        ready, pending = sentences(pending + data["text"])
        for s in ready:
            count += 1
            print(f"[+{time.time() - sent:.1f}s] {s}")
    elif event == "error":
        print(f"[+{time.time() - sent:.1f}s] error: {data}")
for s in sentences(pending, final=True)[0]:  # the stream ended: whatever is left is the last sentence
    count += 1
    print(f"[+{time.time() - sent:.1f}s] {s}")
print(f"{count} sentences")
