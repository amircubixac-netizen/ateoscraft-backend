// routes/support.js
'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { addLog, getClientIp } = require('../utils/logger');

const router = express.Router();

const insertMessage = db.prepare(`
  INSERT INTO support_messages (user_id, username, message)
  VALUES (?, ?, ?)
`);
const insertThreadMsg = db.prepare(`
  INSERT INTO support_ticket_messages (ticket_id, sender_role, sender_id, sender_name, message)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtMyTickets = db.prepare(`
  SELECT * FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100
`);
const stmtTicketById = db.prepare(`
  SELECT * FROM support_messages WHERE id = ?
`);
const stmtThreadForTicket = db.prepare(`
  SELECT * FROM support_ticket_messages WHERE ticket_id = ? ORDER BY id ASC
`);
const stmtReopenTicket = db.prepare(`
  UPDATE support_messages SET status = 'open' WHERE id = ?
`);

// ── POST /api/support/message ── (بدون تغییر در قرارداد API — ایجاد تیکت جدید)
router.post('/message',
  requireAuth,
  body('message').trim().isLength({ min: 5, max: 1000 }).withMessage('پیام باید بین ۵ تا ۱۰۰۰ کاراکتر باشد'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const result = insertMessage.run(req.user.id, req.user.username, req.body.message);
    insertThreadMsg.run(result.lastInsertRowid, 'user', req.user.id, req.user.username, req.body.message);

    addLog({ user_id: req.user.id, username: req.user.username, type: 'support',
      detail: 'تیکت پشتیبانی جدید ارسال شد', ip_address: getClientIp(req) });

    res.json({ success: true, message: 'پیام شما ارسال شد، به‌زودی پاسخ داده می‌شود ✅', ticket_id: result.lastInsertRowid });
  }
);

// ── GET /api/support/my-tickets ── لیست تیکت‌های خود کاربر + آخرین وضعیت
router.get('/my-tickets', requireAuth, (req, res) => {
  try {
    const tickets = stmtMyTickets.all(req.user.id);
    res.json({ success: true, tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا در دریافت تیکت‌ها' });
  }
});

// ── GET /api/support/tickets/:id ── مکالمه کامل یک تیکت (فقط صاحب تیکت)
router.get('/tickets/:id',
  requireAuth,
  param('id').isInt(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'شناسه نامعتبر' });

    try {
      const ticket = stmtTicketById.get(parseInt(req.params.id, 10));
      if (!ticket || ticket.user_id !== req.user.id) {
        return res.status(404).json({ success: false, message: 'تیکت یافت نشد' });
      }
      const thread = stmtThreadForTicket.all(ticket.id);
      res.json({ success: true, ticket, thread });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطای داخلی' });
    }
  }
);

// ── POST /api/support/tickets/:id/reply ── کاربر به پاسخ ادمین جواب می‌دهد (تیکت دوباره باز می‌شود)
router.post('/tickets/:id/reply',
  requireAuth,
  param('id').isInt(),
  body('message').trim().isLength({ min: 1, max: 1000 }).withMessage('پیام نامعتبر است'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

    try {
      const ticket = stmtTicketById.get(parseInt(req.params.id, 10));
      if (!ticket || ticket.user_id !== req.user.id) {
        return res.status(404).json({ success: false, message: 'تیکت یافت نشد' });
      }
      if (ticket.status === 'closed') {
        return res.status(409).json({ success: false, message: 'این تیکت بسته شده و امکان پاسخ‌دهی به آن نیست' });
      }

      insertThreadMsg.run(ticket.id, 'user', req.user.id, req.user.username, req.body.message);
      stmtReopenTicket.run(ticket.id);

      addLog({ user_id: req.user.id, username: req.user.username, type: 'support',
        detail: `پاسخ کاربر به تیکت #${ticket.id}`, ip_address: getClientIp(req) });

      res.json({ success: true, message: 'پاسخ شما ثبت شد ✅' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطای داخلی' });
    }
  }
);

module.exports = router;
