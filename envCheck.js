// utils/envCheck.js
// ─────────────────────────────────────────────────────────────────────────────
// اعتبارسنجی متغیرهای محیطی هنگام راه‌اندازی سرور.
//
// هدف: جلوگیری از رسیدن مقادیر پیش‌فرض ناامن (JWT_SECRET ضعیف، رمز ادمین
// پیش‌فرض و ...) به محیط production. اگر مشکلی critical باشد، پروسه با پیام
// واضح متوقف می‌شود به‌جای اینکه با یک حفره امنیتی پنهان اجرا شود.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const INSECURE_DEFAULTS = new Set([
  'change_this_to_a_long_random_secret_string',
  'insecure_dev_secret_change_me',
  'change_this_admin_password_now',
  'change_this_rcon_password',
  '',
  undefined,
]);

function checkEnv() {
  const isProd = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  // ── JWT_SECRET ────────────────────────────────────────────────────────────
  const jwtSecret = process.env.JWT_SECRET;
  if (INSECURE_DEFAULTS.has(jwtSecret)) {
    errors.push('JWT_SECRET تنظیم نشده یا مقدار پیش‌فرض/نمونه است.');
  } else if (jwtSecret.length < 32) {
    (isProd ? errors : warnings).push('JWT_SECRET کوتاه است (حداقل ۳۲ کاراکتر تصادفی توصیه می‌شود).');
  }

  // ── ADMIN_PASSWORD ────────────────────────────────────────────────────────
  if (INSECURE_DEFAULTS.has(process.env.ADMIN_PASSWORD)) {
    (isProd ? errors : warnings).push('ADMIN_PASSWORD تنظیم نشده یا مقدار پیش‌فرض/نمونه است — حساب ادمین ناامن خواهد بود.');
  }

  // ── RCON password ────────────────────────────────────────────────────────
  if (INSECURE_DEFAULTS.has(process.env.MC_RCON_PASSWORD)) {
    (isProd ? errors : warnings).push('MC_RCON_PASSWORD تنظیم نشده یا مقدار پیش‌فرض است — اتصال RCON ناامن است.');
  }

  // ── CORS wildcard در production ──────────────────────────────────────────
  const origin = process.env.FRONTEND_ORIGIN || '*';
  if (isProd && origin.split(',').map(s => s.trim()).includes('*')) {
    warnings.push('FRONTEND_ORIGIN روی "*" است — در production توصیه می‌شود دامنه‌های مجاز را صریحاً مشخص کنی.');
  }

  // ── زرین‌پال ──────────────────────────────────────────────────────────────
  if (isProd && (process.env.ZARINPAL_SANDBOX || 'true') === 'true') {
    warnings.push('ZARINPAL_SANDBOX روی true است در حالی که NODE_ENV=production — پرداخت‌های واقعی پردازش نمی‌شوند.');
  }

  for (const w of warnings) console.warn(`⚠️  [env] ${w}`);

  if (errors.length) {
    console.error('\n🚫 راه‌اندازی متوقف شد — مشکلات امنیتی critical در تنظیمات محیطی:\n');
    for (const e of errors) console.error(`   - ${e}`);
    console.error('\nفایل .env را بر اساس .env.example با مقادیر واقعی و امن پر کن.\n');
    process.exit(1);
  }
}

module.exports = { checkEnv };
