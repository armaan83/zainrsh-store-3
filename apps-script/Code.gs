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
// Override any of these via Script Properties (e.g. GH_REPO = zainrsh-store-4)
// so you can point at a new repo WITHOUT re-editing code.
const GH_OWNER = getScriptProp("GH_OWNER", "armaan83");
const GH_REPO = getScriptProp("GH_REPO", "zainrsh-store-3");
const GH_BRANCH = getScriptProp("GH_BRANCH", "main");
const GH_IMAGES_PATH = getScriptProp("GH_IMAGES_PATH", "images");
const GH_PRODUCTS_FILE = getScriptProp("GH_PRODUCTS_FILE", "products.json");

// Conversational product-add flow: ask each field one at a time.
// Required = Name, Category, Price. MRP & Description are optional (reply /skip).
const FIELDS = ["name", "category", "price", "mrp", "description"];
const QUESTION = {
  name: "📝 *Step 1/5 — Product Name*\nWhat is the product called? (e.g. Meera Jhumka)",
  category: "📝 *Step 2/5 — Category*\nEarrings / Necklace / Bracelet / Ring / Other?",
  price: "📝 *Step 3/5 — Price (₹)*\nSelling price? (e.g. 450)",
  mrp: "📝 *Step 4/5 — MRP (optional)*\nOriginal/MRP price? Type /skip to leave blank.",
  description: "📝 *Step 5/5 — Description (optional)*\nShort description? Type /skip to leave blank."
};

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

  // Dedupe: Telegram retries webhook delivery on slow responses (Apps Script
  // cold starts), which causes the same update to be processed 2-3x. Ignore
  // repeats. We keep a bounded ring of recent update_ids in ScriptProperties
  // (NOT CacheService — CacheService is unreliable in web-app context and the
  //  dedupe silently failed there, causing the /list triple-send).
  const updateId = update.update_id;
  if (updateId) {
    const sp = PropertiesService.getScriptProperties();
    const DKEY = "recent_update_ids";
    let ids = [];
    try { ids = JSON.parse(sp.getProperty(DKEY) || "[]"); } catch (e) { ids = []; }
    if (ids.indexOf(updateId) > -1) return jsonOut({ ok: true, note: "duplicate" });
    ids.push(updateId);
    if (ids.length > 200) ids = ids.slice(-200);
    sp.setProperty(DKEY, JSON.stringify(ids));
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

  // Slash commands — but ONLY when the message is actually a command.
  // A photo/caption message has empty `text`, so it must NOT enter this branch
  // (that was the bug that made attached photos do nothing). Also, while a
  // product draft is open, plain text (and /skip) is an ANSWER, not a command.
  const draftActive = !!getDraft(chatId);
  const isCommandText = text && text.charAt(0) === "/" && !/^https?:\/\//i.test(text);

  if (isCommandText) {
    const cmd = text.split(" ")[0].toLowerCase();
    const arg = text.slice(cmd.length).trim();
    if (cmd === "/start" || cmd === "/help") {
      tgSend(chatId, "To add a product, just send a *photo* — I'll ask for Name, Category, Price, MRP and Description one by one.\n\nOr send photo + caption with all fields at once:\nName: Meera Jhumka\nCategory: Earrings\nPrice: 449\nMRP: 699\nDescription: antique gold jhumka\n\nCommands:\n/list  /delete <id>  /status  /cancel  /help\n(reply /skip for optional MRP & Description)");
    } else if (cmd === "/add") {
      tgSend(chatId, "Just send a photo (or image URL) + caption:\nName: …\nCategory: …\nPrice: …\nMRP: … (optional)\nDescription: … (optional)");
    } else if (cmd === "/list") {
      tgSend(chatId, listProducts(), "Markdown");
    } else if (cmd === "/delete") {
      tgSend(chatId, deleteProduct(arg), "Markdown");
    } else if (cmd === "/cancel") {
      clearDraft(chatId);
      tgSend(chatId, "🚫 Any in-progress product draft cleared. Send a new photo to start.");
    } else if (cmd === "/debugdraft") {
      const d = getDraft(chatId);
      const last = draftStore().getProperty("lastError_" + chatId);
      tgSend(chatId, "🐞 draft: " + (d ? JSON.stringify(d) : "(none)") + (last ? "\nlastErr: " + last : ""), "Markdown");
    } else if (cmd === "/status") {
      const props = PropertiesService.getScriptProperties().getProperties();
      const keys = Object.keys(props);
      const has = (k) => keys.indexOf(k) > -1 && props[k] && props[k].indexOf("PASTE") === -1;
      tgSend(chatId,
        "🔧 Config:\n" +
        (has("GITHUB_TOKEN") ? "✅ GITHUB_TOKEN present" : "❌ GITHUB_TOKEN missing") + "\n" +
        "   ↳ " + githubCheck() + "\n" +
        (has("TELEGRAM_BOT_TOKEN") ? "✅ TELEGRAM_BOT_TOKEN present" : "❌ TELEGRAM_BOT_TOKEN missing") + "\n" +
        "OWNER_CHAT_ID = " + (props.OWNER_CHAT_ID || "(empty)") + "\n" +
        "SITE_URL = " + (props.SITE_URL || "(empty)") + "\n" +
        "GH_REPO = " + GH_OWNER + "/" + GH_REPO,
        "Markdown");
    } else if (draftActive && cmd === "/skip") {
      // fall through to the draft flow below (so /skip works mid-conversation)
    } else {
      tgSend(chatId, "Unknown command. Send /help.");
      return jsonOut({ ok: true });
    }
    if (!(draftActive && cmd === "/skip")) return jsonOut({ ok: true });
  }

  // ---- Conversational product-add flow ----
  // A photo (or a message containing an image URL) starts/continues a draft.
  // Each missing field is asked one at a time. Plain text while a draft is open
  // is treated as the answer to the current question. MRP & Description are
  // optional (reply /skip). Required fields: Name, Category, Price.
  const capText = caption || text || "";
  const messageHasImage = !!photo || /https?:\/\/\S+\.(png|jpe?g|gif|webp)/i.test(capText);

  if (messageHasImage) {
    let draft = getDraft(chatId) || { photo: null, imageUrl: null, fields: {} };
    if (photo) draft.photo = photo;
    const parsed = parseCaption(capText);
    FIELDS.forEach(function (k) { if (parsed[k]) draft.fields[k] = parsed[k]; });
    const url = (capText.match(/https?:\/\/\S+\.(png|jpe?g|gif|webp)/i) || [])[0];
    if (url) draft.imageUrl = url;
    setDraft(chatId, draft);
    return continueDraft(chatId);
  }

  if (getDraft(chatId)) {
    // Plain-text answer to the current question.
    if (text === "/skip") {
      const draft = getDraft(chatId);
      const f = nextBlankIndex(draft);
      if (f < FIELDS.length && (FIELDS[f] === "mrp" || FIELDS[f] === "description")) {
        draft.fields[FIELDS[f]] = "";
        setDraft(chatId, draft);
        return continueDraft(chatId);
      }
      tgSend(chatId, "❌ Can't skip a required field. Please type it.");
      return jsonOut({ ok: true });
    }
    if (text === "/cancel") {
      clearDraft(chatId);
      tgSend(chatId, "🚫 Cancelled. Send a new photo to start again.");
      return jsonOut({ ok: true });
    }
    const draft = getDraft(chatId);
    const parsed = parseCaption(text);
    FIELDS.forEach(function (k) { if (parsed[k]) draft.fields[k] = parsed[k]; });
    const idx = nextBlankIndex(draft);
    const curField = (idx < FIELDS.length) ? FIELDS[idx] : null;
    // If the reply is a labelled "Field: value" line, store it under that field;
    // otherwise treat the raw text as the answer to the current question.
    const lbl = text.match(/^\s*(name|category|price|mrp|description|desc)\s*[:=]\s*(.+?)\s*$/i);
    if (lbl) {
      let k = lbl[1].toLowerCase();
      if (k === "desc") k = "description";
      draft.fields[k] = lbl[2].trim();
    } else if (curField && text.trim()) {
      draft.fields[curField] = text.trim();
    }
    setDraft(chatId, draft);
    return continueDraft(chatId);
  }

  if (text) tgSend(chatId, "❌ Send a *photo* to add a product, or type /help.");
  return jsonOut({ ok: true });
}

