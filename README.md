# Nandini Unique Boutique

A responsive, no-build storefront in `index.html`. It can be uploaded as-is to standard web hosting or served with GitHub Pages.

## Before launch

This is a storefront prototype. Product names, photos, prices, and other shop copy are sample content; replace them with your business's real information. The bag is client-side only: there is no inventory, payment processing, or order database.

To connect order enquiries to WhatsApp, set `STORE_WHATSAPP` near the start of the script in `index.html` to your business number in international digits, without `+`, spaces, or punctuation. For example, use the format `91XXXXXXXXXX` for an Indian number. The newsletter form is also a visual demo and needs an email service before it can collect subscribers.

## Publish on GoDaddy hosting

A GoDaddy domain by itself does not include web hosting. With a GoDaddy Linux/cPanel hosting plan:

1. Sign in to GoDaddy and open **My Products**.
2. Open **Web Hosting** and choose **Manage** for the hosting plan connected to your domain.
3. Open **cPanel Admin**, then **File Manager**, and open `public_html`.
4. Upload `index.html` into `public_html` (not inside another folder).
5. Visit your domain over HTTPS and confirm the page loads. If the domain is not connected to the plan, follow GoDaddy's domain/hosting connection instructions in that account first.

The site uses externally hosted Unsplash photos and Google Fonts, so those assets require an internet connection.

## Upload to GitHub

Create a repository in your signed-in GitHub account, then, from this project folder, run the following after replacing the URL with your new repository URL:

```sh
git init -b main
git add index.html README.md
git commit -m "Create Nandini saree storefront"
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

If Git asks for your author name or email, configure `git config --global user.name` and `git config --global user.email` with your own details. GitHub may prompt you to authenticate the first time you push.

To publish from GitHub Pages, open the repository's **Settings > Pages**, choose **Deploy from a branch**, and select `main` and `/(root)`. GitHub will show the published URL there. A GoDaddy domain can be connected later through the repository's Pages custom-domain setting and the DNS records GitHub specifies for that domain.
