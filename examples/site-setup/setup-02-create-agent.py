"""setup-02 · Create the agent, with a voice.

Creates the agent from site-assistant.yaml (or the example) with its name, business, welcome line and a voice:
an agent created without `voiceId` has none (there is no default voice), and a call on it is refused. The voice
is `voiceId` from the YAML, or the first ready public voice. The new ids go into .env as LABS_AGENT_ID and
LABS_VOICE_ID. Then each of the owner's hard words is spoken twice, as written and as respelled, for the owner
to listen to in out/hard-words/. The instructions here are a stub: setup-03 builds the real ones.
If LABS_AGENT_ID is already set to a live agent, nothing is created.

Run: uv run python site-setup/setup-02-create-agent.py
"""
import json, os, pathlib, re, sys, urllib.error, urllib.request
import yaml

sys.stdout.reconfigure(line_buffering=True)
ENV = next((d / ".env" for d in pathlib.Path(__file__).resolve().parents if (d / ".env").exists()), pathlib.Path(".env"))
for line in ENV.read_text().splitlines() if ENV.exists() else []:
    k, _, v = line.partition("=")
    if k.strip() and not k.lstrip().startswith("#"):
        os.environ.setdefault(k.strip(), v.strip())
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
ANSWERS = pathlib.Path("site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = pathlib.Path(__file__).parent / "site-assistant.example.yaml"


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


def set_env(name, value):
    """Sets NAME=value in .env, replacing the line if there is one."""
    lines = [line for line in (ENV.read_text() if ENV.exists() else "").splitlines() if not line.startswith(f"{name}=")]
    ENV.write_text("\n".join(lines + [f"{name}={value}"]) + "\n")


site = yaml.safe_load(ANSWERS.read_text())
print(f"answers:  {os.path.relpath(ANSWERS)}")
if os.environ.get("LABS_AGENT_ID"):
    status, _, body = labs("GET", f"/developer-platform/agents/{os.environ['LABS_AGENT_ID']}")
    if status == 200:
        agent = json.loads(body)["data"]
        print(f"agent:    {agent['name']} ({agent['id']}) already exists. setup-03 changes its instructions; "
              "to make a new agent, empty LABS_AGENT_ID in .env.")
        sys.exit(0)

voice_id = site.get("voiceId")
if not voice_id:
    voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
    voice = next(v for v in voices if v["isPublic"] and v["status"] == "ready")
    voice_id = voice["id"]
    print(f"voice:    {voice['name']} ({voice['voiceType']}, public), the first ready public voice")

status, _, body = labs("POST", "/developer-platform/agents", {
    "name": site["name"],
    "storeName": site["storeName"],
    "description": f"Website assistant for {site['storeName']}",
    "welcomeMessage": site["welcomeMessage"],
    "voiceId": voice_id,
    "instructions": f"You are the website assistant for {site['storeName']}. Answer in one or two short sentences.",
})
if status != 201:
    sys.exit("The agent was not created: see the body above.")
agent = json.loads(body)["data"]
set_env("LABS_AGENT_ID", agent["id"])
set_env("LABS_VOICE_ID", voice_id)
print(f"agent:    {agent['name']} ({agent['id']}), voice {agent['voiceId']}")
print(f"saved:    LABS_AGENT_ID and LABS_VOICE_ID in {ENV.name}")

os.makedirs("out/hard-words", exist_ok=True)
for p in site.get("pronunciations") or []:
    slug = re.sub(r"[^a-z0-9]+", "-", p["word"].lower()).strip("-")
    saved = 0
    for suffix, text in (("as-written", p["word"]), ("respelled", p["sayAs"])):
        status, _, audio = labs("POST", f"/voice-audio/voices/{voice_id}/speech", {"text": f"{text}.", "outputFormat": "mp3_44100_64"})
        if status == 200:
            pathlib.Path(f"out/hard-words/{slug}-{suffix}.mp3").write_bytes(audio)
            saved += 1
    if saved == 2:
        print(f"listen:   out/hard-words/{slug}-as-written.mp3 and {slug}-respelled.mp3 (\"{p['word']}\" said as \"{p['sayAs']}\")")
    else:
        print(f"missing:  a clip for \"{p['word']}\" was not made (see the body above); run setup-02 again later")
print("next:     setup-03-build-instructions writes the agent's real instructions from the answers")
