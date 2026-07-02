// middleware/rateLimiters.js
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // ۱۵ دقیقه
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'تعداد تلاش‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کن.' }
});

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'درخواست پرداخت بیش از حد. کمی صبر کن و دوباره امتحان کن.' }
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { authLimiter, paymentLimiter, generalLimiter };
