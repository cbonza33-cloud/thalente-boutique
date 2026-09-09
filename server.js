const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 5000);
const ROOT = __dirname;

// Fallback to '1234' for local development if process.env.ADMIN_PIN is unset
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
if (!process.env.ADMIN_PIN) {
  console.warn("ADMIN_PIN environment variable not set. Using fallback PIN: '1234'");
}

// Cloudinary is the permanent store for product photos (Render's own filesystem
// is wiped on every redeploy, so local disk can never hold uploaded images
// reliably). Credentials come from environment variables ONLY — never hardcode
// them here or commit them anywhere.
const CLOUDINARY_CONFIGURED = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_CONFIGURED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  console.warn(
    "CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not all set. " +
    "Product image uploads will be rejected with a clear error until they are configured " +
    "(pasting an external image URL still works without Cloudinary)."
  );
}

/**
 * Uploads a file buffer to Cloudinary and resolves with its secure HTTPS URL.
 * Rejects on failure — callers must not create/update a product on rejection.
 */
function uploadImageBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "thalente-products", resource_type: "image" },
      (error, result) => {
        if (error || !result || !result.secure_url) {
          return reject(error || new Error("Cloudinary did not return an image URL."));
        }
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// Cloudinary URLs look like: https://res.cloudinary.com/<cloud>/image/upload/.../thalente-products/<id>.<ext>
// This lets us best-effort delete a replaced image's old Cloudinary asset without
// needing a separate database column to track its public_id.
function extractCloudinaryPublicId(url) {
  const match = /\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/.exec(String(url || ""));
  return match ? match[1] : null;
}

function isLegacyLocalImagePath(url) {
  return typeof url === "string" && url.startsWith("/uploads/");
}

const allowedOrigins = new Set([
  "http://localhost:5000",
  process.env.ALLOWED_ORIGIN,
].filter(Boolean));

if (process.env.ALLOWED_ORIGINS) {
  for (const origin of process.env.ALLOWED_ORIGINS.split(",")) {
    const trimmed = origin.trim();
    if (trimmed) allowedOrigins.add(trimmed);
  }
}

app.use(helmet({
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  // Helmet's default CSP ships `script-src 'self'` and `script-src-attr 'none'`,
  // which silently blocks every inline <script> and inline onclick/onerror
  // attribute used across index.html, admin.html, and order-success.html —
  // with no visible error, just a page that never finishes initializing
  // (e.g. a splash screen whose own dismiss timer never gets to run).
  // These directives explicitly allow this app's actual script usage while
  // keeping everything else locked down.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      // 'self' covers admin-uploaded product photos (served from /uploads); https:
      // covers the admin's "paste an image URL" field for any external host they
      // choose — no specific demo/placeholder host is special-cased here.
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
}));

const UPLOAD_DIR = path.join(ROOT, "public", "uploads");
const QUOTE_UPLOAD_DIR = path.join(UPLOAD_DIR, "quotes");
fs.mkdirSync(QUOTE_UPLOAD_DIR, { recursive: true });

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PORTFOLIO_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const PORTFOLIO_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf", ".doc", ".docx", ".zip"]);

function safeExt(file, allowed) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  return allowed.has(ext) ? ext : "";
}

function diskStorage(destination) {
  return multer.diskStorage({
    destination,
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
    },
  });
}

function typeFilter(allowedMimes, allowedExts) {
  return (_req, file, cb) => {
    const ext = safeExt(file, allowedExts);
    if (allowedMimes.has(file.mimetype) && ext) return cb(null, true);
    cb(new Error("Unsupported file type."));
  };
}

const imageUpload = multer({
  // Product photos are buffered in memory, then streamed straight to Cloudinary —
  // never written to local disk, since Render's filesystem doesn't survive a redeploy.
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: typeFilter(IMAGE_TYPES, IMAGE_EXTS),
});

// Multer's fileFilter only sees the client-supplied MIME type/extension, which a
// client can misrepresent. Once the buffer is fully in memory, this checks the
// actual file signature ("magic bytes") so a mislabeled or malicious file can't
// pass as an image just because it claimed to be one.
function sniffImageMimeType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

