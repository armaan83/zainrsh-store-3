// Renders the product catalog grid and handles category filtering.

function productCardHTML(product) {
  const off = product.mrp > product.price
    ? Math.round(100 - (product.price / product.mrp) * 100)
    : 0;

  return `
    <div class="product-card" data-category="${product.category}">
      <div class="product-image">
        ${!product.inStock ? '<span class="product-badge oos">Sold out</span>' : (off > 0 ? `<span class="product-badge">${off}% off</span>` : '')}
        <img src="${product.image}" alt="${product.name}" loading="lazy">
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

  grid.innerHTML = filtered.map(productCardHTML).join("");
  if (countEl) countEl.textContent = `${filtered.length} piece${filtered.length !== 1 ? 's' : ''}`;
}

function setActiveCategory(category) {
  document.querySelectorAll(".chain-cat-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.category === category);
  });
  renderCatalog(category);
}

document.addEventListener("DOMContentLoaded", () => {
  renderCatalog("All");

  document.querySelectorAll(".chain-cat-btn").forEach(btn => {
    btn.addEventListener("click", () => setActiveCategory(btn.dataset.category));
  });
});
