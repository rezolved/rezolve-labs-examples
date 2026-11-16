"""Speech time to first byte: how long before the first audio arrives, by line length and by format.

For one voice of each kind (or the voice ids you pass) it speaks lines of about 60, 150 and 170 characters, three
different lines each, in `mp3_44100_64`, and times the first byte of audio and the last. Then it speaks the three
lines of about 170 characters in every output format, and at speed 1.1: an answer that is only sent once the whole
clip is made shows a first byte later than mp3's.

Run: uv run python speech/speech-ttfb.py [voiceId ...]
"""
import json, os, pathlib, sys, time, urllib.error, urllib.request
from statistics import mean

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
LENGTHS = (60, 150, 170)
FORMATS = ("mp3_44100_128", "mp3_44100_64", "opus_48000_64", "wav_44100", "pcm_24000")
PASSAGES = [  # three different lines for each length, so no answer can be a repeat of another
    "Our sourdough is made with flour from a mill nearby, and every loaf rises for a full day before it goes into the oven at dawn. ",
    "The café on the harbour side opens at eight, serves coffee and pastries until noon, and keeps a few tables outside for dogs. ",
    "Orders placed online before four in the afternoon are baked the next morning and wait for you at the side door after nine. ",
]


def line(passage, n):
    """The passage cut at a word boundary to at most n characters, ending with a full stop."""
    return (passage * 2)[:n].rsplit(" ", 1)[0].rstrip(",") + "."


def labs_timed(method, path, body=None):
    """One Labs call, logged like every other (method, path, status, X-Credits-Charged, a body preview on errors),
    plus the seconds to the first byte of the answer's body and to the last."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    start = time.perf_counter()
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp.read(1)
    first = time.perf_counter() - start
    data += resp.read()
    last = time.perf_counter() - start
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          f" first={first:.2f}s last={last:.2f}s"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data, first, last


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer[:3]
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
    items = data_of(labs_timed("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
    usable = [v for v in items if v["status"] == "ready" and v.get("supportedSettings")]
    if ids:
        return [v for v in usable if v["id"] in ids]
    picked = [next((v for v in usable if kind(v) == k), None) for k in KINDS]
    for k, v in zip(KINDS, picked):
        if not v:
            print(f"{k:<9} none in this workspace: skipped")
    return [v for v in picked if v]


def speak(voice, text, **body):
    return labs_timed("POST", f"/voice-audio/voices/{voice['id']}/speech", {"text": text, **body})


voices = pick_voices(sys.argv[1:])
by_length, by_format = [], []
for v in voices:
    for n in LENGTHS:
        runs = [speak(v, line(p, n), outputFormat="mp3_44100_64") + (len(line(p, n)),) for p in PASSAGES]
        ok = [r for r in runs if r[0] == 200]
        by_length.append((v, f"{min(r[5] for r in runs)}-{max(r[5] for r in runs)}", [r[3] for r in ok],
                          [r[4] for r in ok], ok[0][1].get("X-Credits-Charged", "-") if ok else "-"))
    for fmt, extra in [(f, {}) for f in FORMATS] + [("mp3_44100_64", {"voiceSettings": {"speed": 1.1}})]:
        runs = [r for r in (speak(v, line(p, 170), outputFormat=fmt, **extra) for p in PASSAGES) if r[0] == 200]
        by_format.append((v, fmt + (" at speed 1.1" if extra else ""), runs[0][1].get("Content-Type", "") if runs else "-",
                          [r[3] for r in runs], [r[4] for r in runs]))

label = lambda v: f"{kind(v)} {v['id'][:8]}…"
print("\nTime to first audio, mp3_44100_64, three different lines each (seconds):")
print(f"{'voice':<18} {'characters':<10} {'first byte':<16} {'mean':>5} {'last byte':<16} {'credits':>7}")
for v, chars, firsts, lasts, charged in by_length:
    print(f"{label(v):<18} {chars:<10} {' '.join(f'{x:.2f}' for x in firsts):<16} {mean(firsts or [0]):>5.2f} "
          f"{' '.join(f'{x:.2f}' for x in lasts):<16} {charged:>7}")
print("\nThe lines of about 170 characters in each format (mean seconds of three):")
print(f"{'voice':<18} {'format':<26} {'content type':<12} {'first byte':>10} {'last byte':>9}  first byte vs mp3_44100_64")
for v, fmt, ctype, firsts, lasts in by_format:
    mp3 = next(f for w, name, _, f, _ in by_format if w is v and name == "mp3_44100_64")
    print(f"{label(v):<18} {fmt:<26} {ctype:<12} {mean(firsts or [0]):>10.2f} {mean(lasts or [0]):>9.2f}  "
          f"{mean(firsts or [0]) - mean(mp3 or [0]):+.2f}")