const portfolioUpload = multer({
  storage: diskStorage(QUOTE_UPLOAD_DIR),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: typeFilter(PORTFOLIO_TYPES, PORTFOLIO_EXTS),
});

const adminSessions = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000;

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions) {
    if (session.expires <= now) adminSessions.delete(token);
  }
}

function createAdminSession() {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { expires: Date.now() + SESSION_MS });
  return token;
}

function readCookie(req, name) {
  const header = String(req.get("cookie") || "");
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function setAdminCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `tbae_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
}

function clearAdminCookie(res) {
  res.setHeader("Set-Cookie", "tbae_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

function getAdminToken(req) {
  const header = String(req.get("authorization") || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return readCookie(req, "tbae_admin");
}

function requireAdmin(req, res, next) {
  pruneSessions();
  const token = getAdminToken(req);
  const session = token && adminSessions.get(token);
  if (!session || session.expires <= Date.now()) {
    return res.status(401).json({ error: "Admin authentication required." });
  }
  session.expires = Date.now() + SESSION_MS;
  req.adminToken = token;
  next();
}

function multerSingle(uploader, field) {
  return (req, res, next) => {
    uploader.single(field)(req, res, error => {
      if (!error) return next();
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: error.message || "Upload failed." });
    });
  };
}

app.use(express.json({ limit: "10kb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many PIN attempts. Please try again later." },
});

const quoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many quote requests. Please try again later." },
});

app.use("/api", apiLimiter);

app.get(["/admin", "/admin.html"], (req, res) => {
  const publicAdmin = path.join(ROOT, "public", "admin.html");
  const rootAdmin = path.join(ROOT, "admin.html");

  if (fs.existsSync(publicAdmin)) {
    return res.sendFile(publicAdmin);
  }
  if (fs.existsSync(rootAdmin)) {
    return res.sendFile(rootAdmin);
  }
  return res.status(404).send("admin.html file not found");
});

app.use(express.static(path.join(ROOT, "public")));

const DB_DIR = path.join(ROOT, "data");
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, "thalente.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    price REAL NOT NULL CHECK(price >= 0),
    category TEXT NOT NULL CHECK(category IN ('Women', 'Men', 'Bags', 'Shoes', 'Electronics')),
    stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    description TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    original_price REAL,
    sizes_json TEXT NOT NULL DEFAULT '[]',
    rating REAL NOT NULL DEFAULT 4.5,
    reviews INTEGER NOT NULL DEFAULT 0,
    is_new INTEGER NOT NULL DEFAULT 0,
    is_featured INTEGER NOT NULL DEFAULT 0,
    lead_time TEXT NOT NULL DEFAULT '3-5 business days',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    product_title TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT 'boutique' CHECK(department IN ('boutique', 'electronics')),
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    portfolio_filename TEXT,
    portfolio_original TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    total_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid')),
    items TEXT NOT NULL,
    yoco_checkout_id TEXT,
    payment_method TEXT NOT NULL DEFAULT 'yoco',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL UNIQUE,
    receipt_number TEXT NOT NULL UNIQUE,
    total REAL NOT NULL,
    items_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('order', 'low_stock')),
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

for (const alter of [
  "ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'yoco'",
  "ALTER TABLE products ADD COLUMN lead_time TEXT NOT NULL DEFAULT '3-5 business days'",
]) {
  try {
    db.prepare(alter).run();
  } catch (error) {
    if (!String(error.message).includes("duplicate column name")) throw error;
  }
}

// One-time cleanup: earlier versions of this app auto-seeded demo/mock products
// (hardcoded "attached_assets/*" images and Unsplash placeholder photos) on first
// boot. No real admin-uploaded product can ever have an image_url matching these
// exact patterns (uploads are always saved under /uploads/, per imageUpload
// below), so it's safe to permanently remove any leftover rows from that old
// seed — this runs once per boot and is a no-op once they're gone.
db.prepare(
  "DELETE FROM products WHERE image_url LIKE 'attached_assets/%' OR image_url LIKE 'https://images.unsplash.com%'"
).run();

function serializeProduct(row) {
  return {
    id: row.id,
    name: row.title,
    title: row.title,
    brand: "Thalente Boutique and Electronics",
    category: row.category.toLowerCase(),
    price: row.price,
    originalPrice: row.original_price,
    lead_time: row.lead_time || "3-5 business days",
    leadTime: row.lead_time || "3-5 business days",
    emoji: row.category === "Shoes" ? "👟" : row.category === "Men" ? "👔" : "👗",
    image: row.image_url,
    image_url: row.image_url,
    rating: row.rating,
    reviews: row.reviews,
    description: row.description,
    sizes: JSON.parse(row.sizes_json || "[]"),
    isNew: Boolean(row.is_new),
    isFeatured: Boolean(row.is_featured),
    stock: row.stock,
    images: row.image_url ? [row.image_url] : [],
    badge: row.original_price && row.original_price > row.price ? "Sale" : null,
    // True for products still pointing at a pre-Cloudinary local /uploads/ path.
    // These may 404 after a Render redeploy wipes the filesystem; the image will
    // start working permanently again once the product's photo is re-uploaded.
    legacyLocalImage: isLegacyLocalImagePath(row.image_url),
  };
}

function allProducts(category) {
  const rows = category && category !== "all"
    ? db.prepare("SELECT * FROM products WHERE lower(category) = lower(?) ORDER BY id").all(category)
    : db.prepare("SELECT * FROM products ORDER BY id").all();
  return rows.map(serializeProduct);
}

app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1d" }));

app.get("/api/health", (req, res) => res.json({ ok: true, database: "sqlite" }));
app.post("/api/admin/verify-pin", pinLimiter, (req, res) => {
  const submittedPin = String(req.body?.pin ?? "");
  if (submittedPin !== ADMIN_PIN) return res.json({ success: false, message: "Invalid PIN" });
  const token = createAdminSession();
  setAdminCookie(res, token);
  res.json({ success: true, token });
});
app.post("/api/admin/logout", (req, res) => {
  const token = getAdminToken(req);
  if (token) adminSessions.delete(token);
  clearAdminCookie(res);
  res.json({ success: true });
});
app.get("/api/admin/session", requireAdmin, (req, res) => res.json({ ok: true }));

app.get("/api/products", (req, res) => res.json(allProducts(req.query.category)));

app.post("/api/products", requireAdmin, multerSingle(imageUpload, "image"), async (req, res) => {
  try {
    const uploadedUrl = await resolveUploadedImageUrl(req.file);
    const product = validateProduct(req.body, { uploadedUrl });
    if (!product.ok) return res.status(400).json({ error: product.error });
    const result = db.prepare(`
      INSERT INTO products (title, price, category, stock, description, image_url, original_price, sizes_json, is_new, is_featured, lead_time)
      VALUES (@title, @price, @category, @stock, @description, @image_url, @original_price, @sizes_json, @is_new, @is_featured, @lead_time)
    `).run(product.value);
    res.status(201).json(serializeProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid)));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || "Image upload failed." });
  }
});

app.put("/api/products/:id", requireAdmin, multerSingle(imageUpload, "image"), async (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "Product not found" });
  try {
    const uploadedUrl = await resolveUploadedImageUrl(req.file);
    const product = validateProduct(req.body, { uploadedUrl, existingUrl: existing.image_url });
    if (!product.ok) return res.status(400).json({ error: product.error });
    db.prepare(`
      UPDATE products SET title=@title, price=@price, category=@category, stock=@stock,
        description=@description, image_url=@image_url, original_price=@original_price,
        sizes_json=@sizes_json, is_new=@is_new, is_featured=@is_featured, lead_time=@lead_time WHERE id=@id
    `).run({ ...product.value, id: Number(req.params.id) });
    // Best-effort cleanup of the replaced image. This never blocks or fails the
    // update itself — if it doesn't work, the product update has already succeeded.
    if (uploadedUrl && uploadedUrl !== existing.image_url) {
      const oldPublicId = CLOUDINARY_CONFIGURED ? extractCloudinaryPublicId(existing.image_url) : null;
      if (oldPublicId) {
        cloudinary.uploader.destroy(oldPublicId).catch(error => {
          console.warn(`Could not delete replaced Cloudinary asset ${oldPublicId}:`, error.message);
        });
      }
    }
    res.json(serializeProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id)));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || "Image upload failed." });
  }
});

/**
 * Resolves the uploaded multer file (if any) to a permanent Cloudinary HTTPS URL.
 * Returns "" when no file was uploaded (caller then falls back to a manually
 * typed image_url or the existing image on an edit). Throws — never returns a
 * broken/placeholder URL — if a file was uploaded but can't be safely stored.
 */
async function resolveUploadedImageUrl(file) {
  if (!file) return "";
  const realType = sniffImageMimeType(file.buffer);
  if (!realType) {
    const error = new Error("The uploaded file is not a valid JPEG, PNG, or WebP image.");
    error.status = 400;
    throw error;
  }
  if (!CLOUDINARY_CONFIGURED) {
    const error = new Error(
      "Image uploads are not available right now: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, " +
      "and CLOUDINARY_API_SECRET must be set. Paste an external image URL instead, or configure Cloudinary."
    );
    error.status = 503;
    throw error;
  }
  try {
    return await uploadImageBufferToCloudinary(file.buffer);
  } catch (error) {
    const wrapped = new Error("Cloudinary upload failed: " + (error.message || "unknown error"));
    wrapped.status = 502;
    throw wrapped;
  }
}

app.delete("/api/products/:id", requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM products WHERE id = ?").run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "Product not found" });
  res.status(204).end();
});

function validateProduct(input = {}, { uploadedUrl = "", existingUrl = "" } = {}) {
  const title = String(input.title || input.name || "").trim();
  const category = ["Women", "Men", "Bags", "Shoes", "Electronics"].find(value => value.toLowerCase() === String(input.category || "").toLowerCase());
  const price = Number(input.price);
  const stock = Number(input.stock);
  if (!title || !category || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
    return { ok: false, error: "Title, valid category, non-negative price, and whole-number stock are required." };
  }
  const defaultLead = category === "Electronics" ? "5-7 business days" : "3-5 business days";
  const leadTime = String(input.lead_time || input.leadTime || "").trim() || defaultLead;
  // Only a genuine string typed into the "Image URL" field is accepted here —
  // never anything else — so a malformed request can never corrupt image_url
  // into a stringified object (e.g. the literal text "[object Object]").
  const typedUrl = typeof input.image_url === "string" ? input.image_url.trim() : "";
  return {
    ok: true,
    value: {
      title, category, price, stock,
      description: String(input.description || "").trim(),
      image_url: uploadedUrl || typedUrl || existingUrl,
      original_price: input.original_price == null || input.original_price === "" ? null : Number(input.original_price),
      sizes_json: JSON.stringify(Array.isArray(input.sizes) ? input.sizes : String(input.sizes || "").split(",").map(s => s.trim()).filter(Boolean)),
      is_new: input.is_new === "1" || input.is_new === "true" || input.is_new === true || input.is_new === 1 ? 1 : 0,
      is_featured: input.is_featured === "1" || input.is_featured === "true" || input.is_featured === true || input.is_featured === 1 ? 1 : 0,
      lead_time: leadTime,
    },
  };
}

app.get("/api/orders", requireAdmin, (req, res) => {
  const orders = db.prepare("SELECT * FROM orders ORDER BY id DESC").all().map(order => ({
    ...order,
    items: JSON.parse(order.items),
    display_status: order.payment_method === "demo" ? "paid (Demo)" : order.status,
  }));
  res.json(orders);
});

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json({
    ...order,
    items: JSON.parse(order.items),
    display_status: order.payment_method === "demo" ? "paid (Demo)" : order.status,
  });
});

app.get("/api/orders/:id/receipt", requireAdmin, (req, res) => {
  const receipt = db.prepare(`
    SELECT receipts.*, orders.customer_name, orders.customer_email, orders.customer_phone, orders.address, orders.created_at AS order_created_at
    FROM receipts JOIN orders ON orders.id = receipts.order_id WHERE receipts.order_id = ?
  `).get(Number(req.params.id));
  if (!receipt) return res.status(404).json({ error: "Receipt not available until payment succeeds." });
  res.json({ ...receipt, items: JSON.parse(receipt.items_json) });
});

app.get("/api/notifications", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 50").all();
  res.json(rows.map(row => ({ ...row, read: Boolean(row.read) })));
});

app.patch("/api/notifications/:id/read", requireAdmin, (req, res) => {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(Number(req.params.id));
  res.status(204).end();
});

function markOrderPaid(orderId, mode = "yoco") {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) throw new Error("Order not found.");
  if (order.status === "paid") return order;
  const items = JSON.parse(order.items);
  const completePayment = db.transaction(() => {
    for (const item of items) {
      const result = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?")
        .run(item.quantity, item.productId, item.quantity);
      if (!result.changes) throw new Error(`Insufficient stock for product ${item.productId}`);
    }
    db.prepare("UPDATE orders SET status = 'paid', payment_method = ? WHERE id = ?").run(mode, orderId);
    const receiptNumber = `TB-${new Date().getFullYear()}-${String(orderId).padStart(6, "0")}`;
    db.prepare("INSERT OR IGNORE INTO receipts (order_id, receipt_number, total, items_json) VALUES (?, ?, ?, ?)")
      .run(orderId, receiptNumber, order.total_amount, order.items);
    const message = mode === "demo"
      ? `New Demo Order #${orderId} received for R${Number(order.total_amount).toFixed(2)}`
      : `New paid order #${orderId} for R${Number(order.total_amount).toFixed(2)}`;
    db.prepare("INSERT INTO notifications (message, type) VALUES (?, 'order')").run(message);
    for (const item of items) {
      const product = db.prepare("SELECT title, stock FROM products WHERE id = ?").get(item.productId);
      if (product && product.stock < 3) {
        db.prepare("INSERT INTO notifications (message, type) VALUES (?, 'low_stock')")
          .run(`${product.title} is low in stock (${product.stock} remaining).`);
      }
    }
  });
  completePayment();
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
}

