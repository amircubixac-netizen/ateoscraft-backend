// db/database.js
'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const bcrypt   = require('bcryptjs');
require('dotenv').config();

const DB_PATH = path.join(__dirname, '..', 'data.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout  = 5000');   // جلوگیری از SQLITE_BUSY در concurrency

/**
 * افزودن ایمن یک ستون به جدول موجود (برای دیتابیس‌هایی که قبلاً دیپلوی شده‌اند).
 * اگر ستون از قبل وجود داشته باشد، کاری انجام نمی‌دهد.
 */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`🔧 [migration] ستون "${column}" به جدول "${table}" اضافه شد`);
  }
}

function init() {
  db.exec(`
    -- ─── کاربران ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT UNIQUE NOT NULL,
      email            TEXT UNIQUE NOT NULL,
      password_hash    TEXT NOT NULL,
      mc_username      TEXT DEFAULT NULL,
      role             TEXT NOT NULL DEFAULT 'user',
      wallet_balance   INTEGER NOT NULL DEFAULT 0,
      is_active        INTEGER NOT NULL DEFAULT 1,
      failed_attempts  INTEGER NOT NULL DEFAULT 0,
      locked_until     TEXT DEFAULT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ─── تراکنش‌های کیف پول ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type          TEXT NOT NULL,
      amount        INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description   TEXT,
      ref_authority TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(user_id);

    -- ─── درخواست‌های پرداخت زرین‌پال ───────────────────────────────────────
    -- status flow: pending → verifying → success | failed
    CREATE TABLE IF NOT EXISTS payment_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      authority   TEXT UNIQUE NOT NULL,
      amount      INTEGER NOT NULL,
      purpose     TEXT NOT NULL,
      item_slug   TEXT,
      item_name   TEXT,
      mc_username TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      ref_id      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pay_authority ON payment_requests(authority);
    CREATE INDEX IF NOT EXISTS idx_pay_status    ON payment_requests(status);

    -- ─── خریدها ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS purchases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_slug   TEXT NOT NULL,
      item_name   TEXT NOT NULL,
      price       INTEGER NOT NULL,
      mc_username TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      rcon_result TEXT,
      expires_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);

    -- ─── آیتم‌های فروشگاه ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rank_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      price         INTEGER NOT NULL,
      duration_days INTEGER DEFAULT NULL,
      rcon_commands TEXT NOT NULL,
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ─── سابسکریپشن‌های وایت‌لیست ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mc_username TEXT NOT NULL,
      expire_date TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subs_user         ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subs_active_exp   ON subscriptions(active, expire_date);
    CREATE INDEX IF NOT EXISTS idx_subs_mc           ON subscriptions(mc_username);

    -- ─── صف دستورات RCON (queue دائمی) ────────────────────────────────────
    -- status: pending | processing | done | failed
    CREATE TABLE IF NOT EXISTS rcon_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      command     TEXT NOT NULL,
      mc_username TEXT NOT NULL,
      action      TEXT NOT NULL,          -- 'add' | 'remove'
      context     TEXT,                   -- JSON: اطلاعات اضافی برای لاگ
      status      TEXT NOT NULL DEFAULT 'pending',
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      next_try_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status_next ON rcon_queue(status, next_try_at);

    -- ─── لاگ‌ها ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username   TEXT,
      type       TEXT NOT NULL,
      detail     TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
    CREATE INDEX IF NOT EXISTS idx_logs_ts   ON logs(created_at);

    -- ─── تیکت‌های پشتیبانی ─────────────────────────────────────────────────
    -- هر رکورد یک "تیکت" است. متن کامل مکالمه (پیام کاربر + پاسخ‌های ادمین/کاربر)
    -- در جدول support_ticket_messages نگه‌داری می‌شود تا امکان رفت‌وبرگشت چندباره باشد.
    -- status: open | replied | closed
    CREATE TABLE IF NOT EXISTS support_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username   TEXT,
      message    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'open',
      reply      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      replied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_support_user   ON support_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_support_status ON support_messages(status);

    -- ─── پیام‌های داخل هر تیکت (مکالمه دو طرفه کاربر/ادمین) ────────────────
    CREATE TABLE IF NOT EXISTS support_ticket_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id   INTEGER NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL,     -- 'user' | 'admin'
      sender_id   INTEGER,
      sender_name TEXT,
      message     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_msgs_ticket ON support_ticket_messages(ticket_id);

    -- ─── تنظیمات ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ── migrationهای ایمن برای دیتابیس‌هایی که قبل از این تغییرات ساخته شده‌اند
  ensureColumn('users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'locked_until', 'TEXT');

  seedDefaults();
}

function seedDefaults() {
  // ── ادمین پیش‌فرض
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  if (!db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername)) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123456', 12);
    db.prepare(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(adminUsername, process.env.ADMIN_EMAIL || 'admin@ateoscraft.ir', hash);
    console.log(`✅ ادمین پیش‌فرض ساخته شد: ${adminUsername}`);
  }

  // ── آیتم‌های پیش‌فرض
  const items = [
    { slug: 'whitelist',   name: 'وایت‌لیست ۳۰ روزه', price: 25000, duration_days: 30,   rcon_commands: JSON.stringify(['whitelist add {username}']) },
    { slug: 'sponsor',     name: 'رنک Sponsor',         price: 300000, duration_days: null, rcon_commands: JSON.stringify(['lp user {username} parent add sponsor']) },
    { slug: 'extra-pro',   name: 'رنک ExtraPro',        price: 160000, duration_days: null, rcon_commands: JSON.stringify(['lp user {username} parent add extrapro']) },
    { slug: 'godkiller',   name: 'رنک GodKiller',       price: 100000, duration_days: null, rcon_commands: JSON.stringify(['lp user {username} parent add godkiller']) },
    { slug: 'untouchable', name: 'رنک Untouchable',     price: 60000,  duration_days: null, rcon_commands: JSON.stringify(['lp user {username} parent add untouchable']) },
    { slug: 'mainmember',  name: 'رنک MainMember',      price: 50000,  duration_days: null, rcon_commands: JSON.stringify(['lp user {username} parent add mainmember']) },
    { slug: 'hunter',      name: 'رنک Hunter',          price: 30000,  duration_days: null, rcon_commands: JSON.stringify(['lp user {username} parent add hunter']) },
  ];
  const ins = db.prepare(`INSERT OR IGNORE INTO rank_items (slug,name,price,duration_days,rcon_commands) VALUES (@slug,@name,@price,@duration_days,@rcon_commands)`);
  for (const item of items) ins.run(item);

  // ── تنظیمات پیش‌فرض
  const defaults = { server_ip: process.env.MC_SERVER_IP || 'play.ateoscraft.ir', whitelist_price: '25000' };
  const insSetting = db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`);
  for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);
}

module.exports = { db, init };
