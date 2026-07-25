// Checkout flow:
// 1. Render order summary from cart (recalculates if COD fee applies)
// 2. Validate form
// 3a. UPI: show a QR code + UPI deep link for the exact amount. Customer pays in their own
//     UPI app (outside this site entirely — there's no gateway involved). When they tap
//     "I've paid," we log the order as pending manual verification and show the confirmation.
//     You verify the payment yourself against your bank/UPI app notification before shipping.
// 3b. COD: POST to Apps Script -> logs order directly as COD_PENDING -> straight to success.html

const COD_FEE = 49;

let pendingOrder = null; // { customer, items, total } — set once "Continue to payment" is clicked

function selectedPaymentMethod() {
  const checked = document.querySelector('input[name="paymentMethod"]:checked');
  return checked ? checked.value : "upi";
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
  const shipping = subtotal >= 799 ? 0 : 59;
  const isCod = selectedPaymentMethod() === "cod";
  const codFee = isCod ? COD_FEE : 0;
  const total = subtotal + shipping + codFee;

  container.innerHTML = `
    ${items.map(({ product, qty, lineTotal }) => `
      <div class="order-row">
        <span>${product.name} × ${qty}</span>
        <span>₹${lineTotal}</span>
      </div>
    `).join("")}
    <div class="order-row">
      <span>Shipping</span>
      <span>${shipping === 0 ? "Free" : "₹" + shipping}</span>
    </div>
    ${isCod ? `
    <div class="order-row">
      <span>Cash on Delivery fee</span>
      <span>₹${COD_FEE}</span>
    </div>` : ""}
    <div class="order-row total">
      <span>Total</span>
      <span>₹${total}</span>
    </div>
  `;

  document.getElementById("checkout-form").dataset.total = total;

  if (payBtn) {
    payBtn.textContent = isCod ? "Place order" : "Continue to payment";
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

  const orderRef = "ZRUPI" + Date.now();
  pendingOrder.orderRef = orderRef;

  const upiUri = buildUpiUri(total, "Zainrsh Order " + orderRef);

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
        total: pendingOrder.total
      })
    });
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || "Could not confirm order");
    }

    localStorage.removeItem(CART_KEY);
    window.location.href = "success.html?order=" + encodeURIComponent(pendingOrder.orderRef) + "&method=upi";
  } catch (err) {
    console.error(err);
    // Even if logging failed, the customer already paid — don't leave them stuck on a dead
    // button. Still show the confirmation, but flag it so you know to check the sheet manually.
    window.location.href = "success.html?order=" + encodeURIComponent(pendingOrder.orderRef) + "&method=upi&logfailed=1";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderOrderSummary();

  document.querySelectorAll('input[name="paymentMethod"]').forEach(radio => {
    radio.addEventListener("change", renderOrderSummary);
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

    if (selectedPaymentMethod() === "cod") {
      placeCodOrder(customer, items, total);
    } else {
      showUpiPaymentPanel(customer, items, total);
    }
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

async function placeCodOrder(customer, items, total) {
  const payBtn = document.getElementById("pay-btn");
  payBtn.disabled = true;
  payBtn.textContent = "Placing order…";

  try {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({
        action: "createCodOrder",
        customer,
        items,
        total
      })
    });
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || "Could not place order");
    }

    localStorage.removeItem(CART_KEY);
    window.location.href = "success.html?order=" + encodeURIComponent(data.merchantOrderId) + "&method=cod";
  } catch (err) {
    console.error(err);
    alert("Something went wrong placing your order. Please try again, or check that the store's backend is configured correctly.");
    payBtn.disabled = false;
    payBtn.textContent = "Place order";
  }
}
