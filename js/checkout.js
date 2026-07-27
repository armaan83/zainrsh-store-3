// Checkout flow:
// 1. Render order summary from cart
// 2. Validate form
// 3. UPI: show a QR code + UPI deep link for the exact amount. Customer pays in their own
//     UPI app (outside this site entirely — there's no gateway involved). When they tap
//     "I've paid," we log the order as pending manual verification and show the confirmation.
//     You verify the payment yourself against your bank/UPI app notification before shipping.

let pendingOrder = null; // { customer, items, total } — set once "Continue to payment" is clicked
let appliedPromo = null; // { code, type, value, influencer, discount }
let livePromoCodes = null; // fetched from the sheet via Apps Script (falls back to CONFIG.PROMO_CODES)

function getPromoCodes() {
  return (livePromoCodes && Object.keys(livePromoCodes).length) ? livePromoCodes : (CONFIG.PROMO_CODES || {});
}

function fetchPromoCodes() {
  if (!CONFIG.APPS_SCRIPT_URL) return;
  try {
    fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({ action: "getPromoCodes" })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.codes && Object.keys(data.codes).length) {
          livePromoCodes = data.codes;
        }
      })
      .catch(function () { /* keep using CONFIG.PROMO_CODES fallback */ });
  } catch (e) { /* ignore — fallback stays */ }
}

function computeDiscount(subtotal) {
  if (!appliedPromo) return 0;
  if (appliedPromo.type === "percent") {
    return Math.round(subtotal * (appliedPromo.value / 100));
  }
  if (appliedPromo.type === "flat") {
    return Math.min(appliedPromo.value, subtotal);
  }
  return 0;
}

function applyPromoCode() {
  const input = document.getElementById("promo-code");
  const msg = document.getElementById("promo-msg");
  const raw = (input.value || "").trim().toUpperCase();
  if (!raw) {
    msg.textContent = "Please enter a code.";
    msg.className = "promo-msg err";
    return;
  }
  const codes = getPromoCodes();
  const entry = codes && codes[raw];
  if (!entry) {
    appliedPromo = null;
    msg.textContent = "That code isn't valid.";
    msg.className = "promo-msg err";
    renderOrderSummary();
    return;
  }
  appliedPromo = Object.assign({ code: raw }, entry);
  const desc = entry.type === "percent" ? entry.value + "% off" : "₹" + entry.value + " off";
  msg.textContent = "✓ " + desc + " applied" + (entry.influencer ? " — thanks " + entry.influencer + "!" : "") + " (code locked for this order)";
  msg.className = "promo-msg ok";
  input.disabled = true;
  const btn = document.getElementById("promo-apply-btn");
  if (btn) btn.disabled = true;
  renderOrderSummary();
}

function renderOrderSummary() {
  const items = cartLineItems();
  const container = document.getElementById("order-summary");
  const payBtn = document.getElementById("pay-btn");
  const cartErr = document.getElementById("err-cart");

  if (items.length === 0) {
    container.innerHTML = `<p style="text-align:center; padding: 20px 0;">Your bag is empty.</p>`;
    if (payBtn) payBtn.disabled = true;
    if (cartErr) cartErr.classList.add("show");
    return;
  }

  const subtotal = cartSubtotal();
  const discount = computeDiscount(subtotal);
  const shipping = 0;
  const total = subtotal - discount + shipping;

  container.innerHTML = `
    ${items.map(({ product, qty, lineTotal }) => `
      <div class="order-row">
        <span>${product.name} × ${qty}</span>
        <span>₹${lineTotal}</span>
      </div>
    `).join("")}
    <div class="order-row">
      <span>Subtotal</span>
      <span>₹${subtotal}</span>
    </div>
    ${discount > 0 ? `
    <div class="order-row discount">
      <span>Discount${appliedPromo.influencer ? " (" + appliedPromo.influencer + ")" : ""}</span>
      <span>−₹${discount}</span>
    </div>` : ""}
    <div class="order-row">
      <span>Shipping</span>
      <span>₹${shipping}</span>
    </div>
    <div class="order-row total">
      <span>Total</span>
      <span>₹${total}</span>
    </div>
  `;

  document.getElementById("checkout-form").dataset.total = total;
  document.getElementById("checkout-form").dataset.discount = discount;

  if (payBtn) {
    payBtn.textContent = "Continue to payment";
  }
}