app.post("/api/checkout", async (req, res) => {
  const { customer, items } = req.body || {};
  if (!customer || !customer.name || !customer.email || !customer.phone || !customer.address || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Customer details and at least one cart item are required." });
  }
  const requested = items.map(item => ({
    productId: Number(item.productId),
    size: String(item.size || ""),
    quantity: Number(item.quantity),
  }));
  if (requested.some(item => !Number.isInteger(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1)) {
    return res.status(400).json({ error: "Cart items are invalid." });
  }
  const products = requested.map(item => db.prepare("SELECT * FROM products WHERE id = ?").get(item.productId));
  if (products.some(product => !product)) return res.status(400).json({ error: "One or more products are no longer available." });
  const stockIssue = requested.find((item, index) => item.quantity > products[index].stock);
  if (stockIssue) return res.status(409).json({ error: `${products[requested.indexOf(stockIssue)].title} does not have enough stock.` });
  const total = requested.reduce((sum, item, index) => sum + products[index].price * item.quantity, 0);
  const orderItems = requested.map((item, index) => ({
    productId: item.productId, name: products[index].title, size: item.size, quantity: item.quantity, price: products[index].price,
  }));
  const result = db.prepare(`
    INSERT INTO orders (customer_name, customer_email, customer_phone, address, total_amount, status, items)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(customer.name.trim(), customer.email.trim(), customer.phone.trim(), customer.address.trim(), total, JSON.stringify(orderItems));
  const orderId = Number(result.lastInsertRowid);
  if (!process.env.YOCO_SECRET_KEY) {
    try {
      markOrderPaid(orderId, "demo");
      return res.json({ orderId, demoMode: true, paymentUrl: `/order-success?orderId=${orderId}` });
    } catch (error) {
      return res.status(409).json({ error: error.message, orderId });
    }
  }
  try {
    const response = await fetch("https://payments.yoco.com/api/checkouts", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amountInCents: Math.round(total * 100),
        currency: "ZAR",
        cancelUrl: `${publicBaseUrl(req)}/?payment=cancelled`,
        successUrl: `${publicBaseUrl(req)}/?payment=success`,
        failureUrl: `${publicBaseUrl(req)}/?payment=failed`,
        metadata: { orderId: String(orderId) },
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.redirectUrl) {
      return res.status(502).json({ error: data.message || "Yoco could not create a checkout.", orderId });
    }
    db.prepare("UPDATE orders SET yoco_checkout_id = ? WHERE id = ?").run(data.id || null, orderId);
    res.json({ orderId, paymentUrl: data.redirectUrl });
  } catch (error) {
    res.status(502).json({ error: "Unable to reach Yoco right now.", orderId });
  }
});

function publicBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

app.post("/api/webhooks/yoco", (req, res) => {
  const event = req.body || {};
  const type = event.type || event.eventType;
  if (type !== "payment.succeeded") return res.json({ received: true });
  const payload = event.payload || event.data || event;
  const metadata = payload.metadata || payload.checkout?.metadata || {};
  const orderId = Number(metadata.orderId || metadata.order_id);
  if (!orderId) return res.status(400).json({ error: "Webhook is missing order metadata." });
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "paid") return res.json({ received: true, alreadyProcessed: true });
  try {
    markOrderPaid(orderId, "yoco");
    res.json({ received: true });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.post("/api/quotes", quoteLimiter, multerSingle(portfolioUpload, "portfolio"), (req, res) => {
  const name = String(req.body.customer_name || req.body.name || "").trim();
  const email = String(req.body.customer_email || req.body.email || "").trim();
  const phone = String(req.body.customer_phone || req.body.phone || "").trim();
  const notes = String(req.body.notes || "").trim();
  const productId = Number(req.body.product_id);
  if (!name || !email || !notes) {
    return res.status(400).json({ error: "Name, email, and project notes are required." });
  }
  const product = Number.isInteger(productId)
    ? db.prepare("SELECT id, title, category FROM products WHERE id = ?").get(productId)
    : null;
  const department = String(req.body.department || "").toLowerCase() === "electronics" || product?.category === "Electronics"
    ? "electronics"
    : "boutique";
  const result = db.prepare(`
    INSERT INTO quotes (product_id, product_title, department, customer_name, customer_email, customer_phone, notes, portfolio_filename, portfolio_original)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    product ? product.id : null,
    product ? product.title : String(req.body.product_title || "").trim(),
    department,
    name,
    email,
    phone,
    notes,
    req.file ? req.file.filename : null,
    req.file ? req.file.originalname : null,
  );
  db.prepare("INSERT INTO notifications (message, type) VALUES (?, 'order')")
    .run(`New ${department} quote #${result.lastInsertRowid} from ${name}`);
  res.status(201).json({ success: true, id: Number(result.lastInsertRowid) });
});

app.get("/api/quotes", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM quotes ORDER BY id DESC").all();
  res.json(rows.map(row => ({
    ...row,
    has_portfolio: Boolean(row.portfolio_filename),
  })));
});

