"""setup-03 · Build the agent's instructions from the answers.

Builds the instructions from site-assistant.yaml every time, never by editing the old text, so no rule is lost:
persona (Q1), business (Q2), spellings (Q4, Q8), off-limits topics and redirects (Q7), house style (Q8), answer
length (Q9), what it cannot do and the contact page (Q15), and the pages it may point to (Q6, Q12), which end an
answer with a plain "Read more: /path" line. Checks the 20,000-character limit, then saves the text as the
prompt of the agent's flow: an agent's instructions can't be changed with PATCH. The save is a new flow
version, live at once; there is no publish step (setup-05 saves one to roll back to). An open chat may keep the
old instructions, so test each change in a new chat.

Run: uv run python site-setup/setup-03-build-instructions.py [--dry-run]   (--dry-run prints the text only)
"""
import json, os, pathlib, sys, urllib.error, urllib.request
import yaml

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
LIMIT = 20000  # characters, on create and on a flow save alike
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


def build(site):
    """The whole instructions text, from the answers alone."""
    store, persona, style, size = site["storeName"], site["persona"], site["style"], site["answerStyle"]
    contact = site["contact"]["path"]
    pages = site["followUp"]["offerNavigation"] and site["navigation"]["enabled"] and site["routes"]
    if persona["voice"] == "person":
        lines = [f"You are {persona['name']}, speaking in the first person for {store} on its website."]
    else:
        lines = [f'You are the website assistant for {store}. Speak for the business as "we".']
    lines += ["", "Answer only from the knowledge base and these instructions. If the answer is not there, say you don't "
              f"know and offer the contact page ({contact}).",
              "", "How to answer:",
              f"- Your answers are read aloud. Use at most {size['spokenMaxWords']} words in {size['spokenMaxSentences']} "
              f"sentence{'' if size['spokenMaxSentences'] == 1 else 's'}. If the visitor asks for more detail, use up to "
              f"{size['textMaxWords']} words.",
              "- Write plain sentences only: no markdown, lists, headings, bold, links or emoji.",
              f"- Tone: {style['tone']}. Use {style['spelling']} spelling, "
              f"{'with' if style['serialComma'] else 'without'} the serial comma."]
    spellings = style["brandSpellings"] + site["vocabulary"]
    if spellings:
        lines.append(f"- Spell these exactly as written: {', '.join(spellings)}.")
    if site["offLimits"]:
        lines += ["", "Off limits:"] + [f"- Do not discuss {topic}. Say politely that you can't help with that."
                                        for topic in site["offLimits"]]
    if site["redirects"]:
        lines += ["", "Redirects:"] + [f'- If asked about {r["topic"]}, say: "{r["say"]}"'
                                       + (f' End with "Read more: {r["path"]}".' if pages and r.get("path") else "")
                                       for r in site["redirects"]]
    if site["capabilities"]["cannot"]:
        lines += ["", "What you cannot do:"] + [f"- You cannot {c}." for c in site["capabilities"]["cannot"]]
        lines.append(f"- When asked, say so plainly and offer the contact page ({contact}).")
    if pages:
        lines += ["", 'Pages: when one of these pages answers the question, end your answer with a last line of its own, '
                  '"Read more: <path>", with the path exactly as listed. Never invent a path; leave the line out when '
                  "no page fits."]
        lines += [f"- {r['path']}: {r['label']}" + (f" (also: {', '.join(r['aliases'])})" if r["aliases"] else "")
                  for r in site["routes"]]
    return "\n".join(lines) + "\n"


site = yaml.safe_load(ANSWERS.read_text())
instructions = build(site)
print(f"answers:  {os.path.relpath(ANSWERS)}")
print(f"built:    {len(instructions)} characters (limit {LIMIT})")
if len(instructions) > LIMIT:
    sys.exit(f"Too long by {len(instructions) - LIMIT} characters: shorten the answers, or move facts into the "
             "knowledge base (setup-04).")
if "--dry-run" in sys.argv:
    print("\n" + instructions, end="")
    sys.exit(0)

agent = os.environ.get("LABS_AGENT_ID") or sys.exit("Set LABS_AGENT_ID in .env (setup-02 makes one).")
for attempt in (1, 2):  # a 409 means someone saved since we read: read again and reapply
    flow = data_of(labs("GET", f"/developer-platform/agents/{agent}/flow"), "Could not read the agent's flow")
    if not flow["nodes"]:
        sys.exit("This agent has no flow yet: create it with instructions (setup-02).")
    entry = next((n for n in flow["nodes"] if n.get("type") == "initial"), flow["nodes"][0])
    if entry["data"]["prompt"]["value"] == instructions:
        print(f"unchanged: flow version {flow['version']} already has these instructions")
        sys.exit(0)
    entry["data"]["prompt"] = {"type": "inline", "value": instructions}
    status, _, body = labs("PUT", f"/developer-platform/agents/{agent}/flow",
                           {"baseVersion": flow["version"], "nodes": flow["nodes"], "edges": flow["edges"]})
    if status != 409:
        break
if status != 200:
    sys.exit("The instructions were not saved: see the body above.")
print(f"saved:    flow version {json.loads(body)['data']['version']}, live now: test it in a new chat")
