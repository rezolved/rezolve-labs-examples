"""site-assistant · Your server (Python).

The browser's only way to Labs, as CONTRACT.md describes: a question answered as a stream of whole sentences, one
sentence as audio, cancel, live transcription and the transcript. It holds the secret key, checks the page's origin,
caps input, limits each visitor and the whole site, keeps to the owner's budget and turns Labs refusals into the
error codes the widget shows (see guard.py; the counts are kept in this process's memory). It also serves the sample
site with the built widget (client/dist/), so one URL shows the whole thing.

The owner's answers come from site-assistant.yaml (else site-setup/site-assistant.example.yaml). Clips made by
speech/speech-make-clips are served from out/clips/ when a line matches. Settings: PORT (8040), HOST (127.0.0.1),
ALLOWED_ORIGINS, TRUST_PROXY=1 behind a proxy, ALERT_WEBHOOK_URL, SITE_ANSWERS (another answers file).

Run, from examples/: uv run python site-assistant/server-python/server.py      then open http://localhost:8040
"""
import asyncio, functools, json, math, os, pathlib, re, sys, time

import aiohttp, yaml
from aiohttp import web

import guard, labs
from labs import (AGENT, FALLBACK, KEY, LIVE, PHOTO_INDEX, READ_MORE, UA, clip_key, correct, events, plain, respell, seal, sentences,
                  speech_body, unseal, verdict)

