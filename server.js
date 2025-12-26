import express from "express";
import Database from "better-sqlite3";

/**
 * Config
 * - On Render: set environment variables:
 *   - GLEAM_WEBHOOK_TOKEN = some-random-secret
 *   - PORT = 10000 (Render usually sets PORT automatically)
 *
 * Optional:
 * - DB_PATH = /opt/render/project/src/data.sqlite (default)
 */

const app = express();
app.set("trust proxy", true); // Render behind proxy

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_TOKEN = process.env.GLEAM_WEBHOOK_TOKEN || "";
const DB_PATH = process.env.DB_PATH || "./data.sqlite";

// Your action -> growth points mapping (edit these keys to match your Gleam entry.action)
const ACTION_POINTS = {
  subscribe_newsletter: 50,
  follow_twitter: 10,
  visit_pricing_page: 5
};

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

/** ---------------------------
 * SQLite setup
 * -------------------------- */
const db = new Database(DB_PATH);

// Speed + safety defaults for small apps
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS growth_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  external_event_key TEXT NOT NULL UNIQUE,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_growth_ledger_user_id ON growth_ledger(user_id);
`);

// Prepared statements
const stmtFindUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
const stmtCreateUser = db.prepare("INSERT INTO users (email, created_at) VALUES (?, ?)");
const stmtGetGrowthTotalByUserId = db.prepare(
  "SELECT COALESCE(SUM(delta), 0) AS total FROM growth_ledger WHERE user_id = ?"
);
const stmtInsertLedger = db.prepare(`
  INSERT INTO growth_ledger (
    user_id, delta, reason, source, external_event_key, raw_payload, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

/** ---------------------------
 * Health / debug helpers
 * -------------------------- */
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "gleam-webhook-server",
    time: nowIso()
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Create a user for testing (simulate your product user base).
 * POST /test/users { "email": "a@b.com" }
 */
app.post("/test/users", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  const existing = stmtFindUserByEmail.get(email);
  if (existing) return res.status(200).json({ ok: true, user: existing, existed: true });

  try {
    const info = stmtCreateUser.run(email, nowIso());
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
    return res.status(201).json({ ok: true, user });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "db_error", details: String(e?.message || e) });
  }
});

/**
 * Get a user's growth total by email
 * GET /test/users/:email/total
 */
app.get("/test/users/:email/total", (req, res) => {
  const email = normalizeEmail(req.params.email);
  const user = stmtFindUserByEmail.get(email);
  if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });

  const { total } = stmtGetGrowthTotalByUserId.get(user.id);
  return res.status(200).json({ ok: true, email: user.email, total });
});

/** ---------------------------
 * Gleam Post Entry Webhook
 * -------------------------- */
/**
 * Expected:
 * POST /webhooks/gleam/post-entry?token=xxx
 *
 * Payload fields depend on Gleam, but commonly includes:
 * - payload.user.email
 * - payload.campaign.key
 * - payload.entry.id
 * - payload.entry.action
 */
app.post("/webhooks/gleam/post-entry", (req, res) => {
  // 1) Token check
  const token = req.query.token;
  if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const payload = req.body;

  // 2) Pull key fields (adjust here if your payload shape differs)
  const email = normalizeEmail(payload?.user?.email);
  const campaignKey = payload?.campaign?.key;
  const entryId = payload?.entry?.id;
  const actionKey = payload?.entry?.action;

  if (!email || !campaignKey || !entryId || !actionKey) {
    return res.status(400).json({
      ok: false,
      error: "bad_payload",
      hint: "Expected payload.user.email, payload.campaign.key, payload.entry.id, payload.entry.action",
      got: { email, campaignKey, entryId, actionKey }
    });
  }

  // 3) Compute growth points
  const delta = ACTION_POINTS[actionKey] ?? 0;
  if (delta <= 0) {
    // Ignore actions you don't reward
    return res.status(200).json({ ok: true, ignored: true, actionKey });
  }

  // 4) Find user
  const user = stmtFindUserByEmail.get(email);
  if (!user) {
    // If you want strict mode, change to 404 or 400.
    return res.status(200).json({ ok: true, user_not_found: true, email });
  }

  // 5) Idempotency key
  const externalEventKey = `${campaignKey}:${entryId}`;

  // 6) Insert ledger with UNIQUE external_event_key to dedupe
  try {
    const raw = JSON.stringify(payload);
    stmtInsertLedger.run(
      user.id,
      delta,
      `gleam:${actionKey}`,
      "gleam",
      externalEventKey,
      raw,
      nowIso()
    );

    const { total } = stmtGetGrowthTotalByUserId.get(user.id);
    return res.status(200).json({
      ok: true,
      applied: true,
      email: user.email,
      actionKey,
      delta,
      total
    });
  } catch (e) {
    // Dedup if unique constraint hit
    const msg = String(e?.message || e);
    if (msg.includes("UNIQUE constraint failed") || msg.toLowerCase().includes("unique")) {
      const { total } = stmtGetGrowthTotalByUserId.get(user.id);
      return res.status(200).json({
        ok: true,
        applied: false,
        deduped: true,
        email: user.email,
        actionKey,
        delta,
        total
      });
    }

    console.error("Webhook DB insert error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/** ---------------------------
 * Start server
 * -------------------------- */
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] db at ${DB_PATH}`);
  console.log(`[server] webhook: POST /webhooks/gleam/post-entry?token=***`);
});
