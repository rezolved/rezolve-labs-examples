"""clone-00 · A practice recording.

Makes out/voice-clone/recording.wav: a short interview between two public voices, a host who asks and an owner
who answers, so you can run clone-01 to clone-04 without recording anyone. Each line is one speech call in
`wav_44100` (16-bit mono WAV at 44.1 kHz), and the lines are joined with a pause between them. The owner speaks
for about a minute of it. For the real thing, use a recording of the owner, made with their permission.

Run: uv run python voice-clone/clone-00-sample-recording.py
"""
import io, json, os, pathlib, sys, time, urllib.error, urllib.request, wave

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
OUT = pathlib.Path("out/voice-clone/recording.wav")
PAUSE = 0.6  # seconds of silence between two lines

LINES = [  # (who, what they say)
    ("host", "Thanks for making time. How did the bakery start?"),
    ("owner", "My grandmother baked for the whole street. When she retired, I took over her oven and her recipes, "
              "and we opened the shop in an old fishing shed by the harbour. That was twelve years ago."),
    ("host", "What does a normal day look like?"),
    ("owner", "I start at five. The sourdough has rested overnight, so I shape the loaves first and bake them while "
              "the town is still asleep. By eight the shelves are full, the coffee is on, and the first walkers "
              "come in from the beach."),
    ("host", "Is it all sourdough?"),
    ("owner", "Yes."),
    ("host", "And the pastries?"),
    ("owner", "The pastries are my partner's work. She makes cinnamon buns every morning, and a fruit tart that "
              "changes with the season. In autumn it is apple and blackberry, and people ask for it by name."),
    ("host", "Do you take orders for events?"),
    ("owner", "We do, with two days' notice. Birthday cakes, bread for weddings, and trays of small loaves for the "
              "village fair. Call the shop or send us a message through the website, and we will confirm the day "
              "and the price."),
    ("host", "What should visitors know before they come?"),
    ("owner", "We are closed on Mondays. From Tuesday to Sunday we open at eight and close at four, or earlier when "
              "the bread runs out. Dogs are welcome on the terrace, and there is a water bowl by the door."),
    ("host", "Last question. What do you love most about it?"),
    ("owner", "The quiet hour before we open. The oven is warm, the radio is low, and the whole shop smells of "
              "bread. I would not trade it for anything."),
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


def retrying(method, path, body=None):
    """labs() that tries again after a 429 (waiting Retry-After) or a 5xx (after 1, 2, 4 and 8 s). Neither is charged."""
    for attempt in range(30):
        status, headers, data = labs(method, path, body)
        if status == 429:
            wait = int(headers.get("Retry-After", "1"))
        elif status >= 500 and attempt < 4:
            wait = 2 ** attempt
        else:
            break
        time.sleep(wait)
    return status, headers, data

def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
public = [v["id"] for v in voices if v["isPublic"] and v["status"] == "ready"]
if len(public) < 2:
    sys.exit("This needs two ready public voices; the list has fewer.")
cast = {"owner": public[0], "host": public[1]}
print(f"voices:   owner {cast['owner']}, host {cast['host']} (two public voices)")

frames, rate = [], 44100
for who, text in LINES:
    status, _, audio = retrying("POST", f"/voice-audio/voices/{cast[who]}/speech", {"text": text, "outputFormat": "wav_44100"})
    if status != 200:
        sys.exit("Speech was refused: see the body above.")
    with wave.open(io.BytesIO(audio)) as clip:  # 16-bit mono, so one frame is 2 bytes
        rate = clip.getframerate()
        frames += [clip.readframes(clip.getnframes()), bytes(2 * int(rate * PAUSE))]

OUT.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUT), "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(rate)
    out.writeframes(b"".join(frames))
    seconds = out.getnframes() / rate
print(f"saved:    {OUT} ({seconds:.1f} s, {len(LINES)} lines, {OUT.stat().st_size / 1e6:.1f} MB)")
print("next:     clone-01-transcribe.py finds who speaks when")
