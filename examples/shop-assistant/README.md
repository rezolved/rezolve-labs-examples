# Shop assistant

A personal shopper on a shop's page: the shopper types or talks, the agent searches the catalogue, shows the
products it recommends as cards, keeps the basket, answers delivery and returns questions from the shop's own
policies, and hands over to checkout. Bring your own catalogue: no product data comes with the example.

```bash
cd examples
cp shop-assistant/shop.example.yaml shop-assistant/shop.yaml   # then fill it in
mkdir -p shop-assistant/my-shop                                 # your catalogue.csv goes here, pictures in my-shop/img/
uv run python shop-assistant/setup-shop.py     # or: npx tsx shop-assistant/setup-shop.ts
uv run python shop-assistant/server.py         # or: npx tsx shop-assistant/server.ts
```

Then open `http://localhost:8050`. Allow sound with your first click; hold the microphone button to talk.

| File | What it is |
|---|---|
| `shop.example.yaml` | Copy to `shop.yaml`: the shop's name, where its catalogue is, currency, welcome line and policies |
| your catalogue | A CSV of your products (see below); `shop.yaml`, the catalogue and its pictures stay out of git |
| `instructions.txt` | How the agent behaves; `{store}`, `{currency}` and `{policies}` are filled in from `shop.yaml` |
| `setup-shop.py`, `.ts` | Loads the catalogue into a product search collection, builds the instructions, creates the agent; run again after any change |
| `server.py`, `.ts` | Holds the key and relays chat, cards, basket, speech and push-to-talk for the page |
| `site/shop.html` | The page: the shop, the assistant, the basket |
| `check-shop.py` | A 14-turn shopping conversation built from your catalogue, each turn with what should happen |

## Your catalogue

A CSV with a header row and one product per row. It needs `id`, `name` and `price` (a plain number; the currency is
in `shop.yaml`). Every other column is stored with the product and searched by meaning, so add what a shopper asks
about: `category`, `colour`, `material`, `occasion`, `description`. Two columns are read by name:

- `sizes`: the sizes it comes in, separated by spaces (`XS S M L XL`). The agent asks for one before adding it.
- `image_url`: the product's picture, either a web address or a path next to the CSV (`img/sku-101.jpg`), which the
  server serves to the page.

```text
id,name,price,category,colour,sizes,description,image_url
SKU-101,Linen Midi Dress,89,Dresses,Sage,XS S M L XL,"Sleeveless midi dress in washed linen.",img/sku-101.jpg
```

## How it works

- **The catalogue is a product search collection**, never a knowledge base (those are for documents such as
  policies). Each row becomes a product with its id, title, price and currency, and the descriptive columns are
  searched by meaning. The collection's name starts with your account's prefix; setup finds it for you. Keep prices
  as plain numbers and put the currency in `shop.yaml`.
- **Cards.** The platform searches on every turn, even "hi", and sends a card for every hit. The server keeps only
  the cards the reply names, and the instructions tell the agent that only products it names are shown. So a
  greeting shows nothing, and three recommendations show three cards. Each card's "Add to cart" button sends its
  message as the shopper.
- **The basket is the built-in `modify_cart` tool.** No shop needs connecting: the platform keeps one basket per
  chat and streams it after every change, with each line's size and price. The page shows it live; the agent reads
  it back when asked for the total.
- **Checkout is the page's, not the agent's.** The built-in `checkout` tool, with no shop connected, says it sent a
  payment link by message when nothing was sent. So it is left off: the agent sends the shopper to the basket's
  Check out button, and the page places a clearly marked demonstration order and starts a new basket.
- **Voice, with delivery cues.** The agent opens each reply with a cue in square brackets, such as `[warmly]`,
  `[cheerfully]`, `[excited]` (only for a happy occasion the shopper names) or `[apologetic]`. The voice uses the cue
  to colour how the words are said and doesn't say it aloud. The stream leaves the cues out, so when the reply is
  complete the server reads it back from the chat's transcript, with its cues, and the page speaks it sentence by
  sentence. A sentence without a cue keeps the one before it, and the screen never shows them. While the agent
  searches, the page says a short holding line. Holding the microphone records the shopper; on release the
  recording is made into a 16 kHz WAV in the browser and the server has it transcribed. Talking interrupts the
  agent.
- **Only Labs.** Every call the server makes goes to the Labs API with your key; the page calls only its own
  server and loads nothing from elsewhere except your catalogue's own picture addresses.

## How the agent behaves

`instructions.txt` is written for a personal shopper whose replies are heard as well as read. The main rules:

- **Search first, ask at most one question.** A specific request is searched straight away. Only a vague one
  ("something nice") gets one short narrowing question. Nothing the shopper already said is asked again.
- **Grounded.** It names only products, prices, sizes and colours the search returned, by their exact names. It
  never invents stock, discounts or delivery dates, and says plainly when something isn't there.
- **Presented for the ear.** It names two or three products with one reason each, says which it would pick, and
  ends with one specific question. There are no lists or links, prices are said in words, and it never opens with
  "Sure" or "Absolutely".
- **The basket is honest.** It asks for the size before adding, naming the sizes the item comes in. It never says
  something was added unless the tool ran. Each add is confirmed with name, size and price, and followed by at most
  one complementary idea.
- **Policies only from `shop.yaml`.** Anything they don't cover gets "I can't confirm that" and the customer
  service contact.
- **Tone through cues.** `[warmly]` by default, `[cheerfully]` when something goes into the basket, `[apologetic]`
  for bad news, and `[excited]` only for an occasion the shopper names in that message.

Run `uv run python shop-assistant/check-shop.py` with a server up to see all of it in one conversation built from
your catalogue (14 chat messages, 10 credits each). It prints each reply with its cues and counts the replies that open with one.

**Known issue.** On a small collection, product search doesn't always rank by the query yet: a search for "dress"
can return shirts and jeans first. The agent then says it has no dresses, because it only names what the search
returned. Ask by name ("the Floral Tea Dress") and it finds it.

## Change it

Edit the catalogue, `shop.yaml` or `instructions.txt` and run `setup-shop` again. It loads the catalogue again (a
product already there is updated; one you removed stays until you delete the collection), updates the agent's name,
store name and voice, and saves the instructions as a new flow version of the same agent. Restart the server, which
reads `shop.yaml` when it starts, and test in a new chat (reload the page). The assistant's name in the page's
messages and its suggestion chips are in `site/shop.html`.

The server checks the page's origin and caps input. Before putting it on a public site, add per-visitor limits and
a credit budget as `site-assistant/` does.

## Clean up

Delete the agent and the collection when you're done, then empty `SHOP_AGENT_ID` and `SHOP_COLLECTION` in `.env`.
From `examples/`:

```bash
set -a; . ../.env; set +a; LABS_BASE_URL=${LABS_BASE_URL:-https://api.rezolvelabs.com/api/v1}
curl -s -o /dev/null --max-time 30 -X DELETE -H "X-API-KEY: $LABS_API_KEY" -A "curl/8" -w "DELETE agent -> %{http_code}\n" "$LABS_BASE_URL/developer-platform/agents/$SHOP_AGENT_ID"
curl -s -o /dev/null --max-time 30 -X DELETE -H "X-API-KEY: $LABS_API_KEY" -A "curl/8" -w "DELETE collection -> %{http_code}\n" "$LABS_BASE_URL/product-discovery/collections/$SHOP_COLLECTION"
```
