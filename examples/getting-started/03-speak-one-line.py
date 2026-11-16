"""03 · Speak one line.

One speech call, saved to out/03-speak-one-line.mp3. Uses LABS_VOICE_ID, or else the first ready public voice
in GET /voice-audio/voices/list. The answer is the audio itself (not JSON); its headers say what the call cost
(X-Credits-Charged) and what is left (X-Credits-Remaining). Speech costs 1 credit per 100 characters.

Run: uv run python getting-started/03-speak-one-line.py ["text to say"]
"""
import json, os, pathlib, sys, urllib.error, urllib.request

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


text = sys.argv[1] if len(sys.argv) > 1 else "Hello from Rezolve Labs. This line was spoken by your voice."
voice_id = os.environ.get("LABS_VOICE_ID")
if not voice_id:
    voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
    voice = next(v for v in voices if v["isPublic"] and v["status"] == "ready")
    voice_id = voice["id"]
    print(f"voice:     {voice['name']} ({voice['voiceType']}, public), {voice_id}")

status, headers, audio = labs("POST", f"/voice-audio/voices/{voice_id}/speech", {"text": text, "outputFormat": "mp3_44100_64"})
if status != 200:
    sys.exit("Speech was refused: see the body above.")
os.makedirs("out", exist_ok=True)
pathlib.Path("out/03-speak-one-line.mp3").write_bytes(audio)
print(f"saved:     out/03-speak-one-line.mp3 ({headers['Content-Type']}, {len(text)} characters)")
print(f"charged:   {headers['X-Credits-Charged']} credits, {headers['X-Credits-Remaining']} left")
