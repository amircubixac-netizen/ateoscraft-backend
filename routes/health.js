// routes/health.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /health
//
// وضعیت کلی سیستم را برمی‌گرداند:
//   - database: وضعیت SQLite
//   - redis: N/A (این پروژه Redis ندارد)
//   - rcon: قابلیت اتصال به RCON
//   - queue: تعداد آیتم‌های pending در صف
//   - uptime: مدت زمان روشن بودن سرور
//
// اگر همه سرویس‌ها سالم باشند: HTTP 200
// اگر هر کدام مشکل داشته باشند: HTTP 503
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router  = express.Router();
const { db }            = require('../db/database');
const { testConnection } = require('../utils/rcon');
const { pendingCount }  = require('../utils/rconQueue');

router.get('/', async (_req, res) => {
  const checks = {};
  let allOk = true;

  // ── Database ─────────────────────────────────────────────────────────────
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
    checks.database = { status: 'ok', users: row.c };
  } catch (err) {
    checks.database = { status: 'error', error: err.message };
    allOk = false;
  }

  // ── RCON ─────────────────────────────────────────────────────────────────
  try {
    const rconResult = await testConnection();
    if (rconResult.success) {
      checks.rcon = { status: 'ok' };
    } else {
      checks.rcon = { status: 'degraded', error: rconResult.error };
      // RCON degraded حساب می‌شود ولی critical نیست — allOk را false نمی‌کنیم
      // چون صف RCON خودش retry می‌کند
    }
  } catch (err) {
    checks.rcon = { status: 'error', error: err.message };
  }

  // ── Queue ─────────────────────────────────────────────────────────────────
  try {
    const pending = pendingCount();
    checks.queue = {
      status: pending > 100 ? 'warning' : 'ok',
      pending,
    };
    if (pending > 100) allOk = false;
  } catch (err) {
    checks.queue = { status: 'error', error: err.message };
    allOk = false;
  }

  // ── System ────────────────────────────────────────────────────────────────
  const memMB = process.memoryUsage().rss / 1024 / 1024;
  checks.system = {
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(memMB),
    node_version: process.version,
    env: process.env.NODE_ENV || 'development',
  };

  const httpStatus = allOk ? 200 : 503;
  return res.status(httpStatus).json({
    success: allOk,
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

module.exports = router;
