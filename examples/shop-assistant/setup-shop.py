"""shop-assistant · Set up the shop's agent: catalogue, instructions and basket.

Loads your catalogue (the CSV that shop.yaml names, with at least `id`, `name` and `price` columns) into a product
search collection (a catalogue never goes in a knowledge base: those are for documents), builds the instructions
from instructions.txt and shop.yaml (store name, currency, store policies), and
creates an agent on that collection with a voice and the built-in `modify_cart` tool. No shop needs connecting: the
basket lives on the platform, one per chat. The collection's full name and the agent's id go into .env as
SHOP_COLLECTION and SHOP_AGENT_ID.

Run it again after changing the catalogue, shop.yaml or instructions.txt: it loads the catalogue again (a product
whose id is already there is updated) and saves the new instructions as a new flow version of the same agent. Test
each change in a new chat. A product taken out of the catalogue stays in the collection: delete the collection to
start clean.

Run, from examples/: uv run python shop-assistant/setup-shop.py [--dry-run]   (--dry-run prints the instructions only)
"""
import csv, json, os, pathlib, sys, time, urllib.error, urllib.request
import yaml

sys.stdout.reconfigure(line_buffering=True)
HERE = pathlib.Path(__file__).resolve().parent
ENV = next((d / ".env" for d in HERE.parents if (d / ".env").exists()), HERE.parent.parent / ".env")
for line in ENV.read_text().splitlines() if ENV.exists() else []:
    k, _, v = line.partition("=")
    if k.strip() and not k.lstrip().startswith("#"):
        os.environ.setdefault(k.strip(), v.strip())
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
LIMIT = 20000  # characters of instructions, on create and on a flow save alike
TOOLS = ["modify_cart"]  # built-in basket; the catalogue search comes with the collection. Not checkout: see the README
REQUIRED = ("id", "name", "price")  # every other column is stored with the product, and searched by meaning
NOT_SEARCHED = {"image_url", "sizes"}

if not (HERE / "shop.yaml").exists():
    sys.exit("Copy shop-assistant/shop.example.yaml to shop-assistant/shop.yaml and fill in your shop.")
shop = yaml.safe_load((HERE / "shop.yaml").read_text(encoding="utf-8"))
CATALOGUE = HERE / shop["catalogue"]


