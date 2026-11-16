"""setup-05 · Save the agent's configuration before a change, and put it back.

Labs has no publish or roll-back yet: every flow save is live at once. So save a snapshot before each change
(setup-03, setup-04, a voice change) and restore it if the change goes wrong. A snapshot holds the agent's own
fields and its whole flow (instructions, tools, knowledge base). Restoring saves the old flow as a new version
(versions only count up) and puts the agent's fields back with PATCH. Restore the newest snapshot taken before
the change: an older one also undoes everything since, such as a knowledge base bound by setup-04.

Run: uv run python site-setup/setup-05-snapshot-restore.py save
     uv run python site-setup/setup-05-snapshot-restore.py list
     uv run python site-setup/setup-05-snapshot-restore.py restore snapshots/<agent>/<file>.json
"""
import json, os, pathlib, sys, time, urllib.error, urllib.request

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
AGENT = os.environ.get("LABS_AGENT_ID") or sys.exit("Set LABS_AGENT_ID in .env (setup-02 makes one).")
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
FIELDS = ("name", "description", "voiceId", "storeName", "status", "avatarId")  # what PATCH can change
SNAPSHOTS = pathlib.Path("snapshots")


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


def read_flow():
    return data_of(labs("GET", f"/developer-platform/agents/{AGENT}/flow"), "Could not read the agent's flow")


def prompt_of(flow):
    entry = next((n for n in flow["nodes"] if n.get("type") == "initial"), flow["nodes"][0] if flow["nodes"] else None)
    return entry["data"]["prompt"]["value"] if entry else ""


command = sys.argv[1] if len(sys.argv) > 1 else "list"
if command == "save":
    agent, flow = data_of(labs("GET", f"/developer-platform/agents/{AGENT}"), "Could not read the agent"), read_flow()
    path = SNAPSHOTS / AGENT / f"{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-v{flow['version']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                "agent": {k: agent.get(k) for k in FIELDS},
                                "flow": {k: flow[k] for k in ("version", "nodes", "edges", "meta")}}, indent=1))
    print(f"saved:    {path} (flow version {flow['version']}, {len(prompt_of(flow))}-character instructions)")
elif command == "list":
    for path in sorted((SNAPSHOTS / AGENT).glob("*.json")):
        snap = json.loads(path.read_text())
        entry = next((n for n in snap["flow"]["nodes"] if n.get("type") == "initial"), {"data": {}})["data"]
        print(f"{path}  {snap['savedAt']}  flow version {snap['flow']['version']}  "
              f"{len(prompt_of(snap['flow']))}-character instructions  knowledge base {entry.get('knowledge_base_id') or 'none'}  "
              f"voice {snap['agent']['voiceId']}")
elif command == "restore" and len(sys.argv) > 2:
    snap = json.loads(pathlib.Path(sys.argv[2]).read_text())
    # The agent's fields first: a PATCH can itself save a flow version, so the flow goes back last.
    status, _, _ = labs("PATCH", f"/developer-platform/agents/{AGENT}", {k: v for k, v in snap["agent"].items() if v is not None})
    if status != 200:
        sys.exit("Nothing was restored: see the body above.")
    current = read_flow()
    status, _, body = labs("PUT", f"/developer-platform/agents/{AGENT}/flow", {
        "baseVersion": current["version"], "nodes": snap["flow"]["nodes"], "edges": snap["flow"]["edges"],
        "meta": snap["flow"]["meta"]})
    if status != 200:
        sys.exit("The agent's fields are restored, but the flow is not: see the body above.")
    print(f"restored: agent fields put back; flow version {snap['flow']['version']} saved again as version "
          f"{json.loads(body)['data']['version']}")
else:
    sys.exit("Usage: setup-05-snapshot-restore save | list | restore snapshots/<agent>/<file>.json")
