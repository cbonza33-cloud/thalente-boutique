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

Configure Yoco's webhook URL as `https://<your-app>/api/webhooks/yoco` once live.

## Deploying to Render
1. Push this repo to GitHub.
2. In Render, "New +" → "Blueprint", point it at the repo — `render.yaml` configures
   everything (build/start commands, health check, persistent disk for the database).
3. Set `ADMIN_PIN`, `YOCO_SECRET_KEY`, and `ALLOWED_ORIGIN` as prompted (they're
   marked `sync: false` so Render asks for them rather than committing secrets).
4. Deploy. `Procfile` is included as a fallback if you deploy without Blueprints.

**Note:** Render allows one persistent disk per service, mounted on `data/`
(the SQLite DB). Files uploaded through the admin panel to `public/uploads/`
are not on that disk and won't survive a redeploy — use hosted image URLs for
anything long-lived, or add external object storage later.

## Fixes applied (Sep 2026)
1. **Splash screen freeze** — `server.js` was running Helmet's *default* Content-Security-Policy,
   which sends `script-src 'self'` and `script-src-attr 'none'`. That silently blocked every
   inline `<script>` and inline `onclick`/`onerror` handler across `index.html`, `admin.html`,
   and `order-success.html` — with no visible error, just a page that never finished initializing.
   Fixed by giving Helmet explicit CSP directives that allow this app's actual inline scripts and
   the Unsplash host its seed images load from, while keeping everything else locked down.
2. **PWA icons** — added `public/manifest.json` and a full icon set in `public/icons/` (192/512,
   including maskable variants, plus an iOS `apple-touch-icon` and desktop favicons), generated
   from the exact brand colors already used in `admin.html`'s TBAE wordmark. Linked from all
   three HTML pages' `<head>`.

## Project structure
- `server.js` — Express server, SQLite schema/seed, product/admin/order APIs, Yoco integration, CSP config
- `index.html` — the live storefront: splash screen, dynamic catalogue, cart/wishlist, checkout, manifest/icon links
- `admin.html` — owner dashboard, fully wired to the API; favicon/apple-touch-icon links added
- `order-success.html` — order confirmation/receipt; favicon/apple-touch-icon links added
- `public/manifest.json` / `public/icons/` — PWA manifest and generated icon set
- `data/thalente.sqlite` — runtime database (created & seeded automatically, gitignored)
- `deepseek_html_20260731_90dbdd (1).html` — superseded draft, kept only for reference; no longer served
