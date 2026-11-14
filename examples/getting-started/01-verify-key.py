"""01 · Verify the key.

Checks LABS_API_KEY with GET /api-keys/verify (free) and prints its kind, plan, rate limit and the families it
can call. Every call sends an explicit User-Agent: Python's default one is refused at the network edge.

Run: uv run python getting-started/01-verify-key.py
"""
import json, os, pathlib, sys, urllib.error, urllib.request

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
UA = "labs-playbook-examples/1.0"  # any explicit User-Agent works; Python's default gets 503 upstream_edge_block


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


status, _, body = labs("GET", "/api-keys/verify")
if status != 200:
    sys.exit("The key was refused: see the body above.")
key = json.loads(body)
print(f"key:        {key['kind']} ({key['environment']})")
print(f"plan:       {key['plan']}, {key['rate_limit_per_minute']} requests a minute")
print(f"families:   {', '.join(f['slug'] for f in key['families'])}")
if key["kind"] != "secret":
    print("This key can only read. Your server needs a secret (sk) key; a publishable (pk) key is for browsers.")
