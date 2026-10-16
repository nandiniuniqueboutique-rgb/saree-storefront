'use strict';
// Set from /api/config (WHATSAPP_NUMBER on the server) once the page loads.
let STORE_WHATSAPP = "";
let products = [];
const CART_KEY = "nandini-order-cart";
const cart = new Map();
let activeFilter = "All";
let activeType = "All";

// Restore the bag (shared with the order page) so items survive a refresh or a trip back from checkout.
try {
  const saved = JSON.parse(sessionStorage.getItem(CART_KEY) || "[]");
  if (Array.isArray(saved)) saved.forEach(([id, quantity]) => { if (typeof id === "string" && Number.isInteger(quantity) && quantity > 0) cart.set(id, quantity); });
} catch {}
const saveCart = () => { try { sessionStorage.setItem(CART_KEY, JSON.stringify([...cart.entries()])); } catch {} };
let toastTimer;

const formatPrice = amount => `₹${Number(amount).toLocaleString("en-IN")}`;
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function safeImageURL(value) {
  try {
    const url = new URL(String(value || ""), location.href);
    return url.protocol === "https:" || url.origin === location.origin ? url.href : "";
  } catch {
    return "";
  }
}

const grid = document.getElementById("product-grid");
const filterBar = document.getElementById("filters");
const typeBar = document.getElementById("type-filters");
const detail = document.getElementById("detail");
const detailBody = document.getElementById("detail-body");
const TYPE_LABELS = { Saree: "Sarees", Dress: "Dresses" };
const productType = product => product.type === "Dress" ? "Dress" : "Saree";
const cartPanel = document.getElementById("cart-panel");
const overlay = document.getElementById("overlay");

function renderFilters() {
  const types = ["Saree", "Dress"].filter(type => products.some(product => productType(product) === type));
  if (types.length < 2 || !types.includes(activeType)) activeType = "All";
  typeBar.hidden = types.length < 2;
  typeBar.innerHTML = ["All", ...types].map(type => `<button class="filter" type="button" aria-pressed="${type === activeType}" data-type="${escapeHTML(type)}">${type === "All" ? "All" : escapeHTML(TYPE_LABELS[type])}</button>`).join("");
  const inType = products.filter(product => activeType === "All" || productType(product) === activeType);
  const categories = ["All", ...new Set(inType.map(product => product.category).filter(Boolean))];
  if (!categories.includes(activeFilter)) activeFilter = "All";
  filterBar.innerHTML = categories.map(category => `<button class="filter" type="button" aria-pressed="${category === activeFilter}" data-filter="${escapeHTML(category)}">${category === "All" ? "All styles" : escapeHTML(category)}</button>`).join("");
}

function setFilter(name) {
  activeFilter = name;
  renderFilters();
  renderProducts();
}

function renderProducts() {
  const visibleProducts = products.filter(product => (activeType === "All" || productType(product) === activeType) && (activeFilter === "All" || product.category === activeFilter));
  if (!visibleProducts.length) {
    grid.innerHTML = '<p class="empty-state">Nothing here just yet. New sarees arrive often, so check back soon.</p>';
    return;
  }
  grid.innerHTML = visibleProducts.map(product => `
    <article class="product-card" data-product="${escapeHTML(product.id)}">
      <div class="product-photo">
        <img src="${escapeHTML(safeImageURL(product.thumb || product.image))}" alt="${escapeHTML(product.alt)}" loading="lazy" decoding="async">
        <span class="product-tag">${escapeHTML(product.inStock === false ? "Sold out" : product.tag)}</span>
        <button class="quick-add" type="button" data-add="${escapeHTML(product.id)}" aria-label="${product.inStock === false ? `${escapeHTML(product.name)} is sold out` : `Add ${escapeHTML(product.name)} to bag`}"${product.inStock === false ? " disabled" : ""}>${product.inStock === false ? "Sold out" : "Add to bag +"}</button>
      </div>
      <div class="product-details"><div><h3><button class="product-link" type="button" aria-haspopup="dialog">${escapeHTML(product.name)}</button></h3><p>${escapeHTML(product.detail)}</p></div><span class="price">${formatPrice(product.price)}${product.originalPrice ? `<del class="old-price">${formatPrice(product.originalPrice)}</del>` : ""}</span></div>
    </article>`).join("");
}