HERE = pathlib.Path(__file__).resolve().parent
ANSWERS = pathlib.Path(os.environ.get("SITE_ANSWERS") or "site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = HERE.parent.parent / "site-setup" / "site-assistant.example.yaml"
site = yaml.safe_load(ANSWERS.read_text(encoding="utf-8"))
# What the microphone's transcript is corrected for: the owner's spellings and hard words, and known sound-alikes.
HEARD = (site.get("vocabulary") or []) + [p["word"] for p in site.get("pronunciations") or []]
ALIKES = site.get("soundAlikes") or {}
SITE_DIR = pathlib.Path((site.get("knowledge") or {}).get("source") or "site-setup/sample-site")
CLIENT = HERE.parent / "client" / "dist"
CLIPS = pathlib.Path("out/clips")
HOST = os.environ.get("HOST") or "127.0.0.1"
QUESTION_CHARS, SPEECH_CHARS, LISTEN_SECONDS, FRAME_BYTES = 500, 300, 60, 64 * 1024
PHOTO_CHARS = 1_500_000  # a photo as a data: URL; the widget sends one at most 1,024 pixels across, about 200 KB
PHOTO_NOTE = "[The visitor sent a photo."  # how the note the server adds to a message with a photo starts
PHOTO_MIN = (site.get("catalogue") or {}).get("photoMinScore")  # None: the photo model's own floor
LIVE_PATH = "/transcription/voices/transcriptions/live"
dumps = functools.partial(json.dumps, ensure_ascii=False, separators=(",", ":"))  # the same bytes as JSON.stringify

rates, money = site.get("rateLimits") or {}, site.get("budget") or {}
limits = guard.Limits(
    per_visitor={"question": rates.get("questionsPerMinute", 6), "clip": rates.get("clipsPerMinute", 12),
                 "listen": rates.get("questionsPerMinute", 6), "read": 30},
    per_site={"question": 40, "clip": 100, "listen": 20, "read": 30})  # the whole site: at most 230 Labs calls a
# minute (a question can take two), under the account's own limit, which `GET /api-keys/verify` shows (240 on Pro)
budget = guard.Budget(money.get("monthlyCredits", 50000), money.get("perVisitorCredits", 300))
guard.alert_to.update(site.get("alerts") or {})

STATUS = {"bad_request": 400, "not_allowed": 403, "not_found": 404, "too_long": 413, "slow_down": 429,
          "budget_reached": 402, "unavailable": 503}
MESSAGES = {
    "bad_request": "Sorry, I couldn't read that. Please try again.",
    "not_allowed": "The assistant isn't available on this page.",
    "not_found": "That conversation has ended. Ask again to start a new one.",
    "too_long": "That's a bit long for me. Please ask in fewer words.",
    "slow_down": "One moment, please. Try again in a few seconds.",
    "budget_reached": money.get("atLimitMessage") or "The assistant has reached its limit for now.",
    "unavailable": "The assistant can't answer right now. Please try again later, or use the contact page.",
}


def message(code):
    return {"code": code, "message": MESSAGES[code]}


class Refused(Exception):
    """A refusal in the contract's shape: raised anywhere, answered by the api() middleware."""

    def __init__(self, code, retry_after=None):
        super().__init__(code)
        self.code, self.retry_after = code, retry_after


def refusal(code, retry_after=None):
    body, headers = message(code), {}
    if retry_after:
        body["retryAfter"], headers["Retry-After"] = retry_after, str(retry_after)
    return web.json_response({"error": body}, status=STATUS[code], headers=headers, dumps=dumps)


async def labs_refused(resp):
    """Raises the visitor's code for a Labs refusal, and alerts the owner when a person has to act."""
    code, note = verdict(resp.status, await resp.read())
    if note:
        guard.alert(f"labs {resp.status}", note)
    raise Refused(code, int(resp.headers.get("Retry-After") or 5) if code == "slow_down" else None)


async def call(who, method, path, body=None):
    """labs(), with what the call cost counted against the visitor's and the site's budget."""
    resp = await labs.labs(method, path, body)
    budget.spend(who, int(resp.headers.get("X-Credits-Charged") or 0))
    return resp


@web.middleware
async def api(request, handler):
    """Every /api/ request: the origin check, refusals in the contract's shape, and one log line."""
    if not request.path.startswith("/api/"):
        return await handler(request)
    who, code = guard.visitor(request), "-"
    try:
        if not guard.allowed_origin(request.headers):
            raise Refused("not_allowed")
        if request.method == "OPTIONS":  # a page on another allowed origin asks before it POSTs JSON
            resp = web.Response(status=204, headers={"Access-Control-Allow-Methods": "GET, POST",
                                                     "Access-Control-Allow-Headers": "Content-Type"})
        else:
            resp = await handler(request)
    except Refused as e:
        code, resp = e.code, refusal(e.code, e.retry_after)
    except Exception as e:  # Labs could not be reached, stopped answering, or answered something unexpected
        print(f"[error] {type(e).__name__} {e}")
        code, resp = "unavailable", refusal("unavailable")
    print(f"[api] {request.method} {request.path} -> {resp.status} {code} visitor={who}")
    return resp


async def cors(request, response):
    """Lets an allowed origin read the answer, for a widget on another origin than this server."""
    if request.path.startswith("/api/") and (origin := guard.allowed_origin(request.headers)):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"


async def json_of(request, fields):
    try:
        body = await request.json()
    except web.HTTPRequestEntityTooLarge:
        raise Refused("too_long")
    except (ValueError, UnicodeDecodeError):
        raise Refused("bad_request")
    if not isinstance(body, dict) or set(body) - set(fields):
        raise Refused("bad_request")
    return body


# ── The owner's settings ─────────────────────────────────────────────────────────────────────────────────────────

PUBLIC = ["name", "title", "storeName", "welcomeMessage", "welcome", "acknowledgements", "prompts", "routes",
          "contact", "mode", "bargeIn", "placement", "theme", "followUp", "navigation", "retention"]


async def site_settings(request):
    """The public part of the answers. Never the whole file: `alerts` holds addresses and maybe a webhook secret."""
    return web.json_response({
        **{k: site.get(k) for k in PUBLIC},
        "limits": {"questionChars": QUESTION_CHARS, "speechChars": SPEECH_CHARS, "listenSeconds": LISTEN_SECONDS,
                   "questionsPerMinute": limits.per_visitor["question"], "clipsPerMinute": limits.per_visitor["clip"]},
        "listen": {"encoding": "pcm_s16le", "sampleRates": [8000, 16000]},
        "messages": MESSAGES,
        "photos": bool(PHOTO_INDEX),
    }, dumps=dumps)


def route_for(path):
    """The owner's route a `Read more:` path names, or None: only pages the owner listed are offered."""
    base, _, anchor = path.partition("#")
    base = base.rstrip("/") or "/"
    for r in site.get("routes") or []:
        if "#" in r["path"] and r["path"] == f"{base}#{anchor}":  # a section of a page: "/#finding-us"
            return {"path": r["path"], "label": r["label"]}
        if r["path"] == base and (not anchor or r.get("anchorsAllowed")):
            return {"path": path if anchor else base, "label": r["label"]}
    print(f"[chat] dropped a link to {path}: not one of the owner's routes")
    return None


def tidy(sentence):
    """One sentence of a reply as the browser gets it: ("link", {path, label}), ("sentence", text) or None."""
    if m := READ_MORE.match(sentence):
        link = route_for(m.group(1))
        return ("link", link) if link else None
    text = plain(sentence)
    if not text:
        return None
    return "sentence", text if text[-1] in ".!?…:;," else text + "."  # a list item has no full stop of its own


# ── Chat: a question, answered as a stream of whole sentences ────────────────────────────────────────────────────

class Turn:
    """One answer being read from Labs. The reader puts the browser's events on `out`; cancel() ends the browser's
    stream at once, while the reader carries on to the end of the reply (Labs has no cancel)."""

    def __init__(self):
        self.out, self.cancelled, self.finished = asyncio.Queue(), asyncio.Event(), asyncio.Event()

    def cancel(self):
        self.cancelled.set()
        self.out.put_nowait(None)  # wakes the browser's stream


turns = {}  # Labs chat id -> the Turn running on it: one answer at a time per chat


async def chat(request):
    body = await json_of(request, ["text", "chatId", "photo"])
    text, photo, chat_id = body.get("text", ""), body.get("photo"), None
    if not isinstance(text, str) or not (text.strip() or photo):
        raise Refused("bad_request")
    if photo is not None and not (PHOTO_INDEX and isinstance(photo, str) and photo.startswith("data:image/")):
        raise Refused("bad_request")
    if len(text) > QUESTION_CHARS or len(photo or "") > PHOTO_CHARS:
        raise Refused("too_long")
    if body.get("chatId") and not (chat_id := unseal(body["chatId"])):
        raise Refused("not_found")
    who = guard.visitor(request)
    if wait := limits.take("question", who):
        raise Refused("slow_down", wait)
    if not budget.allows(who):
        raise Refused("budget_reached")
    if photo:
        text = f"{text.strip() or 'What is this?'}\n\n{await looks_like(who, photo)}"
    turn = Turn()
    if chat_id:
        while running := turns.get(chat_id):  # the last answer on this chat is still being written
            try:
                await asyncio.wait_for(running.finished.wait(), 30)
            except TimeoutError:
                raise Refused("slow_down", 5)
        turns[chat_id] = turn
    try:
        new_id, upstream = await ask(who, chat_id, text.strip())
    except BaseException:
        turns.pop(chat_id, None)
        turn.finished.set()  # a question waiting for this chat may go ahead
        raise
    turns.pop(chat_id, None)
    turns[new_id] = turn
    asyncio.create_task(read_answer(turn, new_id, upstream))
    return await stream(request, turn, new_id)


async def looks_like(who, photo):
    """The note added to a message with a photo: the catalogue's products that look most like it, closest first."""
    query = {"imageBase64": photo, "limit": 3, **({"minScore": PHOTO_MIN} if PHOTO_MIN is not None else {})}
    resp = await call(who, "POST", f"/product-discovery/visual-search/indexes/{PHOTO_INDEX}/search", query)
    if resp.status in (413, 422):  # too big, or not an image that can be read
        raise Refused("too_long" if resp.status == 413 else "bad_request")
    if resp.status != 200:
        await labs_refused(resp)
    names = [m["data"]["title"] for m in (await resp.json())["data"]["results"]]
    if not names:
        return f"{PHOTO_NOTE} Nothing in the catalogue looks like it.]"
    return f"{PHOTO_NOTE} The catalogue's products that look most like it, closest first: {', '.join(names)}.]"


async def ask(who, chat_id, text):
    """Sends the question, opening a chat first if there is none, or a new one if Labs says this one is gone or
    full. Returns (chat id, the answer stream, unread)."""
    for attempt in range(3):
        if not chat_id:
            resp = await call(who, "POST", "/developer-platform/chats", {"agentId": AGENT})
            if resp.status != 201:
                await labs_refused(resp)
            chat_id = (await resp.json())["data"]["chatId"]
        resp = await call(who, "POST", f"/developer-platform/chats/{chat_id}/messages", {"text": text})
        if resp.status == 200:
            return chat_id, resp
        body = await resp.read()
        if resp.status == 404 or b"CHAT_CONTEXT_FULL" in body:  # gone, or too long to continue: only a new chat helps
            chat_id = None
        elif resp.status >= 500 and attempt == 0 and b"upstream_edge_block" not in body:
            await asyncio.sleep(1)  # brief, and never charged: try once more
        else:
            break
    await labs_refused(resp)


async def read_answer(turn, chat_id, upstream):
    """Reads one answer from Labs to its end and puts the browser's events on turn.out."""
    put, pending, index, failed = turn.out.put_nowait, "", 0, False

    def release(sentence):
        nonlocal index, failed
        if failed or not (item := tidy(sentence)):
            return
        if index == 0 and item[0] == "sentence" and item[1].startswith(FALLBACK):  # the fallback is a failure
            failed = True
            return put(("error", message("unavailable")))
        if item[0] == "link":
            return put(item)
        put(("sentence", {"index": index, "text": item[1]}))
        index += 1

    try:
        async for event, data in events(upstream):
            if event == "tool.started":
                put(("tool", {"name": data.get("name")}))
            elif event == "message.delta":
                ready, pending = sentences(pending + data.get("text", ""))
                for s in ready:
                    release(s)
            elif event == "error" and not failed:
                print(f"[chat] the turn failed part-way: {data}")
                failed = True
                put(("error", message("unavailable")))
        for s in sentences(pending, final=True)[0]:  # the stream ended: whatever is left is the last sentence
            release(s)
    except (aiohttp.ClientError, TimeoutError, ValueError) as e:
        print(f"[chat] the answer stream broke: {type(e).__name__} {e}")
        if not failed:
            put(("error", message("unavailable")))
    finally:
        upstream.release()
        put(("done", {"cancelled": False}))
        turn.finished.set()
        if turns.get(chat_id) is turn:
            del turns[chat_id]
        if turn.cancelled.is_set():
            print(f"[chat] a cancelled answer was read to its end: {index} sentences, charged in full")


async def stream(request, turn, chat_id):
    """The browser's side of the answer: each event written as soon as it is ready, never held back."""
    resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                                       "X-Accel-Buffering": "no"})  # tells a proxy in front not to buffer it
    await resp.prepare(request)
    event, data = "chat", {"chatId": seal(chat_id)}
    while True:
        try:
            if request.transport is None or request.transport.is_closing():
                raise ConnectionResetError
            await resp.write(f"event: {event}\ndata: {dumps(data)}\n\n".encode())
        except ConnectionResetError:  # the browser closed the stream: the same as cancel
            turn.cancel()
            return resp
        if event == "done":
            return resp
        item = await turn.out.get()
        event, data = ("done", {"cancelled": True}) if turn.cancelled.is_set() else item


