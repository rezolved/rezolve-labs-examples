"""speech · Make the welcome and acknowledgement clips once.

The lines the assistant always says come from site-assistant.yaml (or the example): `welcomeMessage`,
`welcome.back` and `acknowledgements[]`, each respelled with `pronunciations[]` (see speech-respell). Each is spoken
once and stored as out/clips/<key>.mp3, where <key> is its cache key (see speech-cache-key), and
out/clips/manifest.json names them for your server. A run makes only the clips that are missing, so it costs
nothing when no line changed. The voice is part of the key, so a new voice makes new clips, and clips the manifest
no longer lists are removed.

Every voice is cached. A stored clip is the take you keep: the same request can come back as another take
(the workspace's default voice gives a new one on every call), so back up out/clips/ rather than remaking clips
to check them.

The voice: an id on the command line, else the agent's (LABS_AGENT_ID), else LABS_VOICE_ID, else `voiceId` in the
YAML, else the first ready public voice (as setup-02 picks).

Run: uv run python speech/speech-make-clips.py [voiceId]
"""
import hashlib, json, os, pathlib, re, sys, unicodedata, urllib.error, urllib.request
import yaml

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
ANSWERS = pathlib.Path("site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = pathlib.Path(__file__).parent.parent / "site-setup" / "site-assistant.example.yaml"
CLIPS = pathlib.Path("out/clips")
FORMAT = "mp3_44100_64"
SPACES = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")  # the same set in TS


def labs(method, path, body=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=120)
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


# speech_body(), canonical() and clip_key() are copied from speech-cache-key.py; the vectors check below keeps them equal.
def speech_body(text, output_format=FORMAT, voice_settings=None, seed=None, language=None):
    """The speech request, tidied. Send exactly this body, and key the clip with clip_key()."""
    body = {"text": SPACES.sub(" ", unicodedata.normalize("NFC", text)).strip(" "), "outputFormat": output_format}
    settings = {k: int(v) if isinstance(v, float) and v.is_integer() else v
                for k, v in sorted((voice_settings or {}).items()) if v is not None}
    if settings:
        body["voiceSettings"] = settings
    if seed is not None:
        body["seed"] = seed
    if language:
        body["language"] = language
    return body


def canonical(voice_id, body):
    """The voice id and the request as one line of JSON: sorted keys, no spaces, non-ASCII kept as it is."""
    return json.dumps({"voiceId": voice_id.strip().lower(), **body}, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def clip_key(voice_id, body):
    """The clip's key: SHA-256 of canonical(), as 64 hex characters. Use it as the file name."""
    return hashlib.sha256(canonical(voice_id, body).encode("utf-8")).hexdigest()


def respell(text, pronunciations):
    """The text to send to speech: each `word` replaced by its `sayAs`, as a whole word in any case."""
    for p in sorted(pronunciations, key=lambda p: -len(p["word"])):
        text = re.sub(rf"(?<!\w){re.escape(p['word'])}(?!\w)", lambda _, say=p["sayAs"]: say, text, flags=re.IGNORECASE)
    return text


def pick_voice(site):
    """The voice the agent speaks with (see the order at the top of this file)."""
    if len(sys.argv) > 1:
        return sys.argv[1]
    if os.environ.get("LABS_AGENT_ID"):
        agent = data_of(labs("GET", f"/developer-platform/agents/{os.environ['LABS_AGENT_ID']}"), "Could not read the agent")
        return agent["voiceId"] or sys.exit("The agent has no voice: give it one (setup-02) before making clips.")
    if os.environ.get("LABS_VOICE_ID") or site.get("voiceId"):
        return os.environ.get("LABS_VOICE_ID") or site["voiceId"]
    voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
    return next(v for v in voices if v["isPublic"] and v["status"] == "ready")["id"]


def describe(voice):
    """A designed, cloned or default voice, in words."""
    kind = {"generated": "a designed voice", "cloned": "a cloned voice"}.get(voice["voiceType"], f"a {voice['voiceType']} voice")
    if voice.get("isDefault"):
        kind = "the workspace's default voice"
    return kind + (", public" if voice.get("isPublic") else "")


site = yaml.safe_load(ANSWERS.read_text(encoding="utf-8"))
print(f"answers:   {os.path.relpath(ANSWERS)}")
vectors = json.loads((pathlib.Path(__file__).parent / "cache-key-vectors.json").read_text(encoding="utf-8"))["vectors"]
wrong = [v["name"] for v in vectors if clip_key(v["voiceId"], speech_body(
    v["text"], v.get("outputFormat", FORMAT), v.get("voiceSettings"), v.get("seed"), v.get("language"))) != v["key"]]
if wrong:
    sys.exit(f"The key code here differs from speech-cache-key: {', '.join(wrong)}")
print(f"key check: {len(vectors)} vectors pass")

voice_id = pick_voice(site)
voice = data_of(labs("GET", f"/voice-audio/voices/{voice_id}"), "Could not read the voice")
print(f"voice:     {voice_id} ({describe(voice)})")

lines = [("welcome", "welcomeMessage", site.get("welcomeMessage")),
         ("welcome-back", "welcome.back", (site.get("welcome") or {}).get("back"))]
lines += [(f"ack-{n}", f"acknowledgements[{n - 1}]", a) for n, a in enumerate(site.get("acknowledgements") or [], 1)]

CLIPS.mkdir(parents=True, exist_ok=True)
clips = []
for name, field, text in lines:
    if not text:
        print(f"skipped:   {name} ({field} is empty)")
        continue
    body = speech_body(respell(text, site.get("pronunciations") or []))
    key = clip_key(voice_id, body)
    path = CLIPS / f"{key}.mp3"
    if path.exists():
        print(f"kept:      {name} {key[:12]}…")
    else:
        status, _, audio = labs("POST", f"/voice-audio/voices/{voice_id}/speech", body)
        if status != 200:
            print(f"missing:   {name} (see the body above); run again to retry")
            continue
        part = path.with_suffix(".part")  # written whole, then renamed: a half-written clip is never served
        part.write_bytes(audio)
        part.replace(path)
        print(f"made:      {name} {key[:12]}…")
    clips.append({"name": name, "text": text, "spoken": body["text"], "key": key, "file": path.name})

listed = {c["file"] for c in clips}
stale = [p for p in CLIPS.glob("*.mp3") if p.name not in listed]
for p in stale:
    p.unlink()
if stale:
    print(f"removed:   {len(stale)} clips no longer listed (an earlier voice or line)")
manifest = {"voiceId": voice_id, "voiceType": voice["voiceType"], "outputFormat": FORMAT, "clips": clips}
(CLIPS / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"manifest:  out/clips/manifest.json ({len(clips)} clips)")
