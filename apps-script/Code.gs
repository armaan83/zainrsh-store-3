/**
 * Zainrsh Accessories — checkout backend
 *
 * ACTIVE (used by the current frontend):
 *   1. createManualUpiOrder — logs an order paid by UPI (customer paid you directly via QR/UPI
 *                              app — there's no gateway here, so this just records the order and
 *                              optionally emails you an alert). YOU verify the payment against
 *                              your own bank/UPI app notification before shipping.
 *   2. createCodOrder       — logs a Cash on Delivery order (customer pays the courier later)
 *
 * OPTIONAL / NOT CURRENTLY USED (kept in case you want automated payment verification later —
 * see the "PhonePe" section near the bottom of this file):
 *   3. createOrder / checkStatus — talks to PhonePe's Standard Checkout API to create and verify
 *      orders automatically. Requires a PhonePe Business account + API credentials. The current
 *      checkout.js does NOT call these — they're dormant unless you wire the frontend back to them.
 *
 * SETUP — see README.md for the full walkthrough. Short version:
 *   1. Go to https://script.google.com, create a new project, paste this file in as Code.gs
 *   2. Project Settings > Script Properties, add:
 *        OWNER_EMAIL = your email address (optional — enables an email alert on every new order)
 *   3. Create a new Google Sheet for order logging. Copy its ID from the URL, paste below in SHEET_ID
 *   4. Deploy > New deployment > Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   5. Copy the deployment URL into js/config.js as APPS_SCRIPT_URL
 */

const SHEET_ID = "PASTE_YOUR_GOOGLE_SHEET_ID_HERE";
const SHEET_NAME = "Orders";
const PRODUCTS_SHEET_NAME = "Products";

function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    const body = JSON.parse(e.postData.contents);
    let result;

    if (body.action === "createManualUpiOrder") {
      result = createManualUpiOrder(body);
    } else if (body.action === "createCodOrder") {
      result = createCodOrder(body);
    } else if (body.action === "createOrder") {
      result = createPhonePeOrder(body);
    } else if (body.action === "checkStatus") {
      result = checkOrderStatus(body);
    } else {
      result = { success: false, error: "Unknown action" };
    }

    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ success: false, error: err.message }));
  }

  return output;
}

// ============================================================
// PRODUCTS — served live to the storefront (GET, from the sheet)
// ============================================================

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "";
  if (action === "getProducts") {
    return getProductsJson();
  }
  return ContentService.createTextOutput(
    JSON.stringify({ success: false, error: "Unknown action: " + action })
  ).setMimeType(ContentService.MimeType.JSON);
}

// Reads the "Products" tab and returns a JSON array. The storefront fetches this
// so you can manage the catalog straight from the sheet — no code deploys needed.
// Expected columns (row 1 = headers):
//   id | category | name | price | mrp | image | description | inStock
function getProductsJson() {
  const out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    const sheet = getProductsSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) {
      out.setContent(JSON.stringify({ success: true, products: [] }));
      return out;
    }
    const headers = data[0].map(h => String(h).trim().toLowerCase());
    const col = {};
    ["id", "category", "name", "price", "mrp", "image", "description", "instock"]
      .forEach(k => { col[k] = headers.indexOf(k); });

    const products = [];
    const seen = {};
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const name = col.name > -1 ? String(row[col.name]).trim() : "";
      if (!name) continue; // skip empty rows
      let id = col.id > -1 ? String(row[col.id]).trim() : "";
      if (!id) id = "prod-" + r;
      if (seen[id]) continue; // skip duplicate ids
      seen[id] = true;
      products.push({
        id: id,
        category: col.category > -1 ? String(row[col.category]).trim() : "Uncategorized",
        name: name,
        price: numOr(col.price > -1 ? row[col.price] : 0, 0),
        mrp: col.mrp > -1 ? numOr(row[col.mrp], 0) : 0,
        image: (col.image > -1 && String(row[col.image]).trim())
          ? String(row[col.image]).trim() : "images/placeholder-earring-1.svg",
        description: col.description > -1 ? String(row[col.description]).trim() : "",
        inStock: parseBool(col.instock > -1 ? row[col.instock] : "", true)
      });
    }
    out.setContent(JSON.stringify({ success: true, products: products }));
  } catch (err) {
    out.setContent(JSON.stringify({ success: false, error: err.message }));
  }
  return out;
}

