// Product catalog — now LIVE from your Google Sheet (the "Products" tab).
//
// HOW IT WORKS:
//   The storefront calls your Apps Script Web App (?action=getProducts) on load,
//   which reads the "Products" tab of your Sheet and returns the catalog as JSON.
//   Edit a row in the sheet (image URL, price, name, description, category) and the
//   site updates within ~1 minute — no code changes, no repo push.
//
// YOUR SHEET "Products" TAB — columns (row 1 = headers, exact names):
//   id          unique id, e.g. ear-001  (don't reuse; cart relies on it)
//   category    Earrings / Necklaces / Rings / Bracelets / anything
//   name        product name
//   price       selling price as a number (no ₹ sign), e.g. 449
//   mrp         "was" price for the discount sticker (optional, leave blank = no sticker)
//   image       full image URL, e.g. https://...jpg  (or a path in images/)
//   description short text
//   inStock     TRUE / FALSE  (FALSE hides the Add-to-cart button)
//
// Fallback: if the fetch fails, we keep using any products already cached in
// localStorage so the store still works offline / if the sheet is briefly down.

// Default seed (used ONLY if the sheet is empty or unreachable on first ever load).
const PRODUCTS_FALLBACK = [
  { id: "ear-001", category: "Earrings", name: "Meera Jhumka", price: 449, mrp: 699,
    image: "images/placeholder-earring-1.svg", description: "Antique gold-tone jhumka with pearl drops.", inStock: true },
  { id: "neck-001", category: "Necklaces", name: "Anaya Layered Chain", price: 649, mrp: 899,
    image: "images/placeholder-necklace-1.svg", description: "Double-layer chain necklace.", inStock: true }
];

let PRODUCTS = PRODUCTS_FALLBACK.slice();

// Load any cached catalog immediately so the cart works even before the live
// fetch completes (cart.js reads PRODUCTS synchronously on its own load).
try {
  const c = JSON.parse(localStorage.getItem("zainrsh_products_cache_v1"));
  if (Array.isArray(c) && c.length) PRODUCTS = c;
} catch (e) { /* ignore */ }

const PRODUCTS_CACHE_KEY = "zainrsh_products_cache_v1";

function loadCachedProducts() {
  try {
    const c = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY));
    if (Array.isArray(c) && c.length) PRODUCTS = c;
  } catch (e) { /* ignore */ }
}

function getProductsUrl() {
  // CONFIG comes from config.js (APPS_SCRIPT_URL). If it's still the placeholder,
  // we just use the fallback and never fire a bad request.
  const base = (window.CONFIG && CONFIG.APPS_SCRIPT_URL) || "";
  if (!base || base.indexOf("PASTE_YOUR") > -1 || base.indexOf("http") !== 0) return null;
  return base + (base.indexOf("?") > -1 ? "&" : "?") + "action=getProducts";
}

async function fetchProducts() {
  loadCachedProducts();
  const url = getProductsUrl();
  if (!url) {
    console.warn("APPS_SCRIPT_URL not set — using fallback/seed catalog.");
    return PRODUCTS;
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (data && data.success && Array.isArray(data.products) && data.products.length) {
      PRODUCTS = data.products;
      try { localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(PRODUCTS)); } catch (e) {}
    }
  } catch (err) {
    console.warn("Could not load products from sheet, using cached/fallback:", err.message);
  }
  return PRODUCTS;
}
