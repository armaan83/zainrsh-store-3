// ===== SITE CONFIG =====
// Fill this in with your UPI ID and Apps Script backend URL.
// See README.md for step-by-step setup instructions.

const CONFIG = {
  // Your personal or business UPI ID — the one linked to your bank savings account.
  // Looks like: yourname@oksbi, 9876543210@ybl, yourname@okaxis, etc.
  // Find it in your bank's UPI app (or Google Pay/PhonePe personal app) under "My UPI ID".
  UPI_ID: "8511932631@ybl",

  // The name that should show up when customers scan the QR / open their UPI app to pay.
  UPI_PAYEE_NAME: "Zainrsh Accessories",

  // Orders/checkout go through the Apps Script Web App (still used for the Sheet + orders).
  // Looks like: https://script.google.com/macros/s/AKfycb.../exec
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyMqgmOa_cTV1u1tfcxpLueKnzn8WeZoplxcA8OoODcpiFDl2y5Voz3OBz2evqOLh13Jg/exec",

  // The catalog is now published directly to the repo as products.json by the Telegram bot.
  // It lives in the repo root and is served by GitHub Pages for free.
  PRODUCTS_JSON_URL: "products.json",


  STORE_NAME: "Zainrsh Accessories",
};