function doGet(e) {
  // Self-diagnostic: trigger via header `X-Diag: 1` (query params get stripped
  // by the /exec -> /echo redirect, but headers survive). Lets the operator read
  // the live token verdict WITHOUT relaying Telegram messages.
  const params = (e && e.parameter) ? e.parameter : {};
  const headers = (e && e.headers) ? e.headers : {};
  if (params.diag === "1" || (headers["X-Diag"] && String(headers["X-Diag"]) === "1")) {
    const sp = PropertiesService.getScriptProperties();
    return jsonOut({
      ok: true,
      github_token_present: !!getGithubToken(),
      github_check: githubCheck(),
      bot_token_present: !!getBotToken(),
      owner_chat: getScriptProp("OWNER_CHAT_ID", ""),
      site_url: getScriptProp("SITE_URL", ""),
      gh_repo: GH_OWNER + "/" + GH_REPO,
      diag_draft: (function () { try { return JSON.parse(sp.getProperty("draft_1465849687") || "null"); } catch (e) { return "ERR"; } })(),
      diag_last_reply: sp.getProperty("lastError_1465849687") || null,
      products_count: (function () { try { return getProductsJson().products.length; } catch (e) { return "ERR:" + e.message; } })(),
      message: "Zainrsh catalog webhook is live."
    });
  }
  // Isolated GitHub-write test: proves whether appendProductToJson actually works.
  if (params.testwrite === "1") {
    try {
      const before = getProductsJson().products.length;
      const test = { id: "diag-test-" + new Date().getTime(), category: "Diag", name: "Diag Test", price: 1, mrp: 0, description: "write test", image: "https://via.placeholder.com/1.png", inStock: true };
      appendProductToJson(test);
      const after = getProductsJson().products.length;
      return jsonOut({ ok: true, testwrite: "APPENDED", before: before, after: after, succeeded: after === before + 1 });
    } catch (e) {
      return jsonOut({ ok: false, testwrite: "THREW", error: String(e && e.message ? e.message : e) });
    }
  }
  // Sync the Products sheet -> products.json on GitHub (webhook-free catalog path).
  if (params.sync === "1") {
    const result = syncProductsToSite();
    return jsonOut({ ok: !/❌/.test(result || ""), result: result });
  }
  return jsonOut({ ok: true, message: "Zainrsh catalog webhook is live." });
}

