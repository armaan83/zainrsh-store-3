# Zainrsh Accessories — Storefront

A static jewelry storefront built to run free on GitHub Pages. Checkout offers two payment
methods, neither of which requires a payment gateway business account:

- **Pay by UPI** — customer scans a QR code (or taps a link on mobile) and pays your personal/
  business UPI ID directly using any UPI app (Google Pay, PhonePe, Paytm, etc.). You verify the
  payment yourself against your own bank/UPI app notification, then ship the order.
- **Cash on Delivery** — customer pays the courier when the order arrives.

## What's here

```
index.html          Storefront (catalog, category filter, cart drawer)
checkout.html          Checkout form, UPI QR payment panel, COD option
success.html              Order confirmation page
css/style.css                All styling
js/products.js                  Product catalog data — EDIT THIS to add/change products
js/cart.js                        Cart logic (localStorage)
js/catalog.js                       Catalog rendering + filtering
js/checkout.js                        Checkout logic — UPI QR flow + COD
js/config.js                            Your UPI ID + Apps Script backend URL go here
apps-script/Code.gs                       Backend that logs orders to a Sheet + email alerts
images/                                      Placeholder product images (SVG) — swap for real photos
```

## How the payment flow works

**Pay by UPI:**

1. Customer fills the checkout form, selects "Pay by UPI," hits **Continue to payment**
2. Site shows a QR code and a UPI deep link — both encode your UPI ID and the exact order amount
3. Customer scans the QR (or taps the link on their phone) and pays using whichever UPI app they
   already have — nothing about this touches your website, it's a direct UPI transfer
4. Customer taps **I've paid** — this logs the order to your Google Sheet as
   `UPI_PENDING_VERIFICATION` and (if you've set it up) emails you an alert
5. Customer immediately sees "Thanks for your order — we are preparing your order now"
6. **You check your own bank/UPI app notification** to confirm the payment actually landed before
   you pack and ship. This is the one manual step — there's no gateway confirming it for you.

**Cash on Delivery:**

1. Customer selects "Cash on Delivery," hits **Place order**
2. Order logs immediately to the Sheet as `COD_PENDING`, confirmation shows right away
3. You fulfill and ship; courier collects payment on delivery

## Step 1 — Put it on GitHub Pages

1. Create a new GitHub repo (e.g. `zainrsh-store`)
2. Upload all these files, keeping the folder structure
3. Repo Settings → Pages → Source: `main` branch, `/ (root)` folder → Save
4. Your site will be live at `https://<your-username>.github.io/zainrsh-store/`

## Step 2 — Find your UPI ID

You said you already have a savings account set up for UPI, so you likely already have this:

1. Open your bank's app, or Google Pay / PhonePe personal app
2. Look for "My UPI ID" or "My QR code" in the profile/settings section
3. It'll look like `yourname@oksbi`, `9876543210@ybl`, `yourname@okaxis`, etc.

## Step 3 — Deploy the backend (Google Apps Script)

This piece logs every order to a Google Sheet so you have a record to check payments against,
and optionally emails you the moment an order comes in.

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Delete the default code, paste in the contents of `apps-script/Code.gs`
3. *(Optional but recommended)* Click the gear icon (Project Settings) → **Script Properties** →
   add `OWNER_EMAIL` → your email address. This turns on an email alert for every new order.
4. Create a new Google Sheet (this is where orders get logged). Copy its ID from the URL — the
   long string between `/d/` and `/edit`
5. In `Code.gs`, paste that ID into `SHEET_ID` at the top
6. Click **Deploy → New deployment → type: Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy, authorize when prompted
7. Copy the Web App URL it gives you (ends in `/exec`)

## Step 4 — Connect the frontend

Open `js/config.js` and fill in:

```js
UPI_ID: "yourname@oksbi",                 // from Step 2
UPI_PAYEE_NAME: "Zainrsh Accessories",     // shown to customers in their UPI app
APPS_SCRIPT_URL: "https://script.google.com/macros/s/.../exec",  // from Step 3
```

Commit and push — GitHub Pages updates automatically within a minute or two.

## Step 5 — Test it

1. Visit your live GitHub Pages site, add a product, go to checkout, fill the form
2. Choose "Pay by UPI" → you should see a QR code and your UPI ID displayed
3. Scan it with your own phone to confirm the amount and payee name show up correctly (you don't
   have to actually complete a real payment to test this — just confirm the QR opens correctly)
4. Tap "I've paid" → confirm you land on the "Thanks for your order" page, and that a new row
   appears in your Google Sheet marked `UPI_PENDING_VERIFICATION`
5. If you set up `OWNER_EMAIL`, confirm you received the alert email

## The one real trade-off of manual UPI

Because there's no payment gateway involved, **your website can't cryptographically verify a UPI
payment actually happened** — a customer could tap "I've paid" without paying. Always check your
own bank/UPI app notification against the order (matching name, amount, and timing) before you
ship. For a small shop this is usually manageable, but it's worth building the habit of checking
before packing every order. If this becomes a real problem as you grow, upgrading to an automated
gateway (PhonePe Business, Razorpay, etc.) removes this risk — the Apps Script backend already has
a dormant PhonePe integration built in (see the bottom of `Code.gs`) that can be reactivated later
without a full rebuild.

## Editing products (now managed from Google Sheets — no code pushes!)

The catalog is **live from your Google Sheet**. You edit a row and the site updates within ~1
minute — no editing `products.js`, no GitHub push.

**One-time setup (after deploying Code.gs as a Web App):**

1. In your order-logging Sheet, you'll see a tab called **`Products`** (created automatically on
   first load, or run the `seedProducts` function once from the Apps Script editor to prefill the
   starter 12 items).
