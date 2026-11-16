"""Speech newline and end-trim: does a clip end cleanly, with or without a trailing newline?

Speaks 22 short site-assistant lines in one voice of each kind (or the voice ids you pass), each twice: as written
and with "\\n" on the end. It asks for raw PCM (`pcm_24000`: 16-bit mono samples at 24 kHz, no header) so it can
measure the end of each clip: the level of the last 80 ms, and how much silence (below -45 dBFS) follows the last
word. A clip with under 30 ms of silence at the end is counted as clipped. 22 lines x 2 x 1 credit per voice.

Run: uv run python speech/speech-newline-endtrim.py [voiceId ...]
"""
import array, json, math, os, pathlib, sys, urllib.error, urllib.request
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
RATE = 24000  # pcm_24000: samples a second
SILENT_DB = -45  # quieter than this counts as silence
CLIPPED_MS = 30  # less trailing silence than this counts as a clipped ending
LINES = [  # short site-assistant lines with varied final sounds
    "We open at nine.", "Yes, dogs are welcome on the terrace.", "The sourdough sells out by noon.",
    "Delivery is free over thirty euros.", "You can collect your order from the side door.",
    "Our croissants are baked every morning.", "That one is gluten free.", "We close early on Sundays.",
    "I can open the menu page for you.", "Sorry, I don't know that yet.", "One moment, let me check.",
    "Parking is on Quay Road.", "Cards and cash are both fine.", "The café seats twenty people.",
    "Yes, we bake rye on Thursdays.", "Would you like to hear today's specials?", "It's two minutes from the harbour.",
    "Orders placed before four ship the same day.", "We don't take bookings.", "Here is the contact page.",
    "The cinnamon buns are back.", "Thanks for asking!",
]


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


def db(samples):
    """RMS level of 16-bit samples in dBFS (0 is full scale)."""
    rms = math.sqrt(sum(x * x for x in samples) / max(1, len(samples)))
    return 20 * math.log10(max(rms, 1e-9) / 32768)


def ending(pcm):
    """(clip length ms, level of the last 80 ms in dBFS, trailing silence ms) of raw 16-bit mono PCM."""
    s = array.array("h", pcm[: len(pcm) // 2 * 2])  # 16-bit little-endian, the byte order of every common machine
    step = RATE // 100  # 10 ms
    silence = 0
    for end in range(len(s), step, -step):
        if db(s[end - step:end]) > SILENT_DB:
            break
        silence += 10
    return round(len(s) * 1000 / RATE), round(db(s[-RATE * 80 // 1000:]), 1), silence


voices = pick_voices(sys.argv[1:])
results = {}  # voice id -> {"plain": [...], "newline": [...]} of (line, ms, last80, silence)
for v in voices:
    results[v["id"]] = {"plain": [], "newline": []}
    for line in LINES:
        for how, text in (("plain", line), ("newline", line + "\n")):
            status, headers, pcm = labs("POST", f"/voice-audio/voices/{v['id']}/speech", {"text": text, "outputFormat": "pcm_24000"})
            if status == 200:
                results[v["id"]][how].append((line, *ending(pcm)))

print(f"\n{len(LINES)} lines per voice; clipped = under {CLIPPED_MS} ms of silence (below {SILENT_DB} dBFS) after the last word")
print(f"{'voice':<18} {'ending':<8} {'clipped':>7} {'least silence':>14} {'mean silence':>13} {'loudest last 80 ms':>19}")
for v in voices:
    for how in ("plain", "newline"):
        rows = results[v["id"]][how]
        clipped = sum(1 for r in rows if r[3] < CLIPPED_MS)
        print(f"{kind(v) + ' ' + v['id'][:8] + '…':<18} {how:<8} {f'{clipped} of {len(rows)}':>7} "
              f"{min(r[3] for r in rows):>11} ms {round(mean(r[3] for r in rows)):>10} ms {max(r[2] for r in rows):>14} dBFS")
for v in voices:
    worst = min(results[v["id"]]["plain"], key=lambda r: r[3])
    print(f"least silence, {kind(v)}: \"{worst[0]}\" ({worst[1]} ms long, {worst[3]} ms of silence at the end)")
