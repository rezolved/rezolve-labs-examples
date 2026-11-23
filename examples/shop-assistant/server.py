"""shop-assistant · The shop page's server (Python).

Serves site/shop.html and the product photos, and is the page's only way to Labs: it holds the secret key and relays
four things. A shopper's message, answered as a stream of the agent's events (the reply as it is written, the whole
reply with its delivery cues for the voice, product cards, the basket); one line of the reply as speech in the
agent's voice; a short recording turned into text (push to talk); and the shop's name, welcome line and products for
the page.

The platform searches the catalogue on every turn, even "hi", and sends a card for every product the search found.
The server keeps only the cards the reply names (the instructions tell the agent that only those are shown), and
adds the product's picture from your catalogue, matched by name.

The stream leaves out the delivery cues the agent writes ("[warmly]"); the chat's transcript keeps them, so once the
reply is complete the server reads it back from there and sends it as `spoken`, for the voice. Input is capped and
only the page's own origin may call. For per-visitor limits and a credit budget, see
site-assistant/server-python/guard.py.

Settings: PORT (8050), HOST (127.0.0.1), SHOP_AGENT_ID (written by setup-shop).
Run, from examples/: uv run python shop-assistant/server.py      then open http://localhost:8050
"""
import csv, json, os, pathlib, re, sys, time

import aiohttp, yaml
from aiohttp import web

sys.stdout.reconfigure(line_buffering=True)
HERE = pathlib.Path(__file__).resolve().parent
ENV = next((d / ".env" for d in HERE.parents if (d / ".env").exists()), None)
for line in ENV.read_text().splitlines() if ENV else []:
    k, _, v = line.partition("=")
    if k.strip() and not k.lstrip().startswith("#"):
        os.environ.setdefault(k.strip(), v.strip())
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
AGENT = os.environ.get("SHOP_AGENT_ID") or sys.exit("Set SHOP_AGENT_ID: run shop-assistant/setup-shop.py first.")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
PORT, HOST = int(os.environ.get("PORT", "8050")), os.environ.get("HOST", "127.0.0.1")
PICTURES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_TEXT, MAX_SPEECH, MAX_AUDIO = 500, 600, 2_000_000  # characters, characters, bytes (about a minute of 16 kHz WAV)

if not (HERE / "shop.yaml").exists():
    sys.exit("Copy shop-assistant/shop.example.yaml to shop-assistant/shop.yaml and run setup-shop first.")
shop = yaml.safe_load((HERE / "shop.yaml").read_text(encoding="utf-8"))
CATALOGUE = HERE / shop["catalogue"]
products = list(csv.DictReader(CATALOGUE.open(encoding="utf-8-sig")))
by_name = {p["name"].casefold(): p for p in products}
voice = {"id": None, "read": 0.0}


async def labs(method, path, **kw):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. The caller
    reads (or streams) the body and releases the response."""
    headers = {"X-API-KEY": KEY, "User-Agent": UA, **kw.pop("headers", {})}
    resp = await http.request(method, API + path, headers=headers, **kw)
    line = f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
    if resp.status >= 400:
        line += " body=" + (await resp.text())[:300].replace("\n", " ")
    print(line)
    return resp


def refuse(status, code, message):
    return web.json_response({"error": code, "message": message}, status=status)


def same_origin(request):
    """Only the page this server serves may call the API (no Origin header: a same-origin GET, or curl)."""
    origin = request.headers.get("Origin")
    return origin is None or origin == f"{request.scheme}://{request.host}"


def product(name):
    """The catalogue row a card or basket line names (the platform sends names, not our ids), or None."""
    return by_name.get((name or "").strip().casefold())


def image(p, fallback=None):
    """A product's picture: its `image_url` if it is a web address, a file next to the catalogue (served under
    /catalogue/), or the platform's copy."""
    url = (p or {}).get("image_url") or ""
    return url if url.startswith(("https://", "http://")) else f"/catalogue/{url}" if url else fallback


def card(c):
    p = product(c.get("name")) or {}
    return {"id": p.get("id"), "name": c.get("name"), "price": p.get("price") or c.get("priceDisplay"),
            "description": c.get("description"), "colour": p.get("colour"), "sizes": p.get("sizes"),
            "image": image(p, c.get("imageUrl")), "actions": c.get("actionButtons") or []}


