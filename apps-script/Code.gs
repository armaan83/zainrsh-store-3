/**
 * Zainrsh Accessories — Telegram -> GitHub Pages catalog backend (webhook mode)
 *
 * WHAT THIS SCRIPT DOES (the only thing it needs to do for the catalog):
 *   You send a photo + caption to your Telegram bot.
 *   Telegram calls this Web App (doPost) with the message.
 *   This script:
 *     1. Downloads the photo from Telegram
 *     2. Uploads it to the GitHub repo (images/)
 *     3. Appends the product to products.json in the repo
 *   The site (GitHub Pages) reads products.json and shows it live.
 *
 * ORDERS: Manual UPI + Cash on Delivery are still handled here (createManualUpiOrder /
 * createCodOrder) and written to your Google Sheet. PhonePe helpers are kept but unused.
 *
 * WHY WEBHOOK MODE: previous versions dispatched on a body.action field and the deployed
 * code drifted from the source. Here there is exactly ONE entry point (doPost = Telegram
 * webhook), so there is no "Unknown action" failure mode.
 *
 * SETUP:
 *   - Script Properties (Project Settings): GITHUB_TOKEN = your PAT (repo scope)
 *   - Deploy > New deployment > Web app: Execute as Me, Access: Anyone
 *   - Set the Telegram webhook to this deployment URL:
 *       https://api.telegram.org/bot<TOKEN>/setWebhook?url=<DEPLOYMENT_URL>
 *   - The Telegram bot token is read from Script Properties (TELEGRAM_BOT_TOKEN).
 */

const SHEET_ID = "PASTE_YOUR_GOOGLE_SHEET_ID_HERE";
const SHEET_NAME = "Orders";
const PRODUCTS_SHEET_NAME = "Products";

// --- GitHub config (where product photos + products.json live) ---
const GH_OWNER = "armaan83";
const GH_REPO = "zainrsh-store-3";
const GH_BRANCH = "main";
const GH_IMAGES_PATH = "images";
const GH_PRODUCTS_FILE = "products.json";

function getScriptProp(k, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  return (v && v.indexOf("PASTE") === -1) ? v : (fallback || "");
}

function getGithubToken() { return getScriptProp("GITHUB_TOKEN", ""); }
function getBotToken() { return getScriptProp("TELEGRAM_BOT_TOKEN", ""); }

// ---------------------------------------------------------------------------
// Telegram webhook entry point
// ---------------------------------------------------------------------------
function doPost(e) {
  let update;
  try {
    update = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: "bad json" });
  }

  const message = update.message || (update.edited_message);
  if (!message) return jsonOut({ ok: true, note: "no message" });

  const chatId = String(message.chat.id);
  const ownerId = getScriptProp("OWNER_CHAT_ID", "");
  if (ownerId && chatId !== ownerId) {
    tgSend(chatId, "🚫 Unauthorized.");
    return jsonOut({ ok: true });
  }

  const text = message.text || "";
  const caption = message.caption || "";
  const photo = message.photo;

  // Slash commands
  if (text.indexOf("/") === 0) {
    const cmd = text.split(" ")[0].toLowerCase();
    const arg = text.slice(cmd.length).trim();
    if (cmd === "/start" || cmd === "/help") {
      tgSend(chatId, "Send a photo + caption to add a product:\nName: Meera Jhumka\nCategory: Earrings\nPrice: 449\nMRP: 699\nDescription: antique gold jhumka\n\nCommands: /list  /delete <id>");
    } else if (cmd === "/add") {
      tgSend(chatId, "Just send a photo (or image URL) + caption:\nName: …\nCategory: …\nPrice: …\nMRP: … (optional)\nDescription: … (optional)");
    } else if (cmd === "/list") {
      tgSend(chatId, listProducts(), "Markdown");
    } else if (cmd === "/delete") {
      tgSend(chatId, deleteProduct(arg), "Markdown");
    } else {
      tgSend(chatId, "Unknown command. Send /help.");
    }
    return jsonOut({ ok: true });
  }

  // Product add: either a photo, or a caption with an image URL
  const looksLikeProduct = photo || /https?:\/\/\S+\.(png|jpe?g|gif|webp)/i.test(caption);
  if (looksLikeProduct) {
    const reply = handleProduct(chatId, caption, photo);
    tgSend(chatId, reply, "Markdown");
    return jsonOut({ ok: true });
  }

  if (caption) {
    tgSend(chatId, "❌ Attach a photo or include an image URL (ending in .jpg/.png) in the caption.");
  }
  return jsonOut({ ok: true });
}