function numOr(v, d) {
  const n = Number(v);
  return isNaN(n) ? d : n;
}

function parseBool(v, d) {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (s === "") return d;
  if (s === "false" || s === "no" || s === "0") return false;
  if (s === "true" || s === "yes" || s === "1") return true;
  return d;
}

// ============================================================
// ACTIVE — Manual UPI + Cash on Delivery
// ============================================================

function createManualUpiOrder(body) {
  const orderId = body.orderRef || ("ZRUPI" + new Date().getTime());

  // Nothing to verify here automatically — the customer paid you directly via their UPI app.
  // This just records the order so you can check it against your own bank/UPI notification.
  logOrder(orderId, body.customer, body.items, body.total, "UPI_PENDING_VERIFICATION", "UPI (manual)");
  sendOwnerAlert(orderId, body.customer, body.items, body.total, "UPI (manual — verify against your UPI app)");

  return { success: true, merchantOrderId: orderId };
}

function createCodOrder(body) {
  const merchantOrderId = "ZRCOD" + new Date().getTime();

  // COD orders are confirmed immediately — there's no payment gateway step to wait on.
  // The customer pays the courier in person when the package arrives.
  logOrder(merchantOrderId, body.customer, body.items, body.total, "COD_PENDING", "Cash on Delivery");
  sendOwnerAlert(merchantOrderId, body.customer, body.items, body.total, "Cash on Delivery");

  return { success: true, merchantOrderId: merchantOrderId };
}

// Sends you a quick email the moment an order comes in. Purely optional — if OWNER_EMAIL isn't
// set in Script Properties, this silently does nothing. Your phone's own UPI notification is
// still the thing that actually tells you a payment landed; this is just a backup/order alert.
function sendOwnerAlert(orderId, customer, items, total, paymentMode) {
  try {
    const ownerEmail = PropertiesService.getScriptProperties().getProperty("OWNER_EMAIL");
    if (!ownerEmail) return;

    const itemsSummary = (items || []).map(i => `${i.name} x${i.qty}`).join(", ");

    MailApp.sendEmail({
      to: ownerEmail,
      subject: `New order ${orderId} — ₹${total} (${paymentMode})`,
      body:
        `New order received.\n\n` +
        `Order ID: ${orderId}\n` +
        `Payment: ${paymentMode}\n` +
        `Total: ₹${total}\n\n` +
        `Customer: ${customer?.name || ""}\n` +
        `Phone: ${customer?.phone || ""}\n` +
        `Email: ${customer?.email || ""}\n` +
        `Address: ${customer?.address || ""}, ${customer?.city || ""}, ${customer?.state || ""} - ${customer?.pincode || ""}\n\n` +
        `Items: ${itemsSummary}\n\n` +
        (paymentMode.indexOf("UPI") === 0 || paymentMode.indexOf("UPI") > -1
          ? `Check your bank/UPI app to confirm this payment before shipping.\n`
          : ``)
    });
  } catch (err) {
    console.error("Failed to send owner alert email: " + err.message);
  }
}

function getSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME)
    || SpreadsheetApp.openById(SHEET_ID).insertSheet(SHEET_NAME);
}

function getProductsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let s = ss.getSheetByName(PRODUCTS_SHEET_NAME);
  if (!s) {
    s = ss.insertSheet(PRODUCTS_SHEET_NAME);
    // Seed the header row so the tab is ready to fill in.
    s.appendRow(["id", "category", "name", "price", "mrp", "image", "description", "inStock"]);
  }
  return s;
}

