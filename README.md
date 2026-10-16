# Nandini Unique Boutique

Online store for sarees and dresses: public shop, online payment through Razorpay, and a private owner area for products, photos and orders.

One small Node.js server does everything. It serves the shop pages, stores products and orders in its own database (SQLite) and keeps product photos on its own disk. Nothing is stored in GitHub any more, so customer details never sit in a public repository.

```
Customer browser ──► Render web service (this repo) ──► /var/data/store.db   (products, orders, owner login)
                              │                    └──► /var/data/uploads/   (product photos)
                              └──► Razorpay (payments; card and UPI details never reach this server)
```

## Owner area

Open **Owner login** in the shop's top menu (or go to `/admin.html`) and sign in.

- **Orders**: every order with customer details, items, payment status and a WhatsApp / phone link. Set the status (confirmed, shipped, delivered, cancelled) and add a tracking note. New orders show a badge and a pop-up while the page is open.
- **Products**: add and edit sarees and dresses with a description, price, up to 6 photos (first is the cover) and an *Available to order* switch. Mark a piece **Sold out** the moment it is gone.
- **Account**: change your password.

Photos are resized in your browser before upload, so phone photos are fine.

## Going live on Render

Cost (from Render's pricing page, October 2026): the smallest paid instance is **$7/month** and a persistent disk is **$0.25 per GB per month** (1 GB is plenty for thousands of photos). A disk requires a paid instance. Deploys cause a few seconds of downtime because the disk can only be attached to one instance. Render snapshots the disk every 24 hours and keeps snapshots for at least 7 days.

1. **Put the code on Render.** Sign in at render.com, choose **New + → Blueprint**, connect the `saree-storefront` GitHub repository and pick the branch `server-version` (later `main`). Render reads `render.yaml`, creates the web service and the 1 GB disk, and asks for the secret settings below.
   If Render rejects the file, choose **New + → Web Service** instead: Runtime *Node*, Build Command `npm install`, Start Command `npm start`, Health Check Path `/healthz`, add a **Disk** mounted at `/var/data`, and add the settings below by hand.
2. **Enter the settings** (Environment tab):
   | Setting | Value |
   |---|---|
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Your owner login. Password at least 10 characters. After your first sign-in, **delete `ADMIN_PASSWORD`**. |
   | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | From the Razorpay dashboard (next section). Start with **test** keys. |
   | `RAZORPAY_WEBHOOK_SECRET` | Any long random text you choose; type the same text into Razorpay's webhook screen. |
   | `DATA_DIR` | `/var/data` (already set by `render.yaml`; this is the disk) |
   Everything else (`SHIPPING_FEE`, `FREE_SHIPPING_ABOVE`, `WHATSAPP_NUMBER`, `COD_ENABLED`, ...) is listed in `.env.example`.
3. **Open the `.onrender.com` address** Render gives you, sign in under Owner login, and add your first real product.
4. **Test a payment** with Razorpay test keys (test card/UPI details are on Razorpay's documentation). Check that the order appears under Orders as *Paid online*.
5. **Go live with real payments** (below), then **point your domain** at Render (below).

> Without the disk, Render erases the database and photos on every deploy. Make sure the service shows a disk mounted at `/var/data`.

### Razorpay

1. Create an account at razorpay.com. Test mode works immediately; **live payments need Razorpay's business verification (KYC)**, which can take a few days.
2. In the dashboard open the API keys page (under *Account & Settings*; menu names can differ slightly), generate keys, and put them into `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`. Keys starting `rzp_test_` are test mode; `rzp_live_` are real.
3. Add a webhook (*Account & Settings → Webhooks*): URL `https://YOUR-DOMAIN/api/webhooks/razorpay`, the same secret as `RAZORPAY_WEBHOOK_SECRET`, events **payment.captured**, **order.paid** and **payment.failed**. The webhook marks an order paid even if the customer closes the page right after paying.
4. When you switch from test to live keys, replace both key settings and re-create the webhook in live mode.

Refunds are done in the Razorpay dashboard. Afterwards set the order's Payment to *Refunded* in the owner area. Prices are always taken from the database on the server, never from the customer's browser.

### Using your own domain

The old shop on GitHub Pages keeps running until you change DNS, so do this last, after testing on the `.onrender.com` address.

1. In Render: your service → **Settings → Custom Domains → Add** `store.nandhiniunique.com`. Render shows what DNS record to create.
2. In GoDaddy DNS: change the existing `store` CNAME record (it points to GitHub Pages) to the value Render shows. Your root domain and `www` records stay as they are.
3. Wait for Render to show the domain as verified (HTTPS is issued automatically), then update the Razorpay webhook URL if you used the `.onrender.com` address.
4. Optional: in the GitHub repository, *Settings → Pages*, turn Pages off. The Pages workflow and `CNAME` file have been removed from this version.

## Backups and updates

- Render's daily disk snapshots cover the database **and** the photos.
- `npm run backup` (in Render's *Shell* tab, if available on your plan) writes a consistent copy of the database to `/var/data/backups`, keeping the newest 14.
- Updating the site: push to the branch Render deploys; Render rebuilds and restarts in about a minute. Data on the disk is untouched. Database upgrades run automatically at startup.
- Forgot the owner password? Set `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `RESET_ADMIN_PASSWORD=true`, redeploy, sign in, then delete all three settings.

## What is stored, and who can see it

- **Orders**: customer name, phone, email, delivery address and items, in `store.db` on your private disk. Only the signed-in owner can read them. Don't copy them into public places.
- **Photos** you upload are public (they are shown in the shop).
- **Payments**: card, UPI and bank details are entered in Razorpay's window and never reach this server. The server keeps only Razorpay's order and payment reference numbers.
- **Owner password**: stored only as a salted scrypt hash. Sign-in sessions use a random token in an HttpOnly, Secure, SameSite=Strict cookie and expire after 12 hours. Repeated wrong passwords are blocked for 15 minutes. The site sends a strict Content-Security-Policy.

## Known limits

- Each product is a single "available / sold out" switch, not a stock count. If two customers pay for the same one-off piece, the second order shows in the owner area as paid and needs a refund or a substitute. Mark pieces sold out as soon as they go.
- The owner is not emailed about new orders. The Orders tab shows a badge and pops up while the page is open.
- One server instance only (a limit of attaching a disk). That is plenty for a boutique.

## Development

Requires Node 22.13 or newer (it uses Node's built-in SQLite; no npm packages are needed).

```
cp .env.example .env          # set ADMIN_EMAIL and ADMIN_PASSWORD for a first login
npm start                     # http://localhost:3000   (sample products load automatically outside production)
npm test                      # API tests, using a mock Razorpay server
npm run create-admin -- you@example.com   # create or reset the owner login from a terminal
```

`seed/products.json` holds placeholder products for local development only; they never load on a production server unless you set `SEED_SAMPLE_PRODUCTS=true`.