function doGet() {
  return jsonOut({ ok: true, message: "Zainrsh catalog webhook is live." });
}

// ---------------------------------------------------------------------------
// Product handling
// ---------------------------------------------------------------------------
function handleProduct(chatId, caption, photo) {
  const product = parseCaption(caption);
  if (!product.name) {
    return "❌ Send a photo (or image URL) + caption with at least:\nName: <product name>\nPrice: <number>\nCategory: <optional>";
  }

  let imagePath = product.image; // may be an external URL
  const token = getGithubToken();
  if (!token) return "❌ GitHub token not set (Script Property GITHUB_TOKEN).";

  if (!imagePath && photo) {
    try {
      const fileId = photo[photo.length - 1].file_id;
      const bytes = downloadTelegramFile(fileId);
      const b64 = Utilities.base64Encode(bytes);
      const ext = (photo[photo.length - 1].file_unique_id || "img").slice(-6);
      const fname = slugify(product.name) + "-" + new Date().getTime() + ".jpg";
      const res = githubUploadImage(b64, fname);
      if (!res.success) return "❌ Image upload failed: " + res.error;
      // Store a repo-relative path so the site resolves it from its own root.
      imagePath = GH_IMAGES_PATH + "/" + fname;
    } catch (err) {
      return "❌ Image upload failed: " + err.message;
    }
  }

  if (!imagePath) return "❌ No image found. Attach a photo or include a URL: line in the caption.";

  product.image = imagePath;
  product.id = slugify(product.name) + "-" + String(new Date().getTime()).slice(-5);
  product.inStock = true;

  try {
    appendProductToJson(product);
  } catch (err) {
    return "❌ Could not save product: " + err.message;
  }

  const site = getScriptProp("SITE_URL", "https://armaan83.github.io/zainrsh-store-3/");
  return "✅ Added: *" + product.name + "* (" + product.category + ") — ₹" + product.price +
    "\n🌐 Live at " + site + "\n(GitHub Pages refreshes in ~1 min — just reload the site.)";
}

function parseCaption(caption) {
  const fields = {};
  const parts = (caption || "").split(/\n|\|/);
  const urlRe = /https?:\/\/\S+\.(png|jpe?g|gif|webp)/i;
  let freeUrl = null;
  parts.forEach(function (part) {
    const m = part.match(/\s*(name|category|price|mrp|url|description|desc)\s*[:=]\s*(.+?)\s*$/i);
    if (m) {
      let k = m[1].toLowerCase();
      if (k === "desc") k = "description";
      fields[k] = m[2].trim();
    } else {
      const um = part.match(urlRe);
      if (um && !freeUrl) freeUrl = um[0];
    }
  });
  const price = fields.price ? parseFloat(String(fields.price).replace(/[^\d.]/g, "")) || 0 : 0;
  const mrp = fields.mrp ? parseFloat(String(fields.mrp).replace(/[^\d.]/g, "")) || 0 : 0;
  return {
    name: (fields.name || "").trim(),
    category: (fields.category || "Uncategorized").trim(),
    price: price,
    mrp: mrp,
    description: (fields.description || "").trim(),
    image: (fields.url || freeUrl || "").trim()
  };
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || ("item-" + new Date().getTime());
}

