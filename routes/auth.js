// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { db } = require('../db/database');
const { signToken } = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');
const { addLog, getClientIp } = require('../utils/logger');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const findByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUser = db.prepare(`
  INSERT INTO users (username, email, password_hash)
  VALUES (?, ?, ?)
`);
const updateMcUsername = db.prepare(`
  UPDATE users SET mc_username = ?, updated_at = datetime('now') WHERE id = ?
`);
const stmtRegisterFail = db.prepare(`
  UPDATE users SET failed_attempts = failed_attempts + 1,
    locked_until = CASE WHEN failed_attempts + 1 >= ? THEN datetime('now', ?  ' minutes') ELSE locked_until END
  WHERE id = ?
`);
const stmtResetAttempts = db.prepare(`
  UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?
`);

function isLocked(user) {
  return !!user.locked_until && new Date(user.locked_until.replace(' ', 'T') + 'Z') > new Date();
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    mc_username: u.mc_username,
    role: u.role,
    wallet_balance: u.wallet_balance,
    is_active: !!u.is_active,
    created_at: u.created_at
  };
}

// ── POST /api/auth/register ──
router.post('/register',
  body('username').trim().isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('نام کاربری باید بین ۳ تا ۲۰ کاراکتر و فقط حروف انگلیسی/عدد/آندرلاین باشد'),
  body('email').trim().isEmail().withMessage('ایمیل نامعتبر است'),
  body('password').isLength({ min: 6 }).withMessage('رمز عبور باید حداقل ۶ کاراکتر باشد'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { username, email, password } = req.body;
    const ip = getClientIp(req);

    if (findByUsername.get(username)) {
      return res.status(409).json({ success: false, message: 'این نام کاربری قبلا ثبت شده است' });
    }
    if (findByEmail.get(email)) {
      return res.status(409).json({ success: false, message: 'این ایمیل قبلا ثبت شده است' });
    }

    try {
      const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
      const result = insertUser.run(username, email, hash);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);

      const token = signToken({ id: user.id, role: user.role });
      addLog({ user_id: user.id, username: user.username, type: 'register', detail: 'ثبت‌نام جدید', ip_address: ip });

      res.json({ success: true, token, user: publicUser(user) });
    } catch (err) {
      // اگه دو درخواست همزمان با یوزرنیم/ایمیل یکسان اومدن، UNIQUE constraint اینجا میفته
      if (String(err.message  '').includes('UNIQUE constraint')) {
        return res.status(409).json({ success: false, message: 'این نام کاربری یا ایمیل قبلا ثبت شده است' });
      }
      addLog({ type: 'error', detail: `خطای ثبت‌نام: ${err.message}`, ip_address: ip });
      res.status(500).json({ success: false, message: 'خطای سرور در ثبت‌نام' });
    }
  }
);

// ── POST /api/auth/login ──
router.post('/login',
  body('username').trim().notEmpty().withMessage('نام کاربری یا ایمیل را وارد کن'),
  body('password').notEmpty().withMessage('رمز عبور را وارد کن'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { username, password } = req.body;
    const ip = getClientIp(req);

    // اجازه میدیم با یوزرنیم یا ایمیل وارد شه
    const user = findByUsername.get(username) || findByEmail.get(username);// پیام یکسان برای «کاربر نیست» و «رمز غلط» تا از user enumeration جلوگیری شود
    const invalidCredsMsg = { success: false, message: 'نام کاربری یا رمز عبور اشتباه است' };

    if (!user) {
      addLog({ type: 'error', detail: `تلاش ناموفق ورود برای "${username}" (کاربر یافت نشد)`, ip_address: ip });
      return res.status(401).json(invalidCredsMsg);
    }

    // ── قفل موقت حساب بعد از چند تلاش ناموفق پی‌درپی ──────────────────────
    if (isLocked(user)) {
      addLog({ user_id: user.id, username: user.username, type: 'error', detail: 'تلاش ورود روی حساب قفل‌شده', ip_address: ip });
      return res.status(429).json({ success: false, message: `حساب به‌دلیل تلاش‌های ناموفق زیاد موقتاً قفل شده — کمی بعد دوباره امتحان کن` });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      stmtRegisterFail.run(MAX_FAILED_ATTEMPTS, String(LOCK_MINUTES), user.id);
      addLog({ user_id: user.id, username: user.username, type: 'error', detail: رمز عبور اشتباه (تلاش ${user.failed_attempts + 1}), ip_address: ip });
      return res.status(401).json(invalidCredsMsg);
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'حساب کاربری شما مسدود شده است' });
    }

    stmtResetAttempts.run(user.id);

    const token = signToken({ id: user.id, role: user.role });
    addLog({ user_id: user.id, username: user.username, type: 'login', detail: 'ورود موفق', ip_address: ip });

    res.json({ success: true, token, user: publicUser(user) });
  }
);

// ── GET /api/auth/me ──
router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});

// ── POST /api/auth/profile ── (آپدیت mc_username)
router.post('/profile',
  requireAuth,
  body('mc_username').trim().isLength({ min: 3, max: 16 }).matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('نام کاربری ماینکرافت نامعتبر است (۳ تا ۱۶ کاراکتر، فقط حروف/عدد/آندرلاین)'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }
    updateMcUsername.run(req.body.mc_username, req.user.id);
    res.json({ success: true, message: 'پروفایل ذخیره شد' });
  }
);

module.exports = router;