function renderCart() {
  const items = [...cart.entries()].filter(([id]) => products.some(product => product.id === id));
  const count = items.reduce((total, [, quantity]) => total + quantity, 0);
  const subtotal = items.reduce((total, [id, quantity]) => total + products.find(product => product.id === id).price * quantity, 0);
  document.getElementById("bag-count").textContent = count;
  document.getElementById("cart-heading-count").textContent = `(${count})`;
  document.getElementById("cart-total").textContent = formatPrice(subtotal);
  document.getElementById("cart-items").innerHTML = items.length ? items.map(([id, quantity]) => {
    const product = products.find(item => item.id === id);
    const name = escapeHTML(product.name);
    return `<div class="cart-row"><img src="${escapeHTML(safeImageURL(product.thumb || product.image))}" alt="" loading="lazy"><div><h3>${name}</h3><p>${formatPrice(product.price)} each</p><div class="cart-qty"><button type="button" data-step="-1" data-id="${escapeHTML(id)}" aria-label="Remove one ${name}">−</button><span aria-label="Quantity">${quantity}</span><button type="button" data-step="1" data-id="${escapeHTML(id)}" aria-label="Add one ${name}">+</button></div></div><div class="cart-line"><strong>${formatPrice(product.price * quantity)}</strong><button class="remove-item" type="button" data-remove="${escapeHTML(id)}" aria-label="Remove ${name} from bag">Remove</button></div></div>`;
  }).join("") : '<p class="cart-empty">Your bag is taking a little breather. Browse the edit and add a saree you love.</p>';
  saveCart();
}