function validateForm(form) {
  let valid = true;
  const fields = ["name", "phone", "email", "address", "city", "pincode", "state"];
  fields.forEach(field => {
    const input = form.elements[field];
    const errEl = document.getElementById("err-" + field);
    const ok = input.checkValidity();
    if (errEl) errEl.classList.toggle("show", !ok);
    if (!ok) valid = false;
  });
  return valid;
}

function buildUpiUri(amount, note) {
  const params = new URLSearchParams({
    pa: CONFIG.UPI_ID,
    pn: CONFIG.UPI_PAYEE_NAME,
    am: String(amount),
    cu: "INR",
    tn: note
  });
  return "upi://pay?" + params.toString();
}

function showUpiPaymentPanel(customer, items, total) {
  pendingOrder = { customer, items, total };

  const promoTag = appliedPromo ? "-" + appliedPromo.code : "";
  const orderRef = "ZRUPI" + promoTag + Date.now();
  pendingOrder.orderRef = orderRef;
  pendingOrder.promo = appliedPromo ? appliedPromo.code : "";

  const upiUri = buildUpiUri(total, "Zainrash Order " + orderRef);

  document.getElementById("upi-amount-text").textContent = "₹" + total;
  document.getElementById("upi-id-value").textContent = CONFIG.UPI_ID;
  document.getElementById("upi-app-link").href = upiUri;
  document.getElementById("upi-qr-image").src =
    "https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=" + encodeURIComponent(upiUri);

  document.getElementById("checkout-view").style.display = "none";
  document.getElementById("payment-view").style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function confirmUpiPaid() {
  if (!pendingOrder) return;

  const btn = document.getElementById("confirm-paid-btn");
  btn.disabled = true;
  btn.textContent = "Confirming…";

  try {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({
        action: "createManualUpiOrder",
        orderRef: pendingOrder.orderRef,
        customer: pendingOrder.customer,
        items: pendingOrder.items,
        total: pendingOrder.total,
        promo: pendingOrder.promo || "",
        discount: Number(document.getElementById("checkout-form").dataset.discount || 0)
      })
    });
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || "Could not confirm order");
    }

    localStorage.removeItem(CART_KEY);
    window.location.href = "success.html?order=" + encodeURIComponent(pendingOrder.orderRef) + "&method=upi&promo=" + encodeURIComponent(pendingOrder.promo || "");
  } catch (err) {
    console.error(err);
    // Even if logging failed, the customer already paid — don't leave them stuck on a dead
    // button. Still show the confirmation, but flag it so you know to check the sheet manually.
    window.location.href = "success.html?order=" + encodeURIComponent(pendingOrder.orderRef) + "&method=upi&logfailed=1";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderOrderSummary();
  fetchPromoCodes(); // load live codes from the PromoCodes sheet (falls back to config.js)

  document.querySelectorAll('input[name="paymentMethod"]').forEach(radio => {
    radio.addEventListener("change", renderOrderSummary);
  });

  const promoBtn = document.getElementById("promo-apply-btn");
  if (promoBtn) promoBtn.addEventListener("click", applyPromoCode);
  const promoInput = document.getElementById("promo-code");
  if (promoInput) promoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); applyPromoCode(); }
  });

  const form = document.getElementById("checkout-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();

    if (cartLineItems().length === 0) return;
    if (!validateForm(form)) return;

    const customer = {
      name: form.elements["name"].value.trim(),
      phone: form.elements["phone"].value.trim(),
      email: form.elements["email"].value.trim(),
      address: form.elements["address"].value.trim(),
      city: form.elements["city"].value.trim(),
      pincode: form.elements["pincode"].value.trim(),
      state: form.elements["state"].value.trim(),
    };

    const total = Number(form.dataset.total || 0);
    const items = cartLineItems().map(({ product, qty }) => ({
      id: product.id, name: product.name, price: product.price, qty
    }));

    showUpiPaymentPanel(customer, items, total);
  });

  const confirmBtn = document.getElementById("confirm-paid-btn");
  if (confirmBtn) confirmBtn.addEventListener("click", confirmUpiPaid);

  const backBtn = document.getElementById("back-to-form-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      document.getElementById("payment-view").style.display = "none";
      document.getElementById("checkout-view").style.display = "block";
    });
  }
});
