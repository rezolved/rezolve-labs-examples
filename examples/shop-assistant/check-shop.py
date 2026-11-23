"""shop-assistant · A shopping conversation through the server, the way the page holds it.

Builds a 14-turn conversation from your own catalogue (a product with several sizes, and one from another
category), sends each line to POST /api/chat in one chat, and prints what the shopper would see: the reply (with its
delivery cue, which the page hides and the voice uses), the cards and the basket. Each line is followed by what a
good personal shopper does there, so the run can be read against it, and the end counts the replies that open with a
delivery cue. Every turn is a real chat message (10 credits).

Run, with the server up (either one), from examples/: uv run python shop-assistant/check-shop.py [base url]
"""
import csv, json, pathlib, re, sys, urllib.request
import yaml

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8050").rstrip("/")
HERE = pathlib.Path(__file__).resolve().parent
shop = yaml.safe_load((HERE / "shop.yaml").read_text(encoding="utf-8"))
rows = list(csv.DictReader((HERE / shop["catalogue"]).open(encoding="utf-8-sig")))
sized = next((r for r in rows if len((r.get("sizes") or "").split()) > 1), rows[0])
other = next((r for r in rows if r.get("category") != sized.get("category")), rows[-1])
size = (sized.get("sizes") or "").split()[1:2] or [""]
kind = (sized.get("category") or sized["name"]).lower()
CONVERSATION = [
    ("Hi", "greets in one sentence and asks what they're shopping for; no products"),
    ("I need something nice", "asks one narrowing question (occasion or kind of item); no search"),
    (f"I'm looking for {kind}", "searches; names two or three with a reason each; one specific question"),
    (f"Tell me more about the {sized['name']}", "describes it from the catalogue only; no invented details"),
    (f"I'll take the {sized['name']}", "asks which size and names the sizes it comes in; nothing added"
     if size[0] else "adds it; confirms name and price"),
    (size[0] or "Thanks", "adds it (basket changes), confirms name, size and price; at most one complementary idea"),
    (f"Do you have the {other['name']}?", "says yes and why it might suit; a card for it"),
    ("What's in my basket and what's the total?", "reads back the lines and the total from the basket"),
    ("How long does delivery take?", "answers from the shop's policies only, or says it can't confirm"),
    ("Do you price match?", "unless the policies say so: it can't confirm, and points to customer service"),
    ("Can you book me a taxi?", "brief, warm no; steers back to the shop"),
    ("add the thirty h to the bag", "reads back its best guess and asks; nothing added"),
    (f"Actually, make that two of the {sized['name']}", "changes the quantity to two (basket changes) and confirms the total"),
    ("That's all, I'd like to check out", "sends the shopper to the basket's Check out button; never claims the order is placed"),
]


def turn(chat_id, text):
    req = urllib.request.Request(f"{BASE}/api/chat", method="POST", headers={"Content-Type": "application/json"},
                                 data=json.dumps({"chatId": chat_id, "text": text}).encode())
    reply, seen, event = "", {}, None
    with urllib.request.urlopen(req, timeout=180) as resp:
        for raw in resp:
            line = raw.decode().rstrip("\n")
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                if event == "chat":
                    chat_id = data["chatId"]
                elif event == "delta" and not reply:
                    reply = " "  # the reply has started; its whole text, cues included, comes as `spoken`
                elif event == "spoken":
                    reply = data["text"]
                elif event in ("cards", "cart", "error"):
                    seen[event] = data
    return chat_id, reply.strip(), seen


CUE = re.compile(r"^\[(warmly|cheerfully|excited|apologetic)\] ")
chat_id, cued = None, 0
for i, (text, expect) in enumerate(CONVERSATION, 1):
    chat_id, reply, seen = turn(chat_id, text)
    cued += bool(CUE.match(reply))
    print(f"\n{i:>2}. shopper:  {text}\n    expect:   {expect}\n    alex:     {reply}")
    if "cards" in seen:
        print("    cards:    " + "; ".join(f"{c['name']} {c['price']}" for c in seen["cards"]["cards"]))
    if "cart" in seen:
        cart = seen["cart"]
        print("    basket:   " + ("; ".join(f"{l['name']} {l['size'] or ''} x{l['quantity']}" for l in cart["items"]) or "empty")
              + f"  total {cart['total']}")
    if "error" in seen:
        print(f"    error:    {seen['error']}")
print(f"\ndelivery cues: {cued} of {len(CONVERSATION)} replies open with one of the four\nchat {chat_id}")
