// routes/payment.js
// ─────────────────────────────────────────────────────────────────────────────
// جریان پرداخت:
//
// POST /direct  → درخواست پرداخت به زرین‌پال (بدون کیف پول)
// POST /request → خرید از کیف پول
// GET  /verify  → کال‌بک زرین‌پال
//
// بعد از verify موفق برای whitelist:
//   1. subscription ساخته/تمدید می‌شود
//   2. دستور whitelist add در RCON queue ذخیره می‌شود
//   3. اگر RCON بعداً هم fail شود، پول از دست نمی‌رود —
//      دستور در queue می‌ماند و retry می‌شود
//
// امنیت authority:
//   UPDATE ... WHERE status='pending'  → atomic claim
//   اگه changes=0 یعنی قبلاً استفاده شده → رد
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express   = require('express');
const { body, validationResult } = require('express-validator');
const { db }    = require('../db/database');
const { requireAuth }              = require('../middleware/auth');
const { requestPayment, verifyPayment } = require('../utils/zarinpal');
const { alertPaymentFail } = require('../utils/alerts');
const { executeItemCommands }      = require('../utils/rcon');
const { enqueue }                  = require('../utils/rconQueue');
const { addLog, getClientIp }      = require('../utils/logger');
const { createOrExtend, DEFAULT_DAYS } = require('../utils/subscription');

const router = express.Router();

const MC_USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

// ── Prepared statements ──────────────────────────────────────────────────────
const stmtGetItem     = db.prepare(SELECT * FROM rank_items WHERE slug = ? AND is_active = 1);
const stmtGetPR       = db.prepare(SELECT * FROM payment_requests WHERE authority = ?);
const stmtClaimPR     = db.prepare(UPDATE payment_requests SET status='verifying' WHERE authority=? AND status='pending');
const stmtSuccessPR   = db.prepare(UPDATE payment_requests SET status='success', ref_id=?, verified_at=datetime('now') WHERE id=?);
const stmtFailPR      = db.prepare(UPDATE payment_requests SET status='failed' WHERE id=?);
const stmtGetUser     = db.prepare(SELECT * FROM users WHERE id = ?);
const stmtUpdateBal   = db.prepare(UPDATE users SET wallet_balance=?, updated_at=datetime('now') WHERE id=?);
// کسر اتمیک موجودی — شرط wallet_balance>=? از race condition بین دو درخواست همزمان جلوگیری می‌کند
const stmtDeductBalAtomic = db.prepare(UPDATE users SET wallet_balance = wallet_balance - ?, updated_at=datetime('now') WHERE id=? AND wallet_balance >= ?);
const stmtInsertTx    = db.prepare(INSERT INTO wallet_transactions (user_id,type,amount,balance_after,description,ref_authority) VALUES (?,?,?,?,?,?));
const stmtInsertBuy   = db.prepare(INSERT INTO purchases (user_id,item_slug,item_name,price,mc_username,status,rcon_result,expires_at) VALUES (?,?,?,?,?,?,?,?));
const stmtUpdateBuyStatus = db.prepare(UPDATE purchases SET status=?, rcon_result=? WHERE id=?);
const stmtInsertDirPR = db.prepare(INSERT INTO payment_requests (user_id,authority,amount,purpose,item_slug,item_name,mc_username) VALUES (?,?,?,'direct_purchase',?,?,?));
const stmtHistory     = db.prepare(SELECT id,item_slug,item_name,price,mc_username,status,created_at FROM purchases WHERE user_id=? ORDER BY id DESC LIMIT 100);