async def cancel(request):
    chat_id = unseal((await json_of(request, ["chatId"])).get("chatId") or "")
    if not chat_id:
        raise Refused("not_found")
    turn = turns.get(chat_id)
    if not turn or turn.cancelled.is_set():
        return web.json_response({"cancelled": False}, dumps=dumps)
    turn.cancel()
    print("[chat] cancel: the stream to the browser ends now; Labs still finishes the reply and charges it")
    return web.json_response({"cancelled": True}, dumps=dumps)


# ── Speech: one sentence as audio ────────────────────────────────────────────────────────────────────────────────

voice = {"id": None, "read": 0.0}


async def agent_voice(who):
    """The agent's voice, read from the agent at most every 5 minutes, so a new voice is used without a restart."""
    if time.time() - voice["read"] > 300:
        resp = await call(who, "GET", f"/developer-platform/agents/{AGENT}")
        if resp.status != 200:
            await labs_refused(resp)
        voice.update(id=(await resp.json())["data"]["voiceId"], read=time.time())
    if not voice["id"]:
        guard.alert("no voice", "the agent has no voice: give it one (site-setup/setup-02)")
        raise Refused("unavailable")
    return voice["id"]


manifest = {"mtime": None, "files": {}}


def cached_clip(voice_id, body):
    """The stored clip for exactly this request, if speech/speech-make-clips made one (out/clips/manifest.json)."""
    try:
        mtime = (CLIPS / "manifest.json").stat().st_mtime
    except FileNotFoundError:
        return None
    if mtime != manifest["mtime"]:  # re-read after each run of speech-make-clips
        clips = json.loads((CLIPS / "manifest.json").read_text(encoding="utf-8")).get("clips", [])
        manifest.update(mtime=mtime, files={c["key"]: CLIPS / c["file"] for c in clips})
    path = manifest["files"].get(clip_key(voice_id, body))
    return path if path and path.is_file() else None


