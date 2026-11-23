"""hosted-store · 03 Shop the store the way an assistant would: find, basket, demonstration checkout, order.

Lists the departments, browses the first one that has products, tries a word search, reads a product, fills a
basket (add, change the quantity, add and remove a second product), checks out with the store's demonstration card
and reads the order back. Prices come back in minor units (4500 is 45.00).

Checkout places a real order in the store (paid with the demonstration card, no money moves); it shows in the
store's console. --no-checkout stops before it.

Run, from examples/: uv run python hosted-store/store-03-shop.py [--sku SKU] [--term "words"] [--no-checkout]
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
STORE = os.environ.get("STORE_ID") or sys.exit("Set STORE_ID in .env (run hosted-store/store-01-create first).")
S = f"/commerce/stores/{STORE}"
SHOPPER = {"emailAddress": "shopper@example.com", "firstName": "Sam", "lastName": "Shopper"}
ADDRESS = {"streetLine1": "1 High Street", "city": "London", "postalCode": "N1 1AA", "countryCode": "GB"}

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

def money(minor, currency):
    return f"{minor / 100:.2f} {currency}"

def basket(cart, what):
    lines = ", ".join(f"{l['quantity']} x {l['name']} ({l['sku']})" for l in cart["lines"]) or "empty"
    print(f"  {what}: {lines}; total {money(cart['totalWithTax'], cart['currency'])}")

cli = argparse.ArgumentParser(description="Find, basket, check out and read the order, on the store in STORE_ID.")
cli.add_argument("--sku", help="the product to buy (its product_id); else the first one found")
cli.add_argument("--term", help="words to search for; else the first word of the product's name")
cli.add_argument("--no-checkout", action="store_true", help="stop before the order is placed")
args = cli.parse_args()

# Find: departments come from the catalogue's `category`; browsing one needs no search set-up.
found = []
for dept in data_of(labs("GET", f"{S}/collections"), "Could not list departments"):
    found = data_of(labs("POST", f"{S}/search", {"collectionSlug": dept["slug"]}), "Browse failed")["items"]
    if found:
        print(f"Department {dept['name']}: {len(found)} products, such as {found[0]['name']}")
        break
if not found:
    sys.exit("The store has no products in any department: load a catalogue with hosted-store/store-02-catalogue.")
pick = next((p for p in found if p["sku"] == args.sku), None) if args.sku else found[0]
pick = pick or {"sku": args.sku, "name": args.sku, "slug": None}  # not in this department: add it by SKU anyway
other = next((p for p in found if p["sku"] != pick["sku"]), None)

term = args.term or pick["name"].split()[0]
hits = data_of(labs("POST", f"{S}/search", {"term": term}), "Search failed")["items"]
print(f"Search {term!r}: {len(hits)} hits" + ("" if hits else " (word search is off or still indexing; browse works)"))

if pick["slug"]:  # read a product by its slug, not its product_id
    product = data_of(labs("GET", f"{S}/products/{pick['slug']}"), "Could not read the product")
    v = product["variants"][0]
    print(f"Product {product['name']}: {money(v['priceWithTax'], v['currency'])}, {v['stockLevel']},"
          f" sizes {product['customFields'].get('sizes') or '-'} (text only: a basket line has no size)")

# Basket: one token per shopper; keep it in the shopper's session.
cart = data_of(labs("POST", f"{S}/carts", {}), "Could not create a basket")
C = f"{S}/carts/{cart['token']}"
cart = data_of(labs("POST", f"{C}/lines", {"sku": pick["sku"], "quantity": 1}), "Could not add the product")
line = cart["lines"][0]["id"]
cart = data_of(labs("PATCH", f"{C}/lines/{line}", {"quantity": 2}), "Could not change the quantity")
basket(cart, "after changing the quantity")
if other:
    cart = data_of(labs("POST", f"{C}/lines", {"sku": other["sku"], "quantity": 1}), "Could not add a second product")
    basket(cart, "with a second product")
    extra = next(l["id"] for l in cart["lines"] if l["sku"] == other["sku"])
    cart = data_of(labs("DELETE", f"{C}/lines/{extra}"), "Could not remove the line")
    basket(cart, "after removing it")
if args.no_checkout:
    sys.exit(f"Stopped before checkout. The basket {cart['code']} stays open.")

# Checkout, in this order: customer, address, shipping method, then checkout. Earlier answers 409.
data_of(labs("PUT", f"{C}/customer", SHOPPER), "Could not set the customer")
data_of(labs("PUT", f"{C}/shipping-address", ADDRESS), "Could not set the address")
ship = data_of(labs("GET", f"{C}/shipping-methods"), "Could not list shipping methods")[0]
data_of(labs("PUT", f"{C}/shipping-method", {"shippingMethodId": ship["id"]}), "Could not choose shipping")
pay = data_of(labs("GET", f"{C}/payment-methods"), "Could not list payment methods")
print(f"  shipping {ship['name']} ({money(ship['priceWithTax'], cart['currency'])}), payment {pay[0]['name']}")
order = data_of(labs("POST", f"{C}/checkout", {}), "Checkout failed")
print(f"Order {order['code']}: {order['state']}, total {money(order['totalWithTax'], order['currency'])}")
order = data_of(labs("GET", f"{S}/orders/{order['code']}"), "Could not read the order back")
basket(order, f"order {order['code']} as the store keeps it")
