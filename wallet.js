// routes/wallet.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requestPayment } = require('../utils/zarinpal');
const { addLog, getClientIp } = require('../utils/logger');

const router = express.Router();

const insertPaymentRequest = db.prepare(`
  INSERT INTO payment_requests (user_id, authority, amount, purpose, item_name)
  VALUES (?, ?, ?, 'wallet_topup', ?)
`);

const getTransactions = db.prepare(`
  SELECT id, type, amount, balance_after, description, created_at
  FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100
`);

// ── GET /api/wallet/balance ──
router.get('/balance', requireAuth, (req, res) => {
  res.json({ success: true, balance: req.user.wallet_balance });
});

// ── GET /api/wallet/transactions ──
router.get('/transactions', requireAuth, (req, res) => {
  const rows = getTransactions.all(req.user.id);
  res.json({ success: true, transactions: rows });
});

// ── POST /api/wallet/topup ── شارژ کیف پول از طریق زرین‌پال
router.post('/topup',
  requireAuth,
  body('amount').isInt({ min: 5000 }).withMessage('حداقل مقدار شارژ ۵,۰۰۰ تومان است'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const amount = parseInt(req.body.amount, 10);
    const ip = getClientIp(req);

    const payment = await requestPayment(amount, `شارژ کیف پول AteosCraft — ${req.user.username}`);

    if (!payment.success) {
      addLog({ user_id: req.user.id, username: req.user.username, type: 'error',
        detail: `خطا در شارژ کیف پول: ${payment.error}`, ip_address: ip });
      return res.status(502).json({ success: false, message: 'خطا در اتصال به درگاه پرداخت: ' + payment.error });
    }

    insertPaymentRequest.run(req.user.id, payment.authority, amount, 'شارژ کیف پول');

    res.json({ success: true, payment_url: payment.payment_url });
  }
);

module.exports = router;