async def speech(request):
    text = request.query.get("text", "")
    if len(text) > SPEECH_CHARS:
        raise Refused("too_long")
    if not (spoken := plain(text)):
        raise Refused("bad_request")
    who = guard.visitor(request)
    voice_id = await agent_voice(who)
    body = speech_body(respell(spoken, site.get("pronunciations") or []))
    if clip := cached_clip(voice_id, body):
        return web.FileResponse(clip, headers={"X-Clip": "cached", "Cache-Control": "public, max-age=86400"})
    if wait := limits.take("clip", who):
        raise Refused("slow_down", wait)
    if not budget.allows(who):
        raise Refused("budget_reached")
    for attempt in range(2):
        upstream = await call(who, "POST", f"/voice-audio/voices/{voice_id}/speech", body)
        if upstream.status == 200:
            break
        if upstream.status < 500 or attempt or b"upstream_edge_block" in await upstream.read():
            await labs_refused(upstream)
        await asyncio.sleep(1)  # brief, and never charged: try once more
    resp = web.StreamResponse(headers={"Content-Type": upstream.headers.get("Content-Type", "audio/mpeg"),
                                       "X-Clip": "live", "Cache-Control": "no-store"})
    await resp.prepare(request)
    try:
        async for chunk in upstream.content.iter_any():  # relayed as it arrives: playback starts on the first bytes
            await resp.write(chunk)
    except ConnectionResetError:
        print("[speech] the browser dropped the clip part-way; it is charged in full")
    except (aiohttp.ClientError, TimeoutError) as e:
        print(f"[speech] the audio was cut short: {type(e).__name__} {e}")
    finally:
        upstream.release()
    return resp


