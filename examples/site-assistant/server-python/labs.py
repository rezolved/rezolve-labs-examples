"""The Labs side of the server: the key, one logged call, the chat stream, the text tools, and what a Labs refusal
means for the visitor. server.py uses these; nothing here talks to the browser."""
import hashlib, hmac, json, os, pathlib, re, sys, unicodedata

import aiohttp

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
PHOTO_INDEX = os.environ.get("LABS_PHOTO_INDEX")  # site-setup/setup-07-photos makes it; without it, no photos in the chat
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
LIVE = API.replace("https://", "wss://", 1) + "/transcription/voices/transcriptions/live"
FALLBACK = "Sorry, I couldn't put a reply together"  # how the platform's fallback sentence starts

http: aiohttp.ClientSession  # opened by server.py when it starts


def open_session():
    global http
    http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=90))
    return http


async def labs(method, path, body=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors.
    The answer comes back unread, so a stream can be relayed as it arrives. Release it when done."""
    resp = await http.request(method, API + path, json=body,
                              headers={"X-API-KEY": KEY, "User-Agent": UA})
    preview = ""
    if resp.status >= 400:
        preview = " body=" + (await resp.text(errors="replace"))[:300].replace("\n", " ")
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}{preview}")
    return resp


async def events(resp):
    """Yields (event, data) from a text/event-stream answer, one event at a time."""
    event = None
    async for raw in resp.content:
        line = raw.decode().rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            yield event, json.loads(line[5:])


def verdict(status, body):
    """What a Labs refusal means for the visitor: (our error code, a note for the owner or None).
    The same cases as getting-started/05; a note means a person has to act, so the server alerts the owner."""
    try:
        err = json.loads(body or b"{}")
    except ValueError:
        err = {}
    code = err.get("code") or next((e.get("code") for e in err.get("errors") or []), "-")
    if status == 401:
        return "unavailable", "bad key: check LABS_API_KEY"
    if status == 402:
        return "budget_reached", f"the account can't pay for this call ({code}): top up or change the plan"
    if status == 403:
        return "unavailable", f"refused ({code}): {err.get('detail', '')}"
    if status == 404:
        return "unavailable", "not found: check LABS_AGENT_ID and the agent's voice"
    if status == 425:
        return "unavailable", "the knowledge base is still indexing: wait until its documents are ready"
    if status in (409, 429):
        return "slow_down", None
    if code == "upstream_edge_block":
        return "unavailable", "edge block: send an explicit User-Agent"
    if status >= 500:
        return "unavailable", None  # brief: never charged, the next try usually works
    return "bad_request", None


# Chat ids go to the browser sealed: the id plus a signature only this server can make. The key can read every chat
# in the workspace, so the server reads back or continues only chats it opened itself.
SEAL = hmac.new(KEY.encode(), b"site-assistant chat ids", hashlib.sha256).digest()  # derived from the key, never sent


def seal(chat_id):
    return chat_id + "." + hmac.new(SEAL, chat_id.encode(), hashlib.sha256).hexdigest()[:32]


def unseal(token):
    """The Labs chat id inside a sealed id, or None if this server didn't issue it."""
    chat_id = str(token).rpartition(".")[0]
    return chat_id if chat_id and hmac.compare_digest(seal(chat_id), str(token)) else None


MARKER = re.compile(r"(^|\n)[ \t]*(?:[-*+•]|\d+[.)]|#{1,6})[ \t]+")  # list and heading markers at a line start
DONE = re.compile(r"[\s\S]*(?:[.!?…]\s|\n)")  # everything up to the last sentence end or line break
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")  # [label](address)
READ_MORE = re.compile(r"Read more:\s*(/\S*?)[.!?]?$")  # the agent's last line names the page it used


def sentences(pending, final=False):
    """Splits off the whole sentences in `pending`. Returns (sentences, what is left over)."""
    pending = MARKER.sub(r"\1", pending)
    cut = len(pending) if final else (m.end() if (m := DONE.match(pending)) else 0)
    ready = re.sub(r"\*\*|__|`", "", pending[:cut])  # bold and code marks
    return [s.strip() for s in re.split(r"(?<=[.!?…])\s+|\n+", ready) if s.strip()], pending[cut:]


def plain(text):
    """Text without markdown, for speech: list and heading markers, bold, code marks and link syntax removed."""
    return re.sub(r"\*\*|__|`", "", LINK.sub(r"\1", MARKER.sub(r"\1", text))).strip()


def respell(text, pronunciations):
    """The text to send to speech: each `word` replaced by its `sayAs`, as a whole word in any case."""
    for p in sorted(pronunciations, key=lambda p: -len(p["word"])):
        text = re.sub(rf"(?<!\w){re.escape(p['word'])}(?!\w)", lambda _, say=p["sayAs"]: say, text, flags=re.IGNORECASE)
    return text


# correct() is copied from speech/speech-sound-alikes.py.
def correct(text, words, alikes):
    """The transcript with each word spelled as the owner spells it, matched as whole words in any case."""
    for word in sorted(words, key=len, reverse=True):
        forms = [r"[\s-]?".join(map(re.escape, word.replace(" ", ""))),  # "saltmarsh", "salt marsh", "salt-marsh"
                 *map(re.escape, alikes.get(word) or [])]
        pattern = re.compile(rf"(?<!\w)(?:{'|'.join(forms)})(?!\w)", re.IGNORECASE)

        def spell(m, word=word):  # a capital only where a sentence starts
            before = m.string[:m.start()].rstrip()
            return word[0].upper() + word[1:] if not before or before[-1] in ".!?" else word
        text = pattern.sub(spell, text)
    return text


# speech_body() and clip_key() are copied from speech/speech-cache-key.py, so a line matches its stored clip.
SPACES = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")  # the same set in TS


def speech_body(text, output_format="mp3_44100_64"):
    """The speech request, tidied. Send exactly this body, and key the clip with clip_key()."""
    return {"text": SPACES.sub(" ", unicodedata.normalize("NFC", text)).strip(" "), "outputFormat": output_format}


def clip_key(voice_id, body):
    """The clip's key: SHA-256 of the voice id and the request as canonical JSON."""
    return hashlib.sha256(json.dumps({"voiceId": voice_id.strip().lower(), **body}, sort_keys=True,
                                     separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
