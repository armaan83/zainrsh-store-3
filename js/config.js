// ===== SITE CONFIG =====
// Fill this in with your UPI ID and Apps Script backend URL.
// See README.md for step-by-step setup instructions.

const CONFIG = {
  // Your personal or business UPI ID — the one linked to your bank savings account.
  // Looks like: yourname@oksbi, 9876543210@ybl, yourname@okaxis, etc.
  // Find it in your bank's UPI app (or Google Pay/PhonePe personal app) under "My UPI ID".
  UPI_ID: "8511932631@ybl",

  // The name that should show up when customers scan the QR / open their UPI app to pay.
  UPI_PAYEE_NAME: "Zainrash Accessories",

  // Orders/checkout go through the Apps Script Web App (still used for the Sheet + orders).
  // Looks like: https://script.google.com/macros/s/AKfycb.../exec
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyMqgmOa_cTV1u1tfcxpLueKnzn8WeZoplxcA8OoODcpiFDl2y5Voz3OBz2evqOLh13Jg/exec",

  // The catalog is now published directly to the repo as products.json by the Telegram bot.
  // It lives in the repo root and is served by GitHub Pages for free.
  PRODUCTS_JSON_URL: "products.json",

  // WhatsApp contact number for customer support (include country code, no + or spaces).
  // Customers tap the floating button to message you directly.
  WHATSAPP_NUMBER: "916355224464",

  // Optional pre-filled message shown when a customer opens the WhatsApp chat.
  WHATSAPP_MESSAGE: "Hi Zainrash! I have a question about my order.",

  STORE_NAME: "Zainrash Accessories",

  // ===== INFLUENCER / PROMO CODES =====
  // FALLBACK ONLY. The live list is now managed from the "PromoCodes" tab in your
  // Google Sheet (created automatically on first use). Edit the sheet to add/change
  // codes — no redeploy needed for sheet edits. This block is used only if the sheet
  // fetch fails (e.g. offline). Keep it in sync if you want a safety net.
  //   type "percent" -> value is % off the subtotal (e.g. 10 = 10% off)
  //   type "flat"    -> value is a fixed ₹ amount off (e.g. 50 = ₹50 off)
  //   influencer     -> name shown to the customer + recorded in the order ID for tracking
  PROMO_CODES: {
    "RAJ10":  { type: "percent", value: 10, influencer: "Raj" },
    "NEHA50": { type: "flat",    value: 50, influencer: "Neha" },
    "MIRA15": { type: "percent", value: 15, influencer: "Mira" }
  },
};