// ---------------------------------------------------------------------------
// products.json read/write on GitHub
// ---------------------------------------------------------------------------
function getProductsJson() {
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE + "?ref=" + GH_BRANCH;
  const auth = githubAuth();
  const res = UrlFetchApp.fetch(api, { headers: auth, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { products: [], sha: null };
  const j = JSON.parse(res.getContentText());
  let products = [];
  try { products = JSON.parse(Utilities.base64DecodeWebSafe(j.content).map(function (b) { return String.fromCharCode(b); }).join("")); } catch (e) {}
  return { products: products, sha: j.sha };
}

function appendProductToJson(product) {
  const cur = getProductsJson();
  const products = cur.products || [];
  products.push(product);
  const content = Utilities.base64EncodeWebSafe(JSON.stringify(products, null, 2));
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE;
  const payload = { message: "Update catalog (" + products.length + " products)", content: content, branch: GH_BRANCH };
  if (cur.sha) payload.sha = cur.sha;
  UrlFetchApp.fetch(api, {
    method: "put", contentType: "application/json",
    headers: githubAuth(), payload: JSON.stringify(payload), muteHttpExceptions: true
  });
}

function listProducts() {
  const cur = getProductsJson();
  const ps = cur.products || [];
  if (!ps.length) return "📭 No products yet.";
  let lines = ["📦 *" + ps.length + " product(s):*"];
  ps.forEach(function (p) { lines.push("• `" + p.id + "` — " + p.name + " (₹" + p.price + ")"); });
  return lines.join("\n");
}

function deleteProduct(id) {
  if (!id) return "Usage: /delete <id>";
  const cur = getProductsJson();
  const before = (cur.products || []).length;
  const after = (cur.products || []).filter(function (p) { return p.id !== id; });
  if (after.length === before) return "❌ No product with id `" + id + "`.";
  const content = Utilities.base64EncodeWebSafe(JSON.stringify(after, null, 2));
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE;
  const payload = { message: "Delete product " + id, content: content, branch: GH_BRANCH, sha: cur.sha };
  UrlFetchApp.fetch(api, { method: "put", contentType: "application/json", headers: githubAuth(), payload: JSON.stringify(payload), muteHttpExceptions: true });
  return "🗑 Deleted `" + id + "`. " + after.length + " products remain.";
}

// ---------------------------------------------------------------------------
// GitHub helpers (reused from original design)
// ---------------------------------------------------------------------------
function githubAuth() {
  return { Authorization: "token " + getGithubToken(), Accept: "application/vnd.github+json" };
}

function githubUploadImage(base64Data, filename) {
  const token = getGithubToken();
  if (!token) return { success: false, error: "GitHub token not set." };
  let b64 = base64Data || "";
  const comma = b64.indexOf(",");
  if (comma > -1) b64 = b64.substring(comma + 1);
  const path = GH_IMAGES_PATH + "/" + filename;
  const apiUrl = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + path;
  const auth = githubAuth();
  let sha = null;
  try {
    const head = UrlFetchApp.fetch(apiUrl, { headers: auth, muteHttpExceptions: true });
    if (head.getResponseCode() === 200) { try { sha = JSON.parse(head.getContentText()).sha; } catch (e) {} }
  } catch (e) {}
  const payload = { message: "Add product image " + filename, content: b64, branch: GH_BRANCH };
  if (sha) payload.sha = sha;
  const res = UrlFetchApp.fetch(apiUrl, { method: "put", contentType: "application/json", headers: auth, payload: JSON.stringify(payload), muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText());
  if (j && j.content && j.content.download_url) return { success: true, url: j.content.download_url };
  return { success: false, error: (j && j.message) || ("GitHub API " + res.getResponseCode()) };
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
function tgSend(chatId, text, parseMode) {
  const token = getBotToken();
  if (!token) return;
  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  const payload = { chat_id: String(chatId), text: text };
  if (parseMode) payload.parse_mode = parseMode;
  UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true });
}

function downloadTelegramFile(fileId) {
  const token = getBotToken();
  const info = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/getFile?file_id=" + fileId, { muteHttpExceptions: true });
  const j = JSON.parse(info.getContentText());
  if (!j.ok) throw new Error("getFile failed");
  const path = j.result.file_path;
  const bytes = UrlFetchApp.fetch("https://api.telegram.org/file/bot" + token + "/" + path, { muteHttpExceptions: true }).getContent();
  return bytes;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Orders (kept from original design)
// ---------------------------------------------------------------------------
function createManualUpiOrder(body) {
  const orderId = body.orderRef || ("ZRUPI" + new Date().getTime());
  logOrder(orderId, body.customer, body.items, body.total, "UPI_PENDING_VERIFICATION", "UPI (manual)");
  sendOwnerAlert(orderId, body.customer, body.items, body.total, "UPI (manual — verify against your UPI app)");
  return { success: true, merchantOrderId: orderId };
}

function createCodOrder(body) {
  const merchantOrderId = "ZRCOD" + new Date().getTime();
  logOrder(merchantOrderId, body.customer, body.items, body.total, "COD_PENDING", "Cash on Delivery");
  sendOwnerAlert(merchantOrderId, body.customer, body.items, body.total, "Cash on Delivery");
  return { success: true, merchantOrderId: merchantOrderId };
}

function sendOwnerAlert(orderId, customer, items, total, paymentMode) {
  try {
    const ownerEmail = getScriptProp("OWNER_EMAIL", "");
    if (!ownerEmail) return;
    const itemsSummary = (items || []).map(function (i) { return i.name + " x" + i.qty; }).join(", ");
    MailApp.sendEmail({
      to: ownerEmail,
      subject: "New order " + orderId + " — ₹" + total + " (" + paymentMode + ")",
      body: "New order received.\n\nOrder ID: " + orderId + "\nPayment: " + paymentMode + "\nTotal: ₹" + total +
        "\n\nCustomer: " + (customer ? customer.name : "") + "\nPhone: " + (customer ? customer.phone : "") +
        "\nEmail: " + (customer ? customer.email : "") + "\nAddress: " + (customer ? customer.address : "") + ", " +
        (customer ? customer.city : "") + ", " + (customer ? customer.state : "") + " - " + (customer ? customer.pincode : "") +
        "\n\nItems: " + itemsSummary + "\n\n" +
        (paymentMode.indexOf("UPI") === 0 ? "Check your bank/UPI app to confirm this payment before shipping.\n" : "")
    });
  } catch (err) {
    console.error("Failed to send owner alert email: " + err.message);
  }
}

function getSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME) ||
    SpreadsheetApp.openById(SHEET_ID).insertSheet(SHEET_NAME);
}

function getProductsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let s = ss.getSheetByName(PRODUCTS_SHEET_NAME);
  if (!s) {
    s = ss.insertSheet(PRODUCTS_SHEET_NAME);
    s.appendRow(["id", "category", "name", "price", "mrp", "image", "description", "inStock"]);
  }
  return s;
}