// ============================================================
// SEED — run this ONCE from the Apps Script editor (Run ▶ seedProducts)
// to copy the starter catalog into the "Products" tab. After that, manage
// everything from the sheet — no need to run this again.
// ============================================================
function seedProducts() {
  const sheet = getProductsSheet();
  // Clear existing product rows (keep header) so we don't duplicate on re-run.
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).clearContent();

  const seed = [
    ["ear-001","Earrings","Meera Jhumka",449,699,"images/placeholder-earring-1.svg","Antique gold-tone jhumka with pearl drops.","TRUE"],
    ["ear-002","Earrings","Layla Hoops",299,449,"images/placeholder-earring-2.svg","Minimal statement hoops, everyday wear.","TRUE"],
    ["ear-003","Earrings","Noor Chandbali",549,799,"images/placeholder-earring-3.svg","Traditional chandbali with kundan work.","TRUE"],
    ["ear-004","Earrings","Ivy Studs",199,299,"images/placeholder-earring-4.svg","Everyday minimal studs, hypoallergenic posts.","TRUE"],
    ["neck-001","Necklaces","Anaya Layered Chain",649,899,"images/placeholder-necklace-1.svg","Double-layer chain necklace, gold-plated finish.","TRUE"],
    ["neck-002","Necklaces","Farah Pendant",399,599,"images/placeholder-necklace-2.svg","Delicate pendant on a fine chain.","TRUE"],
    ["neck-003","Necklaces","Rania Choker",599,849,"images/placeholder-necklace-3.svg","Statement choker with stonework.","FALSE"],
    ["ring-001","Rings","Zoya Band",249,349,"images/placeholder-ring-1.svg","Adjustable band ring, tarnish-resistant plating.","TRUE"],
    ["ring-002","Rings","Amira Stack Set",349,499,"images/placeholder-ring-2.svg","Set of 3 stackable rings, adjustable sizing.","TRUE"],
    ["brac-001","Bracelets","Sana Chain Bracelet",329,449,"images/placeholder-bracelet-1.svg","Classic chain bracelet with lobster clasp.","TRUE"],
    ["brac-002","Bracelets","Elora Charm Bracelet",379,549,"images/placeholder-bracelet-2.svg","Charm bracelet, adjustable extender chain.","TRUE"],
    ["brac-003","Bracelets","Yara Cuff",299,429,"images/placeholder-bracelet-3.svg","Open cuff bracelet, one-size-fits-most.","TRUE"]
  ];

  // Append header if the sheet is brand new/empty.
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["id","category","name","price","mrp","image","description","inStock"]);
  }
  seed.forEach(row => sheet.appendRow(row));
  return "Seeded " + seed.length + " products into the '" + PRODUCTS_SHEET_NAME + "' tab.";
}

function logOrder(merchantOrderId, customer, items, total, status, paymentMode) {
  try {
    const sheet = getSheet();

    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Timestamp", "Order ID", "Status", "Payment Mode", "Customer Name", "Phone", "Email",
        "Address", "City", "Pincode", "State", "Items", "Total"
      ]);
    }

    const itemsSummary = (items || []).map(i => `${i.name} x${i.qty}`).join(", ");

    sheet.appendRow([
      new Date(),
      merchantOrderId,
      status,
      paymentMode || "",
      customer?.name || "",
      customer?.phone || "",
      customer?.email || "",
      customer?.address || "",
      customer?.city || "",
      customer?.pincode || "",
      customer?.state || "",
      itemsSummary,
      total || ""
    ]);
  } catch (err) {
    console.error("Failed to log order: " + err.message);
  }
}

function updateOrderStatus(merchantOrderId, newStatus) {
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    // Column B (index 1) holds Order ID, column C (index 2) holds Status
    for (let row = 1; row < data.length; row++) {
      if (data[row][1] === merchantOrderId) {
        sheet.getRange(row + 1, 3).setValue(newStatus);
        break;
      }
    }
  } catch (err) {
    console.error("Failed to update order status: " + err.message);
  }
}

