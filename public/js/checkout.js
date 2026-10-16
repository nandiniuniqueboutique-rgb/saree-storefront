'use strict';
(() => {
  const CART_KEY = 'nandini-order-cart';
  const $ = id => document.getElementById(id);
  const formatPrice = amount => `₹${Number(amount).toLocaleString('en-IN')}`;
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const safeImageURL = value => {
    try {
      const url = new URL(String(value || ''), location.href);
      return url.protocol === 'https:' || url.origin === location.origin ? url.href : '';
    } catch { return ''; }
  };

  const orderItems = $('order-items');
  const form = $('order-form');
  const sendButton = $('send-order');
  const statusLine = $('status');
  let config = { onlinePayments: false, cod: true, shippingFee: 0, freeShippingAbove: 0, whatsapp: '' };
  let products = [];
  let cart = new Map();
  let busy = false;
  let pending = null; // an online order already created and waiting for payment: { signature, response }

  function setStatus(message, isError = false) {
    statusLine.textContent = message;
    statusLine.classList.toggle('error', isError);
  }

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  const saveCart = () => { try { sessionStorage.setItem(CART_KEY, JSON.stringify([...cart.entries()])); } catch { /* private mode */ } };
  const lines = () => [...cart.entries()].filter(([id, qty]) => qty > 0 && products.some(p => p.id === id)).map(([id, qty]) => ({ product: products.find(p => p.id === id), quantity: qty }));
  const subtotal = () => lines().reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const shippingFor = amount => (config.freeShippingAbove > 0 && amount >= config.freeShippingAbove ? 0 : config.shippingFee);
  const method = () => (form.elements.method ? form.elements.method.value : '');

  function renderOrder() {
    const items = lines();
    const amount = subtotal();
    const shipping = shippingFor(amount);
    $('totals').hidden = !items.length;
    $('subtotal').textContent = formatPrice(amount);
    $('shipping').textContent = shipping ? formatPrice(shipping) : 'Free';
    $('total').textContent = formatPrice(amount + shipping);
    const note = $('shipping-note');
    const toFree = config.freeShippingAbove - amount;
    note.hidden = !(config.freeShippingAbove > 0 && toFree > 0 && items.length);
    note.textContent = `Add ${formatPrice(toFree)} more for free delivery.`;
    const soldOut = items.filter(line => line.product.inStock === false);
    orderItems.innerHTML = items.length ? items.map(({ product, quantity }) => `<article class="order-item"><img src="${escapeHTML(safeImageURL(product.thumb || product.image))}" alt="${escapeHTML(product.alt)}"><div><h3>${escapeHTML(product.name)}</h3><p>${escapeHTML(product.detail)}${product.inStock === false ? ' · <strong>Sold out</strong>' : ''}</p><div class="quantity"><button type="button" data-step="-1" data-id="${escapeHTML(product.id)}" aria-label="Remove one ${escapeHTML(product.name)}">−</button><span>${quantity}</span><button type="button" data-step="1" data-id="${escapeHTML(product.id)}" aria-label="Add one ${escapeHTML(product.name)}">+</button></div></div><strong class="line-total">${formatPrice(product.price * quantity)}</strong></article>`).join('')
      : '<p class="empty-state">Your selection is empty. <a href="/#collection">Browse the collection</a>.</p>';
    sendButton.disabled = busy || !items.length || soldOut.length > 0 || !method();
    $('whatsapp-enquiry').disabled = !items.length || !config.whatsapp;
    if (soldOut.length) setStatus(`${soldOut.map(line => line.product.name).join(', ')} has sold out. Please remove it to continue.`, true);
    updateButtonLabel();
  }

  function updateButtonLabel() {
    const total = formatPrice(subtotal() + shippingFor(subtotal()));
    if (busy) return;
    sendButton.textContent = pending ? `Complete payment · ${total}` : method() === 'online' ? `Pay ${total} securely` : method() === 'cod' ? 'Place order · Cash on delivery' : 'Place order';
  }

  function renderPaymentOptions() {
    const options = [];
    if (config.onlinePayments) options.push({ value: 'online', title: 'Pay online', text: 'UPI, cards, netbanking and wallets through Razorpay.' });
    if (config.cod) options.push({ value: 'cod', title: 'Cash on delivery', text: 'Pay in cash when your order arrives.' });
    const fieldset = $('pay-options');
    fieldset.hidden = options.length === 0;
    fieldset.innerHTML = `<legend>Payment</legend>${options.map((option, index) => `<label class="pay-option"><input type="radio" name="method" value="${option.value}"${index === 0 ? ' checked' : ''}><div><strong>${option.title}</strong><span>${option.text}</span></div></label>`).join('')}`;
    $('secure').hidden = !config.onlinePayments;
    $('pay-note').textContent = options.length
      ? 'The boutique confirms availability and delivery on WhatsApp or phone after you order.'
      : 'Online ordering is not available right now. Send an enquiry on WhatsApp and the boutique will help you.';
  }

  orderItems.addEventListener('click', event => {
    const button = event.target.closest('[data-step]');
    if (!button) return;
    const id = button.dataset.id;
    const quantity = Math.min(10, Math.max(0, (cart.get(id) || 0) + Number(button.dataset.step)));
    if (quantity) cart.set(id, quantity); else cart.delete(id);
    pending = null; // changing the bag invalidates an unpaid order
    saveCart();
    renderOrder();
    const again = orderItems.querySelector(`[data-id="${CSS.escape(id)}"][data-step="${button.dataset.step}"]`);
    if (again) again.focus();
  });

  form.addEventListener('change', () => { pending = null; renderOrder(); });

  const customerFromForm = () => {
    const data = new FormData(form);
    return { name: String(data.get('name')).trim(), phone: String(data.get('phone')).trim(), email: String(data.get('email')).trim(), address: String(data.get('address')).trim(), city: String(data.get('city')).trim() };
  };

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('The payment window could not load. Please check your connection and try again.'));
      document.head.appendChild(script);
    });
  }

  function showDone({ order, paid, name }) {
    try { sessionStorage.removeItem(CART_KEY); } catch { /* ignore */ }
    const payLine = order.method === 'cod'
      ? `Please keep <strong>${formatPrice(order.total)}</strong> ready in cash when your order arrives.`
      : `We have received your payment of <strong>${formatPrice(order.total)}</strong>. Thank you!`;
    const message = encodeURIComponent(`Hello Nandini Unique, I placed order ${order.number}${paid ? ' (paid online)' : ' (cash on delivery)'}. Name: ${name}.`);
    $('checkout').hidden = true;
    const done = $('done');
    done.hidden = false;
    done.innerHTML = `<div class="tick" aria-hidden="true">✓</div>
      <span class="eyebrow">Order placed</span>
      <h1>Thank you, ${escapeHTML(name.split(' ')[0])}!</h1>
      <div class="number" aria-label="Order number">${escapeHTML(order.number)}</div>
      <p>${payLine}</p>
      <p>The boutique will confirm availability and delivery with you shortly. Keep your order number handy.</p>
      <div class="actions">
        ${config.whatsapp ? `<a class="primary" href="https://wa.me/${escapeHTML(config.whatsapp)}?text=${message}" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a>` : ''}
        <a href="/">Continue shopping</a>
      </div>`;
    done.querySelector('h1').setAttribute('tabindex', '-1');
    done.querySelector('h1').focus();
    window.scrollTo({ top: 0 });
  }

  async function openPayment(response, name) {
    const { razorpay, order } = response;
    await loadRazorpay();
    let settled = false;
    const checkout = new window.Razorpay({
      key: razorpay.keyId,
      amount: razorpay.amount,
      currency: razorpay.currency,
      name: razorpay.name,
      description: razorpay.description,
      order_id: razorpay.orderId,
      prefill: razorpay.prefill,
      theme: { color: '#234d3c' },
      modal: {
        ondismiss: () => {
          if (settled) return;
          busy = false;
          setStatus('Payment was not completed. Your order is saved. Tap the button to try again.', true);
          renderOrder();
        }
      },
      handler: async paymentResult => {
        settled = true;
        setStatus('Confirming your payment...');
        try {
          await api('POST', `/api/orders/${encodeURIComponent(order.number)}/verify`, paymentResult);
          pending = null;
          showDone({ order, paid: true, name });
        } catch (error) {
          busy = false;
          setStatus(`${error.message} Order number: ${order.number}.`, true);
          renderOrder();
        }
      }
    });
    checkout.on('payment.failed', event => {
      busy = false;
      setStatus(`${(event.error && event.error.description) || 'The payment did not go through.'} You can try again.`, true);
      renderOrder();
    });
    checkout.open();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const customer = customerFromForm();
    busy = true;
    sendButton.disabled = true;
    sendButton.textContent = 'Please wait...';
    setStatus('');
    try {
      const signature = JSON.stringify([[...cart.entries()], customer, method(), new FormData(form).get('note')]);
      if (pending && pending.signature === signature) {
        await openPayment(pending.response, customer.name);
        return;
      }
      const response = await api('POST', '/api/orders', {
        method: method(),
        items: lines().map(line => ({ id: line.product.id, quantity: line.quantity })),
        customer,
        note: String(new FormData(form).get('note') || '').trim()
      });
      if (response.order.method === 'cod') {
        busy = false;
        showDone({ order: response.order, paid: false, name: customer.name });
        return;
      }
      pending = { signature, response };
      setStatus('Opening the secure payment window...');
      await openPayment(response, customer.name);
    } catch (error) {
      busy = false;
      setStatus(error.message, true);
      renderOrder();
    }
  });

  $('whatsapp-enquiry').addEventListener('click', () => {
    const items = lines();
    if (!items.length || !config.whatsapp) return;
    const customer = customerFromForm();
    const total = subtotal() + shippingFor(subtotal());
    const message = [
      "Hello Nandini Unique, I'd like to enquire about these items.",
      customer.name && `Name: ${customer.name}`,
      customer.phone && `Phone: ${customer.phone}`,
      customer.address && `Address: ${customer.address}`,
      customer.city && `City / PIN: ${customer.city}`,
      'Items:',
      ...items.map(line => `${line.product.name} × ${line.quantity} — ${formatPrice(line.product.price * line.quantity)}`),
      `Total: ${formatPrice(total)}`
    ].filter(Boolean).join('\n');
    window.open(`https://wa.me/${config.whatsapp}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  });

  async function init() {
    try {
      const [configResponse, productsResponse] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/products')]);
      config = { ...config, ...configResponse };
      products = productsResponse;
      let saved = [];
      try { saved = JSON.parse(sessionStorage.getItem(CART_KEY) || '[]'); } catch { /* ignore */ }
      cart = new Map((Array.isArray(saved) ? saved : []).filter(([id, qty]) => products.some(p => p.id === id) && Number.isInteger(qty) && qty > 0));
      saveCart();
      renderPaymentOptions();
      renderOrder();
    } catch {
      orderItems.innerHTML = '<p class="empty-state">The shop could not be loaded. <a href="/">Return to the shop</a>.</p>';
    }
  }

  init();
})();