# ── Listen: live transcription, relayed ──────────────────────────────────────────────────────────────────────────

listening = {}  # visitor -> their open session: one each


def release(who, browser):
    """Frees the visitor for their next session, unless a newer session already holds it."""
    if listening.get(who) is browser:
        del listening[who]
LISTEN_ERRORS = {"bad_start": "bad_request"}  # Labs' error codes on the socket -> ours; any other is "unavailable"


def closable(code):
    return code if code and code not in (1005, 1006) else 1000  # "no code" can't be sent in a close frame


async def listen(request):
    """A WebSocket the browser can open without a key: the server opens Labs' with the key and relays both ways."""
    if request.headers.get("Upgrade", "").lower() != "websocket":
        raise Refused("bad_request")  # only as a WebSocket
    who = guard.visitor(request)
    browser = web.WebSocketResponse(max_msg_size=1 << 20)
    await browser.prepare(request)
    refused = None
    if who in listening:
        refused = "slow_down"
    elif limits.take("listen", who):
        refused = "slow_down"
    elif not budget.allows(who):
        refused = "budget_reached"
    if refused:
        await browser.send_json({"type": "error", **message(refused)})
        await browser.close(code=1008)
        return browser
    listening[who] = browser
    try:
        await relay(browser, who)
    finally:
        release(who, browser)
    return browser