// ============================================================
// OPTIONAL — PhonePe automated payments (not called by the current frontend)
//
// If you later get a PhonePe Business account and want payments verified automatically
// instead of by hand, add these Script Properties, then point checkout.js back at the
// "createOrder" / "checkStatus" actions (see the git history / earlier version of checkout.js
// for the frontend code that used this):
//   PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, PHONEPE_CLIENT_VERSION, PHONEPE_ENV, SUCCESS_URL
// ============================================================

const ENDPOINTS = {
  SANDBOX: {
    auth: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
    pay: "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay",
    status: "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order/"
  },
  PRODUCTION: {
    auth: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
    pay: "https://api.phonepe.com/apis/pg/checkout/v2/pay",
    status: "https://api.phonepe.com/apis/pg/checkout/v2/order/"
  }
};

function getPhonePeProps() {
  const props = PropertiesService.getScriptProperties();
  const env = (props.getProperty("PHONEPE_ENV") || "SANDBOX").toUpperCase();
  return {
    clientId: props.getProperty("PHONEPE_CLIENT_ID"),
    clientSecret: props.getProperty("PHONEPE_CLIENT_SECRET"),
    clientVersion: props.getProperty("PHONEPE_CLIENT_VERSION") || "1",
    successUrl: props.getProperty("SUCCESS_URL"),
    env: env,
    endpoints: ENDPOINTS[env] || ENDPOINTS.SANDBOX
  };
}

function getAuthToken() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("phonepe_access_token");
  if (cached) return cached;

  const { clientId, clientSecret, clientVersion, endpoints } = getPhonePeProps();

  const response = UrlFetchApp.fetch(endpoints.auth, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      client_id: clientId,
      client_version: clientVersion,
      client_secret: clientSecret,
      grant_type: "client_credentials"
    },
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());
  if (!data.access_token) {
    throw new Error("Could not authenticate with PhonePe: " + response.getContentText());
  }

  cache.put("phonepe_access_token", data.access_token, 21600);
  return data.access_token;
}

function createPhonePeOrder(body) {
  const { successUrl, endpoints } = getPhonePeProps();
  const amountPaise = Math.round(Number(body.amount) * 100);
  const merchantOrderId = "ZR" + new Date().getTime();

  logOrder(merchantOrderId, body.customer, body.items, body.amount, "PENDING", "Online (PhonePe)");

  const token = getAuthToken();

  const response = UrlFetchApp.fetch(endpoints.pay, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "O-Bearer " + token },
    payload: JSON.stringify({
      merchantOrderId: merchantOrderId,
      amount: amountPaise,
      expireAfter: 1200,
      paymentFlow: {
        type: "PG_CHECKOUT",
        merchantUrls: {
          redirectUrl: successUrl + "?order=" + merchantOrderId
        }
      }
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());

  if (!data.redirectUrl) {
    return { success: false, error: data.message || "Could not create PhonePe order" };
  }

  return { success: true, redirectUrl: data.redirectUrl, merchantOrderId: merchantOrderId };
}

function checkOrderStatus(body) {
  const { endpoints } = getPhonePeProps();
  const merchantOrderId = body.merchantOrderId;
  const token = getAuthToken();

  const response = UrlFetchApp.fetch(endpoints.status + merchantOrderId + "/status?details=false", {
    method: "get",
    contentType: "application/json",
    headers: { Authorization: "O-Bearer " + token },
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());

  if (data.state === "COMPLETED") {
    updateOrderStatus(merchantOrderId, "PAID");
    return { success: true, state: "COMPLETED" };
  } else if (data.state === "FAILED") {
    updateOrderStatus(merchantOrderId, "FAILED");
    return { success: true, state: "FAILED" };
  }

  return { success: true, state: data.state || "PENDING" };
}
