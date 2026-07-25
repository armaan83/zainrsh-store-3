// Renders the product catalog grid and handles category filtering.
// Products now come from the Google Sheet (see products.js) instead of a static array.

function productCardHTML(product) {
  const off = product.mrp > product.price
    ? Math.round(100 - (product.price / product.mrp) * 100)
    : 0;

  return `
    <div class="product-card" data-category="${product.category}">
      <div class="product-image">
        ${!product.inStock ? '<span class="product-badge oos">Sold out</span>' : (off > 0 ? `<span class="product-badge">${off}% off</span>` : '')}
        <img src="${product.image}" alt="${product.name}" loading="lazy" onerror="this.src='images/placeholder-earring-1.svg'">
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
  renderCatalog("All");       // show everything

  document.querySelectorAll(".chain-cat-btn").forEach(btn => {
    btn.addEventListener("click", () => setActiveCategory(btn.dataset.category));
  });
});
