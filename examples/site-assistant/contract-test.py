"""site-assistant · Contract test: the same checks against either server.

Talks to a running server only through CONTRACT.md, the way the browser does, and prints one line per check. The
`pass` lines are the same for both servers; `note` lines hold what changes from run to run (timings, counts). Run it
against a freshly started server: the rate-limit checks use up this visitor's minute. It asks 6 questions (60
credits) and makes about 12 live clips and a few seconds of live transcription; with photos on (`photos` in
/api/site), 2 more questions, with a plain square for a photo.

Optional: --bad-key URL, a second instance started with LABS_API_KEY=rzlb_live_sk_not_a_real_key (Labs refusals
become `unavailable`); --small-budget URL, an instance whose SITE_ANSWERS file has perVisitorCredits: 15 (the cap
answers `budget_reached` with the owner's message); --log FILE (repeatable), a server log to search for the key.
The listen check decodes the welcome clip with ffmpeg; without ffmpeg it only checks the protocol.

Run, from examples/, with a server on 8040:
  uv run python site-assistant/contract-test.py http://127.0.0.1:8040 [--bad-key URL] [--small-budget URL] [--log FILE]
"""
import asyncio, base64, json, pathlib, re, shutil, struct, subprocess, sys, time, urllib.error, urllib.parse, urllib.request, zlib
from concurrent.futures import ThreadPoolExecutor

import aiohttp, yaml

