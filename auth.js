// middleware/auth.js
const { verifyToken } = require('../utils/jwt');
const { db } = require('../db/database');

const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

/**
 * این میدلور توکن JWT رو از هدر Authorization می‌خونه،
 * اعتبارش رو چک می‌کنه و یوزر رو به req.user اضافه می‌کنه.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'توکن ارسال نشده — ابتدا وارد حساب کاربری شو' });
  }

  try {
    const payload = verifyToken(token);
    const user = getUserById.get(payload.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'کاربر یافت نشد' });
    }
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'حساب کاربری شما مسدود شده است' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'توکن نامعتبر یا منقضی شده — دوباره وارد شو' });
  }
}

/**
 * فقط بعد از requireAuth استفاده شه. دسترسی رو فقط به نقش ادمین میده.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز — فقط ادمین' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