def basket(data):
    lines = [{"id": (product(i.get("name")) or {}).get("id"), "name": i.get("name"), "quantity": i.get("quantity", 1),
              "unitPrice": i.get("unitPrice"), "size": (i.get("payload") or {}).get("size"),
              "image": image(product(i.get("name")), (i.get("payload") or {}).get("imageUrl"))}
             for i in data.get("items") or []]
    total = sum(float(line["unitPrice"] or 0) * int(line["quantity"] or 1) for line in lines)
    return {"items": lines, "total": f"{total:.2f}", "canCheckout": data.get("canCheckout", False)}


async def site(request):
    return web.json_response({"storeName": shop["storeName"], "welcome": shop["welcome"],
                              "currencySymbol": shop["currencySymbol"],
                              "products": [{**{k: p.get(k) or "" for k in ("id", "name", "price", "category", "colour",
                                                                            "sizes")}, "image": image(p)} for p in products]})


async def chat(request):
    """POST {chatId?, text} -> text/event-stream: chat, tool, delta, spoken, cards, cart, error, done."""
    if not same_origin(request):
        return refuse(403, "origin", "This page may not use the shop assistant.")
    body = await request.json()
    text, chat_id = str(body.get("text") or "").strip(), body.get("chatId")
    if not text or len(text) > MAX_TEXT:
        return refuse(400, "bad_request", f"Send between 1 and {MAX_TEXT} characters.")
    if not chat_id:  # one chat per visit: the platform keeps its history and its basket
        resp = await labs("POST", "/developer-platform/chats", json={"agentId": AGENT})
        data = await resp.json()
        if resp.status != 201:
            return refuse(502, "unavailable", data.get("message") or "The assistant could not start.")
        chat_id = data["data"]["chatId"]
    upstream = await labs("POST", f"/developer-platform/chats/{chat_id}/messages", json={"text": text},
                          headers={"Accept": "text/event-stream"})
    if upstream.status == 409:  # one message at a time per chat
        upstream.release()
        return refuse(409, "busy", "Still answering the last message.")
    if upstream.status != 200:
        upstream.release()
        return refuse(502, "unavailable", "The assistant is not available right now.")

    out = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-store"})
    await out.prepare(request)

    async def send(event, data):
        await out.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())

    await send("chat", {"chatId": chat_id})
    event, reply = None, ""
    try:
        async for raw in upstream.content:  # SSE, line by line, relayed as it arrives
            line = raw.decode().rstrip("\r\n")
            if line.startswith("event:"):
                event = line[6:].strip()
                continue
            if not line.startswith("data:"):
                continue
            data = json.loads(line[5:].strip() or "{}")
            if event == "tool.started":
                await send("tool", {"name": data.get("name")})
            elif event == "message.delta":
                reply += data.get("text", "")
                await send("delta", {"text": data.get("text", "")})
            elif event == "message.completed":
                await send("spoken", {"text": await with_cues(chat_id, data.get("text") or reply)})
            elif event == "cards.ready":  # arrives after the whole reply
                named = [card(c) for c in data.get("cards") or [] if (c.get("name") or "").casefold() in reply.casefold()]
                if named:
                    await send("cards", {"cards": named})
            elif event == "cart.updated":
                await send("cart", basket(data))
            elif event == "error":
                await send("error", {"code": data.get("code"), "message": data.get("message")})
            elif event == "done":
                break
    except (aiohttp.ClientError, TimeoutError) as e:
        print(f"[chat] the stream was cut short: {type(e).__name__} {e}")
        await send("error", {"code": "unavailable", "message": "The answer was cut short."})
    finally:
        upstream.release()
    await send("done", {})
    return out


CUE = re.compile(r"\[[a-z][a-z ]{0,20}\]\s*", re.I)


