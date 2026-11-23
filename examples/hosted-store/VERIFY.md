# Verify the hosted-store playbook on your store

This sheet is for the owner of a Rezolve commerce store. It walks through the hosted-store examples on your own
account so you can confirm that what the playbook says is true:
create a store, load a catalogue, find a product, fill a basket, check out with the demonstration card and see the
order. About 15 minutes. Please fill in the **Result** column and send the sheet back.

## What you need

- Python 3.11+ with [`uv`](https://docs.astral.sh/uv/), or Node 20.12+. Either is enough; the two versions of each
  script print the same lines.
- A Rezolve Labs **secret** key (`rzlb_live_sk_…`) whose families include `commerce`, from the dashboard's
  **API keys** page.
- A catalogue CSV: a header row and a few of your products. Required columns: `product_id`, `title`, `category`
  (levels split by `>`, such as `Women > Dresses`), `price` (a plain number). Optional: `original_price`, `brand`,
  `gender`, `description`, `product_url`, `main_image_url`, and `additional_image_url`, `sizes`, `colors`, `tags`
  (several values split by `|`). Use products from at least one department with two or more products, so the
  basket step can add and remove a second one. The dashboard's catalogue file works as it is.

```bash
git clone https://github.com/rezolved/rezolve-labs-examples && cd rezolve-labs-examples
cp env.example .env              # put your key in LABS_API_KEY
cd examples
uv sync                          # Python
npm install                      # TypeScript
```

## What this changes on your account

- Steps 2–5 work on a **new** store, `Playbook Verify`, and step 6 deletes it. Your existing stores are only listed,
  never changed.
- Step 4 places one order in the new store, paid with the demonstration card. No money moves.
- Every successful call costs 1 credit; a refusal costs nothing. The whole sheet is about 40 credits.

## Steps

Run each command from `examples/`. For TypeScript, replace `uv run python … .py` with `npx tsx … .ts`. Each call
prints a `[labs]` line with its method, path, status and credits; a failure adds the start of the answer.

### 1. List your stores

```bash
uv run python hosted-store/store-01-create.py
```

Expect `Your stores:` and one line per store: id, name, currency, product and order counts, and its page
(`https://commerce.rezolvelabs.com/{id}/`). Your first store is listed first.

### 2. Create a test store

```bash
uv run python hosted-store/store-01-create.py "Playbook Verify"
```

Expect `POST /commerce/stores -> 201`, the new store's line (id `playbook-verify`, `products=0`) and
`Saved STORE_ID in .env`. Open the page it prints: the store's page loads with no sign-in.

### 3. Load your catalogue

```bash
uv run python hosted-store/store-02-catalogue.py /path/to/your-catalogue.csv --currency GBP
```

Expect `PUT …/catalog -> 202`, `Uploading N products as job …`, then `Imported N (N for sale), M departments.` and
one `department` line per department. Then run the same command again: it must stop with
`already has N products and the upload replaces them all. Pass --replace to go ahead.` without uploading.

### 4. Shop: find, basket, checkout, order

```bash
uv run python hosted-store/store-03-shop.py
```

Expect, in order:

1. `Department …: K products, such as …`: the first department that has products.
2. `Search '…': … hits`. On a store made through the API we saw 0 hits (see "What we found" below).
3. `Product …: price, IN_STOCK, sizes …`: the product's price matches your CSV.
4. Three basket lines: quantity 2 of the first product; then a second product added; then removed again. Each
   total is right for your prices.
5. `shipping Standard delivery (0.00 …), payment Demonstration card`.
6. `Order <code>: PaymentSettled, total …` and the same order read back.

Then open the store's **Console** from the dashboard's **Stores** page: the order is there with the same code and
total.

### 5. Optional: the TypeScript twins

```bash
npx tsx hosted-store/store-02-catalogue.ts /path/to/your-catalogue.csv --replace
npx tsx hosted-store/store-03-shop.ts --no-checkout
```

Expect the same lines as steps 3 and 4, and `Stopped before checkout. The basket … stays open.` with no new order.

### 6. Delete the test store

```bash
uv run python hosted-store/store-01-create.py --delete
```

Expect `DELETE /commerce/stores/playbook-verify -> 204` and `Deleted playbook-verify and removed STORE_ID from .env.`
The store is gone from the dashboard's **Stores** page.

## Results

| # | Check | Result (pass / fail + note) |
|---|---|---|
| 1 | Stores are listed with the right counts and pages | |
| 2 | Store created; its page opens with no sign-in | |
| 3a | Catalogue loaded; departments match your `category` column | |
| 3b | A second load is refused without `--replace` | |
| 4a | Browsing a department lists its products | |
| 4b | Product price and sizes match the CSV | |
| 4c | Basket add, change quantity, add and remove a second product: totals right | |
| 4d | Checkout gives `PaymentSettled`; the order shows in the console | |
| 5 | TypeScript prints the same; `--no-checkout` places no order | |
| 6 | Store deleted | |

## What we found, and what we'd like you to confirm

These are in the playbook as gotchas. Please say whether each is expected behaviour or a bug.

1. **The reference leaves every request body untyped**, and a bad catalogue record answers `422` "catalogue is not
   valid" with only "Invalid input" and no field. The working shape: `{"records": [...]}`, each with `category` as
   an array of levels and `price` as `[{"currency": "GBP", "value": 45}]`.
2. **Word search finds nothing on a store made through the API.** `POST …/search {"term": "…"}` answers `200` with
   no items; the dashboard shows the store as **Search off** ("needs Product discovery in your plan") although the
   key has that family; the catalogue job says `labsEnrichmentStarted: false`. Browsing by `collectionSlug` works.
   Is there a way to turn search on for a store made through the API?
3. **One SKU per product.** `sizes` are stored as text, so a basket line can't carry a size. Is one row per size
   the intended way?
4. **Reading a deleted store answers `503 upstream_sign_in_failed`**, not `404`.
5. **`GET /commerce/opt-in` answered `{"opted_in": false}`** on an account where every store call worked. Is opting
   in still needed?

Anything else that surprised you: please add it here.