app.get("/api/quotes/:id/portfolio", requireAdmin, (req, res) => {
  const quote = db.prepare("SELECT * FROM quotes WHERE id = ?").get(Number(req.params.id));
  if (!quote || !quote.portfolio_filename) return res.status(404).json({ error: "Portfolio file not found." });
  const filePath = path.join(QUOTE_UPLOAD_DIR, quote.portfolio_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Portfolio file not found." });
  res.download(filePath, quote.portfolio_original || quote.portfolio_filename);
});

app.get("/order-success", (req, res) => res.sendFile(path.join(ROOT, "order-success.html")));

app.get("/", (req, res) => {
  const indexFile = path.join(ROOT, "index.html");
  const fallbackFile = path.join(ROOT, "deepseek_html_20260731_90dbdd (1).html");
  
  if (fs.existsSync(indexFile)) {
    return res.sendFile(indexFile);
  }
  if (fs.existsSync(fallbackFile)) {
    return res.sendFile(fallbackFile);
  }
  return res.status(404).send("Storefront index file not found.");
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Thalente Boutique and Electronics running on port ${PORT}`);
});
httpServer.on("error", error => {
  console.error(`HTTP server error: ${error.message}`);
  process.exitCode = 1;
});
process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
  process.exitCode = 1;
});
process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
  process.exitCode = 1;
});