sys.stdout.reconfigure(line_buffering=True)
args = sys.argv[1:]
BASE = args[0].rstrip("/") if args and not args[0].startswith("--") else sys.exit(__doc__)
opt = lambda name: args[args.index(name) + 1].rstrip("/") if name in args else None
LOGS = [args[i + 1] for i, a in enumerate(args) if a == "--log"]
ORIGIN = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(BASE))
ANSWERS = pathlib.Path("site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = pathlib.Path(__file__).resolve().parent.parent / "site-setup" / "site-assistant.example.yaml"
site = yaml.safe_load(ANSWERS.read_text(encoding="utf-8"))
# The owner's own site, from the answers, so the test runs against any site: a page other than the home page, the
# suggested prompts as questions, and the words of the welcome line to listen for.
ROUTES = site.get("routes") or []
PAGE = next((r["path"].split("#")[0] for r in ROUTES if r["path"].split("#")[0] not in ("", "/")), "/")
PROMPTS = (site.get("prompts") or []) + ["What can you help me with?"] * 3
LONG = ("Please give me a long, detailed answer of at least five sentences: describe, one by one, everything you "
        "know about " + ", then ".join(r["label"] for r in ROUTES) + ".")
WELCOME_WORDS = set(re.findall(r"[a-z]{5,}", re.sub(r"\[[^\]]*\]", "", site["welcomeMessage"].lower())))
seen = []  # every status line, header and body the server sent, searched for the key at the end
results = []


def check(name, ok, detail):
    ok = bool(ok)
    results.append(ok)
    print(f"{'pass' if ok else 'FAIL'}  {name:<16} {detail}")


def note(text):
    print(f"note  {text}")


def http(method, path, body=None, headers=None, base=None, raw=None):
    """One request: (status, headers, body bytes). Sends this origin's Origin unless headers say otherwise."""
    h = {"Origin": ORIGIN, "User-Agent": "contract-test/1.0", **(headers or {})}
    h = {k: v for k, v in h.items() if v is not None}
    data = raw if raw is not None else None if body is None else json.dumps(body).encode()
    if data is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request((base or BASE) + path, data=data, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        resp = e
    out = resp.read()
    seen.append(f"{resp.status} {dict(resp.headers)} ".encode() + out)
    return resp.status, resp.headers, out


def error_code(answer):
    try:
        return json.loads(answer[2])["error"]["code"]
    except (ValueError, KeyError, TypeError):
        return None


def ask(text, chat_id=None, cancel=False, base=None, photo=None):
    """POSTs a question, with a photo if given, and reads the stream: (status, [(seconds, event, data)]). With
    cancel=True it calls /api/cancel at the first tool or sentence event: a reply can arrive in one burst, so later is
    often too late."""
    body = {"text": text, **({"chatId": chat_id} if chat_id else {}), **({"photo": photo} if photo else {})}
    req = urllib.request.Request((base or BASE) + "/api/chat", data=json.dumps(body).encode(), method="POST",
                                 headers={"Origin": ORIGIN, "Content-Type": "application/json"})
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        seen.append(e.read())
        return e.status, []
    got, event = [], None
    for raw in resp:
        seen.append(raw)
        line = raw.decode().rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data = json.loads(line[5:])
            got.append((time.time() - t0, event, data))
            if cancel and event in ("tool", "sentence") and not any(e == "(cancel)" for _, e, _ in got):
                got.append((time.time() - t0, "(cancel)", json.loads(http("POST", "/api/cancel", {"chatId": got[0][2]["chatId"]}, base=base)[2])))
    return resp.status, got


def shape(events):
    """The order of the events, repeats folded: chat, tool, sentence+, link*, done."""
    names = []
    for _, e, _ in events:
        if e == "(cancel)":
            continue
        if names and names[-1].rstrip("+") == e:
            names[-1] = e + "+"
        else:
            names.append(e)
    return ", ".join(names)


# ── Pages and settings ───────────────────────────────────────────────────────────────────────────────────────────
print(f"server:    {BASE}")
home, page, nope = http("GET", "/", headers={"Origin": None}), http("GET", PAGE, headers={"Origin": None}), \
    http("GET", "/nope", headers={"Origin": None})
check("pages", home[0] == page[0] == 200 and site["storeName"].encode() in home[2] and nope[0] == 404,
      f"/ and {PAGE} 200, /nope {nope[0]}; widget tag {'added' if b'/assistant/widget.js' in home[2] else 'absent (client not built)'}")

s = http("GET", "/api/site")
settings = json.loads(s[2]) if s[0] == 200 else {}
leaks = [w for w in ("alerts", "webhookUrl", "owner@example.com", "rzlb_") if w.encode() in s[2]]
check("site", s[0] == 200 and settings.get("title") == site["title"] and not leaks
      and settings["messages"]["budget_reached"] == site["budget"]["atLimitMessage"]
      and s[1].get("Access-Control-Allow-Origin") == ORIGIN,
      f"{settings.get('title')!r}, {len(settings.get('routes') or [])} routes, {len(settings.get('messages') or {})} messages, "
      f"limits {settings.get('limits')}, leaks {leaks or 'none'}")

# ── Who may call ─────────────────────────────────────────────────────────────────────────────────────────────────
evil = http("POST", "/api/chat", {"text": "hi"}, headers={"Origin": "https://evil.example"})
bare = http("GET", "/api/site", headers={"Origin": None})
ref = http("GET", "/api/site", headers={"Origin": None, "Referer": ORIGIN + PAGE})
check("origin", (evil[0], error_code(evil), bare[0], ref[0]) == (403, "not_allowed", 403, 200),
      f"other origin {evil[0]} {error_code(evil)}, no Origin or Referer {bare[0]}, Referer from this origin {ref[0]}")
pre = http("OPTIONS", "/api/chat", headers={"Access-Control-Request-Method": "POST"})
check("preflight", pre[0] == 204 and pre[1].get("Access-Control-Allow-Origin") == ORIGIN,
      f"OPTIONS {pre[0]}, Access-Control-Allow-Origin {pre[1].get('Access-Control-Allow-Origin') == ORIGIN}")

bad = [http("POST", "/api/chat", raw=b"not json"), http("POST", "/api/chat", {"text": "  "}),
       http("POST", "/api/chat", {"text": "hi", "extra": 1}), http("GET", "/api/listen")]
check("bad_request", all(a[0] == 400 and error_code(a) == "bad_request" for a in bad),
      "not JSON, blank text, an unknown field, /api/listen without a WebSocket: " + ", ".join(str(a[0]) for a in bad))
forged = http("POST", "/api/chat", {"text": "hi", "chatId": "3f2a1b9c-0000-4000-8000-000000000000.0123456789abcdef"})
unknown = http("GET", "/api/nope")
read_forged = http("GET", "/api/transcript?chatId=" + "3f2a1b9c-0000-4000-8000-000000000000.0123456789abcdef")
check("not_found", [(a[0], error_code(a)) for a in (forged, unknown, read_forged)] == [(404, "not_found")] * 3,
      f"a chat id this server didn't issue {forged[0]}, its transcript {read_forged[0]}, /api/nope {unknown[0]}")
long_q = http("POST", "/api/chat", {"text": "x" * (settings["limits"]["questionChars"] + 1)})
long_s = http("GET", "/api/speech?text=" + "y" * (settings["limits"]["speechChars"] + 1))
check("too_long", [(a[0], error_code(a)) for a in (long_q, long_s)] == [(413, "too_long")] * 2,
      f"question of {settings['limits']['questionChars'] + 1} characters {long_q[0]}, speech of "
      f"{settings['limits']['speechChars'] + 1} {long_s[0]}")

# ── Chat ─────────────────────────────────────────────────────────────────────────────────────────────────────────
Q1 = PROMPTS[0]
status, ev = ask(Q1)
names = [e for _, e, _ in ev]
said = [d for _, e, d in ev if e == "sentence"]
first = next((t for t, e, _ in ev if e == "sentence"), 0)
tool = next((t for t, e, _ in ev if e == "tool"), None)
check("chat stream", status == 200 and names[:1] == ["chat"] and names[-1:] == ["done"] and said
      and (tool is None or tool < first - 0.3)  # relayed as it happens: the look-up shows before the answer
      and [d["index"] for d in said] == list(range(len(said))) and ev[-1][2] == {"cancelled": False}
      and not any(m in d["text"] for d in said for m in ("**", "`", "\n")),
      f"{shape(ev)}; tool event ahead of the sentences, indexes from 0, no markdown, done {{cancelled: false}}")
note(f"tool at {tool or 0:.1f}s, first sentence at {first:.1f}s, done at {ev[-1][0]:.1f}s, {len(said)} sentences, links {[d['path'] for _, e, d in ev if e == 'link']}")
chat_id = ev[0][2]["chatId"] if ev else ""
status, ev2 = ask(PROMPTS[1], chat_id)
check("same chat", status == 200 and ev2 and ev2[0][2]["chatId"] == chat_id and ev2[-1][1] == "done",
      f"second question with the chat id: {shape(ev2)}, the same chat id back")

t = http("GET", "/api/transcript?chatId=" + urllib.parse.quote(chat_id))
turns = json.loads(t[2])["turns"] if t[0] == 200 else []
check("transcript", t[0] == 200 and [x["role"] for x in turns] == ["user", "assistant"] * 2 and turns[0]["text"] == Q1
      and all(not x["text"].lstrip().startswith("{") for x in turns),
      f"{[x['role'] for x in turns]}, the question as asked, no tool look-ups, links "
      f"{'as {path, label}' if any(x['link'] for x in turns) else 'none'}")

# ── Speech ───────────────────────────────────────────────────────────────────────────────────────────────────────
audio_ref = {"Origin": None, "Referer": ORIGIN + "/"}  # what an <audio> element sends
manifest = json.loads(pathlib.Path("out/clips/manifest.json").read_text()) if pathlib.Path("out/clips/manifest.json").exists() else {}
welcome = next((c for c in manifest.get("clips", []) if c["name"] == "welcome"), None)
c = http("GET", "/api/speech?text=" + urllib.parse.quote(site["welcomeMessage"]), headers=audio_ref)
if welcome:
    stored = (pathlib.Path("out/clips") / welcome["file"]).read_bytes()
    check("speech cached", c[0] == 200 and c[1].get("X-Clip") == "cached" and c[2] == stored
          and c[1].get("Content-Length") == str(len(stored)) and c[1].get("Content-Type") == "audio/mpeg",
          f"welcome line: X-Clip {c[1].get('X-Clip')}, the stored clip's bytes, Content-Length, {c[1].get('Cache-Control')}")
else:
    check("speech cached", c[0] == 200 and c[1].get("X-Clip") == "live", "no out/clips/manifest.json: spoken live")
line = said[0]["text"] if said else "We bake every morning."
t0 = time.time()
req = urllib.request.Request(BASE + "/api/speech?text=" + urllib.parse.quote(line), headers={"Referer": ORIGIN + "/"})
with urllib.request.urlopen(req, timeout=120) as r:
    head = r.read(1)
    ttfb = time.time() - t0
    live = head + r.read()
    seen.append(f"{r.status} {dict(r.headers)}".encode())
    check("speech live", r.status == 200 and r.headers.get("X-Clip") == "live" and r.headers.get("Content-Length") is None
          and r.headers.get("Content-Type") == "audio/mpeg" and (live[:3] == b"ID3" or live[:2] in (b"\xff\xfb", b"\xff\xf3")),
          f"first sentence: X-Clip live, audio/mpeg, no Content-Length, {r.headers.get('Cache-Control')}")
note(f"live clip: first byte {ttfb:.2f}s, {len(live)} bytes in {time.time() - t0:.2f}s")

# ── Cancel ───────────────────────────────────────────────────────────────────────────────────────────────────────
status, ev3 = ask(LONG, chat_id, cancel=True)
cancel_at = next((i for i, (_, e, _) in enumerate(ev3) if e == "(cancel)"), None)
after = [e for _, e, _ in ev3[cancel_at + 1:]] if cancel_at is not None else []
streamed = sum(e == "sentence" for _, e, _ in ev3)
check("cancel", cancel_at is not None and ev3[cancel_at][2] == {"cancelled": True} and set(after) <= {"tool", "sentence", "done"}
      and ev3[-1][1:] == ("done", {"cancelled": True}) and ev3[-1][0] - ev3[cancel_at][0] < 1,
      "while it answers: /api/cancel {cancelled: true}, then done {cancelled: true} within a second")
if cancel_at is not None:
    note(f"cancel answered at {ev3[cancel_at][0]:.1f}s, done at {ev3[-1][0]:.1f}s, "
         f"{after.count('sentence')} sentences already on their way, {streamed} streamed in all")
status, ev4 = ask(PROMPTS[2], chat_id)
again = http("POST", "/api/cancel", {"chatId": chat_id})
check("after cancel", status == 200 and ev4[-1][2] == {"cancelled": False} and json.loads(again[2]) == {"cancelled": False},
      f"the next question on the same chat waits for the cancelled reply, then {shape(ev4)}; cancel now {{cancelled: false}}")
if ev4:
    note(f"next answer: done at {ev4[-1][0]:.1f}s")
t = http("GET", "/api/transcript?chatId=" + urllib.parse.quote(chat_id))
cancelled_reply = json.loads(t[2])["turns"][5]["text"] if t[0] == 200 else ""
whole = len(re.findall(r"[.!?](?:\s|$)", cancelled_reply))  # sentence ends
check("finished anyway", t[0] == 200 and len(json.loads(t[2])["turns"]) == 8 and whole > streamed,
      "the cancelled reply is in the transcript in full, longer than what was streamed")
note(f"cancelled reply: {streamed} sentences streamed, about {whole} in the transcript")

# ── Photos ───────────────────────────────────────────────────────────────────────────────────────────────────────
def png(side, rgb):
    """A plain square as a PNG: the test ships no photos, and the search answers whatever the photo shows."""
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + bytes(rgb) * side for _ in range(side))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


square = "data:image/png;base64," + base64.b64encode(png(64, (150, 100, 60))).decode()
asked = 4  # questions so far this minute: the limit check below counts on it
if settings.get("photos"):
    status, ev6 = ask("", photo=square)
    asked += 1
    said6 = [d["text"] for _, e, d in ev6 if e == "sentence"]
    t = http("GET", "/api/transcript?chatId=" + urllib.parse.quote(ev6[0][2]["chatId"])) if ev6 else (0, {}, b"{}")
    turns6 = json.loads(t[2]).get("turns", [])
    check("photo", status == 200 and ev6[-1][1] == "done" and said6 and turns6[:1]
          and turns6[0].get("photo") is True and turns6[0]["text"] == "What is this?" and "[The visitor" not in t[2].decode(),
          f"a photo and no text: {shape(ev6)}; in the transcript as \"What is this?\" with photo: true, without the note")
    note(f"photo answer: {' '.join(said6)[:120]}")
    unreadable = http("POST", "/api/chat", {"text": "", "photo": "data:image/png;base64,bm90IGFuIGltYWdl"})
    asked += 1
    big = http("POST", "/api/chat", {"text": "", "photo": "data:image/png;base64," + "A" * 1_500_000})
    check("photo refused", [(a[0], error_code(a)) for a in (unreadable, big)] == [(400, "bad_request"), (413, "too_long")],
          "a photo that isn't an image: 400 bad_request; over 1,500,000 characters: 413 too_long")
else:
    off = http("POST", "/api/chat", {"text": "What is this?", "photo": square})
    check("photo refused", (off[0], error_code(off)) == (400, "bad_request"), "photos off: a photo gets 400 bad_request")


# ── Listen ───────────────────────────────────────────────────────────────────────────────────────────────────────
async def listen_checks():
    ws_url = BASE.replace("http", "ws", 1) + "/api/listen"
    pcm = b""
    if shutil.which("ffmpeg") and welcome:
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
                             input=c[2], capture_output=True, check=True).stdout + bytes(32000)  # and 1 s of silence
    async with aiohttp.ClientSession() as session:
        async def run(start, audio=b"", frame=3200, origin=ORIGIN, hold=None):
            """One session: (frames received, close code). `hold` keeps it open until the event is set."""
            got = []
            async with session.ws_connect(ws_url, headers={"Origin": origin}) as ws:
                await ws.send_str(json.dumps(start))
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    seen.append(msg.data.encode())
                    got.append(json.loads(msg.data))
                    if got[-1]["type"] == "ready":
                        if hold:
                            await hold.wait()
                            await ws.send_str(json.dumps({"type": "stop"}))
                            continue
                        for i in range(0, len(audio), frame):
                            await ws.send_bytes(audio[i:i + frame])
                        await ws.send_str(json.dumps({"type": "stop"}))
                return got, ws.close_code

        got, code = await run({"type": "start", "sampleRate": 16000}, pcm or bytes(32000))
        types = [g["type"] for g in got]
        finals = " ".join(g["text"] for g in got if g["type"] == "final")
        heard = any(w in finals.lower() for w in WELCOME_WORDS) if pcm else True
        check("listen", types[:1] == ["ready"] and types[-1:] == ["end"] and code == 1000 and heard,
              f"ready, partial/final, end, close {code}" + ("; the welcome clip heard as said" if pcm else "; silence only (no ffmpeg)"))
        note(f"heard: {finals!r}")

        got, code = await run({"type": "start", "sampleRate": 44100})
        check("listen error", [g.get("code") for g in got if g["type"] == "error"] == ["bad_request"] and code == 4000,
              f"a start frame Labs refuses: our code {[g.get('code') for g in got]}, Labs' close {code}")

        hold = asyncio.Event()
        first = asyncio.create_task(run({"type": "start", "sampleRate": 16000}, hold=hold))
        await asyncio.sleep(2)
        second, code2 = await run({"type": "start", "sampleRate": 16000})
        hold.set()
        await first
        check("listen twice", [g.get("code") for g in second] == ["slow_down"] and code2 == 1008,
              f"a second session while one is open: {[g.get('code') for g in second]}, close {code2}")

        async with session.ws_connect(ws_url, headers={"Origin": ORIGIN}) as ws:  # as the widget ends a silent turn
            await ws.send_str(json.dumps({"type": "start", "sampleRate": 16000}))
            await ws.receive()
            await ws.send_str(json.dumps({"type": "stop"}))
        got, code = await run({"type": "start", "sampleRate": 16000}, bytes(32000))
        check("listen again", [g["type"] for g in got][:1] == ["ready"] and code == 1000,
              f"a new session as soon as the last one's socket closed: {[g['type'] for g in got][:1]}, close {code}")

        got, code = await run({"type": "start", "sampleRate": 16000}, bytes(70_000), frame=70_000)
        check("listen frame", [g.get("code") for g in got if g["type"] == "error"] == ["too_long"] and code == 1009,
              f"a 70,000-byte frame: {[g.get('code') for g in got if g['type'] == 'error']}, close {code}")

        try:
            await session.ws_connect(ws_url, headers={"Origin": "https://evil.example"})
            status = 101
        except aiohttp.WSServerHandshakeError as e:
            status = e.status
        check("listen origin", status == 403, f"handshake from another origin: {status}")