async def relay(browser, who):
    try:
        upstream = await labs.http.ws_connect(LIVE, headers={"X-API-KEY": KEY, "User-Agent": UA}, max_msg_size=1 << 20)
    except aiohttp.WSServerHandshakeError as e:
        print(f"[labs] GET {LIVE_PATH} -> {e.status} credits={(e.headers or {}).get('X-Credits-Charged', '-')}")
        code, note = verdict(e.status, b"")
        if note:
            guard.alert(f"labs {e.status}", note)
        await browser.send_json({"type": "error", **message(code)})
        return await browser.close(code=1011)
    except (aiohttp.ClientError, TimeoutError) as e:
        print(f"[labs] GET {LIVE_PATH} -> failed: {type(e).__name__} {e}")
        await browser.send_json({"type": "error", **message("unavailable")})
        return await browser.close(code=1011)
    print(f"[labs] GET {LIVE_PATH} -> 101 credits=-")
    state = {"rate": 16000, "audio": 0, "stopped": False}

    async def up():  # browser -> Labs
        async for msg in browser:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    frame = json.loads(msg.data)
                except ValueError:
                    frame = {}
                if frame.get("type") == "start" and frame.get("sampleRate") in (8000, 16000):
                    state["rate"] = frame["sampleRate"]
                if frame.get("type") == "stop":
                    if state["stopped"]:
                        continue  # the server already stopped the session at the cap
                    state["stopped"] = True
                await upstream.send_str(msg.data)
            elif msg.type == aiohttp.WSMsgType.BINARY:
                if len(msg.data) > FRAME_BYTES:
                    await browser.send_json({"type": "error", **message("too_long")})
                    return await browser.close(code=1009)
                if state["stopped"]:
                    continue
                state["audio"] += len(msg.data)
                await upstream.send_bytes(msg.data)
                if state["audio"] >= LISTEN_SECONDS * state["rate"] * 2:  # the cap: stop as if the browser had
                    state["stopped"] = True
                    await upstream.send_str(json.dumps({"type": "stop"}))

    async def down():  # Labs -> browser
        async for msg in upstream:
            if msg.type == aiohttp.WSMsgType.TEXT:
                frame = json.loads(msg.data)
                if frame.get("type") == "error":  # Labs' own wording stays here; the browser gets ours
                    print(f"[listen] Labs refused: {frame.get('code')} {frame.get('message')}")
                    await browser.send_json({"type": "error", **message(LISTEN_ERRORS.get(frame.get("code"), "unavailable"))})
                elif frame.get("text"):  # partial and final: the owner's spellings back before the visitor sees them
                    await browser.send_json({**frame, "text": correct(frame["text"], HEARD, ALIKES)})
                else:
                    await browser.send_str(msg.data)

    tasks = {asyncio.create_task(up()), asyncio.create_task(down())}
    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)  # whichever side ends first
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    release(who, browser)  # free at once: the widget listens again as soon as either side has ended
    if upstream.closed:
        await browser.close(code=closable(upstream.close_code))
    else:
        await upstream.close(code=closable(browser.close_code))
    seconds = state["audio"] / (state["rate"] * 2)
    credits = math.ceil(seconds * 5 / 60) if state["audio"] else 0  # 5 credits a minute of audio, rounded up
    budget.spend(who, credits)
    print(f"[labs] closed {LIVE_PATH} {upstream.close_code} credits≈{credits}"
          f" ({seconds:.1f} s of audio at 5 a minute: the socket sends no credit header)")


# ── Transcript ───────────────────────────────────────────────────────────────────────────────────────────────────

