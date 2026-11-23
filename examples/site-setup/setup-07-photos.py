"""setup-07 · Index the catalogue's photos, so a visitor can find a product by sending a photo of it.

The catalogue's collection (setup-06, LABS_COLLECTION) holds each product's `image_url`. This asks Labs to add those
photos to a photo index named after the collection, waits until every photo is indexed, and saves the index's name
as LABS_PHOTO_INDEX in .env: the server then takes photos in the chat (site-assistant/CONTRACT.md). Run it again
after the catalogue gains products: only new photos are charged. Pass a photo, as a file or a web address, to see
which products it finds, and their scores: the server names only those scoring at least `catalogue.photoMinScore`.
With --search it skips the sync, so trying photos takes seconds, not minutes.

Run: uv run python site-setup/setup-07-photos.py [--search] [photo]   (--search: only the search, on LABS_PHOTO_INDEX)
"""
import base64, json, os, pathlib, sys, time, urllib.error, urllib.request
import yaml

sys.stdout.reconfigure(line_buffering=True)
ENV = next((d / ".env" for d in pathlib.Path(__file__).resolve().parents if (d / ".env").exists()), pathlib.Path(".env"))
for line in ENV.read_text().splitlines() if ENV.exists() else []:
    k, _, v = line.partition("=")
    if k.strip() and not k.lstrip().startswith("#"):
        os.environ.setdefault(k.strip(), v.strip())
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
COLLECTION = os.environ.get("LABS_COLLECTION") or sys.exit("Set LABS_COLLECTION in .env (setup-06 loads the catalogue).")
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
VS = "/product-discovery/visual-search"
MODEL = "general-v1.5"  # kept for the index's life: to change it, delete the index and run this again
ANSWERS = pathlib.Path("site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = pathlib.Path(__file__).parent / "site-assistant.example.yaml"
MIN_SCORE = (yaml.safe_load(ANSWERS.read_text()).get("catalogue") or {}).get("photoMinScore")


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
    return resp.status, data


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


if "--search" in sys.argv:  # only the search, on the index made before: no waiting for a sync
    index = os.environ.get("LABS_PHOTO_INDEX") or sys.exit("No LABS_PHOTO_INDEX: run setup-07 without --search first.")
else:
    # 1. Ask for the collection's photos, then follow the sync: it starts within a minute
    sync = data_of(labs("POST", f"{VS}/collections/{COLLECTION}/photos", {"model": MODEL}), "The photos were not asked for")
    index, started = sync["indexName"], time.time()
    while sync["state"] not in ("done", "failed", "gave_up"):
        time.sleep(5)
        sync = data_of(labs("GET", f"{VS}/collections/{COLLECTION}/photos"), "Could not read the sync")
    if sync["state"] != "done":
        sys.exit(f"The sync ended {sync['state']}: {sync['error']}")
    if sync["error"]:
        print(f"note:     {sync['error']}")
    if not sync["newPhotos"] + sync["updatedPhotos"]:
        sys.exit("No product has a photo: give the catalogue an image_url column of web addresses, run setup-06, then this.")

    # 2. Wait until every photo is downloaded and indexed
    while (state := data_of(labs("GET", f"{VS}/indexes/{index}"), "Could not read the index"))["queuedPhotos"]:
        time.sleep(3)
    print(f"ready:    {index}, {state['photos']} photos of {state['products']} products, model {state['model']}, "
          f"after {time.time() - started:.0f} s ({sync['newPhotos']} new)")
    if state["failedPhotos"]:
        print(f"note:     {state['failedPhotos']} photos could not be downloaded: check their image_url opens from anywhere")
    set_env("LABS_PHOTO_INDEX", index)
    print(f"saved:    LABS_PHOTO_INDEX={index} in {ENV.name}")

# 3. With a photo: the products it finds, closest first
photos = [a for a in sys.argv[1:] if a != "--search"]
if photos:
    photo = photos[0]
    query = {"imageUrl": photo} if photo.startswith(("https://", "http://")) else \
        {"imageBase64": base64.b64encode(pathlib.Path(photo).read_bytes()).decode()}
    # minScore 0 shows the closest three whatever they score; the server names only those at MIN_SCORE or more
    found = data_of(labs("POST", f"{VS}/indexes/{index}/search", {**query, "limit": 3, "minScore": 0}), "The search failed")
    floor = found["minScore"] if MIN_SCORE is None else MIN_SCORE
    for m in found["results"]:
        print(f"found:    {m['data'].get('title')} ({m['productId']}), score {m['score']:.2f}"
              + ("" if m["score"] >= floor else f", under {floor}: the server leaves it out"))
print("next:     setup-03-build-instructions tells the agent about photos")
