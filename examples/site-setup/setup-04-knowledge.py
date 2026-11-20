"""setup-04 · Upload the site's pages as knowledge; run it again on every publish.

Reads the built HTML pages in `knowledge.source` (Q5) into one row per page: its address, title and text. A
.txt or .md upload is refused, so the rows go up as a CSV (also saved to out/knowledge.csv) to the knowledge base
in LABS_KB_ID, which is created and saved to .env the first time. When the new document is `ready`, the older
ones are deleted: while both are in the base, answers mix old and new. An agent that has no knowledge base yet is
bound to it through its flow (`knowledge_base_id` plus the `search_knowledge` tool), since PATCH can't do it.

Run: uv run python site-setup/setup-04-knowledge.py
"""
import html, json, os, pathlib, re, sys, time, urllib.error, urllib.request, uuid
import yaml

sys.stdout.reconfigure(line_buffering=True)
ENV = next((d / ".env" for d in pathlib.Path(__file__).resolve().parents if (d / ".env").exists()), pathlib.Path(".env"))
for line in ENV.read_text().splitlines() if ENV.exists() else []:
    k, _, v = line.partition("=")
    if k.strip() and not k.lstrip().startswith("#"):
        os.environ.setdefault(k.strip(), v.strip())
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
AGENT = os.environ.get("LABS_AGENT_ID") or sys.exit("Set LABS_AGENT_ID in .env (setup-02 makes one).")
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
ANSWERS = pathlib.Path("site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = pathlib.Path(__file__).parent / "site-assistant.example.yaml"


def labs(method, path, body=None, content_type="application/json"):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, method=method, data=data,
                                 headers={"X-API-KEY": KEY, "Content-Type": content_type, "User-Agent": UA})
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


def address(relative):
    """The page's address: index.html -> /, breads.html -> /breads, visit/index.html -> /visit."""
    return ("/" + re.sub(r"(^|/)index$", "", re.sub(r"\.html?$", "", relative))).rstrip("/") or "/"


def clean(text):
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def page(source):
    """(title, text) of an HTML page: its <main> (or <body>), without scripts, styles, navigation, header, footer."""
    title = re.search(r"<title[^>]*>([\s\S]*?)</title>", source, re.I)
    body = re.search(r"<main[^>]*>([\s\S]*?)</main>", source, re.I) or re.search(r"<body[^>]*>([\s\S]*?)</body>", source, re.I)
    text = re.sub(r"<(script|style|nav|header|footer)\b[\s\S]*?</\1>", " ", body.group(1) if body else source, flags=re.I)
    return clean(title.group(1)) if title else "", clean(re.sub(r"<[^>]+>", " ", text))


def csv(rows):
    return "".join(",".join('"' + cell.replace('"', '""') + '"' for cell in row) + "\n" for row in rows)


site = yaml.safe_load(ANSWERS.read_text())
source = pathlib.Path(site["knowledge"]["source"])
files = sorted(p for p in source.rglob("*") if p.suffix.lower() in (".html", ".htm"))
if not files:
    sys.exit(f"No .html pages in {source} (knowledge.source in {ANSWERS.name}).")
rows = [("page", "title", "text")] + [(address(p.relative_to(source).as_posix()), *page(p.read_text())) for p in files]
data = csv(rows).encode()
os.makedirs("out", exist_ok=True)
pathlib.Path("out/knowledge.csv").write_bytes(data)
print(f"pages:    {len(files)} from {source}: {', '.join(r[0] for r in rows[1:])} ({len(data)} bytes, out/knowledge.csv)")

kb = os.environ.get("LABS_KB_ID")
if not kb:
    kb = data_of(labs("POST", "/unstructured-data/knowledge-bases", {"name": f"{site['storeName']} site pages"}),
                 "Could not create the knowledge base")["id"]
    set_env("LABS_KB_ID", kb)
    print(f"created:  knowledge base {kb}, saved as LABS_KB_ID in {ENV.name}")
listed = data_of(labs("GET", f"/unstructured-data/knowledge-bases/{kb}/documents?pageSize=100"), "Could not list the documents")
older = [d["id"] for d in listed["items"]]

boundary = uuid.uuid4().hex
form = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="site-pages.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
status, _, body = labs("POST", f"/unstructured-data/knowledge-bases/{kb}/documents", form,
                       f"multipart/form-data; boundary={boundary}")
if status != 202:
    sys.exit("The upload was refused: see the body above.")
doc, started = json.loads(body)["data"]["id"], time.time()
while True:  # accepted is not searchable: wait for `ready`
    state = data_of(labs("GET", f"/unstructured-data/knowledge-bases/{kb}/documents/{doc}"), "Could not read the document")
    if state["status"] in ("ready", "failed"):
        break
    time.sleep(5)
if state["status"] == "failed":
    sys.exit(f"Indexing failed ({state.get('error')}); the previous pages are still in place.")
print(f"ready:    document {doc} after {time.time() - started:.0f} s")
for old in older:
    labs("DELETE", f"/unstructured-data/knowledge-bases/{kb}/documents/{old}")
print(f"removed:  {len(older)} older document(s)")

if data_of(labs("GET", f"/developer-platform/agents/{AGENT}"), "Could not read the agent")["knowledgeBaseId"] == kb:
    print("agent:    already searches this knowledge base")
else:
    flow = data_of(labs("GET", f"/developer-platform/agents/{AGENT}/flow"), "Could not read the agent's flow")
    entry = next((n for n in flow["nodes"] if n.get("type") == "initial"), flow["nodes"][0])
    entry["data"]["knowledge_base_id"] = kb
    tools = entry["data"].setdefault("tools", {}).setdefault("local", [])
    if "search_knowledge" not in tools:
        tools.append("search_knowledge")
    status, _, body = labs("PUT", f"/developer-platform/agents/{AGENT}/flow",
                           {"baseVersion": flow["version"], "nodes": flow["nodes"], "edges": flow["edges"]})
    if status != 200:
        sys.exit("The agent was not bound to the knowledge base: see the body above.")
    print(f"agent:    now searches knowledge base {kb} (flow version {json.loads(body)['data']['version']})")