async def transcript(request):
    chat_id = unseal(request.query.get("chatId", ""))
    if not chat_id:
        raise Refused("not_found")
    who = guard.visitor(request)
    if wait := limits.take("read", who):
        raise Refused("slow_down", wait)
    resp = await call(who, "GET", f"/developer-platform/chats/{chat_id}/messages")
    if resp.status == 404:
        raise Refused("not_found")
    if resp.status != 200:
        await labs_refused(resp)
    out = []
    for t in (await resp.json())["data"]["turns"]:
        if t.get("role") == "user" and t.get("text", "").startswith("(On screen now"):
            continue  # a note Labs adds after a search, not something the visitor said
        if t.get("role") == "user" and t.get("text"):
            text, _, note = t["text"].partition(f"\n\n{PHOTO_NOTE}")
            out.append({"role": "user", "text": text, "link": None, **({"photo": True} if note else {})})
        elif t.get("role") == "bot" and t.get("text"):  # a bot turn with no text is a tool call: left out
            items = [i for i in map(tidy, sentences(t["text"], final=True)[0]) if i]
            out.append({"role": "assistant", "text": " ".join(v for k, v in items if k == "sentence"),
                        "link": next((v for k, v in items if k == "link"), None)})
    return web.json_response({"chatId": seal(chat_id), "turns": out}, dumps=dumps)


async def unknown(request):
    raise Refused("not_found")


# ── The sample site and the built widget ─────────────────────────────────────────────────────────────────────────

async def page(request):
    """A page of the sample site (/breads is breads.html), with the widget's tags added before </body>."""
    name = request.match_info["page"].strip("/").removesuffix(".html") or "index"
    path = SITE_DIR / f"{name}.html"
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not path.is_file():
        return web.Response(status=404, text="Not found")
    html = path.read_text(encoding="utf-8")
    if (CLIENT / "widget.js").is_file():
        tags = '<link rel="stylesheet" href="/assistant/widget.css">\n' if (CLIENT / "widget.css").is_file() else ""
        html = html.replace("</body>", tags + '<script type="module" src="/assistant/widget.js"></script>\n</body>', 1)
    return web.Response(text=html, content_type="text/html")


async def client_file(request):
    path = (CLIENT / request.match_info["path"]).resolve()
    if not path.is_relative_to(CLIENT.resolve()) or not path.is_file():
        return web.Response(status=404, text="Not found")
    return web.FileResponse(path)


async def session(app):
    labs.open_session()
    yield
    await labs.http.close()


def main():
    if not SITE_DIR.is_dir():
        sys.exit(f"No {SITE_DIR}/ here: run the server from examples/.")
    app = web.Application(middlewares=[api], client_max_size=PHOTO_CHARS + 64 * 1024)
    app.cleanup_ctx.append(session)
    app.on_response_prepare.append(cors)
    app.router.add_get("/api/site", site_settings)
    app.router.add_post("/api/chat", chat)
    app.router.add_post("/api/cancel", cancel)
    app.router.add_get("/api/speech", speech)
    app.router.add_get("/api/listen", listen)
    app.router.add_get("/api/transcript", transcript)
    app.router.add_route("*", "/api/{tail:.*}", unknown)
    app.router.add_get("/assistant/{path:.+}", client_file)
    app.router.add_get("/{page:.*}", page)
    clips = len(json.loads((CLIPS / "manifest.json").read_text())["clips"]) if (CLIPS / "manifest.json").is_file() else 0
    print(f"answers:   {os.path.relpath(ANSWERS)}")
    print(f"site:      {SITE_DIR}/, widget {'client/dist/widget.js' if (CLIENT / 'widget.js').is_file() else 'not built yet (site-assistant/client)'}")
    print(f"clips:     {clips} in out/clips/ (speech/speech-make-clips makes them)")
    print(f"origins:   {', '.join(sorted(guard.ORIGINS))}")
    print(f"limits:    {limits.per_visitor['question']} questions and {limits.per_visitor['clip']} clips a minute per visitor, "
          f"{limits.per_site['question']} and {limits.per_site['clip']} for the site (in this process's memory)")
    print(f"budget:    {budget.monthly} credits a month, {budget.per_visitor} a day per visitor")
    print(f"photos:    {f'searched in {PHOTO_INDEX}' if PHOTO_INDEX else 'off (site-setup/setup-07-photos turns them on)'}")
    print(f"open:      http://localhost:{guard.PORT}")
    web.run_app(app, host=HOST, port=guard.PORT, print=None, access_log=None)


if __name__ == "__main__":
    main()
