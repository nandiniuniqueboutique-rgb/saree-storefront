// Request handlers for the three payment endpoints. All outside services (database,
// Razorpay) are passed in as `deps`, so tests can swap in fakes.
import { makeOrderRef, priceOrder, validateOrderInput, verifyCheckoutSignature, verifyWebhookSignature } from "./logic.js";

const MAX_BODY_BYTES = 20000;

function corsHeaders(deps, request) {
  const allowed = deps.allowedOrigins || [];
  const origin = request.headers.get("origin") || "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] || "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

function reply(deps, request, status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(deps, request), "Content-Type": "application/json" } });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Request too large");
  return { text, json: JSON.parse(text || "{}") };
}

export function createOrderHandler(deps) {
  return async request => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(deps, request) });
    if (request.method !== "POST") return reply(deps, request, 405, { error: "Method not allowed" });
    try {
      const { json } = await readJson(request);
      const input = validateOrderInput(json);
      if (!input.ok) return reply(deps, request, 400, { error: input.errors[0], errors: input.errors });

      const rows = await deps.db.getProducts(input.items.map(item => item.id));
      const priced = priceOrder(input.items, rows);
      if (!priced.ok) return reply(deps, request, 409, { error: priced.errors[0], errors: priced.errors });

      const ref = makeOrderRef(deps.now ? deps.now() : new Date());
      const rzpResponse = await deps.fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${btoa(`${deps.keyId}:${deps.keySecret}`)}`
        },
        body: JSON.stringify({ amount: priced.subtotal * 100, currency: "INR", receipt: ref, notes: { ref } })
      });
      const rzpOrder = await rzpResponse.json().catch(() => ({}));
      if (!rzpResponse.ok || !rzpOrder.id) {
        console.error("Razorpay order failed", rzpResponse.status, JSON.stringify(rzpOrder));
        return reply(deps, request, 502, { error: "The payment service is not available right now. Please try again or order on WhatsApp." });
      }

      await deps.db.createOrder({
        ref,
        status: "pending",
        customer_name: input.customer.name,
        phone: input.customer.phone,
        address: input.customer.address,
        city_pin: input.customer.city,
        note: input.customer.note,
        subtotal: priced.subtotal,
        currency: "INR",
        razorpay_order_id: rzpOrder.id
      }, priced.lines);

      return reply(deps, request, 200, {
        keyId: deps.keyId,
        razorpayOrderId: rzpOrder.id,
        amount: priced.subtotal * 100,
        currency: "INR",
        ref,
        customer: { name: input.customer.name, contact: input.customer.phone }
      });
    } catch (error) {
      console.error("create-order failed", error);
      return reply(deps, request, 500, { error: "Something went wrong. Please try again or order on WhatsApp." });
    }
  };
}

export function verifyPaymentHandler(deps) {
  return async request => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(deps, request) });
    if (request.method !== "POST") return reply(deps, request, 405, { error: "Method not allowed" });
    try {
      const { json } = await readJson(request);
      const valid = await verifyCheckoutSignature({
        orderId: json.razorpay_order_id,
        paymentId: json.razorpay_payment_id,
        signature: json.razorpay_signature,
        keySecret: deps.keySecret
      });
      if (!valid) return reply(deps, request, 400, { error: "We could not verify this payment. If money was deducted, it will be matched automatically or refunded; message us on WhatsApp." });
      const order = await deps.db.markPaid(json.razorpay_order_id, json.razorpay_payment_id);
      return reply(deps, request, 200, { ok: true, ref: order.ref });
    } catch (error) {
      console.error("verify-payment failed", error);
      return reply(deps, request, 500, { error: "We could not confirm the payment yet. If money was deducted, your order will be confirmed shortly." });
    }
  };
}

export function razorpayWebhookHandler(deps) {
  return async request => {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const rawBody = await request.text();
    const valid = await verifyWebhookSignature({
      rawBody,
      signature: request.headers.get("x-razorpay-signature"),
      webhookSecret: deps.webhookSecret
    });
    if (!valid) return new Response("Invalid signature", { status: 400 });
    try {
      const event = JSON.parse(rawBody);
      const payment = event?.payload?.payment?.entity;
      const orderId = payment?.order_id || event?.payload?.order?.entity?.id;
      if ((event.event === "payment.captured" || event.event === "order.paid") && orderId && payment?.id) {
        await deps.db.markPaid(orderId, payment.id);
      } else if (event.event === "payment.failed" && orderId) {
        await deps.db.markFailed(orderId);
      }
      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error("webhook failed", error);
      return new Response("error", { status: 500 }); // Razorpay will retry
    }
  };
}