asyncio.run(listen_checks())

# ── Limits ───────────────────────────────────────────────────────────────────────────────────────────────────────
per_minute = settings["limits"]["questionsPerMinute"]
limited = None
while asked < per_minute + 2 and not limited:
    st, ev5 = ask("Hi")
    if st == 429:
        limited = st
    else:
        asked += 1
r = http("POST", "/api/chat", {"text": "Hi"})
check("question limit", limited == 429 and asked == per_minute and error_code(r) == "slow_down"
      and r[1].get("Retry-After") and json.loads(r[2])["error"].get("retryAfter"),
      f"refused after {asked} questions in a minute: 429 slow_down with Retry-After and retryAfter")

with ThreadPoolExecutor(16) as pool:
    clips = list(pool.map(lambda n: http("GET", f"/api/speech?text=Thank+you+{n}.", headers=audio_ref), range(16)))
live_ok = sum(a[0] == 200 for a in clips)
live_before = 1 if welcome else 2  # the first sentence, and the welcome too when it has no clip
check("clip limit", live_ok + live_before == settings["limits"]["clipsPerMinute"] and all(error_code(a) == "slow_down" for a in clips if a[0] != 200),
      f"16 live clips at once after {live_before}: {live_ok} made, the rest 429 slow_down")
if welcome:
    cached_still = http("GET", "/api/speech?text=" + urllib.parse.quote(site["welcomeMessage"]), headers=audio_ref)
    check("cached is free", cached_still[0] == 200, f"a cached clip once the live limit is reached: {cached_still[0]}")
