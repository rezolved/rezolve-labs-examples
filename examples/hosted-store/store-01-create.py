"""hosted-store · 01 List, create or delete a store.

With no arguments, lists your stores: your first store and the ones you added, each with its id and its page. With a
name, creates a store and saves its id in .env as STORE_ID. With --delete, deletes the store in STORE_ID, with its
catalogue and orders (this cannot be undone; your first store can't be deleted this way).

To work on a store that already exists, put its id in .env as STORE_ID and skip the create.

Run, from examples/: uv run python hosted-store/store-01-create.py ["My Shop" [--currency GBP]] [--delete]
"""
import argparse, json, os, pathlib, sys, urllib.error, urllib.request

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
SHOP_HOST = "https://commerce.rezolvelabs.com"  # where storefrontPath is served

def labs(method, path, body=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
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
    return json.loads(body)["data"] if body else None

def set_env(name, value):
    """Sets NAME=value in .env (removes the line when value is None)."""
    lines = [line for line in (ENV.read_text() if ENV.exists() else "").splitlines() if not line.startswith(f"{name}=")]
    ENV.write_text("\n".join(lines + ([f"{name}={value}"] if value is not None else [])) + "\n")

def show(store):
    counts = store.get("counts") or {}
    print(f"  {store['id']:<28} {store['name']:<24} {store['currency']}  products={counts.get('products', 0)}"
          f"  orders={counts.get('orders', 0)}  page={SHOP_HOST}{store['storefrontPath']}")

cli = argparse.ArgumentParser(description="List your stores, create one, or delete the one in STORE_ID.")
cli.add_argument("name", nargs="?", help="create a store with this name")
cli.add_argument("--currency", default="GBP", choices=("GBP", "EUR", "USD", "AUD"), help="its main currency")
cli.add_argument("--delete", action="store_true", help="delete the store in STORE_ID")
args = cli.parse_args()
if args.delete:
    store_id = os.environ.get("STORE_ID") or sys.exit("No STORE_ID in .env: nothing to delete.")
    data_of(labs("DELETE", f"/commerce/stores/{store_id}"), "Delete failed")
    set_env("STORE_ID", None)
    print(f"Deleted {store_id} and removed STORE_ID from .env.")
elif args.name:
    store = data_of(labs("POST", "/commerce/stores", {"name": args.name, "currency": args.currency}), "Create failed")
    set_env("STORE_ID", store["id"])
    show(store)
    print("Saved STORE_ID in .env. Next: hosted-store/store-02-catalogue with your catalogue CSV.")
else:
    print("Your stores:")
    show(data_of(labs("GET", "/commerce/store"), "Could not read your first store"))
    for store in data_of(labs("GET", "/commerce/stores"), "Could not list your stores"):
        show(store)
    print("Put the id of the store to work on in .env as STORE_ID, or pass a name to create one.")