async def with_cues(chat_id, text):
    """The reply as the agent wrote it, delivery cues included. The stream leaves the cues out; the chat's transcript
    keeps them, so the last reply is read back from it (free). Falls back to the streamed text."""
    resp = await labs("GET", f"/developer-platform/conversations/{chat_id}/transcript")
    if resp.status == 200:
        turns = (await resp.json())["data"]["turns"]
        last = next((t["text"] for t in reversed(turns) if t["role"] == "bot" and t.get("text")), "")
        if " ".join(CUE.sub("", last).split()) == " ".join(text.split()):
            return last
    else:
        resp.release()
    return text


def plain(text):
    """What a reply sounds like: no markdown markers, no links."""
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[*_`#>]+|^\s*[-•]\s+", "", text, flags=re.M)
    return re.sub(r"\s+", " ", text).strip()


async def agent_voice():
    """The agent's voice, read from the agent at most every 5 minutes."""
    if time.time() - voice["read"] > 300:
        resp = await labs("GET", f"/developer-platform/agents/{AGENT}")
        voice.update(id=(await resp.json())["data"]["voiceId"] if resp.status == 200 else None, read=time.time())
    return voice["id"]


async def speech(request):
    """GET ?text= -> audio/mpeg in the agent's voice, relayed as it arrives."""
    text = plain(request.query.get("text", ""))
    if not same_origin(request):
        return refuse(403, "origin", "This page may not use the shop assistant.")
    if not text or len(text) > MAX_SPEECH:
        return refuse(400, "bad_request", f"Send between 1 and {MAX_SPEECH} characters.")
    if not (voice_id := await agent_voice()):
        return refuse(503, "unavailable", "The agent has no voice.")
    upstream = await labs("POST", f"/voice-audio/voices/{voice_id}/speech",
                          json={"text": text, "outputFormat": "mp3_44100_64"})
    if upstream.status != 200:
        upstream.release()
        return refuse(502, "unavailable", "No speech right now.")
    out = web.StreamResponse(headers={"Content-Type": "audio/mpeg", "Cache-Control": "no-store"})
    await out.prepare(request)
    try:
        async for chunk in upstream.content.iter_any():
            await out.write(chunk)
    except (aiohttp.ClientError, ConnectionResetError) as e:
        print(f"[speech] cut short: {type(e).__name__}")
    finally:
        upstream.release()
    return out


async def listen(request):
    """POST audio/wav (push to talk) -> {"text"}: the recording, transcribed."""
    if not same_origin(request):
        return refuse(403, "origin", "This page may not use the shop assistant.")
    audio = await request.read()
    if not audio or len(audio) > MAX_AUDIO or audio[:4] != b"RIFF":
        return refuse(400, "bad_request", "Send one WAV recording of under a minute.")
    form = aiohttp.FormData()
    form.add_field("audio", audio, filename="speech.wav", content_type="audio/wav")
    resp = await labs("POST", "/transcription/voices/transcriptions", data=form)
    data = await resp.json()
    if resp.status != 200:
        return refuse(502, "unavailable", "Could not hear that.")
    return web.json_response({"text": (data["data"].get("text") or "").strip()})


async def picture(request):
    """A picture that sits next to your catalogue (image files only, never the catalogue itself)."""
    path = (CATALOGUE.parent / request.match_info["path"]).resolve()
    if not path.is_relative_to(CATALOGUE.parent.resolve()) or path.suffix.lower() not in PICTURES or not path.is_file():
        return refuse(404, "not_found", "No such picture.")
    return web.FileResponse(path)


async def page(request):
    return web.FileResponse(HERE / "site" / "shop.html")


async def session(app):
    global http
    http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=180))
    yield
    await http.close()


app = web.Application(client_max_size=MAX_AUDIO + 1024)
app.cleanup_ctx.append(session)
app.router.add_get("/api/shop", site)
app.router.add_post("/api/chat", chat)
app.router.add_get("/api/speech", speech)
app.router.add_post("/api/listen", listen)
app.router.add_get("/catalogue/{path:.+}", picture)
app.router.add_get("/", page)

if __name__ == "__main__":
    print(f"shop:      {shop['storeName']}, {len(products)} products, agent {AGENT}")
    web.run_app(app, host=HOST, port=PORT, print=lambda *_: print(f"open:      http://localhost:{PORT}"))