2. The columns are (row 1 = headers, exact names):
   | Column | What to put |
   |---|---|
   | `id` | unique id, e.g. `ear-005` — never reuse, the cart relies on it |
   | `category` | `Earrings`, `Necklaces`, `Rings`, `Bracelets` — or any new category (tabs build automatically) |
   | `name` | product name |
   | `price` | selling price as a number, **no ₹ sign** (e.g. `449`) |
   | `mrp` | "was" price for the discount sticker — leave blank for no sticker |
   | `image` | **full image URL** (e.g. `https://your-host.com/photo.jpg`) or a path inside `images/` |
   | `description` | one-line text |
   | `inStock` | `TRUE` / `FALSE` (FALSE hides the Add-to-bag button) |

3. Add / edit / delete rows freely. The storefront calls
   `?action=getProducts` on every load and renders whatever is in the sheet.

**About images:** paste any direct image URL into the `image` column (Google Drive "Anyone with
link" share links won't work — use a real image host, Imgur, or host in the repo's `images/`
folder and use a `images/your-photo.jpg` path). If an image fails to load, a placeholder shows.

To manage everything from the sheet instead of GitHub, you only ever touch: the `Products` tab
(for the catalog) and the `Orders` tab (where sales land). `js/products.js` is now just the
loader — you don't need to edit it.

## Swapping in real product photos

Easiest: upload each photo to an image host (or your own site) and paste the URL into the sheet's
`image` column. Alternatively drop files in the repo's `images/` folder, commit/push, and use a
`images/your-photo.jpg` path. Compress before uploading (e.g. [tinypng.com](https://tinypng.com))
so pages load fast on mobile data.

## Notes

- The QR code is generated via a free third-party service (api.qrserver.com) — your UPI ID and
  the order amount are sent to them to render the image each time. This is normal for QR
  generation but worth knowing; if you'd rather avoid a third party entirely, a client-side QR
  library can replace this later.
- Free shipping is set at ₹799+ subtotal, otherwise ₹59 flat; COD adds a ₹49 handling fee on top
  — change these in `js/checkout.js` (`COD_FEE` constant and the `shipping` line)
- The cart is stored in the browser (`localStorage`), so it's per-device, not synced across devices
- Every order — UPI or COD — logs to your Sheet immediately, so you have a full record of
  everything, including UPI orders that were never actually paid (which is exactly why you check
  before shipping)
- This site doesn't handle shipping/fulfillment — pair it with a courier or aggregator (e.g.
  Shiprocket) to actually pack, label, and ship orders, and to collect COD cash from customers
- This site has no admin/login area — you manage products by editing `products.js` directly and
  pushing to GitHub. For 15–50 products this is genuinely the simplest approach; a CMS would be
  overkill
