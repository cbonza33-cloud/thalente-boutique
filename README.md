# Thalente Boutique and Electronics (TBAE)

A South African fashion & electronics storefront: Node.js/Express backend, SQLite
inventory, live Yoco checkout, and an owner admin dashboard.

## Run locally
```
npm install
npm start
```
Visit `http://localhost:5000`. Without `YOCO_SECRET_KEY` set, checkout runs in
**demo mode** — orders complete instantly with no real charge, so you can test
the full flow end to end before going live.

## Routes
- `/` — the storefront (`index.html`): splash screen, live product catalogue,
  cart, wishlist, search/filter/sort, and checkout
- `/admin` — PIN-protected owner dashboard: inventory, orders, receipts, quotes, notifications
- `/order-success` — order confirmation / printable digital receipt
- `/api/products` — live SQLite product catalogue
- `/api/checkout` — creates a pending order and a Yoco (or demo-mode) checkout
- `/api/webhooks/yoco` — marks payments paid, decrements stock, creates receipts/notifications
- `/api/health` — health check (used by `render.yaml`)

## Configuration
Copy `.env.example` and set:
- `ADMIN_PIN` — admin dashboard PIN (fallback `1234` if unset — **change this before going live**)
- `YOCO_SECRET_KEY` — from your Yoco merchant dashboard; leave unset for demo mode
- `ALLOWED_ORIGIN` / `ALLOWED_ORIGINS` — your deployed origin(s) for CORS
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — required for
  product image uploads (see below)

Configure Yoco's webhook URL as `https://<your-app>/api/webhooks/yoco` once live.

### Product images (Cloudinary)
Product photos uploaded through `/admin` are stored permanently on
[Cloudinary](https://cloudinary.com), not on Render's local disk — Render wipes its
filesystem on every redeploy, so anything saved to `public/uploads/` would otherwise
be lost the next time you deploy.

1. Create a free Cloudinary account at https://cloudinary.com/console.
2. From that dashboard, copy your **Cloud name**, **API Key**, and **API Secret**.
3. Set them as `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`
   — in Render's dashboard for production, or your local `.env` for development.
4. Without all three set, uploading a file returns a clear error asking you to
   configure Cloudinary; pasting an external image URL in the "Image URL" field
   still works either way and is never uploaded to Cloudinary.

**Existing products with an old `/uploads/...` image** (from before this fix) are left
exactly as they are — they are not deleted, and the app will keep displaying them if
that file still happens to exist on disk. They'll keep working normally once you
re-upload or re-save their photo through the admin dashboard, which then stores a
permanent Cloudinary URL going forward. No database migration is needed for this.

## Deploying to Render
1. Push this repo to GitHub.
2. In Render, "New +" → "Blueprint", point it at the repo — `render.yaml` configures
   everything (build/start commands, health check, persistent disk for the database).
3. Set `ADMIN_PIN`, `YOCO_SECRET_KEY`, `ALLOWED_ORIGIN`, and the three `CLOUDINARY_*`
   variables as prompted (they're marked `sync: false` so Render asks for them rather
   than committing secrets).
4. Deploy. `Procfile` is included as a fallback if you deploy without Blueprints.

**Note:** Render allows one persistent disk per service, mounted on `data/`
(the SQLite DB). Product photos no longer need that disk — they live on Cloudinary.
`public/uploads/` is still used for quote-request portfolio attachments only, which
remain ephemeral (unrelated to product images; out of scope for this fix).

## Fixes applied (Sep 2026)
1. **Splash screen freeze** — `server.js` was running Helmet's *default* Content-Security-Policy,
   which sends `script-src 'self'` and `script-src-attr 'none'`. That silently blocked every
   inline `<script>` and inline `onclick`/`onerror` handler across `index.html`, `admin.html`,
   and `order-success.html` — with no visible error, just a page that never finished initializing.
   Fixed by giving Helmet explicit CSP directives that allow this app's actual inline scripts,
   while keeping everything else locked down.
2. **PWA icons** — added `public/manifest.json` and a full icon set in `public/icons/` (192/512,
   including maskable variants, plus an iOS `apple-touch-icon` and desktop favicons), generated
   from the exact brand colors already used in `admin.html`'s TBAE wordmark. Linked from all
   three HTML pages' `<head>`.
3. **Removed all demo/mock data** — deleted the hardcoded seed list of 22 products (which mixed
   nonexistent `attached_assets/*` paths with Unsplash placeholder photos) and the startup code
   that auto-inserted them. Added a one-time cleanup migration that removes any leftover rows
   matching those old patterns from a database that already has them, so the storefront never
   shows demo items even on an existing deployment. The catalog now starts genuinely empty and
   is populated exclusively through the admin dashboard — the storefront shows a clear "No
   products are available yet" message until then, never a placeholder.
4. **Permanent product image storage (Cloudinary)** — two separate bugs were found and fixed:
   - `admin.html`'s product form built a `FormData`, immediately flattened it with
     `Object.fromEntries()`, then sent it as `JSON.stringify(...)` with a manually-set
     `Content-Type: application/json`. A `File` object has no enumerable properties, so
     `JSON.stringify` turned it into `{}` — meaning the file picker never actually delivered
     image bytes to the server, regardless of storage backend. Fixed by sending a real
     `multipart/form-data` request (raw `FormData`, no manual `Content-Type`) whenever a file
     is selected, while leaving the existing JSON path untouched for edits with no new file.
   - Uploaded files were saved to `public/uploads/`, which isn't on Render's persistent disk —
     they were silently deleted on every redeploy while the (persisted) database kept pointing
     at the now-missing file. Fixed by uploading directly to Cloudinary and storing the returned
     permanent HTTPS URL in `products.image_url` instead — `public/uploads/` is no longer used
     for product photos at all. Also added real magic-byte sniffing (not just the client-supplied
     MIME type) before any upload is accepted or sent to Cloudinary.

## Project structure
- `server.js` — Express server, SQLite schema, product/admin/order APIs, Yoco integration,
  Cloudinary image uploads, CSP config
- `index.html` — the live storefront: splash screen, dynamic catalogue (pulled exclusively from
  `/api/products`), cart/wishlist, checkout, manifest/icon links
- `admin.html` — owner dashboard, fully wired to the API; favicon/apple-touch-icon links added
- `order-success.html` — order confirmation/receipt; favicon/apple-touch-icon links added
- `public/manifest.json` / `public/icons/` — PWA manifest and generated icon set
- `public/uploads/` — quote-request portfolio attachments only (ephemeral; gitignored). Product
  photos are no longer stored here — see Cloudinary section above
- `data/thalente.sqlite` — runtime database (created automatically, gitignored; starts with zero
  products until added via `/admin`)
- `deepseek_html_20260731_90dbdd (1).html` — superseded draft, kept only for reference; no longer served