// ─────────────────────────────────────────────────────────────────────────────
// اعتبارسنجی mc_username
// ─────────────────────────────────────────────────────────────────────────────
function validateMcUsername(value) {
  return MC_USERNAME_RE.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// تابع مشترک: فعال‌سازی وایت‌لیست بعد از پرداخت موفق
// subscription ساخته می‌شود، دستور RCON در queue قرار می‌گیرد
// ─────────────────────────────────────────────────────────────────────────────
function activateWhitelist({ userId, mcUsername, context }) {
  const subResult = createOrExtend(userId, mcUsername);enqueue({
    command:     whitelist add ${mcUsername},
    mc_username: mcUsername,
    action:      'add',
    context: {
      ...context,
      sub_id:        subResult.subscription.id,
      expire_date:   subResult.subscription.expire_date,
      is_new_sub:    subResult.isNew
    }
  });

  return subResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// تابع مشترک: اجرای RCON برای آیتم‌های غیر-whitelist (فوری با تلاش اول)
//
// اگر سرور آفلاین بود / اجرا fail شد: به‌جای گم‌شدن دستور، هر دستور به‌صورت
// جداگانه در rcon_queue قرار می‌گیرد تا با retry/backoff دوباره امتحان شود.
// اگر purchaseId داده شده باشد، وقتی صف بعداً موفق/failed نهایی شود،
// وضعیت رکورد purchases هم به‌روزرسانی می‌شود (به‌جای اینکه برای همیشه pending بماند).
// ─────────────────────────────────────────────────────────────────────────────
async function applyItemRcon(item, mcUsername, context, purchaseId = null) {
  const templates = JSON.parse(item.rcon_commands);
  const result    = await executeItemCommands(templates, mcUsername);

  if (!result.success) {
    addLog({
      user_id:  context.user_id  null,
      username: context.username  null,
      type:     'error',
      detail:   RCON ناموفق برای ${item.slug} (${mcUsername}): ${result.error} — دستورات در صف قرار گرفتند
    });

    // هر دستور را جداگانه در صف بگذار تا در پس‌زمینه retry شود
    const commands = templates.map(c => c.replaceAll('{username}', mcUsername));
    for (const command of commands) {
      enqueue({
        command,
        mc_username: mcUsername,
        action: 'add',
        context: { ...context, item_slug: item.slug, purchase_id: purchaseId, reason: 'purchase_rcon_retry' },
      });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/request — خرید از کیف پول
// ─────────────────────────────────────────────────────────────────────────────
router.post('/request',
  requireAuth,
  body('item_slug').trim().notEmpty(),
  body('mc_username').trim().custom(v => { if (!validateMcUsername(v)) throw new Error('نام کاربری ماینکرافت نامعتبر است (3-16 کاراکتر، فقط a-z A-Z 0-9 _)'); return true; }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

    const ip         = getClientIp(req);
    const mcUsername = req.body.mc_username.trim();
    const item       = stmtGetItem.get(req.body.item_slug.trim());

    if (!item) return res.status(404).json({ success: false, message: 'آیتم یافت نشد یا غیرفعال است' });

    const user = stmtGetUser.get(req.user.id);

    try {
      // ── کسر اتمیک موجودی ────────────────────────────────────────────────
      // شرط wallet_balance>=price در خود UPDATE چک می‌شود تا دو درخواست همزمان
      // نتوانند هر دو رد شوند (race condition / احتمال موجودی منفی).
      const deduction = stmtDeductBalAtomic.run(item.price, user.id, item.price);
      if (deduction.changes === 0) {
        return res.status(400).json({ success: false, message: 'موجودی کیف پول کافی نیست' });
      }
      const newBal = stmtGetUser.get(user.id).wallet_balance;
      stmtInsertTx.run(user.id, 'purchase', -item.price, newBal, خرید ${item.name}, null);

      const ctx = { user_id: user.id, username: user.username, source: 'wallet' };
      const expiresAt = item.duration_days
        ? (() => { const d = new Date(); d.setDate(d.getDate() + item.duration_days); return d.toISOString(); })()
        : null;

      let rconResult = { success: true };
      let subResult  = null;if (item.slug === 'whitelist') {
        subResult = activateWhitelist({ userId: user.id, mcUsername, context: ctx });
        stmtInsertBuy.run(user.id, item.slug, item.name, item.price, mcUsername, 'active', JSON.stringify(rconResult), expiresAt);
      } else {
        // اول رکورد purchase را با وضعیت pending می‌سازیم تا id بگیریم،
        // بعد RCON را اجرا می‌کنیم و اگر fail شد، دستور در صف با ارجاع به همین purchase قرار می‌گیرد
        const buy = stmtInsertBuy.run(user.id, item.slug, item.name, item.price, mcUsername, 'pending', null, expiresAt);
        rconResult = await applyItemRcon(item, mcUsername, ctx, buy.lastInsertRowid);
        const finalStatus = rconResult.success ? 'active' : 'pending';
        stmtUpdateBuyStatus.run(finalStatus, JSON.stringify(rconResult), buy.lastInsertRowid);
      }

      addLog({
        user_id: user.id, username: user.username, type: 'buy', ip_address: ip,
        detail: خرید از کیف پول: ${item.name} برای ${mcUsername} +
          (subResult ?  — سابسکریپشن تا ${subResult.subscription.expire_date} (${subResult.isNew ? 'جدید' : 'تمدید'}) : '')
      });

      res.json({
        success:      true,
        message:      'خرید با موفقیت انجام شد ✅',
        new_balance:  newBal,
        subscription: subResult ? { expire_date: subResult.subscription.expire_date, is_new: subResult.isNew } : null
      });
    } catch (err) {
      addLog({ user_id: user.id, username: user.username, type: 'error', ip_address: ip, detail: خطا در خرید از کیف پول: ${err.message} });
      res.status(500).json({ success: false, message: 'خطای داخلی سرور' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/direct — خرید مستقیم (زرین‌پال)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/direct',
  requireAuth,
  body('item_slug').trim().notEmpty(),
  body('mc_username').trim().custom(v => { if (!validateMcUsername(v)) throw new Error('نام کاربری ماینکرافت نامعتبر است (3-16 کاراکتر، فقط a-z A-Z 0-9 _)'); return true; }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

    const ip         = getClientIp(req);
    const mcUsername = req.body.mc_username.trim();
    const item       = stmtGetItem.get(req.body.item_slug.trim());

    if (!item) return res.status(404).json({ success: false, message: 'آیتم یافت نشد' });

    try {
      const payment = await requestPayment(item.price, خرید ${item.name} — AteosCraft — ${req.user.username});
      if (!payment.success) {
        addLog({ user_id: req.user.id, username: req.user.username, type: 'error', ip_address: ip, detail: خطا در درگاه: ${payment.error} });
        return res.status(502).json({ success: false, message: 'خطا در اتصال به درگاه: ' + payment.error });
      }

      stmtInsertDirPR.run(req.user.id, payment.authority, item.price, item.slug, item.name, mcUsername);
      res.json({ success: true, payment_url: payment.payment_url });
    } catch (err) {
      addLog({ user_id: req.user.id, type: 'error', ip_address: ip, detail: خطا در /direct: ${err.message} });
      res.status(500).json({ success: false, message: 'خطای داخلی سرور' });
    }
  }
);// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/verify — کال‌بک زرین‌پال
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verify', async (req, res) => {
  const { Authority, Status } = req.query;
  const frontendUrl = process.env.FRONTEND_RETURN_URL  'http://localhost:3000';
  const ip          = getClientIp(req);

  const fail  = (reason) => {
    addLog({ type: 'error', ip_address: ip, detail: `[verify] ${reason}` });
    // 🚨 alert برای payment fail
    alertPaymentFail({
      userId:    null,
      username:  null,
      amount:    null,
      authority: Authority,
      error:     reason,
    }).catch(() => {});
    return res.redirect(`${frontendUrl}?payment=failed`);
  };

  if (!Authority) return fail('Authority خالی');

  const pr = stmtGetPR.get(Authority);
  if (!pr)     return fail(`Authority ناشناخته: ${Authority}`);

  if (Status !== 'OK') {
    if (pr.status === 'pending') stmtFailPR.run(pr.id);
    return fail(`کاربر پرداخت را لغو کرد (status=${Status})`);
  }

  // ── atomic claim ──────────────────────────────────────────────────────────
  const claim = stmtClaimPR.run(Authority);
  if (claim.changes === 0) {
    const fresh = stmtGetPR.get(Authority);
    if (fresh?.status === 'success') {
      // قبلاً موفق پردازش شده — بدون پردازش دوباره redirect کن
      const lbl = encodeURIComponent(fresh.item_name  'پرداخت');
      return res.redirect(${frontendUrl}?payment=success&ref=${fresh.ref_id || ''}&item=${lbl});
    }
    return fail(تلاش تکراری برای Authority: ${Authority});
  }

  // ── تایید مبلغ با دیتابیس (جلوگیری از تغییر مبلغ) ───────────────────────
  const verification = await verifyPayment(pr.amount, Authority);
  if (!verification.success) {
    stmtFailPR.run(pr.id);
    return fail(تایید زرین‌پال ناموفق: ${verification.error});
  }

  stmtSuccessPR.run(verification.ref_id, pr.id);
  const user = stmtGetUser.get(pr.user_id);
  const lbl  = encodeURIComponent(pr.item_name || 'خرید');

  try {
    // ══ شارژ کیف پول ════════════════════════════════════════════════════════
    if (pr.purpose === 'wallet_topup') {
      const newBal = user.wallet_balance + pr.amount;
      stmtUpdateBal.run(newBal, user.id);
      stmtInsertTx.run(user.id, 'deposit', pr.amount, newBal, 'شارژ کیف پول', Authority);
      addLog({ user_id: user.id, username: user.username, type: 'buy', ip_address: ip, detail: شارژ کیف پول ${pr.amount.toLocaleString('fa-IR')} ت — ref:${verification.ref_id} });
      return res.redirect(${frontendUrl}?payment=success&ref=${verification.ref_id}&item=${encodeURIComponent('شارژ کیف پول')});
    }

    // ══ خرید مستقیم ═════════════════════════════════════════════════════════
    if (pr.purpose === 'direct_purchase') {
      const item = stmtGetItem.get(pr.item_slug);
      const ctx  = { user_id: user.id, username: user.username, ref_id: verification.ref_id, source: 'zarinpal' };

      let subResult  = null;
      let rconResult = { success: true };
      const expiresAt = item?.duration_days
        ? (() => { const d = new Date(); d.setDate(d.getDate() + item.duration_days); return d.toISOString(); })()
        : null;if (!item) {
        addLog({ user_id: user.id, type: 'error', ip_address: ip, detail: آیتم ${pr.item_slug} یافت نشد بعد از پرداخت موفق! });
        stmtInsertBuy.run(user.id, pr.item_slug, pr.item_name, pr.amount, pr.mc_username, 'pending', JSON.stringify(rconResult), expiresAt);
      } else if (item.slug === 'whitelist') {
        // subscription ایجاد / تمدید + whitelist add در queue
        subResult = activateWhitelist({ userId: user.id, mcUsername: pr.mc_username, context: ctx });
        stmtInsertBuy.run(user.id, pr.item_slug, pr.item_name, pr.amount, pr.mc_username, 'active', JSON.stringify(rconResult), expiresAt);
      } else {
        // اول رکورد purchase را می‌سازیم تا id بگیریم، بعد RCON را اجرا می‌کنیم —
        // اگر fail شد، applyItemRcon دستورات را با ارجاع به همین purchase در صف می‌گذارد
        const buy = stmtInsertBuy.run(user.id, pr.item_slug, pr.item_name, pr.amount, pr.mc_username, 'pending', null, expiresAt);
        rconResult = await applyItemRcon(item, pr.mc_username, ctx, buy.lastInsertRowid);
        const finalStatus = rconResult.success ? 'active' : 'pending';
        stmtUpdateBuyStatus.run(finalStatus, JSON.stringify(rconResult), buy.lastInsertRowid);
      }

      addLog({
        user_id: user.id, username: user.username, type: 'buy', ip_address: ip,
        detail: خرید مستقیم ${pr.item_name} برای ${pr.mc_username} — ref:${verification.ref_id} +
          (subResult ?  — سابسکریپشن تا ${subResult.subscription.expire_date} (${subResult.isNew ? 'جدید' : 'تمدید'}) : '')
      });

      return res.redirect(${frontendUrl}?payment=success&ref=${verification.ref_id}&item=${lbl});
    }

    // purpose ناشناخته
    addLog({ user_id: pr.user_id, type: 'error', detail: purpose ناشناخته: ${pr.purpose} });
    return res.redirect(${frontendUrl}?payment=failed);

  } catch (err) {
    // پول تایید شده اما پردازش داخلی خطا داد — redirect موفق می‌کنیم، لاگ می‌کنیم
    addLog({ user_id: pr.user_id, type: 'error', ip_address: ip, detail: خطا در پردازش بعد از verify: ${err.message} });
    return res.redirect(${frontendUrl}?payment=success&ref=${verification.ref_id}&item=${lbl}&warn=1);
  }
});

// ── GET /api/payment/history ─────────────────────────────────────────────────
router.get('/history', requireAuth, (req, res) => {
  try {
    res.json({ success: true, purchases: stmtHistory.all(req.user.id) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا در دریافت تاریخچه' });
  }
});

module.exports = router;
