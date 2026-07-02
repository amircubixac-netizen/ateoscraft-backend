// routes/admin.js
'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const { db }    = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { addLog, getClientIp }       = require('../utils/logger');
const { pendingCount }              = require('../utils/rconQueue');
const { runExpiryCheck, runWhitelistSync } = require('../utils/cron');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// ══ STATS ════════════════════════════════════════════════════════════════════
router.get('/stats', (req, res) => {
  try {
    res.json({
      success: true,
      stats: {
        total_users:         db.prepare('SELECT COUNT(*) c FROM users').get().c,
        active_users:        db.prepare('SELECT COUNT(*) c FROM users WHERE is_active=1').get().c,
        total_purchases:     db.prepare('SELECT COUNT(*) c FROM purchases').get().c,
        total_revenue:       db.prepare(`SELECT COALESCE(SUM(price),0) s FROM purchases WHERE status='active'`).get().s,
        open_tickets:        db.prepare(`SELECT COUNT(*) c FROM support_messages WHERE status='open'`).get().c,
        active_subscriptions:db.prepare(`SELECT COUNT(*) c FROM subscriptions WHERE active=1 AND expire_date>datetime('now')`).get().c,
        rcon_queue_pending:  pendingCount(),
        rcon_queue_failed:   db.prepare(`SELECT COUNT(*) c FROM rcon_queue WHERE status='failed'`).get().c,
        today_logins:        db.prepare(`SELECT COUNT(*) c FROM logs WHERE type='login' AND created_at>=date('now')`).get().c,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا در دریافت آمار' });
  }
});

// ══ USERS ════════════════════════════════════════════════════════════════════
router.get('/users', (req, res) => {
  try {
    const search  = (req.query.search || '').trim();
    const page    = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 20;
    const offset  = (page - 1) * perPage;
    const like    = `%${search}%`;

    const base = search
      ? `FROM users WHERE username LIKE ? OR email LIKE ? OR mc_username LIKE ?`
      : `FROM users WHERE 1=1`;
    const params = search ? [like, like, like] : [];

    const users = db.prepare(`SELECT id,username,email,mc_username,role,wallet_balance,is_active,created_at ${base} ORDER BY id DESC LIMIT ? OFFSET ?`)
                    .all(...params, perPage, offset);
    const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...params).c;

    res.json({ success: true, users, total, page, per_page: perPage });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا در دریافت کاربران' });
  }
});

router.put('/users/:id',
  body('is_active').optional().isBoolean(),
  body('wallet_balance').optional().isInt({ min: 0 }),
  body('role').optional().isIn(['user', 'admin']),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

    try {
      const userId = parseInt(req.params.id, 10);
      const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      if (!target) return res.status(404).json({ success: false, message: 'کاربر یافت نشد' });

      const { is_active, wallet_balance, role } = req.body;
      if (is_active   !== undefined) db.prepare(`UPDATE users SET is_active=?,updated_at=datetime('now') WHERE id=?`).run(is_active ? 1 : 0, userId);
      if (role        !== undefined) db.prepare(`UPDATE users SET role=?,updated_at=datetime('now') WHERE id=?`).run(role, userId);
      if (wallet_balance !== undefined) {
        const diff = wallet_balance - target.wallet_balance;
        db.prepare(`UPDATE users SET wallet_balance=?,updated_at=datetime('now') WHERE id=?`).run(wallet_balance, userId);
        db.prepare(`INSERT INTO wallet_transactions (user_id,type,amount,balance_after,description) VALUES (?,'admin_adjust',?,?,'تغییر موجودی توسط ادمین')`).run(userId, diff, wallet_balance);
      }
      addLog({ user_id: req.user.id, username: req.user.username, type: 'admin', ip_address: getClientIp(req), detail: `ویرایش کاربر #${userId} (${target.username})` });
      res.json({ success: true, message: 'تغییرات ذخیره شد ✅' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطای داخلی' });
    }
  }
);

router.delete('/users/:id', (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ success: false, message: 'کاربر یافت نشد' });
    if (target.role === 'admin') return res.status(403).json({ success: false, message: 'حذف ادمین مجاز نیست' });
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    addLog({ user_id: req.user.id, username: req.user.username, type: 'admin', detail: `حذف کاربر "${target.username}"`, ip_address: getClientIp(req) });
    res.json({ success: true, message: `کاربر "${target.username}" حذف شد` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطای داخلی' });
  }
});

// ══ LOGS ═════════════════════════════════════════════════════════════════════
router.get('/logs', (req, res) => {
  try {
    const type = (req.query.type || '').trim();
    const rows = type
      ? db.prepare(`SELECT * FROM logs WHERE type=? ORDER BY id DESC LIMIT 300`).all(type)
      : db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT 300`).all();
    res.json({ success: true, logs: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا در دریافت لاگ‌ها' });
  }
});

router.delete('/logs/clear', (req, res) => {
  try {
    db.prepare('DELETE FROM logs').run();
    res.json({ success: true, message: 'لاگ‌ها پاک شدند ✅' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطای داخلی' });
  }
});

// ══ RCON QUEUE ═══════════════════════════════════════════════════════════════
router.get('/queue', (req, res) => {
  try {
    const status = (req.query.status || '').trim();
    const rows = status
      ? db.prepare(`SELECT * FROM rcon_queue WHERE status=? ORDER BY id DESC LIMIT 200`).all(status)
      : db.prepare(`SELECT * FROM rcon_queue ORDER BY id DESC LIMIT 200`).all();
    res.json({ success: true, queue: rows, pending: pendingCount() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا' });
  }
});

// retry یک آیتم failed
router.post('/queue/:id/retry', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.prepare('SELECT * FROM rcon_queue WHERE id=?').get(id);
    if (!item) return res.status(404).json({ success: false, message: 'یافت نشد' });
    db.prepare(`UPDATE rcon_queue SET status='pending', attempts=0, next_try_at=datetime('now'), last_error=NULL WHERE id=?`).run(id);
    addLog({ user_id: req.user.id, username: req.user.username, type: 'admin', detail: `retry دستی برای queue#${id}` });
    res.json({ success: true, message: 'آیتم برای retry ریست شد ✅' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطای داخلی' });
  }
});

// ══ PURCHASES ════════════════════════════════════════════════════════════════
router.get('/purchases', (req, res) => {
  try {
    const rows = db.prepare(`SELECT p.*,u.username FROM purchases p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 300`).all();
    res.json({ success: true, purchases: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا' });
  }
});

// ══ SUBSCRIPTIONS ════════════════════════════════════════════════════════════
router.get('/subscriptions', (req, res) => {
  try {
    const rows = db.prepare(`SELECT s.*,u.username FROM subscriptions s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 300`).all();
    res.json({ success: true, subscriptions: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا' });
  }
});

// ══ SUPPORT ══════════════════════════════════════════════════════════════════
router.get('/support', (req, res) => {
  try {
    res.json({ success: true, messages: db.prepare(`SELECT * FROM support_messages ORDER BY id DESC LIMIT 300`).all() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا' });
  }
});

// مکالمه کامل یک تیکت (برای پنل ادمین)
router.get('/support/:id', (req, res) => {
  try {
    const ticket = db.prepare('SELECT * FROM support_messages WHERE id=?').get(parseInt(req.params.id, 10));
    if (!ticket) return res.status(404).json({ success: false, message: 'تیکت یافت نشد' });
    const thread = db.prepare('SELECT * FROM support_ticket_messages WHERE ticket_id=? ORDER BY id ASC').all(ticket.id);
    res.json({ success: true, ticket, thread });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا' });
  }
});

router.post('/support/:id/reply',
  body('reply').trim().isLength({ min: 1, max: 1000 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'پاسخ نامعتبر' });
    try {
      const ticket = db.prepare('SELECT * FROM support_messages WHERE id=?').get(parseInt(req.params.id, 10));
      if (!ticket) return res.status(404).json({ success: false, message: 'تیکت یافت نشد' });

      // ستون‌های قدیمی reply/status/replied_at برای سازگاری با کلاینت‌های فعلی حفظ می‌شوند
      db.prepare(`UPDATE support_messages SET reply=?,status='replied',replied_at=datetime('now') WHERE id=?`).run(req.body.reply, ticket.id);
      db.prepare(`INSERT INTO support_ticket_messages (ticket_id, sender_role, sender_id, sender_name, message) VALUES (?,?,?,?,?)`)
        .run(ticket.id, 'admin', req.user.id, req.user.username, req.body.reply);

      addLog({ user_id: req.user.id, username: req.user.username, type: 'admin', detail: `پاسخ به تیکت #${ticket.id}`, ip_address: getClientIp(req) });
      res.json({ success: true, message: 'پاسخ ارسال شد ✅' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطای داخلی' });
    }
  }
);

// بستن نهایی یک تیکت (بدون امکان پاسخ بیشتر از سمت کاربر)
router.post('/support/:id/close', (req, res) => {
  try {
    const ticket = db.prepare('SELECT * FROM support_messages WHERE id=?').get(parseInt(req.params.id, 10));
    if (!ticket) return res.status(404).json({ success: false, message: 'تیکت یافت نشد' });
    db.prepare(`UPDATE support_messages SET status='closed' WHERE id=?`).run(ticket.id);
    addLog({ user_id: req.user.id, username: req.user.username, type: 'admin', detail: `بستن تیکت #${ticket.id}`, ip_address: getClientIp(req) });
    res.json({ success: true, message: 'تیکت بسته شد ✅' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطای داخلی' });
  }
});

// ══ SETTINGS ═════════════════════════════════════════════════════════════════
router.post('/settings',
  body('server_ip').optional().isString(),
  body('whitelist_price').optional().isInt({ min: 0 }),
  body('subscription_days').optional().isInt({ min: 1, max: 365 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
    try {
      const upsert = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
      const { server_ip, whitelist_price, subscription_days } = req.body;
      if (server_ip)         upsert.run('server_ip', server_ip);
      if (whitelist_price)   { upsert.run('whitelist_price', String(whitelist_price)); db.prepare(`UPDATE rank_items SET price=? WHERE slug='whitelist'`).run(whitelist_price); }
      if (subscription_days) upsert.run('subscription_days', String(subscription_days));
      addLog({ user_id: req.user.id, username: req.user.username, type: 'admin', detail: 'تنظیمات آپدیت شد', ip_address: getClientIp(req) });
      res.json({ success: true, message: 'تنظیمات ذخیره شد ✅' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطای داخلی' });
    }
  }
);

// ══ MANUAL EXPIRY + SYNC ═════════════════════════════════════════════════════
router.post('/run-expiry', async (req, res) => {
  try {
    const count = await runExpiryCheck();
    res.json({ success: true, expired: count });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/run-sync', async (req, res) => {
  try {
    await runWhitelistSync();
    res.json({ success: true, message: 'sync اجرا شد' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
