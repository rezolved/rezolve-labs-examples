"""07 · A voice agent in one file.

04 plus speech, in the agent's own voice. Each whole sentence goes to speech as soon as it is released, with at
most 2 speech calls in flight, and the clips play in the order of the text, not the order they finish. The first
clip waits until it holds more than 150 characters: cloned and designed voices generate a line of up to 150
characters whole before sending any audio, so a longer first clip starts sooner. Markdown is dropped before
speech, and a "Read more: /path" line is shown, not spoken. The clips are saved in order to out/07-voice-agent.mp3
and played with afplay, ffplay or mpg123 if one is installed (--no-play to skip).

Run: uv run python getting-started/07-voice-agent.py ["your question"] [--no-play]
"""
import json, os, pathlib, queue, re, shutil, subprocess, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

for d in pathlib.Path(__file__).resolve().parents:  # the nearest .env above this file
    if (d / ".env").exists():
        for line in (d / ".env").read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() and not k.lstrip().startswith("#"):
                os.environ.setdefault(k.strip(), v.strip())
        break
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
AGENT = os.environ.get("LABS_AGENT_ID") or sys.exit("Set LABS_AGENT_ID in .env (site-setup/setup-02-create-agent makes one).")
UA = "labs-playbook-examples/1.0"  # any explicit User-Agent works; Python's default gets 503 upstream_edge_block
FIRST_CLIP = 150  # characters the first clip must exceed (see above)
PLAYERS = (["afplay"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"], ["mpg123", "-q"])


def say(line):
    sys.stdout.write(line + "\n")  # one write, so the player thread's lines don't interleave with ours
    sys.stdout.flush()


def labs(method, path, body=None, stream=False):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors.
    With stream=True a successful answer comes back unread, so its events can be taken as they arrive."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp if stream and resp.status < 400 else resp.read()
    say(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
        + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


def events(resp):
    """Yields (event, data) from a text/event-stream answer, one event at a time."""
    event = None
    for raw in resp:
        line = raw.decode().rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            yield event, json.loads(line[5:])


MARKER = re.compile(r"(^|\n)[ \t]*(?:[-*+•]|\d+[.)]|#{1,6})[ \t]+")  # list and heading markers at a line start
DONE = re.compile(r"[\s\S]*(?:[.!?…]\s|\n)")  # everything up to the last sentence end or line break


def sentences(pending, final=False):
    """Splits off the whole sentences in `pending`. Returns (sentences, what is left over)."""
    pending = MARKER.sub(r"\1", pending)
    cut = len(pending) if final else (m.end() if (m := DONE.match(pending)) else 0)
    ready = re.sub(r"\*\*|__|`", "", pending[:cut])  # bold and code marks
    return [s.strip() for s in re.split(r"(?<=[.!?…])\s+|\n+", ready) if s.strip()], pending[cut:]


question = next((a for a in sys.argv[1:] if not a.startswith("--")), "Tell me about your breads and when you are open.")
player = None if "--no-play" in sys.argv else next((p for p in PLAYERS if shutil.which(p[0])), None)
voice_id = data_of(labs("GET", f"/developer-platform/agents/{AGENT}"), "Could not read the agent")["voiceId"] or sys.exit(
    f"The agent has no voice. Set one: PATCH /developer-platform/agents/{AGENT} with {{\"voiceId\": ...}}.")

sent = time.time()
since = lambda: f"[+{time.time() - sent:.1f}s]"
speech = ThreadPoolExecutor(max_workers=2)  # at most 2 speech calls in flight
clips = queue.Queue()  # (text, future audio) in the order of the text; None ends the answer
held = []  # sentences gathered for the first clip; None once it has gone
credits = []


def speak(text):
    status, headers, audio = labs("POST", f"/voice-audio/voices/{voice_id}/speech", {"text": text, "outputFormat": "mp3_44100_64"})
    credits.append(int(headers.get("X-Credits-Charged") or 0))
    return audio if status == 200 else b""


def play_in_order():
    os.makedirs("out", exist_ok=True)
    with open("out/07-voice-agent.mp3", "wb") as out:
        n = 0
        while (item := clips.get()) is not None:
            n += 1
            text, audio = item[0], item[1].result()  # waits for this clip, even if a later one is already done
            say(f"{since()} play {n}: {text}")
            out.write(audio)
            if player and audio:
                pathlib.Path("out/07-clip.mp3").write_bytes(audio)
                subprocess.run([*player, "out/07-clip.mp3"], check=False)
    say(f"{since()} done: {n} clips, {sum(credits)} speech credits, saved to out/07-voice-agent.mp3")


def release(s):
    global held
    if s.startswith("Read more:"):
        return say(f"{since()} link: {s[len('Read more:'):].strip()}")
    say(f"{since()} text: {s}")
    s = s if s[-1] in ".!?…:;," else s + "."  # a list item has no full stop; without one, joined items run together
    if held is None:
        return clips.put((s, speech.submit(speak, s)))
    held.append(s)
    if len(" ".join(held)) > FIRST_CLIP:
        clips.put((" ".join(held), speech.submit(speak, " ".join(held))))
        held = None


playing = threading.Thread(target=play_in_order)
playing.start()
chat_id = data_of(labs("POST", "/developer-platform/chats", {"agentId": AGENT}), "Could not open a chat")["chatId"]
status, _, resp = labs("POST", f"/developer-platform/chats/{chat_id}/messages", {"text": question}, stream=True)
pending = ""
for event, data in events(resp) if status == 200 else []:
    if event == "message.delta":
        ready, pending = sentences(pending + data["text"])
        for s in ready:
            release(s)
for s in sentences(pending, final=True)[0]:
    release(s)
if held:  # a short answer: everything is in the first clip
    clips.put((" ".join(held), speech.submit(speak, " ".join(held))))
clips.put(None)
playing.join()
