// Pure helpers for checkout. No network or database access here, so they can be unit tested.

export const LIMITS = { maxLines: 20, maxQuantity: 10, maxSubtotal: 500000 };

export function cleanText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

// Validates the request body from the browser. Returns { ok, errors, items, customer }.
export function validateOrderInput(body) {
  const errors = [];
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (!rawItems.length) errors.push("Your bag is empty.");
  if (rawItems.length > LIMITS.maxLines) errors.push("Too many different items in one order.");

  const merged = new Map();
  for (const item of rawItems.slice(0, LIMITS.maxLines)) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const quantity = Number(item?.quantity);
    if (!id || id.length > 80 || !Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.maxQuantity) {
      errors.push("One of the items in your bag is not valid.");
      continue;
    }
    merged.set(id, Math.min((merged.get(id) || 0) + quantity, LIMITS.maxQuantity));
  }

  const c = body?.customer ?? {};
  const customer = {
    name: cleanText(c.name, 80),
    phone: cleanText(c.phone, 20),
    address: cleanText(c.address, 300),
    city: cleanText(c.city, 80),
    note: cleanText(c.note, 300)
  };
  if (customer.name.length < 2) errors.push("Enter your full name.");
  const digits = customer.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15 || !/^[0-9+\-\s()]+$/.test(customer.phone)) errors.push("Enter a valid mobile number.");
  if (customer.address.length < 5) errors.push("Enter your delivery address.");
  if (customer.city.length < 3) errors.push("Enter your city and PIN code.");

  return { ok: errors.length === 0, errors, items: [...merged].map(([id, quantity]) => ({ id, quantity })), customer };
}

// Prices the order from the database rows, never from anything the browser sent.
export function priceOrder(items, productRows) {
  const byId = new Map(productRows.map(row => [row.id, row]));
  const errors = [];
  const lines = [];
  let subtotal = 0;
  for (const { id, quantity } of items) {
    const product = byId.get(id);
    if (!product || product.active === false) {
      errors.push("An item in your bag is no longer available. Please remove it and try again.");
      continue;
    }
    if (product.stock !== null && product.stock !== undefined && quantity > product.stock) {
      errors.push(product.stock <= 0 ? `${product.name} is sold out.` : `Only ${product.stock} of ${product.name} left.`);
      continue;
    }
    const unitPrice = Number(product.price);
    if (!Number.isInteger(unitPrice) || unitPrice <= 0) {
      errors.push(`${product.name} cannot be ordered right now.`);
      continue;
    }
    lines.push({ product_id: product.id, name: product.name, unit_price: unitPrice, quantity });
    subtotal += unitPrice * quantity;
  }
  if (!errors.length && subtotal > LIMITS.maxSubtotal) errors.push("This order is above the online payment limit. Please message us on WhatsApp.");
  return { ok: errors.length === 0, errors, lines, subtotal };
}

export function makeOrderRef(date = new Date(), randomValues = crypto.getRandomValues(new Uint32Array(1))) {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const stamp = ist.toISOString().slice(0, 10).replaceAll("-", "");
  return `NUB-${stamp}-${String(randomValues[0] % 10000).padStart(4, "0")}`;
}

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...signature].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// Razorpay checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
export async function verifyCheckoutSignature({ orderId, paymentId, signature, keySecret }) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return safeEqual(await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`), signature);
}

// Razorpay webhook signature: HMAC_SHA256(raw_body, webhook_secret)
export async function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  if (!rawBody || !signature || !webhookSecret) return false;
  return safeEqual(await hmacSha256Hex(webhookSecret, rawBody), signature);
}
