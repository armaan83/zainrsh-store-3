// Renders the product catalog grid and handles category filtering.
// Products now come from the Google Sheet (see products.js) instead of a static array.

// Escape a value for safe use inside an HTML attribute.
function escAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Collect all gallery images (single `image` + optional `images[]`) as absolute URLs.
function productImages(product) {
  const list = [product.image].concat(Array.isArray(product.images) ? product.images : []);
  return list.map(function (u) { return resolveImageUrl(u); }).filter(Boolean);
}

// Render a clickable thumbnail strip. Returns "" when there's only one image.
function galleryHTML(product) {
  const imgs = productImages(product);
  if (imgs.length <= 1) return "";
  const thumbs = imgs.map(function (src, i) {
    return `<button type="button" class="thumb${i === 0 ? " active" : ""}" data-src="${escAttr(src)}" onclick="swapProductImage(this)" aria-label="View image ${i + 1}"><img src="${escAttr(src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></button>`;
  }).join("");
  return `<div class="product-thumbs">${thumbs}</div>`;
}

function productCardHTML(product) {
  const off = product.mrp > product.price
    ? Math.round(100 - (product.price / product.mrp) * 100)
    : 0;
  const imgs = productImages(product);
  const mainSrc = imgs[0] || "images/placeholder-earring-1.svg";

  return `
    <div class="product-card" data-id="${escAttr(product.id)}" data-category="${escAttr(product.category)}">
      <div class="product-image">
        ${!product.inStock ? '<span class="product-badge oos">Sold out</span>' : (off > 0 ? `<span class="product-badge">${off}% off</span>` : '')}
        <img class="main-img" src="${escAttr(mainSrc)}" alt="${escAttr(product.name)}" loading="lazy" onclick="openLightbox(this)" style="cursor:zoom-in" onerror="this.src='images/placeholder-earring-1.svg'">
        ${galleryHTML(product)}
      </div>
      <div class="product-info">
        <div class="product-cat">${product.category}</div>
        <div class="product-name">${product.name}</div>
        <div class="product-desc">${product.description}</div>
        <div class="product-price-row">
          <span class="price-now">₹${product.price}</span>
          ${product.mrp > product.price ? `<span class="price-mrp">₹${product.mrp}</span>` : ''}
        </div>
        <button class="add-btn" ${!product.inStock ? 'disabled' : ''} onclick="addToCart('${product.id}'); openCart();">
          ${product.inStock ? 'Add to bag' : 'Sold out'}
        </button>
      </div>
    </div>
  `;
}

// Thumbnail click: swap the card's main image and mark the active thumbnail.
function swapProductImage(thumb) {
  const src = thumb.getAttribute("data-src");
  if (!src) return;
  const card = thumb.closest(".product-card");
  if (!card) return;
  const main = card.querySelector(".main-img");
  if (main) main.src = src;
  card.querySelectorAll(".thumb").forEach(t => t.classList.remove("active"));
  thumb.classList.add("active");
}

// ----- Lightbox (click image to pop out) -----
let lightboxState = { images: [], index: 0 };

function openLightbox(arg) {
  // arg is the clicked <img> (this) or a product id string.
  const imgEl = (arg && arg.tagName === "IMG") ? arg : null;
  const cardEl = imgEl ? imgEl.closest(".product-card") : null;
  const productId = cardEl ? cardEl.getAttribute("data-id") : (typeof arg === "string" ? arg : null);

  let imgs = [];
  let start = 0;
  const product = productId ? PRODUCTS.find(p => p.id === productId) : null;
  if (product) {
    imgs = productImages(product);
    // If the card shows a specific image, start there.
    const cur = imgEl ? imgEl.getAttribute("src") : "";
    if (cur) {
      const found = imgs.indexOf(cur);
      if (found >= 0) start = found;
    }
  } else if (imgEl) {
    const cur = imgEl.getAttribute("src");
    if (cur) imgs = [cur];
  }
  if (!imgs.length) return;
  lightboxState.images = imgs;
  lightboxState.index = start;
  renderLightbox();
  const ov = document.getElementById("lightbox-overlay");
  if (ov) ov.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function renderLightbox() {
  const img = document.getElementById("lightbox-img");
  const counter = document.getElementById("lightbox-counter");
  if (!img) return;
  img.src = lightboxState.images[lightboxState.index];
  if (counter) counter.textContent = (lightboxState.index + 1) + " / " + lightboxState.images.length;
  const prev = document.getElementById("lightbox-prev");
  const next = document.getElementById("lightbox-next");
  if (prev) prev.style.display = lightboxState.images.length > 1 ? "block" : "none";
  if (next) next.style.display = lightboxState.images.length > 1 ? "block" : "none";
}

function lightboxStep(dir) {
  const n = lightboxState.images.length;
  if (!n) return;
  lightboxState.index = (lightboxState.index + dir + n) % n;
  renderLightbox();
}

function closeLightbox() {
  const ov = document.getElementById("lightbox-overlay");
  if (ov) ov.style.display = "none";
  document.body.style.overflow = "";
}

document.addEventListener("keydown", function (e) {
  if (document.getElementById("lightbox-overlay") &&
      document.getElementById("lightbox-overlay").style.display === "flex") {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") lightboxStep(-1);
    else if (e.key === "ArrowRight") lightboxStep(1);
  }
});

function renderCatalog(filterCategory = "All") {
  const grid = document.getElementById("product-grid");
  const countEl = document.getElementById("product-count");
  if (!grid) return;

  const filtered = filterCategory === "All"
    ? PRODUCTS
    : PRODUCTS.filter(p => p.category === filterCategory);

  grid.innerHTML = filtered.length
    ? filtered.map(productCardHTML).join("")
    : `<div class="cart-empty">No products yet. Add rows to the "Products" tab of your Google Sheet.</div>`;
  if (countEl) countEl.textContent = `${filtered.length} piece${filtered.length !== 1 ? 's' : ''}`;
}

// Build category buttons dynamically from the sheet's categories (plus an "All").
function buildCategoryButtons() {
  const nav = document.querySelector(".chain-categories");
  if (!nav) return;
  const cats = Array.from(new Set(PRODUCTS.map(p => p.category).filter(Boolean)));
  const want = ["All", ...cats];
  // Only rebuild if the current buttons don't already match the live categories.
  const existing = Array.from(nav.querySelectorAll(".chain-cat-btn")).map(b => b.dataset.category);
  if (existing.length === want.length && want.every((c, i) => c === existing[i])) return;
  nav.innerHTML = want.map((c, i) =>
    `<button class="chain-cat-btn${i === 0 ? ' active' : ''}" data-category="${c}">${c}</button>`
  ).join("");
  nav.querySelectorAll(".chain-cat-btn").forEach(btn => {
    btn.addEventListener("click", () => setActiveCategory(btn.dataset.category));
  });
}

function setActiveCategory(category) {
  document.querySelectorAll(".chain-cat-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.category === category);
  });
  renderCatalog(category);
}

document.addEventListener("DOMContentLoaded", async () => {
  await fetchProducts();      // load live catalog from the sheet
  buildCategoryButtons();     // make category tabs match the sheet
  if (typeof pruneOrphanCartItems === "function") pruneOrphanCartItems(); // drop stale cart ids
  renderCatalog("All");       // show everything

  document.querySelectorAll(".chain-cat-btn").forEach(btn => {
    btn.addEventListener("click", () => setActiveCategory(btn.dataset.category));
  });
});
