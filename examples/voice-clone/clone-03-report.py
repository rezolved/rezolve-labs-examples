"""clone-03 · A report on the sample, for the owner to approve before the clone is paid for.

Reads out/voice-clone/sample.wav and cuts.json (from clone-02), prints a short report and saves it as
out/voice-clone/report.txt: length and size, the pieces of the recording used and dropped, the levels, and
warnings. The one-speaker check sends the sample back to transcription with diarize=true (a few credits) and
warns if it hears more than one speaker. Give the owner the report and the sample, and clone only after they
have listened and said yes.

It warns when the sample is:
- shorter than 30 s or longer than 3 minutes (aim for about a minute);
- quiet: speech below -40 dBFS;
- noisy: the quietest moments less than 20 dB below the speech;
- clipped: any samples at full scale;
- more than one voice, as transcription hears it; it then lists where the other voice is in the sample.

Run: uv run python voice-clone/clone-03-report.py
"""
import array, json, math, os, pathlib, sys, urllib.error, urllib.request, uuid, wave

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
REPORT = pathlib.Path("out/voice-clone/report.txt")
SHORT, LONG = 30, 180      # seconds
QUIET, NOISY = -40, 20     # dBFS of the speech; dB from the speech down to the quietest moments


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


def level(samples):
    """The RMS level of some samples, in dBFS; -120 for silence."""
    rms = math.sqrt(sum(x * x for x in samples) / len(samples)) if samples else 0
    return 20 * math.log10(rms / 32768) if rms else -120.0


def clock(seconds):
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


lines = []
def say(text=""):
    print(text)
    lines.append(text)


if not CUTS.exists():
    sys.exit(f"No {CUTS}: run clone-02-cut.py first.")
cuts = json.loads(CUTS.read_text())
sample = pathlib.Path(cuts["sample"])
with wave.open(str(sample)) as w:
    rate = w.getframerate()
    samples = array.array("h", w.readframes(w.getnframes()))
if sys.byteorder == "big":
    samples.byteswap()
size = sample.stat().st_size

# Speech is where the words are. Its quietest tenth, in 50 ms steps, is the background between the words.
speech = array.array("h")
for u in cuts["used"]:
    speech += samples[int(u["at"] * rate):int((u["at"] + u["to"] - u["from"]) * rate)]
step = int(0.05 * rate)
frames = sorted(level(speech[i:i + step]) for i in range(0, len(speech) - step, step))
loud, floor = round(level(speech)), round(frames[len(frames) // 10])
peak = round(20 * math.log10(max(1, max(samples), -min(samples)) / 32768))
clipped = samples.count(32767) + samples.count(-32768)

body, content_type = multipart({"diarize": "true"}, "audio", sample)
heard = data_of(labs("POST", "/transcription/voices/transcriptions", body, content_type), "The one-speaker check failed")
heard_for = {}
for s in heard["segments"]:
    heard_for[s["speaker"]] = heard_for.get(s["speaker"], 0) + s["endMs"] - s["startMs"]
voices = sorted(heard_for, key=heard_for.get, reverse=True)  # the main voice first

say(f"sample:   {sample}, {len(samples) / rate:.1f} s, {size / 1e6:.1f} MB, {rate} Hz mono")
say(f"source:   {cuts['speaker']} in {cuts['recording']}, language {cuts['language']!r}")
say(f"used:     {len(cuts['used'])} pieces of the recording")
for u in cuts["used"]:
    say(f"  {clock(u['from'])}–{clock(u['to'])}  \"{u['text'][:70]}{'…' if len(u['text']) > 70 else ''}\"")
spare = [d for d in cuts["dropped"] if d["why"].startswith("not needed")]
say(f"dropped:  {len(cuts['dropped']) - len(spare)} of them" + (f", and {len(spare)} more not needed" if spare else ""))
for d in cuts["dropped"]:
    if d not in spare:
        say(f"  {clock(d['from'])}–{clock(d['to'])}  {d['why']}: \"{d['text'][:50]}\"")
say(f"levels:   speech {loud} dBFS, quietest moments {floor} dBFS, peak {peak} dBFS")
say(f"voices:   transcription hears {len(voices)} ({', '.join(voices)}), language {heard['language']!r}")
for s in heard["segments"]:
    if s["speaker"] != voices[0]:
        say(f"  {clock(s['startMs'] / 1000)}–{clock(s['endMs'] / 1000)} in the sample, {s['speaker']}: \"{s['text'][:50]}\"")

warnings = []
if len(samples) / rate < SHORT:
    warnings.append(f"short: {len(samples) / rate:.0f} s. Aim for about a minute; add more of the recording.")
if len(samples) / rate > LONG:
    warnings.append(f"long: {len(samples) / rate:.0f} s. About a minute is enough.")
if loud < QUIET:
    warnings.append(f"quiet: speech at {loud} dBFS. Record closer to the microphone.")
if loud - floor < NOISY:
    warnings.append(f"noisy: the background is only {loud - floor} dB below the speech. Record somewhere quieter.")
if clipped:
    warnings.append(f"clipped: {clipped} samples at full scale. Record with less gain.")
if len(voices) > 1:
    warnings.append(f"{len(voices)} voices heard (where: above). Listen there; cut that part out of the recording and "
                    "run clone-01 again, or record again.")
say("warnings: " + ("none" if not warnings else f"{len(warnings)}"))
for warning in warnings:
    say(f"  {warning}")
say(f"approve:  the owner listens to {sample}; if it is their voice and nothing else, run clone-04-create.py")
REPORT.write_text("\n".join(lines) + "\n")
print(f"saved:    {REPORT}")