def labs(method, path, body=None, content_type="application/json"):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, method=method, data=data,
                                 headers={"X-API-KEY": KEY, "Content-Type": content_type, "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        resp = e
    out = resp.read()
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + out.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, out


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


def set_env(name, value):
    """Sets NAME=value in .env, replacing the line if there is one."""
    lines = [line for line in (ENV.read_text() if ENV.exists() else "").splitlines() if not line.startswith(f"{name}=")]
    ENV.write_text("\n".join(lines + [f"{name}={value}"]) + "\n")


def instructions():
    """instructions.txt with the shop's name, currency and policies filled in."""
    text = (HERE / "instructions.txt").read_text(encoding="utf-8")
    policies = "\n".join(f"- {p}" for p in shop["policies"])
    return text.replace("{store}", shop["storeName"]).replace("{currency}", shop["currency"]).replace("{policies}", policies)


text = instructions()
if len(text) > LIMIT:
    sys.exit(f"The instructions are {len(text)} characters; the limit is {LIMIT}. Shorten instructions.txt or the policies.")
if "--dry-run" in sys.argv:
    print(text)
    print(f"\n{len(text)} of {LIMIT} characters. Nothing was saved.")
    sys.exit()
if not CATALOGUE.is_file():
    sys.exit(f"No catalogue at {CATALOGUE}: put your CSV there, or set `catalogue` in shop.yaml.")
rows = list(csv.DictReader(CATALOGUE.open(encoding="utf-8-sig")))
columns = list(rows[0]) if rows else []
if missing := [c for c in REQUIRED if c not in columns]:
    sys.exit(f"The catalogue needs the columns {', '.join(REQUIRED)}; it has no {', '.join(missing)}.")
print(f"catalogue: {len(rows)} products; instructions: {len(text)} of {LIMIT} characters")

# 1. The catalogue, as a product search collection. Its name starts with the account's collection prefix: the
# first ingest without it is refused with a 422 that names the prefix, and is sent again with it.
def product(r):
    """One catalogue row as a product: id, title, price and currency, then every other column as it is. An
    `image_url` that is a web address goes along as the product's picture; a file path is for the page only."""
    p = {"product_id": r["id"], "title": r["name"], "price": float(r["price"]), "currency": shop["currencyCode"],
         "in_stock": True}
    p.update({k: v for k, v in r.items() if k not in REQUIRED + ("image_url",) and v})
    if (r.get("image_url") or "").startswith(("https://", "http://")):
        p["main_image_url"] = r["image_url"]
    return p


products = [product(r) for r in rows]
SEARCHED = ["title"] + [c for c in columns if c not in REQUIRED and c not in NOT_SEARCHED]
collection = os.environ.get("SHOP_COLLECTION") or shop["collection"]
while True:
    status, body = labs("POST", "/developer-platform/vector/ingest",
                        {"collection_name": collection, "products": products, "embedding_fields": SEARCHED})
    prefix = json.loads(body).get("context", {}).get("collection_prefix") if status == 422 else None
    if not prefix or collection.lower().startswith(prefix.lower()):
        break
    collection = prefix + collection
if status >= 300:
    sys.exit("The catalogue was refused: see the body above.")
started, ingest = time.time(), json.loads(body)
collection = ingest["collection_name"]
set_env("SHOP_COLLECTION", collection)
while True:  # the ingest answers are not wrapped in `data`
    status, body = labs("GET", f"/developer-platform/vector/ingest/progress/{ingest['progress_key']}")
    if status >= 300:
        sys.exit("Could not read the ingest: see the body above.")
    if (state := json.loads(body))["status"] in ("completed", "failed", "cancelled"):
        break
    time.sleep(3)
if state["status"] != "completed":
    sys.exit(f"The ingest ended {state['status']}; the collection holds what it held before.")
print(f"catalogue: {collection}, {len(products)} products searchable after {time.time() - started:.0f} s")

# 2. The agent: created once, then each run saves the instructions as a new flow version.
agent = os.environ.get("SHOP_AGENT_ID")
if agent and labs("GET", f"/developer-platform/agents/{agent}")[0] != 200:
    agent = None
if agent:
    flow = data_of(labs("GET", f"/developer-platform/agents/{agent}/flow"), "Could not read the agent's flow")
    entry = next((n for n in flow["nodes"] if n.get("type") == "initial"), flow["nodes"][0])
    entry["data"]["prompt"]["value"] = text
    saved = data_of(labs("PUT", f"/developer-platform/agents/{agent}/flow",
                         {"baseVersion": flow["version"], "nodes": flow["nodes"], "edges": flow["edges"]}),
                    "The instructions were not saved")
    print(f"agent:     {agent}, instructions saved as flow version {saved['version']}")
else:
    voice = shop.get("voiceId")
    if not voice:
        voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
        voice = next(v["id"] for v in voices if v["isPublic"] and v["status"] == "ready")
    created = data_of(labs("POST", "/developer-platform/agents", {
        "name": shop["agentName"], "instructions": text, "welcomeMessage": shop["welcome"],
        "storeName": shop["storeName"], "productSearchCollection": collection, "voiceId": voice, "tools": TOOLS}),
        "Could not create the agent")
    agent = created["id"]
    set_env("SHOP_AGENT_ID", agent)
    print(f"agent:     {created['name']} ({agent}), voice {created['voiceId']}, saved as SHOP_AGENT_ID")

def enabled():
    nodes = data_of(labs("GET", f"/developer-platform/agents/{agent}/tools"), "Could not read the agent's tools")
    return {t["name"] for node in nodes if node["entry"] for t in node["tools"]}


have = enabled()  # keep the built-ins in step with TOOLS; each change saves a flow version
for name in sorted(set(TOOLS) - have):
    labs("POST", f"/developer-platform/agents/{agent}/tools", {"name": name})
for name in sorted(have - set(TOOLS) - {"search_knowledge"}):
    labs("DELETE", f"/developer-platform/agents/{agent}/tools/{name}")
print(f"tools:     {', '.join(sorted(enabled()))}")
print("next:      uv run python shop-assistant/server.py   then open http://localhost:8050")
