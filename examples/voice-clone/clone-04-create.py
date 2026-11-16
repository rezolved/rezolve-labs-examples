"""clone-04 · Clone the voice, then listen to it.

Sends out/voice-clone/sample.wav (from clone-02) to POST /voice-audio/voices/clone as multipart, with the name
you give, consent=true, and the language transcription heard in the recording (from cuts.json; --language to
change it). An instant clone is ready straight away. The new voice then speaks a few lines a site assistant says,
saved as out/voice-clone/test-N.wav for the owner to listen to, each with how much quiet it ends on: a clip
that stops right on a word may be cutting it short.

Every clone is charged in full, so run this once: after the owner has approved the sample (clone-03), and with
the speaker's permission on file. --consent says you have it; without it nothing is sent.

Run: uv run python voice-clone/clone-04-create.py --consent --name "Saltmarsh owner"
"""
import argparse, array, io, json, math, os, pathlib, sys, urllib.error, urllib.request, uuid, wave

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
CUTS = pathlib.Path("out/voice-clone/cuts.json")
TEST_LINES = [  # short lines a site assistant says; use your own
    "Hi, I'm the Saltmarsh Bakery assistant. Ask me about our breads, opening hours or delivery.",
    "We're closed on Mondays.",
    "One moment, I'll check that for you.",
    "Yes, dogs are welcome on our terrace, and there's a water bowl by the door.",
]


def labs(method, path, body=None, content_type="application/json"):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    data = body if body is None or isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(API + path, method=method, data=data,
                                 headers={"X-API-KEY": KEY, "Content-Type": content_type, "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp.read()
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data


def multipart(fields, file_field, path):
    """A multipart/form-data body with text fields and one WAV file: (body, Content-Type)."""
    boundary = uuid.uuid4().hex
    body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                    for k, v in fields.items())
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{path.name}"\r\n'
             "Content-Type: audio/wav\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def quiet_end(audio):
    """(seconds, ms of quiet at the end) of a 16-bit mono WAV; quiet is 20 ms below -45 dBFS."""
    with wave.open(io.BytesIO(audio)) as w:
        rate, samples = w.getframerate(), array.array("h", w.readframes(w.getnframes()))
    if sys.byteorder == "big":
        samples.byteswap()
    step, end = int(0.02 * rate), len(samples)
    while end >= step and math.sqrt(sum(x * x for x in samples[end - step:end]) / step) < 32768 * 10 ** (-45 / 20):
        end -= step
    return len(samples) / rate, round((len(samples) - end) / rate * 1000)


parser = argparse.ArgumentParser(description="Clone the voice in out/voice-clone/sample.wav, then speak test lines.")
parser.add_argument("--name", required=True, help="the voice's name; it must be new in the workspace")
parser.add_argument("--consent", action="store_true", help="the speaker's permission to clone their voice is on file")
parser.add_argument("--language", help="the language the voice speaks, such as en or en-US (default: as transcribed)")
args = parser.parse_args()
if not args.consent:
    sys.exit("Nothing sent. Pass --consent once the speaker's permission to clone their voice is on file.")
if not CUTS.exists():
    sys.exit(f"No {CUTS}: run clone-02-cut.py and clone-03-report.py first.")
cuts = json.loads(CUTS.read_text())
sample = pathlib.Path(cuts["sample"])
language = args.language or cuts["language"]

body, content_type = multipart({"name": args.name, "consent": "true", "language": language}, "file", sample)
status, _, answer = labs("POST", "/voice-audio/voices/clone", body, content_type)
if status != 201:
    sys.exit("The voice was not cloned: see the body above.")
voice = json.loads(answer)["data"]
print(f"voice:    {voice['name']} ({voice['id']}), {voice['voiceType']} {voice['cloneTier']}, "
      f"status {voice['status']}, language {voice['language']!r}")
if voice["status"] != "ready":
    sys.exit(f"Not ready yet: read it again with GET /voice-audio/voices/{voice['id']} until `status` is ready.")

for n, text in enumerate(TEST_LINES, 1):
    status, _, audio = labs("POST", f"/voice-audio/voices/{voice['id']}/speech", {"text": text, "outputFormat": "wav_44100"})
    if status != 200:
        continue
    path = sample.parent / f"test-{n}.wav"
    path.write_bytes(audio)
    seconds, quiet = quiet_end(audio)
    print(f"listen:   {path} ({seconds:.1f} s, ends on {quiet} ms of quiet) \"{text}\"")
print(f"voice id: {voice['id']}")
print("use it:   as voiceId in site-assistant.yaml before setup-02, or in PATCH /developer-platform/agents/{agentId}")
print(f"remove:   if the owner turns it down, DELETE /voice-audio/voices/{voice['id']}")
