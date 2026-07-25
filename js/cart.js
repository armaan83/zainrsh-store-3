// Cart state — persisted to localStorage so it survives across pages/reloads.
// Cart shape: { "product-id": quantity, ... }

const CART_KEY = "zainrsh_cart_v1";

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartCount();
}

function addToCart(productId, qty = 1) {
  const cart = getCart();
  cart[productId] = (cart[productId] || 0) + qty;
  saveCart(cart);
}

function setQty(productId, qty) {
  const cart = getCart();
  if (qty <= 0) {
    delete cart[productId];
  } else {
    cart[productId] = qty;
  }
  saveCart(cart);
  renderCartDrawer();
}

function removeFromCart(productId) {
  const cart = getCart();
  delete cart[productId];
  saveCart(cart);
  renderCartDrawer();
}

function cartItemCount() {
  const cart = getCart();
  return Object.values(cart).reduce((sum, q) => sum + q, 0);
}

function cartLineItems() {
  const cart = getCart();
  // PRODUCTS comes from products.js, must be loaded before this file
  return Object.entries(cart)
    .map(([id, qty]) => {
      const product = PRODUCTS.find(p => p.id === id);
      if (!product) return null;
      return { product, qty, lineTotal: product.price * qty };
    })
    .filter(Boolean);
}

function cartSubtotal() {
  return cartLineItems().reduce((sum, item) => sum + item.lineTotal, 0);
}

function updateCartCount() {
  const el = document.getElementById("cart-count");
  if (el) el.textContent = cartItemCount();
}

// ===== Cart drawer UI (present on every page that includes the drawer markup) =====

function openCart() {
  const overlay = document.getElementById("cart-overlay");
  const drawer = document.getElementById("cart-drawer");
  if (!overlay || !drawer) return;
  renderCartDrawer();
  overlay.classList.add("open");
  drawer.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeCart() {
  const overlay = document.getElementById("cart-overlay");
  const drawer = document.getElementById("cart-drawer");
  if (!overlay || !drawer) return;
  overlay.classList.remove("open");
  drawer.classList.remove("open");
  document.body.style.overflow = "";
}

function renderCartDrawer() {
  const container = document.getElementById("cart-items");
  const footer = document.getElementById("cart-footer");
  if (!container) return;

  const items = cartLineItems();

  if (items.length === 0) {
    container.innerHTML = `<div class="cart-empty">Your bag is empty.<br>Browse the collection to add pieces you love.</div>`;
    if (footer) footer.style.display = "none";
    return;
  }

  if (footer) footer.style.display = "block";

  container.innerHTML = items.map(({ product, qty, lineTotal }) => `
    <div class="cart-item">
      <img src="${product.image}" alt="${product.name}">
      <div class="cart-item-info">
        <div class="cart-item-name">${product.name}</div>
        <div class="cart-item-price">₹${product.price} × ${qty} = ₹${lineTotal}</div>
        <div class="qty-controls">
          <button class="qty-btn" onclick="setQty('${product.id}', ${qty - 1})" aria-label="Decrease quantity">−</button>
          <span class="qty-val">${qty}</span>
          <button class="qty-btn" onclick="setQty('${product.id}', ${qty + 1})" aria-label="Increase quantity">+</button>
          <button class="remove-btn" onclick="removeFromCart('${product.id}')">Remove</button>
        </div>
      </div>
    </div>
  `).join("");

  const subtotalEl = document.getElementById("cart-subtotal");
  if (subtotalEl) subtotalEl.textContent = `₹${cartSubtotal()}`;
}

document.addEventListener("DOMContentLoaded", () => {
  updateCartCount();
  renderCartDrawer();
});
