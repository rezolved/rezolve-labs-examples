"""speech · Respell hard words before speech.

The owner's `pronunciations[]` in site-assistant.yaml (or the example) say how to say a word: in the text sent to
speech, each `word` becomes its `sayAs`, as a whole word in any case ("Saltmarsh's" too), longest word first. The
speech request has no pronunciation field, so a respelling is how you steer it. Only the speech request gets it:
the text on screen, the agent's instructions and its knowledge keep the real spelling.

Each line the assistant always says (the welcome, welcome back and acknowledgements) that has a hard word, or the
text you pass, is spoken as written and respelled into out/respell/, for the owner to compare.

Run: uv run python speech/speech-respell.py ["text to say"]
"""
import json, os, pathlib, re, sys, urllib.error, urllib.request
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


def respell(text, pronunciations):
    """The text to send to speech: each `word` replaced by its `sayAs`, as a whole word in any case."""
    for p in sorted(pronunciations, key=lambda p: -len(p["word"])):
        text = re.sub(rf"(?<!\w){re.escape(p['word'])}(?!\w)", lambda _, say=p["sayAs"]: say, text, flags=re.IGNORECASE)
    return text


site = yaml.safe_load(ANSWERS.read_text(encoding="utf-8"))
print(f"answers:   {os.path.relpath(ANSWERS)}")
pronunciations = site.get("pronunciations") or []
if not pronunciations:
    sys.exit("No pronunciations[] in the answers: nothing to respell.")
for p in pronunciations:
    print(f"respell:   {p['word']} -> {p['sayAs']}")

said = [site.get("welcomeMessage"), (site.get("welcome") or {}).get("back"), *(site.get("acknowledgements") or [])]
lines = ([sys.argv[1]] if len(sys.argv) > 1 else [s for s in said if s and respell(s, pronunciations) != s]
         or [f"{p['word']}." for p in pronunciations])

voice_id = os.environ.get("LABS_VOICE_ID") or site.get("voiceId")
if not voice_id:
    voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
    voice_id = next(v for v in voices if v["isPublic"] and v["status"] == "ready")["id"]
print(f"voice:     {voice_id}")

os.makedirs("out/respell", exist_ok=True)
for n, line in enumerate(lines, 1):
    print(f"line {n}:    {line}")
    print(f"respelled: {respell(line, pronunciations)}")
    saved = []
    for suffix, text in (("as-written", line), ("respelled", respell(line, pronunciations))):
        status, _, audio = labs("POST", f"/voice-audio/voices/{voice_id}/speech", {"text": text, "outputFormat": "mp3_44100_64"})
        if status == 200:
            pathlib.Path(f"out/respell/line-{n}-{suffix}.mp3").write_bytes(audio)
            saved.append(f"out/respell/line-{n}-{suffix}.mp3")
    print(f"listen:    {' and '.join(saved)}" if len(saved) == 2 else "missing:   a clip was not made (see the body above)")
