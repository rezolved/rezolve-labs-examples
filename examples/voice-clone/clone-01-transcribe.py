"""clone-01 · Transcribe the recording, with who spoke when.

Sends one recording to POST /transcription/voices/transcriptions with diarize=true and saves the answer's `data`
to out/voice-clone/transcript.json, with the recording's path added: the language, the length, and each segment
with its speaker (speaker_0, speaker_1, …), start, end, text and the timing of every word. clone-02 cuts the
sample from these timings. The call takes any common audio format, but clone-02 reads WAV only, so send a WAV.
Keep the file under 25 MB.

Run: uv run python voice-clone/clone-01-transcribe.py [recording.wav]   (default: out/voice-clone/recording.wav)
"""
import json, os, pathlib, sys, urllib.error, urllib.request, uuid

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
RECORDING = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "out/voice-clone/recording.wav")
OUT = pathlib.Path("out/voice-clone/transcript.json")


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


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


def multipart(fields, file_field, path):
    """A multipart/form-data body with text fields and one WAV file: (body, Content-Type)."""
    boundary = uuid.uuid4().hex
    body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                    for k, v in fields.items())
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{path.name}"\r\n'
             "Content-Type: audio/wav\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


if not RECORDING.exists():
    sys.exit(f"No {RECORDING}. Pass the owner's recording, or make a practice one with clone-00-sample-recording.py.")
if RECORDING.stat().st_size >= 25 * 1024 * 1024:
    sys.exit(f"{RECORDING} is {RECORDING.stat().st_size / 1e6:.1f} MB: the API takes up to 25 MB. Send a shorter part.")

body, content_type = multipart({"diarize": "true"}, "audio", RECORDING)
transcript = data_of(labs("POST", "/transcription/voices/transcriptions", body, content_type), "Not transcribed")
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"recording": str(RECORDING), **transcript}, indent=1))

seconds = {}
for s in transcript["segments"]:
    seconds[s["speaker"]] = seconds.get(s["speaker"], 0) + (s["endMs"] - s["startMs"]) / 1000
print(f"heard:    {transcript['durationMs'] / 1000:.1f} s in language {transcript['language']!r}, "
      f"{len(transcript['segments'])} segments")
for speaker, total in sorted(seconds.items(), key=lambda item: -item[1]):
    first = next(s["text"] for s in transcript["segments"] if s["speaker"] == speaker)
    print(f"speaker:  {speaker} speaks for {total:.1f} s, first: \"{first[:60]}\"")
print(f"saved:    {OUT}")
print("next:     clone-02-cut.py keeps one speaker (the one who speaks most, or the one you name)")