else:
    note("cached is free: not checked, there are no clips made in advance (out/clips/manifest.json)")

# ── Other instances ──────────────────────────────────────────────────────────────────────────────────────────────
if bad_key := opt("--bad-key"):
    a = http("POST", "/api/chat", {"text": "Hi"}, base=bad_key, headers={"Origin": "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(bad_key))})
    b = http("GET", "/api/speech?text=Hello.", base=bad_key, headers={"Origin": "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(bad_key))})
    check("labs refusal", [(x[0], error_code(x)) for x in (a, b)] == [(503, "unavailable")] * 2
          and b"401" not in a[2] + b[2] and b"api_key" not in a[2] + b[2],
          f"Labs answers 401: chat {a[0]} {error_code(a)}, speech {b[0]} {error_code(b)}; Labs' body not passed on")
if small := opt("--small-budget"):
    o = {"Origin": "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(small))}
    codes = []
    for _ in range(3):
        req = urllib.request.Request(small + "/api/chat", data=json.dumps({"text": "Hi"}).encode(), method="POST",
                                     headers={**o, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                r.read()
                codes.append(r.status)
        except urllib.error.HTTPError as e:
            body = e.read()
            seen.append(body)
            codes.append((e.status, json.loads(body)["error"]["code"], json.loads(body)["error"]["message"]))
    check("budget", codes[:2] == [200, 200] and codes[2][:2] == (402, "budget_reached") and codes[2][2] == site["budget"]["atLimitMessage"],
          f"perVisitorCredits 15: {codes[0]}, {codes[1]}, then {codes[2][0]} {codes[2][1]} with the owner's atLimitMessage")

# ── The key ──────────────────────────────────────────────────────────────────────────────────────────────────────
found = [i for i, s in enumerate(seen) if b"rzlb_live_sk" in s]
logs = {f: "rzlb_live_sk" in pathlib.Path(f).read_text(errors="replace") for f in LOGS}
check("no key", not found and not any(logs.values()),
      f"'rzlb_live_sk' in the answers: {len(found)}; in {len(logs)} server logs: {sum(logs.values())}")
note(f"searched {len(seen)} answers and stream lines")
print(f"result:    {sum(results)} of {len(results)} pass")
sys.exit(0 if all(results) else 1)