async function loadProducts() {
  try {
    const response = await fetch("/api/products", { cache: "no-store" });
    if (!response.ok) throw new Error("Catalog request failed");
    const catalog = await response.json();
    if (!Array.isArray(catalog)) throw new Error("Catalog format is invalid");
    products = catalog;
    [...cart.keys()].forEach(id => { if (!products.some(product => product.id === id)) cart.delete(id); });
    renderFilters();
    renderProducts();
    renderCart();
  } catch {
    grid.innerHTML = '<p class="empty-state">The collection could not be loaded. Please try again shortly.</p>';
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setCartOpen(open) {
  cartPanel.classList.toggle("open", open);
  overlay.classList.toggle("open", open);
  cartPanel.setAttribute("aria-hidden", String(!open));
  // While the bag is open, the rest of the page is inert so keyboard focus stays inside it.
  cartPanel.inert = !open;
  document.querySelectorAll(".skip-link, .announcement, .site-header, main, footer, .whatsapp-fab").forEach(element => { element.inert = open; });
  document.body.style.overflow = open ? "hidden" : "";
  if (open) document.getElementById("cart-close").focus();
  else document.getElementById("cart-open").focus();
}

function addToCart(id) {
  const product = products.find(item => item.id === id);
  if (!product) return;
  if (product.inStock === false) { showToast(`${product.name} has just sold out`); return; }
  cart.set(id, (cart.get(id) || 0) + 1);
  renderCart();
  showToast(`${product.name} added to your bag`);
}

function openDetail(id) {
  const product = products.find(item => item.id === id);
  if (!product) return;
  const images = (Array.isArray(product.images) && product.images.length ? product.images : [product.image]).map(safeImageURL).filter(Boolean);
  const name = escapeHTML(product.name);
  const question = encodeURIComponent(`Hello Nandini Unique, I have a question about ${product.name}.`);
  detailBody.innerHTML = `
    <div class="detail-gallery">
      <img class="detail-main" id="detail-main" src="${escapeHTML(images[0] || "")}" alt="${escapeHTML(product.alt || product.name)}">
      ${images.length > 1 ? `<div class="detail-thumbs">${images.map((src, index) => `<button class="thumb" type="button" data-thumb="${escapeHTML(src)}" aria-label="Show photo ${index + 1} of ${images.length}" aria-pressed="${index === 0}"><img src="${escapeHTML(src)}" alt=""></button>`).join("")}</div>` : ""}
    </div>
    <div class="detail-info">
      <span class="eyebrow">${escapeHTML(product.category)} · ${escapeHTML(productType(product))}</span>
      <h2 id="detail-title">${name}</h2>
      <p class="detail-fabric">${escapeHTML(product.detail)}</p>
      <p class="detail-price">${formatPrice(product.price)}${product.originalPrice ? `<del>${formatPrice(product.originalPrice)}</del>` : ""}</p>
      ${product.description ? `<p class="detail-description">${escapeHTML(product.description)}</p>` : ""}
      <div class="detail-actions">
        ${product.inStock === false ? '<button class="button" type="button" disabled>Sold out</button>' : `<button class="button" type="button" data-add="${escapeHTML(product.id)}">Add to bag +</button>`}
        ${STORE_WHATSAPP ? `<a class="text-link" href="https://wa.me/${STORE_WHATSAPP}?text=${question}" target="_blank" rel="noopener noreferrer">Ask on WhatsApp</a>` : ""}
      </div>
    </div>`;
  detail.showModal();
  detail.scrollTop = 0;
}

typeBar.addEventListener("click", event => {
  const button = event.target.closest("[data-type]");
  if (!button) return;
  activeType = button.dataset.type;
  activeFilter = "All";
  renderFilters();
  renderProducts();
  typeBar.querySelector(`[data-type="${CSS.escape(activeType)}"]`)?.focus();
});

detail.addEventListener("click", event => {
  if (event.target === detail || event.target.closest("#detail-close")) { detail.close(); return; }
  const thumb = event.target.closest("[data-thumb]");
  if (thumb) {
    document.getElementById("detail-main").src = thumb.dataset.thumb;
    detail.querySelectorAll(".thumb").forEach(item => item.setAttribute("aria-pressed", String(item === thumb)));
    return;
  }
  const add = event.target.closest("[data-add]");
  if (add) {
    detail.close();
    addToCart(add.dataset.add);
  }
});

filterBar.addEventListener("click", event => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  setFilter(button.dataset.filter);
  filterBar.querySelector(`[data-filter="${CSS.escape(activeFilter)}"]`)?.focus();
});

document.querySelectorAll("[data-nav-filter]").forEach(link => link.addEventListener("click", () => {
  activeType = "All";
  setFilter(link.dataset.navFilter);
  document.getElementById("nav-links").classList.remove("open");
  document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
}));

grid.addEventListener("click", event => {
  const button = event.target.closest("[data-add]");
  if (button) {
    addToCart(button.dataset.add);
    return;
  }
  const card = event.target.closest("[data-product]");
  if (card) openDetail(card.dataset.product);
});

document.getElementById("cart-items").addEventListener("click", event => {
  const stepper = event.target.closest("[data-step]");
  if (stepper) {
    const id = stepper.dataset.id;
    const quantity = (cart.get(id) || 0) + Number(stepper.dataset.step);
    if (quantity > 0) cart.set(id, quantity);
    else cart.delete(id);
    renderCart();
    document.querySelector(`#cart-items [data-id="${CSS.escape(id)}"][data-step="${stepper.dataset.step}"]`)?.focus();
    return;
  }
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  cart.delete(button.dataset.remove);
  renderCart();
});

document.getElementById("cart-open").addEventListener("click", () => setCartOpen(true));
document.getElementById("cart-close").addEventListener("click", () => setCartOpen(false));
overlay.addEventListener("click", () => setCartOpen(false));
document.addEventListener("keydown", event => { if (event.key === "Escape" && cartPanel.classList.contains("open")) setCartOpen(false); });

document.getElementById("menu-toggle").addEventListener("click", event => {
  const menu = document.getElementById("nav-links");
  const open = menu.classList.toggle("open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
  event.currentTarget.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
});

document.getElementById("order-button").addEventListener("click", () => {
  if (!cart.size) {
    showToast("Your bag is empty. Find a saree to get started.");
    return;
  }
  saveCart();
  window.location.href = "order.html";
});

// WhatsApp chat button and updates link share the boutique number used for orders.
function applyConfig(config) {
  STORE_WHATSAPP = String(config.whatsapp || "").replace(/\D/g, "");
  if (!STORE_WHATSAPP) return;
  {
  const chatLink = document.getElementById("whatsapp-fab");
  chatLink.href = `https://wa.me/${STORE_WHATSAPP}?text=${encodeURIComponent("Hello Nandini Unique, I have a question about your sarees.")}`;
  chatLink.hidden = false;
  const updatesLink = document.getElementById("updates-link");
  updatesLink.href = `https://wa.me/${STORE_WHATSAPP}?text=${encodeURIComponent("Hello Nandini Unique, please send me updates on new sarees.")}`;
  updatesLink.hidden = false;
  }
}

fetch("/api/config", { cache: "no-store" }).then(response => response.json()).then(applyConfig).catch(() => {});
loadProducts();
