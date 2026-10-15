# Nandini Unique Boutique

Live storefront: https://store.nandhiniunique.com

## Orders

`order.html` carries the cart into a delivery form and opens a WhatsApp enquiry to the number already published on the existing Nandini Unique site. The form does not save customer details or take payment; the boutique confirms availability and delivery in WhatsApp.

## Catalog Admin

Open https://store.nandhiniunique.com/admin.html. Create a GitHub fine-grained personal access token limited to `nandiniuniqueboutique-rgb/saree-storefront` with **Contents: Read and write**, then connect from the admin page. The token is kept in that browser tab's session storage and is never committed to the repository.

The admin can add, edit, and remove products (sarees or dresses), write a description for each, upload up to 6 photos per product (the first is the cover), and update `products.json`. Customers open a product from the shop to see its photos and description. The admin page also explains how to create the token. Each change commits to `main`; GitHub Actions publishes the storefront and uploaded images. The repository is public, so catalog entries and uploaded product photos are public too. Never store customer details or payment information in it.

The catalog starts with the product names and prices shown on the current public shop. Confirm availability and prices before selling. Starter catalog photos are representative; upload accurate product photos from the admin page. The "A lovely note now and then" section opens a WhatsApp message to the boutique number asking for new-arrival updates, so no email service is needed. The floating "Chat with us" button uses the same number.

## Search and sharing

`index.html` carries the page title, description, canonical link, social-share preview tags and basic Store structured data. `robots.txt` and `sitemap.xml` are published alongside it; the order and admin pages are kept out of search results.

## Hosting

GitHub Pages hosts the storefront. GoDaddy DNS maps `store.nandhiniunique.com` to that site; HTTPS is enforced. The existing root domain and `www` records remain pointed at the original Netlify site. No GoDaddy web-hosting plan is used.

The Pages workflow is `.github/workflows/pages.yml`; it publishes `index.html`, `products.json`, `order.html`, `admin.html`, `robots.txt`, `sitemap.xml`, and any files under `images/` on pushes to `main`. Photos and fonts use external providers and require an internet connection.
