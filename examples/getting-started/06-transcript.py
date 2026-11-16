"""06 · Read the transcript back.

GET /developer-platform/chats/{chatId}/messages (free) returns every turn of a chat, oldest first, with `isError`
on each. GET /developer-platform/conversations/{chatId}/transcript returns the same: a chat id is its conversation id.
With a chat id argument this reads that chat; without one it makes a two-turn chat first.

Run: uv run python getting-started/06-transcript.py [chatId]
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
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent


def labs(method, path, body=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp.read()  # a chat answer is an event stream; reading it whole waits for the end of the turn
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


if len(sys.argv) > 1:
    chat_id = sys.argv[1]
else:
    agent = os.environ.get("LABS_AGENT_ID") or sys.exit("Set LABS_AGENT_ID in .env, or pass a chat id.")
    chat_id = data_of(labs("POST", "/developer-platform/chats", {"agentId": agent}), "Could not open a chat")["chatId"]
    for question in ("Do you sell rye bread?", "How much is it?"):  # "it" only works because it is the same chat
        labs("POST", f"/developer-platform/chats/{chat_id}/messages", {"text": question})

transcript = data_of(labs("GET", f"/developer-platform/chats/{chat_id}/messages"), "Could not read the transcript")
print(f"chat:   {chat_id} ({len(transcript['turns'])} turns, {transcript['status']})")
for turn in transcript["turns"]:
    flag = " [error]" if turn["isError"] else ""
    print(f"{turn['role']:>4}:{flag} {turn['text']}".replace("\n", " "))
