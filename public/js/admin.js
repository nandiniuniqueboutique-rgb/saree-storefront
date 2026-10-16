'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const formatPrice = amount => `₹${Number(amount).toLocaleString('en-IN')}`;
  const safeImageURL = value => {
    try {
      const url = new URL(String(value || ''), location.href);
      return url.protocol === 'https:' || url.origin === location.origin ? url.href : '';
    } catch { return ''; }
  };
  const MAX_PHOTOS = 6;
  const STATUS_LABELS = { awaiting_payment: 'Awaiting payment', new: 'New', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
  const PAYMENT_LABELS = { unpaid: 'Not paid yet', paid: 'Paid', refunded: 'Refunded' };

  const state = { admin: null, products: [], orders: [], tab: 'products', editingId: '', photos: [], uploads: 0 };
  let toastTimer;
  let pollTimer;

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
  }

  class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

  async function api(method, url, body) {
    const isForm = body instanceof FormData;
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: isForm ? body : JSON.stringify(body) } : {}),
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && state.admin && !url.startsWith('/api/auth/')) {
      showLogin('Your session ended. Please sign in again.');
      throw new ApiError('Please sign in again.', 401);
    }
    if (!response.ok) throw new ApiError(data.error || 'Something went wrong. Please try again.', response.status);
    return data;
  }

  /* ---------- views ---------- */
  function showLogin(message = '') {
    state.admin = null;
    clearInterval(pollTimer);
    $('login-view').hidden = false;
    $('app-view').hidden = true;
    $('sign-out-top').hidden = true;
    $('login-message').textContent = message;
    $('login-message').classList.toggle('error', Boolean(message));
    $('login-password').value = '';
    document.title = 'Owner Login | Nandini Unique Boutique';
    $('login-email').focus();
  }

  async function showApp(admin) {
    state.admin = admin;
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('sign-out-top').hidden = false;
    $('signed-in-as').textContent = `Signed in as ${admin.email}`;
    $('account-email').textContent = `Signed in as ${admin.email}.`;
    document.title = 'Owner Dashboard | Nandini Unique Boutique';
    await Promise.all([loadProducts(), loadOrders()]);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!document.hidden) loadOrders(true).catch(() => {}); }, 60_000);
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
    for (const name of ['orders', 'products', 'account']) $(`panel-${name}`).hidden = name !== tab;
  }

  document.querySelector('.tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-tab]');
    if (button) setTab(button.dataset.tab);
  });
  document.querySelector('.tabs').addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.tab')];
    const index = tabs.findIndex(tab => tab.dataset.tab === state.tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.tab);
    next.focus();
  });

  /* ---------- sign in / out ---------- */
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('login-button');
    button.disabled = true;
    $('login-message').textContent = '';
    try {
      const { admin } = await api('POST', '/api/auth/login', { email: $('login-email').value, password: $('login-password').value });
      await showApp(admin);
    } catch (error) {
      $('login-message').textContent = error.message;
      $('login-message').classList.add('error');
    } finally {
      button.disabled = false;
    }
  });

  async function signOut() {
    try { await api('POST', '/api/auth/logout', {}); } catch { /* already signed out */ }
    showLogin('You have been signed out.');
    $('login-message').classList.remove('error');
  }
  $('sign-out').addEventListener('click', signOut);
  $('sign-out-top').addEventListener('click', signOut);

  $('password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const message = $('pw-message');
    message.classList.remove('error');
    if ($('pw-new').value !== $('pw-again').value) {
      message.textContent = 'The two new passwords do not match.';
      message.classList.add('error');
      return;
    }
    $('pw-button').disabled = true;
    try {
      await api('POST', '/api/admin/password', { current: $('pw-current').value, next: $('pw-new').value });
      message.textContent = 'Password changed. Other devices were signed out.';
      event.target.reset();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('error');
    } finally {
      $('pw-button').disabled = false;
    }
  });

  /* ---------- products ---------- */
  async function loadProducts() {
    state.products = await api('GET', '/api/admin/products');
    renderProducts();
  }

  function renderProducts() {
    $('product-count').textContent = `(${state.products.length})`;
    $('product-list').innerHTML = state.products.length ? state.products.map(product => `
      <article class="product-row">
        <img src="${escapeHtml(safeImageURL(product.thumb || product.image))}" alt="${escapeHtml(product.alt)}">
        <div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.type)} · ${escapeHtml(product.category)}${product.detail ? ` · ${escapeHtml(product.detail)}` : ''} · ${product.photos.length} photo${product.photos.length === 1 ? '' : 's'}${product.description ? '' : ' · <strong>no description yet</strong>'}</p></div>
        <span class="price">${formatPrice(product.price)}</span>
        <button class="stock ${product.inStock ? 'in' : 'out'}" type="button" data-stock="${escapeHtml(product.id)}" aria-label="${escapeHtml(product.name)}: ${product.inStock ? 'in stock. Click to mark sold out' : 'sold out. Click to mark available'}">${product.inStock ? 'In stock' : 'Sold out'}</button>
        <div class="row-actions">
          <button class="icon-action" type="button" data-edit="${escapeHtml(product.id)}" aria-label="Edit ${escapeHtml(product.name)}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16-.8 4.8L8 20l11-11-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></svg></button>
          <button class="icon-action remove" type="button" data-delete="${escapeHtml(product.id)}" aria-label="Remove ${escapeHtml(product.name)}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
        </div>
      </article>`).join('') : '<p class="empty">No products yet. Tap “Add product” to create the first one.</p>';
    $('category-options').innerHTML = [...new Set([...state.products.map(p => p.category), 'Silk', 'Cotton', 'Festive', 'Everyday', 'Party wear', 'Casual', 'Bridal'])].map(c => `<option value="${escapeHtml(c)}">`).join('');
  }

  $('product-list').addEventListener('click', async event => {
    const edit = event.target.closest('[data-edit]');
    if (edit) return openProduct(state.products.find(p => p.id === edit.dataset.edit));
    const stock = event.target.closest('[data-stock]');
    if (stock) {
      const product = state.products.find(p => p.id === stock.dataset.stock);
      try {
        const updated = await api('PATCH', `/api/admin/products/${encodeURIComponent(product.id)}/stock`, { inStock: !product.inStock });
        state.products = state.products.map(p => (p.id === updated.id ? updated : p));
        renderProducts();
        showToast(`${updated.name} marked ${updated.inStock ? 'in stock' : 'sold out'}.`);
      } catch (error) { showToast(error.message); }
      return;
    }
    const del = event.target.closest('[data-delete]');
    if (!del) return;
    const product = state.products.find(p => p.id === del.dataset.delete);
    if (!product || !window.confirm(`Remove “${product.name}” from the shop? Its photos are deleted too. Past orders keep their details.`)) return;
    try {
      await api('DELETE', `/api/admin/products/${encodeURIComponent(product.id)}`);
      await loadProducts();
      showToast(`${product.name} removed.`);
    } catch (error) { showToast(error.message); }
  });

  /* ---------- product editor ---------- */
  const dialog = $('product-dialog');
  const form = $('product-form');

  function renderPhotos() {
    $('photo-grid').innerHTML = state.photos.map((photo, index) => `
      <div class="photo-tile${index === 0 ? ' cover' : ''}">
        <div class="frame"><img src="${escapeHtml(photo.preview)}" alt="Photo ${index + 1}">${photo.uploading ? '<div class="busy">Uploading…</div>' : ''}</div>
        ${index === 0 ? '<span class="badge">Cover</span>' : ''}
        <div class="tile-actions">
          ${index === 0 || photo.uploading ? '' : `<button type="button" data-cover="${index}">Make cover</button>`}
          ${photo.uploading ? '' : `<button class="remove" type="button" data-drop="${index}">Remove</button>`}
        </div>
      </div>`).join('');
    $('save-product').disabled = state.uploads > 0;
  }

  function openProduct(product) {
    state.editingId = product ? product.id : '';
    form.reset();
    $('product-photo').value = '';
    $('dialog-message').textContent = '';
    $('dialog-title').textContent = product ? 'Edit product' : 'Add product';
    state.photos = [];
    if (product) {
      form.elements.name.value = product.name;
      form.elements.type.value = product.type;
      form.elements.category.value = product.category;
      form.elements.detail.value = product.detail;
      form.elements.tag.value = product.tag;
      form.elements.price.value = product.price;
      form.elements.originalPrice.value = product.originalPrice ?? '';
      form.elements.description.value = product.description;
      form.elements.alt.value = product.alt === product.name ? '' : product.alt;
      form.elements.inStock.checked = product.inStock;
      state.photos = product.photos.map(photo => ({ url: photo.url, thumbUrl: photo.thumbUrl, preview: photo.thumbUrl }));
    }
    renderPhotos();
    dialog.showModal();
    form.elements.name.focus();
  }

  $('add-product').addEventListener('click', () => openProduct(null));
  $('dialog-close').addEventListener('click', () => dialog.close());
  $('cancel-edit').addEventListener('click', () => dialog.close());

  async function toJpeg(bitmap, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; // PNG transparency becomes white
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Photo conversion failed.'))), 'image/jpeg', quality));
  }

  async function uploadPhoto(file) {
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error(`“${file.name}” is not a photo this browser can read. Use JPEG, PNG or WebP.`); }
    const full = await toJpeg(bitmap, 1600, 0.86);
    const thumb = await toJpeg(bitmap, 640, 0.8);
    bitmap.close();
    const data = new FormData();
    data.append('full', full, 'photo.jpg');
    data.append('thumb', thumb, 'thumb.jpg');
    return api('POST', '/api/admin/uploads', data);
  }

  $('product-photo').addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    const room = MAX_PHOTOS - state.photos.length;
    if (files.length > room) showToast(`Only ${MAX_PHOTOS} photos per product. Extra photos were skipped.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const tile = { uploading: true, preview: URL.createObjectURL(file), url: '', thumbUrl: '' };
      state.photos.push(tile);
      state.uploads += 1;
      renderPhotos();
      uploadPhoto(file).then(result => {
        tile.url = result.url;
        tile.thumbUrl = result.thumbUrl;
        tile.preview = result.thumbUrl;
        tile.uploading = false;
      }).catch(error => {
        state.photos = state.photos.filter(item => item !== tile);
        $('dialog-message').textContent = error.message;
        $('dialog-message').classList.add('error');
      }).finally(() => {
        state.uploads -= 1;
        renderPhotos();
      });
    }
  });

  $('photo-grid').addEventListener('click', event => {
    const cover = event.target.closest('[data-cover]');
    const drop = event.target.closest('[data-drop]');
    if (cover) {
      const [photo] = state.photos.splice(Number(cover.dataset.cover), 1);
      state.photos.unshift(photo);
    } else if (drop) {
      state.photos.splice(Number(drop.dataset.drop), 1);
    } else return;
    renderPhotos();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.uploads > 0) return;
    const message = $('dialog-message');
    message.textContent = '';
    message.classList.add('error');
    if (!state.photos.length) { message.textContent = 'Add at least one photo.'; return; }
    const data = new FormData(form);
    const body = {
      name: data.get('name'),
      type: data.get('type'),
      category: data.get('category'),
      detail: data.get('detail'),
      tag: data.get('tag'),
      price: data.get('price'),
      originalPrice: data.get('originalPrice') || null,
      description: data.get('description'),
      alt: data.get('alt'),
      inStock: form.elements.inStock.checked,
      images: state.photos.map(photo => ({ url: photo.url, thumbUrl: photo.thumbUrl }))
    };
    $('save-product').disabled = true;
    try {
      if (state.editingId) await api('PUT', `/api/admin/products/${encodeURIComponent(state.editingId)}`, body);
      else await api('POST', '/api/admin/products', body);
      dialog.close();
      await loadProducts();
      showToast('Product saved. It is live in the shop now.');
    } catch (error) {
      message.textContent = error.message;
    } finally {
      renderPhotos();
    }
  });

  /* ---------- orders ---------- */
  async function loadOrders(quiet = false) {
    const { orders } = await api('GET', '/api/admin/orders');
    const previousNew = state.orders.filter(order => order.status === 'new').length;
    state.orders = orders;
    const newCount = orders.filter(order => order.status === 'new').length;
    $('orders-count').hidden = newCount === 0;
    $('orders-count').textContent = newCount;
    if (quiet && newCount > previousNew) showToast(`${newCount - previousNew} new order${newCount - previousNew === 1 ? '' : 's'} received.`);
    renderOrders();
  }

  function paymentBadge(order) {
    if (order.status === 'cancelled' && order.paymentStatus === 'paid') return '<span class="badge-pill bad">Paid, but cancelled: refund needed</span>';
    if (order.paymentMethod === 'online') {
      if (order.paymentStatus === 'paid') return '<span class="badge-pill">Paid online</span>';
      if (order.paymentStatus === 'refunded') return '<span class="badge-pill warn">Refunded</span>';
      return '<span class="badge-pill warn">Awaiting payment</span>';
    }
    if (order.paymentStatus === 'paid') return '<span class="badge-pill">Cash received</span>';
    return `<span class="badge-pill warn">Cash on delivery: collect ${formatPrice(order.total)}</span>`;
  }

  function renderOrders() {
    const filter = $('order-filter').value;
    const orders = filter ? state.orders.filter(order => order.status === filter) : state.orders;
    $('order-list').innerHTML = orders.length ? orders.map(order => {
      const when = new Date(order.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      const phone = order.customer.phone;
      return `<article class="order-card${order.status === 'new' ? ' attention' : ''}" data-order="${order.id}">
        <div class="order-head"><div><strong>${escapeHtml(order.number)}</strong> <time datetime="${escapeHtml(order.createdAt)}">${escapeHtml(when)}</time></div><div>${paymentBadge(order)} <span class="badge-pill${order.status === 'cancelled' ? ' bad' : order.status === 'awaiting_payment' ? ' warn' : ''}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span></div></div>
        <div class="order-body">
          <div>
            <h4>Customer</h4>
            <address>${escapeHtml(order.customer.name)}<br>${escapeHtml(order.address).replace(/\n/g, '<br>')}<br>${escapeHtml(order.city)}</address>
            <p class="contact"><a href="tel:+${escapeHtml(phone)}">+${escapeHtml(phone)}</a> · <a href="https://wa.me/${escapeHtml(phone)}?text=${encodeURIComponent(`Hello ${order.customer.name}, this is Nandini Unique Boutique about your order ${order.number}.`)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>${order.customer.email ? ` · <a href="mailto:${escapeHtml(order.customer.email)}">${escapeHtml(order.customer.email)}</a>` : ''}</p>
            ${order.note ? `<h4>Note from customer</h4><p>${escapeHtml(order.note)}</p>` : ''}
            ${order.razorpayPaymentId ? `<p class="help">Razorpay payment ${escapeHtml(order.razorpayPaymentId)}</p>` : ''}
          </div>
          <div>
            <h4>Items</h4>
            <ul class="order-lines">${order.items.map(item => `<li><img src="${escapeHtml(safeImageURL(item.image))}" alt=""><span>${escapeHtml(item.name)} × ${item.quantity}</span><strong>${formatPrice(item.price * item.quantity)}</strong></li>`).join('')}</ul>
            <div class="order-sum"><span>Delivery</span><span>${order.shipping ? formatPrice(order.shipping) : 'Free'}</span></div>
            <div class="order-sum grand"><span>Total</span><span>${formatPrice(order.total)}</span></div>
          </div>
        </div>
        <form class="order-controls" data-order-form="${order.id}">
          <div class="field"><label for="st-${order.id}">Order status</label><select id="st-${order.id}" name="status">${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}"${value === order.status ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
          <div class="field"><label for="pay-${order.id}">Payment</label><select id="pay-${order.id}" name="paymentStatus">${Object.entries(PAYMENT_LABELS).map(([value, label]) => `<option value="${value}"${value === order.paymentStatus ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
          <div class="field grow"><label for="tr-${order.id}">Tracking or courier note</label><input id="tr-${order.id}" name="tracking" maxlength="160" value="${escapeHtml(order.tracking)}" placeholder="e.g. India Post EE123456789IN"></div>
          <button class="button small" type="submit">Save</button>
        </form>
      </article>`;
    }).join('') : `<p class="empty">${filter ? 'No orders with this status.' : 'No orders yet. They will appear here as soon as a customer checks out.'}</p>`;
  }

  $('order-filter').addEventListener('change', renderOrders);
  $('refresh-orders').addEventListener('click', () => loadOrders().then(() => showToast('Orders refreshed.')).catch(error => showToast(error.message)));
  $('order-list').addEventListener('submit', async event => {
    const orderForm = event.target.closest('[data-order-form]');
    if (!orderForm) return;
    event.preventDefault();
    const button = orderForm.querySelector('button');
    button.disabled = true;
    const data = new FormData(orderForm);
    try {
      await api('PATCH', `/api/admin/orders/${orderForm.dataset.orderForm}`, { status: data.get('status'), paymentStatus: data.get('paymentStatus'), tracking: data.get('tracking') });
      await loadOrders();
      showToast('Order updated.');
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });

  /* ---------- start ---------- */
  api('GET', '/api/auth/me').then(({ admin }) => (admin ? showApp(admin) : showLogin())).catch(() => showLogin('Could not reach the server. Please try again.'));
})();
