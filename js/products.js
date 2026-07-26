// Product catalog — LIVE from products.json in this repo.
//
// HOW IT WORKS:
//   The Telegram bot (telegram_catalog_bot.py) writes every product straight to
//   products.json in the repo. GitHub Pages serves it for free. When the bot adds
//   a product, it's live on the next site refresh (GitHub Pages cache ~1 min).
//   Product photos are uploaded to the images/ folder in the repo; the product's
//   "image" field stores a repo-relative path (e.g. "images/foo.jpg") which we
//   resolve against the site root.
//
// FALLBACK: if products.json is missing or fails to load, we keep using any
// products already cached in localStorage so the store still works.

// Default seed (used ONLY if products.json is empty or unreachable on first ever load).
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

// Resolve a possibly-repo-relative image path to an absolute URL using the site origin.
function resolveImageUrl(img) {
  if (!img) return img;
  if (/^https?:\/\//i.test(img)) return img;
  // repo-relative path like "images/foo.jpg" -> resolve against the current origin
  try {
    return new URL(img, location.href).href;
  } catch (e) {
    return img;
  }
}

function loadCachedProducts() {
  try {
    const c = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY));
    if (Array.isArray(c) && c.length) PRODUCTS = c;
  } catch (e) { /* ignore */ }
}

function getProductsUrl() {
  const url = (window.CONFIG && CONFIG.PRODUCTS_JSON_URL) || "products.json";
  return url;
}

async function fetchProducts() {
  loadCachedProducts();
  const url = getProductsUrl();
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    let arr = Array.isArray(data) ? data : (data && Array.isArray(data.products) ? data.products : []);
    if (arr.length) {
      // normalize images to absolute URLs
      arr = arr.map(p => {
        const norm = Object.assign({}, p, { image: resolveImageUrl(p.image) });
        // support both a comma-separated `images` string (from the Sheet) and an array
        let extra = p.images;
        if (typeof extra === "string") extra = extra.split(",").map(s => s.trim()).filter(Boolean);
        if (Array.isArray(extra)) norm.images = extra.map(resolveImageUrl).filter(Boolean);
        return norm;
      });
      PRODUCTS = arr;
      try { localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(PRODUCTS)); } catch (e) {}
    }
  } catch (err) {
    console.warn("Could not load products.json, using cached/fallback:", err.message);
  }
  return PRODUCTS;
}

// Re-fetch from the repo and re-render (used by the "Refresh catalog" button).
async function refreshCatalog() {
  await fetchProducts();
  buildCategoryButtons();
  const active = document.querySelector(".chain-cat-btn.active");
  renderCatalog(active ? active.dataset.category : "All");
  return PRODUCTS;
}
