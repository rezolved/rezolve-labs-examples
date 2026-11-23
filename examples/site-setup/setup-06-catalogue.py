"""setup-06 · Load the product catalogue and give it to a product desk; run it again when the catalogue changes.

A catalogue goes in a product search collection, never in the knowledge base, and one step of an agent searches a
knowledge base or a collection, not both. So the site's pages stay with the agent's first step (setup-04), and the
catalogue goes to a second step, the product desk, which the first hands product questions to with
`transfer_to_product_desk`. This loads `catalogue.source` (Q5), a CSV with at least `id`, `name` and `price`
columns, into the collection in LABS_COLLECTION (made the first time, with the account's prefix, and saved to .env),
waits until it is searchable, then adds the product desk to the agent's flow, or points the one it has at the
collection. setup-03 writes both steps' instructions: run it after this one.

Run: uv run python site-setup/setup-06-catalogue.py
"""
import csv, json, os, pathlib, re, sys, time, urllib.error, urllib.request
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
REQUIRED = ("id", "name", "price")  # every other column is stored with the product, and searched by meaning
DESK = "product_desk"


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
catalogue = site.get("catalogue") or {}
if not catalogue.get("source"):
    sys.exit(f"No catalogue: set catalogue.source in {ANSWERS.name} (Q5) to the owner's CSV.")
rows = list(csv.DictReader(open(catalogue["source"], encoding="utf-8-sig", newline="")))
columns = list(rows[0]) if rows else []
if missing := [c for c in REQUIRED if c not in columns]:
    sys.exit(f"The catalogue needs the columns {', '.join(REQUIRED)}; it has no {', '.join(missing)}.")
if bad := [r["id"] for r in rows if not re.fullmatch(r"[0-9]+(\.[0-9]+)?", r["price"].strip())]:
    sys.exit(f"A price must be a plain number, such as 6.50, with no currency sign; not in {', '.join(bad[:10])}.")


def product(r):
    """One catalogue row as a product: id, title, price and currency, then every other column as it is. An
    `image_url` that is a web address goes along as the product's picture."""
    p = {"product_id": r["id"], "title": r["name"], "price": float(r["price"]), "currency": catalogue["currency"],
         "in_stock": True}
    p.update({k: v for k, v in r.items() if k not in REQUIRED + ("image_url",) and v})
    if (r.get("image_url") or "").startswith(("https://", "http://")):
        p["main_image_url"] = r["image_url"]
    return p


products = [product(r) for r in rows]
searched = ["title"] + [c for c in columns if c not in REQUIRED + ("image_url",)]
print(f"catalogue: {len(products)} products from {catalogue['source']}, searched by {', '.join(searched)}")

# 1. The collection: its name needs the account's prefix, which the first refusal names
collection = os.environ.get("LABS_COLLECTION") or re.sub(r"[^a-z0-9]+", "_", site["storeName"].lower()).strip("_") + "_catalogue"
while True:
    status, _, body = labs("POST", "/developer-platform/vector/ingest",
                           {"collection_name": collection, "products": products, "embedding_fields": searched})
    prefix = json.loads(body).get("context", {}).get("collection_prefix") if status == 422 else None
    if not prefix or collection.lower().startswith(prefix.lower()):
        break
    collection = prefix + collection
if status >= 300:
    sys.exit("The catalogue was refused: see the body above.")
ingest, started = json.loads(body), time.time()  # the ingest answers are not wrapped in `data`
collection = ingest["collection_name"]
set_env("LABS_COLLECTION", collection)
while True:
    status, _, body = labs("GET", f"/developer-platform/vector/ingest/progress/{ingest['progress_key']}")
    if status >= 300:
        sys.exit("Could not read the ingest: see the body above.")
    if (state := json.loads(body))["status"] in ("completed", "failed", "cancelled"):
        break
    time.sleep(3)
if state["status"] != "completed":
    sys.exit(f"The ingest ended {state['status']}; the collection holds what it held before.")
print(f"ready:    {collection}, searchable after {time.time() - started:.0f} s (LABS_COLLECTION in {ENV.name})")

# 2. The product desk: a second step on the collection, which the first step hands product questions to
for attempt in (1, 2):  # a 409 means someone saved since we read: read again and reapply
    flow = data_of(labs("GET", f"/developer-platform/agents/{AGENT}/flow"), "Could not read the agent's flow")
    entry = next((n for n in flow["nodes"] if n.get("type") == "initial"), flow["nodes"][0])
    desk = next((n for n in flow["nodes"] if n["id"] == DESK), None)
    if desk and desk["data"].get("product_search_collection") == collection:
        print(f"agent:    the product desk already searches {collection}")
        break
    if not desk:  # the step and its route, shaped as a manifest makes them; setup-03 writes its instructions
        desk = {"id": DESK, "type": "node", "position": {"x": 0, "y": 160},
                "data": {"name": DESK, "factory": "tool_agent", "description": "", "tools": {"local": ["search_knowledge"]},
                         "prompt": {"type": "inline", "value": f"You answer questions about {site['storeName']}'s products."}}}
        route = {"id": f"route_{DESK}", "from": entry["id"], "to": DESK, "kind": "route", "trigger_tool": f"transfer_to_{DESK}"}
        flow["nodes"].append(desk)
        flow["edges"].append({"id": route["id"], "source": entry["id"], "target": DESK, "data": route})  # from/to must name the steps
    desk["data"]["product_search_collection"] = collection
    status, _, body = labs("PUT", f"/developer-platform/agents/{AGENT}/flow",
                           {"baseVersion": flow["version"], "nodes": flow["nodes"], "edges": flow["edges"]})
    if status != 409 or attempt == 2:
        if status != 200:
            sys.exit("The product desk was not saved: see the body above.")
        print(f"agent:    the product desk searches {collection} (flow version {json.loads(body)['data']['version']})")
        break
print("next:     setup-03-build-instructions writes both steps' instructions")
