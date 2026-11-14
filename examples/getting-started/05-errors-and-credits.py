"""05 · Errors and credits.

Makes one real answer and forces three refusals: a bad key (401), the edge block on Python's default
User-Agent (503) and the rate limit (429, from a burst of free calls). `verdict()` turns each into what a site
should do, including a 402 (out of credits) and the platform's fallback sentence, which arrives as an ordinary
answer. Then it reads the balance and today's usage (both free) and checks them against X-Credits-Charged.
If ALERT_WEBHOOK_URL is set, every failure that needs a person is posted to it as {"text": ...}.

Run: uv run python getting-started/05-errors-and-credits.py      (the burst locks the key out for a few seconds)
"""
import json, os, pathlib, sys, threading, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

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
FALLBACK = "Sorry, I couldn't put a reply together"  # how the platform's fallback sentence starts


def labs(method, path, body=None, stream=False, key=KEY, ua=UA):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors.
    With stream=True a successful answer comes back unread, so its events can be taken as they arrive."""
    headers = {"X-API-KEY": key, "Content-Type": "application/json"}
    if ua:
        headers["User-Agent"] = ua
    req = urllib.request.Request(API + path, method=method, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp if stream and resp.status < 400 else resp.read()
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")) + "\n",
          end="")  # one write, so the burst's threads don't interleave lines
    return resp.status, resp.headers, data


def events(resp):
    """Yields (event, data) from a text/event-stream answer, one event at a time."""
    event = None
    for raw in resp:
        line = raw.decode().rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            yield event, json.loads(line[5:])


def verdict(status, headers, body, reply="", failed=False):
    """What a Labs answer means for a site: (code, what to do). Only "answer" is an answer."""
    try:
        err = json.loads(body) if status >= 400 else {}
    except ValueError:
        err = {}
    code = err.get("code", "-")
    if status < 300:
        if failed:
            return "-", "the turn failed part-way: show your own message, don't count it as an answer"
        if reply.startswith(FALLBACK):
            return "-", "fallback sentence: show your own message, don't count it as an answer"
        return "-", "answer"
    if status == 401:
        return code, "bad key: check LABS_API_KEY"
    if status == 402 and code == "call_over_plan_limit":
        return code, "costs more than the plan allows in one call: only a bigger plan helps"
    if status == 402:
        return code, "out of credits: stop calling, tell the owner, show your limit message"
    if status == 403:
        return code, f"refused: {err.get('detail', '')}"
    if status == 425:
        return code, "knowledge base still indexing: wait until its documents are ready, then retry"
    if status == 429:
        return code, f"rate limited: wait {headers.get('Retry-After', '1')} s, then retry"
    if code == "upstream_edge_block":
        return code, "edge block: send an explicit User-Agent; retrying won't help"
    if status >= 500:
        return code, "service error: retry with a growing delay (never charged)"
    return code, f"request refused, fix it: {err.get('detail', '')}"


def alert(text):
    """Posts {"text": ...} to ALERT_WEBHOOK_URL, if one is set."""
    url = os.environ.get("ALERT_WEBHOOK_URL")
    if not url:
        return
    req = urllib.request.Request(url, method="POST", data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    try:
        status = urllib.request.urlopen(req, timeout=10).status
    except urllib.error.HTTPError as e:
        status = e.status
    print(f"[alert] POST {urllib.parse.urlsplit(url).hostname} -> {status}")


def retrying(method, path, body=None, stream=False):
    """labs() that tries again while the answer is a 429 (after Retry-After) or a 5xx other than the edge block
    (after 1, 2, 4 and 8 s). One Retry-After wait is not always enough: the minute's window can still be full."""
    for attempt in range(30):
        status, headers, data = labs(method, path, body, stream)
        if status == 429:
            wait = int(headers.get("Retry-After", "1"))
        elif status >= 500 and attempt < 4 and b"upstream_edge_block" not in data:
            wait = 2 ** attempt
        else:
            break
        time.sleep(wait)
    return status, headers, data


def usage_today():
    status, _, body = retrying("GET", "/api-keys/usage?group_by=day")
    if status != 200:
        sys.exit("Could not read the usage: see the body above.")
    u = json.loads(body)
    today = next((g for g in u["groups"] if g["key"] == u["end"][:10]), {"calls": 0, "credits": 0})
    return today["calls"], today["credits"]


rows, charged = [], 0


def record(case, status, headers, body, reply="", failed=False):
    global charged
    code, todo = verdict(status, headers, body, reply, failed)
    credits = headers.get("X-Credits-Charged", "-")
    charged += int(credits) if credits.isdigit() else 0
    rows.append((case, status, code, credits, todo))
    if todo != "answer" and status != 429:
        alert(f"Site assistant: {todo} ({case}, HTTP {status})")


calls_before, credits_before = usage_today()

# 1. A real answer. A 200 is not enough: an `error` event or the fallback sentence is still a failure.
status, _, body = labs("POST", "/developer-platform/chats", {"agentId": AGENT})
if status != 201:
    sys.exit("Could not open a chat: see the body above.")
chat_id = json.loads(body)["data"]["chatId"]
status, headers, resp = retrying("POST", f"/developer-platform/chats/{chat_id}/messages", {"text": "Are you open on Monday?"}, stream=True)
reply, failed = "", False
if status == 200:
    for event, data in events(resp):
        if event == "message.completed":
            reply = data["text"]
        elif event == "error":
            failed = True
record("answer", status, headers, b"" if status == 200 else resp, reply, failed)

# 2. A bad key, and 3. Python's default User-Agent (ua=None sends urllib's own).
record("bad key", *labs("GET", "/voice-audio/voices/list?pageSize=1", key="rzlb_live_sk_not_a_real_key"))
record("edge block", *labs("GET", "/voice-audio/voices/list?pageSize=1", ua=None))

# 4. The rate limit: free calls, 32 at a time, until the first 429.
stop = threading.Event()


def burst_call(_):
    if stop.is_set():
        return None
    r = labs("GET", "/voice-audio/voices/list?pageSize=1")
    if r[0] == 429:
        stop.set()
    return r


with ThreadPoolExecutor(32) as pool:
    burst = [r for r in pool.map(burst_call, range(600)) if r]
limited = next((r for r in burst if r[0] == 429), None)
if limited:
    record("rate limit", *limited)
    print(f"burst: {sum(1 for r in burst if r[0] == 200)} answered before the first 429")
    record("after waiting", *retrying("GET", "/voice-audio/voices/list?pageSize=1"))  # 5. wait, retry, repeat

status, _, body = retrying("GET", "/api-keys/balance")
if status != 200:
    sys.exit("Could not read the balance: see the body above.")
balance = json.loads(body)
calls_after, credits_after = usage_today()

print()
print(f"{'case':<14} {'status':<7} {'code':<22} {'charged':<8} verdict")
for case, status, code, credits, todo in rows:
    print(f"{case:<14} {status:<7} {code:<22} {credits:<8} {todo}")
print()
print(f"balance:  {balance['available']} available, {balance['held']} held, "
      f"blocked: {'yes' if balance['blocked'] else 'no'}, low balance: {'yes' if balance['low_balance'] else 'no'}")
print(f"usage:    today {calls_after} calls, {credits_after} credits")
print(f"check:    X-Credits-Charged added up to {charged}; today's usage moved by {credits_after - credits_before} credits")