// ---------------------------------------------------------------------------
// Product handling
// ---------------------------------------------------------------------------
function handleProduct(product) {
  let imagePath = product.image; // may be an external URL
  const token = getGithubToken();
  if (!token) return "❌ GitHub token not set (Script Property GITHUB_TOKEN).";

  if (!imagePath && product.photo) {
    try {
      const fileId = product.photo[product.photo.length - 1].file_id;
      const bytes = downloadTelegramFile(fileId);
      const b64 = Utilities.base64Encode(bytes);
      const fname = slugify(product.name) + "-" + new Date().getTime() + ".jpg";
      const res = githubUploadImage(b64, fname);
      if (!res.success) return "❌ Image upload failed: " + res.error;
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
  // NOTE: return "" (not a default like "Uncategorized") for missing fields.
  // The caller only stores a field when it is truthy, so an empty string keeps
  // the field genuinely blank instead of locking in a bogus default.
  return {
    name: (fields.name || "").trim(),
    category: (fields.category || "").trim(),
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
  const content = Utilities.base64Encode(JSON.stringify(products, null, 2));
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE;
  const payload = { message: "Update catalog (" + products.length + " products)", content: content, branch: GH_BRANCH };
  if (cur.sha) payload.sha = cur.sha;
  const res = UrlFetchApp.fetch(api, {
    method: "put", contentType: "application/json",
    headers: githubAuth(), payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 201) {
    throw new Error("GitHub PUT products.json failed: HTTP " + res.getResponseCode() + " " + res.getContentText().slice(0, 160));
  }
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
  const content = Utilities.base64Encode(JSON.stringify(after, null, 2));
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE;
  const payload = { message: "Delete product " + id, content: content, branch: GH_BRANCH, sha: cur.sha };
  const res = UrlFetchApp.fetch(api, { method: "put", contentType: "application/json", headers: githubAuth(), payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 201) {
    return "❌ Delete failed: HTTP " + res.getResponseCode() + " " + res.getContentText().slice(0, 120);
  }
  return "🗑 Deleted `" + id + "`. " + after.length + " products remain.";
}

// ---------------------------------------------------------------------------
// GitHub helpers (reused from original design)
// ---------------------------------------------------------------------------
function githubAuth() {
  return { Authorization: "token " + getGithubToken(), Accept: "application/vnd.github+json" };
}

// Live check: is the PAT valid, and does it have WRITE access to the repo?
function githubCheck() {
  const token = getGithubToken();
  if (!token) return "❌ GITHUB_TOKEN empty";
  // 1) Who owns the token? (proves it's a real, valid PAT)
  const me = UrlFetchApp.fetch("https://api.github.com/user", { headers: githubAuth(), muteHttpExceptions: true });
  if (me.getResponseCode() !== 200) {
    const m = JSON.parse(me.getContentText()).message || ("HTTP " + me.getResponseCode());
    return "❌ Token REJECTED by GitHub: " + m + "  (bad/expired token, or pasted with a space)";
  }
  const user = JSON.parse(me.getContentText()).login;
  // 2) Does it have write perms on our repo?
  const repo = UrlFetchApp.fetch("https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO, { headers: githubAuth(), muteHttpExceptions: true });
  const p = repo.getResponseCode() === 200 ? JSON.parse(repo.getContentText()).permissions : {};
  const perms = (p.push ? "✅ push" : (p.pull ? "⚠️ read-only" : "❌ none"));
  return "✅ Token valid → user @" + user + " | repo perms: " + perms + " (" + GH_OWNER + "/" + GH_REPO + ")";
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

// When this script is BOUND to a spreadsheet, use the active one (so you never
// have to paste SHEET_ID). Falls back to SHEET_ID for standalone use.
function activeOrConfiguredSs() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active && SHEET_ID === "PASTE_YOUR_GOOGLE_SHEET_ID_HERE") return active;
  } catch (e) { /* not bound */ }
  return SpreadsheetApp.openById(SHEET_ID);
}

function getSheet() {
  const ss = activeOrConfiguredSs();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function getProductsSheet() {
  const ss = activeOrConfiguredSs();
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
  const content = Utilities.base64Encode(JSON.stringify(products, null, 2));
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE;
  const cur = getProductsJson();
  const payload = { message: "Seed catalog", content: content, branch: GH_BRANCH };
  if (cur.sha) payload.sha = cur.sha;
  UrlFetchApp.fetch(api, { method: "put", contentType: "application/json", headers: githubAuth(), payload: JSON.stringify(payload), muteHttpExceptions: true });
  return "Seeded " + products.length + " products.";
}

// ---------------------------------------------------------------------------
// Conversational draft helpers.
// Use ScriptProperties (keyed by chatId): it reliably PERSISTS between web-app
// requests and is shared with the owner (the only user). getUserProperties()
// is unreliable in a "Execute as Me" web app, and CacheService has eventual
// consistency — both silently broke the draft flow. ScriptProperties is the
// dependable choice here.
// ---------------------------------------------------------------------------
function draftStore() { return PropertiesService.getScriptProperties(); }
function draftKey(chatId) { return "draft_" + chatId; }

function getDraft(chatId) {
  const raw = draftStore().getProperty(draftKey(chatId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function setDraft(chatId, draft) {
  draftStore().setProperty(draftKey(chatId), JSON.stringify(draft));
}

function clearDraft(chatId) {
  draftStore().deleteProperty(draftKey(chatId));
}

// Index of the first field still blank (or FIELDS.length if all filled).
// NOTE: a field that was explicitly answered (even with an empty string, e.g.
// via /skip for optional MRP/Description) is treated as FILLED. We therefore
// test for "never set" (undefined/null), NOT falsiness — otherwise an empty
// optional field would loop forever and the bot would never reach publish.
function nextBlankIndex(draft) {
  const f = draft.fields || {};
  for (let i = 0; i < FIELDS.length; i++) {
    if (f[FIELDS[i]] === undefined || f[FIELDS[i]] === null) return i;
  }
  return FIELDS.length;
}

// Drives the conversation: ask the next missing field, or publish when done.
function continueDraft(chatId) {
  const draft = getDraft(chatId);
  if (!draft) { tgSend(chatId, "❌ No draft found. Send a photo to start."); return jsonOut({ ok: true }); }
  const idx = nextBlankIndex(draft);
  if (idx < FIELDS.length) {
    tgSend(chatId, QUESTION[FIELDS[idx]], "Markdown");
    return jsonOut({ ok: true });
  }
  // All fields collected. Publish.
  const product = {
    name: draft.fields.name,
    category: draft.fields.category || "Uncategorized",
    price: parseFloat(String(draft.fields.price).replace(/[^\d.]/g, "")) || 0,
    mrp: parseFloat(String(draft.fields.mrp).replace(/[^\d.]/g, "")) || 0,
    description: draft.fields.description || "",
    image: draft.imageUrl || "",
    photo: draft.photo || null
  };
  const reply = handleProduct(product);
  draftStore().setProperty("lastError_" + chatId, String(reply));
  clearDraft(chatId);
  tgSend(chatId, reply, "Markdown");
  return jsonOut({ ok: true });
}

// ===========================================================================
// SHEET -> SITE SYNC  (webhook-free catalog management)
// ---------------------------------------------------------------------------
// The Telegram-webhook bot is unreliable because Apps Script /exec 302-redirects
// every POST and Telegram refuses to follow redirects. So the dependable path is:
//   you edit a Google Sheet  ->  this script  ->  products.json on GitHub  ->  site.
// Paste an image URL directly into the "image" column; the site already resolves
// absolute https URLs. Run "Sync -> Site" from the menu, or it auto-syncs on edit.
// ===========================================================================

// Menu shown when the Sheet is opened.
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Zainrsh Catalog")
    .addItem("Sync -> Site", "syncProductsToSite")
    .addItem("Count rows in sheet", "countSheetRows")
    .addToUi();
}

// Debounced auto-sync when you edit the Products sheet.
function onEdit(e) {
  try {
    const sheet = e && e.range ? e.range.getSheet() : null;
    if (!sheet || sheet.getName() !== PRODUCTS_SHEET_NAME) return;
    const props = PropertiesService.getScriptProperties();
    const last = Number(props.getProperty("autoSyncAt") || 0);
    const now = Date.now();
    props.setProperty("autoSyncAt", now);
    if (now - last < 15000) return; // skip if synced <15s ago
    syncProductsToSite();
  } catch (err) { console.error("onEdit sync failed: " + err.message); }
}

// Read the Products sheet and build the products.json array.
function buildProductsFromSheet() {
  const sheet = getProductsSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return []; // only header, no products
  const header = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const idx = {};
  header.forEach(function (h, i) { idx[h] = i; });
  const products = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const name = row[idx.name] != null ? String(row[idx.name]).trim() : "";
    if (!name) continue; // skip blank rows
    const category = (row[idx.category] != null ? String(row[idx.category]) : "").trim();
    const priceRaw = row[idx.price] != null ? String(row[idx.price]) : "0";
    const mrpRaw = row[idx.mrp] != null ? String(row[idx.mrp]) : "0";
    const price = parseFloat(priceRaw.replace(/[^0-9.]/g, "")) || 0;
    const mrp = parseFloat(mrpRaw.replace(/[^0-9.]/g, "")) || 0;
    const image = (row[idx.image] != null ? String(row[idx.image]) : "").trim();
    const description = (row[idx.description] != null ? String(row[idx.description]) : "").trim();
    const inStockRaw = row[idx.instock] != null ? String(row[idx.instock]).trim().toLowerCase() : "";
    const inStock = inStockRaw === "" ? true : (inStockRaw === "true" || inStockRaw === "yes" || inStockRaw === "1");
    let id = (row[idx.id] != null ? String(row[idx.id]).trim() : "");
    // id is OPTIONAL — leave the column blank and we derive a stable slug from
    // the name (e.g. "Mera Necklace" -> "mera-necklace"). Type one only if you
    // want a fixed id (e.g. to keep cart links stable across edits).
    if (!id) id = slugify(name);
    products.push({ id: id, category: category, name: name, price: price, mrp: mrp, image: image, description: description, inStock: inStock });
  }
  return products;
}

// Build products.json from the sheet and write it to GitHub.
function syncProductsToSite() {
  let products = [];
  try { products = buildProductsFromSheet(); }
  catch (err) { return "❌ Failed to read sheet: " + err.message; }
  const content = Utilities.base64Encode(JSON.stringify(products, null, 2));
  const cur = getProductsJson();
  const api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + GH_PRODUCTS_FILE;
  const payload = { message: "Sync catalog from Sheet (" + products.length + " products)", content: content, branch: GH_BRANCH };
  if (cur.sha) payload.sha = cur.sha;
  const res = UrlFetchApp.fetch(api, {
    method: "put", contentType: "application/json",
    headers: githubAuth(), payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200 && code !== 201) {
    return "❌ GitHub PUT failed: HTTP " + code + " " + res.getContentText().slice(0, 160);
  }
  return "✅ Synced " + products.length + " product(s) to the site. Refresh the store in ~1 min.";
}

function countSheetRows() {
  const sheet = getProductsSheet();
  const n = Math.max(0, sheet.getLastRow() - 1);
  SpreadsheetApp.getUi().alert(n + " product row(s) in the sheet (excluding header).");
}
