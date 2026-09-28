// Restores the SQLite database from a PRIVATE Supabase Storage bucket at startup.
// Render's free tier wipes the local disk on every restart, redeploy, and idle
// spin-down, so without this the database (products, orders) would start empty
// each time. server.js runs this synchronously before opening the database.
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const BACKUP_BUCKET = "thalente-private-backup";
const BACKUP_OBJECT = "thalente.sqlite";
const dbFile = path.join(__dirname, "data", "thalente.sqlite");
const markerFile = path.join(__dirname, "data", ".no-backup");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Returns true/false when we can tell for sure, null when we can't.
async function backupExists(supabase) {
  const { data, error } = await supabase.storage.from(BACKUP_BUCKET).list("", { search: BACKUP_OBJECT });
  if (error) return /not found/i.test(error.message || "") ? false : null;
  return data.some(file => file.name === BACKUP_OBJECT);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.warn("[restore] Supabase not configured; skipping."); return; }
  if (fs.existsSync(dbFile)) { console.log("[restore] local database already present; skipping."); return; }

  const supabase = createClient(url, key);
  let lastMessage = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await supabase.storage.from(BACKUP_BUCKET).download(BACKUP_OBJECT);
    if (!error) {
      const buffer = Buffer.from(await data.arrayBuffer());
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      fs.writeFileSync(dbFile, buffer);
      console.log(`[restore] restored database (${buffer.length} bytes) from Supabase.`);
      return;
    }
    lastMessage = error.message || lastMessage;
    if ((await backupExists(supabase)) === false) {
      console.log("[restore] no backup exists yet — starting with a fresh database.");
      return;
    }
    await sleep(2000);
  }
  throw new Error("could not download backup: " + lastMessage);
}

main()
  .catch(error => {
    // Never let an empty database overwrite a real backup: if the restore failed
    // for an unknown reason, disable backups for this run and loudly say so.
    console.error("[restore] FAILED — backups disabled for this run so the existing backup is not overwritten:", error.message);
    try {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(markerFile, String(error.message));
    } catch (_) { /* nothing more we can do */ }
  })
  .finally(() => process.exit(0));
