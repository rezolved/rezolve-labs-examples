"""Speech determinism: which voices repeat a line byte for byte, and what each voice takes.

Picks one ready voice of each kind in the workspace (preset, designed, public, cloned), or the voice ids you pass.
For each voice it prints the voice's `supportedSettings` from the list (free) and tries each setting once. Then it
speaks a short and a long line N times each in two formats, and N times with `seed` 7, and counts the distinct clips
by their SHA-256; and the long line once with `seed` 8. Every speech call is charged (1 credit per 100 characters),
even when it returns a clip you already have.

Run: uv run python speech/speech-determinism.py [--n 5] [voiceId ...]
"""
import hashlib, json, os, pathlib, sys, urllib.error, urllib.request

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
KINDS = ("preset", "designed", "public", "cloned")
SHORT = "Welcome to Saltmarsh Bakery. What can I get you?"
LONG = ("Welcome to Saltmarsh Bakery on Quay Road. We bake sourdough, seeded rye and spelt every morning, "
        "and delivery is free on orders over thirty euros. What can I get you?")
credits = []


def labs(method, path, body=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=180)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp.read()
    credits.append(int(resp.headers.get("X-Credits-Charged") or 0))
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


def kind(voice):
    """preset, designed, public or cloned: the kinds of voice that behave differently."""
    if voice["voiceType"] == "generated":
        return "public" if voice["isPublic"] else "designed"
    return voice["voiceType"]


def pick_voices(ids):
    """One ready voice of each kind, or the voices whose ids were passed. A professional clone has no
    supportedSettings and can't speak, so it is left out."""
    items = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
    usable = [v for v in items if v["status"] == "ready" and v.get("supportedSettings")]
    if ids:
        return [v for v in usable if v["id"] in ids]
    picked = [next((v for v in usable if kind(v) == k), None) for k in KINDS]
    for k, v in zip(KINDS, picked):
        if not v:
            print(f"{k:<9} none in this workspace: skipped")
    return [v for v in picked if v]


def speak(voice, body):
    """(status, error code or content type, audio)"""
    status, headers, data = labs("POST", f"/voice-audio/voices/{voice['id']}/speech", body)
    if status != 200:
        try:
            return status, json.loads(data).get("code", ""), b""
        except ValueError:
            return status, "", b""
    return status, headers.get("Content-Type", ""), data


def distinct(clips):
    """How many different clips came back, or the refusal if the voice refused the call."""
    refused = next((f"{status} {code}".strip() for status, code, _ in clips if status != 200), None)
    return refused or str(len({hashlib.sha256(audio).hexdigest() for _, _, audio in clips}))


def takes(supported):
    """The voice's supportedSettings in one line."""
    num = lambda x: f"{x:g}" if isinstance(x, float) else str(x)
    r = lambda s: f"{num(s['min'])} to {num(s['max'])}"
    langs = supported["languages"]
    return (f"speed {r(supported['speed'])}, volume {r(supported['volume'])}, "
            f"seed {r(supported['seed']) if supported.get('seed') else 'none'}, "
            f"languages {', '.join(langs[:4]) + f' … ({len(langs)})' if langs else 'none'}")


n = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 5
ids = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith("--") and sys.argv[i - 1] != "--n"]
voices = pick_voices(ids)
label = lambda v: f"{kind(v)} {v['id'][:8]}…"
for v in voices:
    print(f"{label(v)}: {takes(v['supportedSettings'])}" + (" (the workspace's default voice)" if v["isDefault"] else ""))

PROBES = [  # (what, extra fields in the body); every probe speaks a 15-character line
    ("speed 1.1", {"voiceSettings": {"speed": 1.1}}),
    ("volume 3", {"voiceSettings": {"volume": 3}}),
    ("expressiveness 0.5", {"voiceSettings": {"expressiveness": 0.5}}),
    ('latency "normal"', {"latency": "normal"}),
    ('latency "low"', {"latency": "low"}),
    ('language "en"', {"language": "en"}),
    ('language "de"', {"language": "de"}),
    ("seed 7", {"seed": 7}),
]
settings = {}  # (what, voice id) -> "200" or "422 VALIDATION_ERROR"
for v in voices:
    for what, extra in PROBES:
        status, code, _ = speak(v, {"text": "Settings check.", "outputFormat": "mp3_44100_64", **extra})
        settings[what, v["id"]] = f"{status}" if status == 200 else f"{status} {code}".strip()
    for size in (3000, 3001):
        status, code, _ = speak(v, {"text": ("Fresh bread daily. " * 160)[: size - 1] + ".", "outputFormat": "mp3_44100_64"})
        settings[f"text of {size:,} characters", v["id"]] = f"{status}" if status == 200 else f"{status} {code}".strip()

REPEATS = [  # (row, body) for each line
    ("mp3", {"outputFormat": "mp3_44100_64"}),
    ("pcm", {"outputFormat": "pcm_24000"}),
    ("mp3, seed 7", {"outputFormat": "mp3_44100_64", "seed": 7}),
]
repeats = {}  # (row, voice id) -> distinct clips, or the refusal
for v in voices:
    for name, text in (("short", SHORT), ("long", LONG)):
        for row, body in REPEATS:
            clips = [speak(v, {"text": text, **body}) for _ in range(n)]
            repeats[f"{name} {row}", v["id"]] = distinct(clips)
    status, code, other = speak(v, {"text": LONG, "outputFormat": "mp3_44100_64", "seed": 8})  # vs the last N clips
    repeats["long mp3, seed 8 vs 7", v["id"]] = (f"{status} {code}".strip() if status != 200
                                                 else "same" if other in {audio for _, _, audio in clips} else "differs")


def table(title, rows, cells):
    print(f"\n{title}")
    widths = [max(len(r) for r in rows)] + [max(len(label(v)), *(len(cells[r, v["id"]]) for r in rows)) for v in voices]
    print("  ".join(h.ljust(w) for h, w in zip(["", *map(label, voices)], widths)).rstrip())
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip([r, *(cells[r, v["id"]] for v in voices)], widths)).rstrip())


table("What each voice takes (status of a speech call with that setting):",
      [p[0] for p in PROBES] + ["text of 3,000 characters", "text of 3,001 characters"], settings)
table(f"Distinct clips in {n} calls with the same voice and text (1 = repeats byte for byte):",
      [f"{name} {row}" for name in ("short", "long") for row, _ in REPEATS] + ["long mp3, seed 8 vs 7"], repeats)
print(f"\ncharged: {sum(credits)} credits in {len(credits)} calls (short line {len(SHORT)}, long line {len(LONG)} characters)")
