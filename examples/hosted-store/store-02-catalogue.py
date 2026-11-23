"""hosted-store · 02 Load your catalogue into the store.

Reads your catalogue CSV (a header row; `product_id`, `title`, `category` and `price` required), turns each row into
the JSON record the store takes, uploads them all with PUT …/catalog, and waits for the job. The upload REPLACES the
store's whole catalogue: on a store that already has products the script stops unless you pass --replace.

Columns: `category` is up to three levels split by `>` ("Women > Dresses"); `price` and `original_price` are plain
numbers in --currency; `additional_image_url`, `sizes`, `colors` and `tags` take several values split by `|`;
`brand`, `gender`, `description`, `product_url` and `main_image_url` are optional text.

Run, from examples/: uv run python hosted-store/store-02-catalogue.py my-catalogue.csv [--currency GBP] [--replace]
"""
import argparse, csv, json, os, pathlib, sys, time, urllib.error, urllib.request

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
STORE = os.environ.get("STORE_ID") or sys.exit("Set STORE_ID in .env (run hosted-store/store-01-create first).")
REQUIRED = ("product_id", "title", "category", "price")
TEXT = ("brand", "gender", "description", "product_url", "main_image_url")
LISTS = ("additional_image_url", "sizes", "colors", "tags")
MOST = 20000  # products in one upload

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
    return json.loads(body)["data"]

def record(row, n, currency):
    """One CSV row as a catalogue record. The store refuses a bad record with only "Invalid input", so check here."""
    for col in REQUIRED:
        if not (row.get(col) or "").strip():
            sys.exit(f"Row {n}: {col} is required.")
    try:
        price = float(row["price"])
    except ValueError:
        sys.exit(f"Row {n}: price must be a number, such as 49.95.")
    rec = {"product_id": row["product_id"].strip(), "title": row["title"].strip(),
           "category": [c.strip() for c in row["category"].split(">") if c.strip()][:3],  # an array, not "A > B"
           "price": [{"currency": currency, "value": price}]}  # a list of prices, not a number
    if (row.get("original_price") or "").strip():
        rec["original_price"] = [{"currency": currency, "value": float(row["original_price"])}]
    rec |= {col: row[col].strip() for col in TEXT if (row.get(col) or "").strip()}
    rec |= {col: [v.strip() for v in row[col].split("|") if v.strip()] for col in LISTS if (row.get(col) or "").strip()}
    return rec

cli = argparse.ArgumentParser(description="Load a catalogue CSV into the store in STORE_ID.")
cli.add_argument("csv")
cli.add_argument("--currency", default="GBP", choices=("GBP", "EUR", "USD", "AUD"), help="the currency of the prices")
cli.add_argument("--replace", action="store_true", help="replace a catalogue the store already has")
args = cli.parse_args()
with open(args.csv, newline="", encoding="utf-8-sig") as f:
    records = [record(row, n, args.currency) for n, row in enumerate(csv.DictReader(f), start=2)]
ids = [r["product_id"] for r in records]
if not records or len(records) > MOST:
    sys.exit(f"The file has {len(records)} products; send 1 to {MOST}.")
if len(set(ids)) != len(ids):
    sys.exit(f"product_id {next(i for i in ids if ids.count(i) > 1)} appears twice.")

store = data_of(labs("GET", f"/commerce/stores/{STORE}"), "Could not read the store")
if store["counts"]["products"] and not args.replace:
    sys.exit(f"{STORE} already has {store['counts']['products']} products and the upload replaces them all. "
             "Pass --replace to go ahead.")
job = data_of(labs("PUT", f"/commerce/stores/{STORE}/catalog", {"records": records}), "Upload refused")
print(f"Uploading {job['records']} products as job {job['jobId']}")
while (state := data_of(labs("GET", f"/commerce/stores/{STORE}/jobs/{job['jobId']}"), "Could not read the job"))["state"] not in ("COMPLETED", "FAILED"):
    time.sleep(3)
if state["state"] == "FAILED":
    sys.exit(f"The job failed: {state['error']}")
result = state["result"]
print(f"Imported {result['imported']} ({result['forSale']} for sale), {result['collections']} departments.")
for c in data_of(labs("GET", f"/commerce/stores/{STORE}/collections"), "Could not list departments"):
    print(f"  department {c['slug']}: {c['name']}")
if not result.get("labsEnrichmentStarted"):
    print("Word search is not being set up for this store: searches with words will find nothing (browse works).")
