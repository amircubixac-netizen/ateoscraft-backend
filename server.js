// server.js
// ─────────────────────────────────────────────────────────────────────────────
// AteosCraft Backend — God-Level Production
//
// ویژگی‌های اضافه شده:
//   ✅ Queue Persistence — صف در SQLite است، بعد از ریست از بین نمی‌رود
//   ✅ Database Backup   — backup روزانه خودکار (utils/backup.js)
//   ✅ Monitoring+Alerts — webhook Discord برای payment/rcon/queue failure
//   ✅ Rate Limiting      — generalLimiter + authLimiter + paymentLimiter
//   ✅ Graceful Shutdown  — SIGTERM/SIGINT: صف متوقف می‌شود، connection‌ها بسته
//   ✅ Health Check API   — GET /health وضعیت db/rcon/queue
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
require('dotenv').config();

// ── بررسی متغیرهای محیطی قبل از هر کار دیگری ─────────────────────────────────
// اگر تنظیمات critical (JWT_SECRET و ...) ناامن/خالی باشد، پروسه همینجا متوقف می‌شود
const { checkEnv } = require('./utils/envCheck');
checkEnv();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

const { init, db }                           = require('./db/database');
const { startAllCrons, runStartupChecks }    = require('./utils/cron');
const { takeBackup }                         = require('./utils/backup');
const { alertStartup, alertShutdown }        = require('./utils/alerts');
const { generalLimiter, authLimiter, paymentLimiter } = require('./middleware/rateLimiters');

const authRoutes         = require('./routes/auth');
const walletRoutes       = require('./routes/wallet');
const paymentRoutes      = require('./routes/payment');
const serverRoutes       = require('./routes/server');
const supportRoutes      = require('./routes/support');
const adminRoutes        = require('./routes/admin');
const subscriptionRoutes = require('./routes/subscription');
const healthRoutes       = require('./routes/health');

// ── دیتابیس ──────────────────────────────────────────────────────────────────
init();

const app = express();
app.set('trust proxy', 1);
// جلوگیری از افشای اینکه بک‌اند با Express ساخته شده
app.disable('x-powered-by');

// ── هدرهای امنیتی (CSP خاموش چون این یک API است، نه یک سایت با HTML) ────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

const allowedOrigins = (process.env.FRONTEND_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '100kb' }));
app.use(generalLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ success: true, message: 'AteosCraft backend 🚀' }));

// Health check — بدون rate limit تا monitoring tool‌ها بتوانند آزادانه بزنند
app.use('/health', healthRoutes);

app.use('/api/auth',         authLimiter,    authRoutes);
app.use('/api/wallet',       paymentLimiter, walletRoutes);
app.use('/api/payment',      paymentLimiter, paymentRoutes);
app.use('/api/server',                       serverRoutes);
app.use('/api/support',                      supportRoutes);
app.use('/api/admin',                        adminRoutes);
app.use('/api/subscription',                 subscriptionRoutes);

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'مسیر یافت نشد' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ success: false, message: 'خطای داخلی سرور' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, async () => {
  console.log(`✅ AteosCraft backend روی پورت ${PORT}`);

  await runStartupChecks();
  startAllCrons();

  await alertStartup(`سرور روی پورت ${PORT} راه‌اندازی شد ✅`);
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
// هنگام SIGTERM (pm2 stop / docker stop) یا SIGINT (Ctrl+C):
//   1. اتصال‌های جدید قبول نمی‌شود
//   2. یک backup سریع از DB گرفته می‌شود
//   3. Connection‌های موجود بسته می‌شوند
//   4. SQLite بسته می‌شود
//   5. alert shutdown ارسال می‌شود
//   6. پروسه خارج می‌شود

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 [shutdown] سیگنال ${signal} دریافت شد — خاموش شدن graceful ...`);

  // 1. قبول نکردن اتصال‌های جدید
  server.close(async () => {
    console.log('🔌 [shutdown] HTTP server بسته شد');

    try {
      // 2. backup اضطراری
      console.log('💾 [shutdown] backup قبل از خاموش شدن ...');
      await takeBackup('shutdown');
    } catch (err) {
      console.error('[shutdown] backup ناموفق:', err.message);
    }

    // 3. بستن SQLite
    try {
      db.close();
      console.log('🗄  [shutdown] SQLite بسته شد');
    } catch (err) {
      console.error('[shutdown] خطا در بستن DB:', err.message);
    }

    // 4. alert
    await alertShutdown(`سرور با سیگنال ${signal} خاموش شد`).catch(() => {});

    console.log('👋 [shutdown] کامل شد');
    process.exit(0);
  });

  // اگر بعد از 15 ثانیه هنوز باز است، اجباری خارج شو
  setTimeout(() => {
    console.error('⏱  [shutdown] timeout — خروج اجباری');
    process.exit(1);
  }, 15_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// خطاهای uncaught — log کن ولی سرور را نکش
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