function logOrder(merchantOrderId, customer, items, total, status, paymentMode) {
  try {
    const sheet = getSheet();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp", "Order ID", "Status", "Payment Mode", "Customer Name", "Phone", "Email", "Address", "City", "Pincode", "State", "Items", "Total"]);
    }
    const itemsSummary = (items || []).map(function (i) { return i.name + " x" + i.qty; }).join(", ");
    sheet.appendRow([new Date(), merchantOrderId, status, paymentMode || "", customer ? customer.name : "", customer ? customer.phone : "", customer ? customer.email : "", customer ? customer.address : "", customer ? customer.city : "", customer ? customer.pincode : "", customer ? customer.state : "", itemsSummary, total || ""]);
  } catch (err) {
    console.error("Failed to log order: " + err.message);
  }
}

function updateOrderStatus(merchantOrderId, newStatus) {
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    for (let row = 1; row < data.length; row++) {
      if (data[row][1] === merchantOrderId) { sheet.getRange(row + 1, 3).setValue(newStatus); break; }
    }
  } catch (err) {
    console.error("Failed to update order status: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// One-time setup helper: writes the seed catalog into products.json
// (run once from the editor if you want starter products; the site already
//  has its own fallback, so this is optional).
// ---------------------------------------------------------------------------
function seedProductsToJson() {
  const seed = [
    ["ear-001", "Earrings", "Meera Jhumka", 449, 699, "images/placeholder-earring-1.svg", "Antique gold-tone jhumka with pearl drops."],
    ["neck-001", "Necklaces", "Anaya Layered Chain", 649, 899, "images/placeholder-necklace-1.svg", "Double-layer chain necklace."]
  ];
  const products = seed.map(function (r) {
    return { id: r[0], category: r[1], name: r[2], price: r[3], mrp: r[4], image: r[5], description: r[6], inStock: true };
  });
  const content = Utilities.base64EncodeWebSafe(JSON.stringify(products, null, 2));
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE;
  const cur = getProductsJson();
  const payload = { message: "Seed catalog", content: content, branch: GH_BRANCH };
  if (cur.sha) payload.sha = cur.sha;
  UrlFetchApp.fetch(api, { method: "put", contentType: "application/json", headers: githubAuth(), payload: JSON.stringify(payload), muteHttpExceptions: true });
  return "Seeded " + products.length + " products.";
}
