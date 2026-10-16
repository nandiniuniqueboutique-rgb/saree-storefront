'use strict';
const crypto = require('node:crypto');

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Create a Razorpay order for the given amount in paise. */
async function createRazorpayOrder(cfg, { amountPaise, receipt, notes }) {
  const { keyId, keySecret, apiBase } = cfg.razorpay;
  const response = await fetch(`${apiBase}/v1/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) {
    const reason = result && result.error && result.error.description ? result.error.description : `status ${response.status}`;
    throw new Error(`Razorpay order failed: ${reason}`);
  }
  return result;
}

/** The checkout handler returns razorpay_signature = HMAC_SHA256(order_id|payment_id, key_secret). */
function verifyPaymentSignature(cfg, { orderId, paymentId, signature }) {
  if (!cfg.razorpay.keySecret || !orderId || !paymentId) return false;
  return safeEqualHex(hmacHex(cfg.razorpay.keySecret, `${orderId}|${paymentId}`), String(signature || ''));
}

/** Webhooks are signed with HMAC_SHA256(raw body, webhook secret) in X-Razorpay-Signature. */
function verifyWebhookSignature(cfg, rawBody, signature) {
  if (!cfg.razorpay.webhookSecret) return false;
  return safeEqualHex(hmacHex(cfg.razorpay.webhookSecret, rawBody), String(signature || ''));
}

module.exports = { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature, hmacHex };
