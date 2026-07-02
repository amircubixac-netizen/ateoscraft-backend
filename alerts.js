// utils/alerts.js
// ─────────────────────────────────────────────────────────────────────────────
// سیستم alert برای خطاهای critical
// ارسال webhook به Discord (یا هر URL دیگری)
//
// نحوه استفاده:
//   await sendAlert({ level: 'critical', title: 'Payment Failed', body: '...' })
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const axios = require('axios');
require('dotenv').config();

const WEBHOOK_URL    = process.env.ALERT_WEBHOOK_URL || '';
const SERVER_NAME    = process.env.SERVER_NAME || 'AteosCraft';
const ALERT_ENABLED  = !!WEBHOOK_URL;

// رنگ‌های Discord embed بر اساس سطح
const COLORS = {
  critical: 0xFF0000,  // قرمز
  warning:  0xFF9900,  // نارنجی
  info:     0x00ADEF,  // آبی
};

/**
 * ارسال alert به Discord Webhook
 * @param {object} opts
 * @param {'critical'|'warning'|'info'} opts.level
 * @param {string} opts.title    - عنوان کوتاه
 * @param {string} opts.body     - توضیحات
 * @param {object} [opts.fields] - فیلدهای اضافی { key: value }
 */
async function sendAlert({ level = 'critical', title, body, fields = {} }) {
  if (!ALERT_ENABLED) {
    console.warn(`[alert] webhook تنظیم نشده — alert رد شد: [${level}] ${title}`);
    return;
  }

  const embed = {
    title: `${levelEmoji(level)} [${SERVER_NAME}] ${title}`,
    description: body,
    color: COLORS[level] ?? COLORS.info,
    timestamp: new Date().toISOString(),
    fields: Object.entries(fields).map(([name, value]) => ({
      name,
      value: String(value),
      inline: true,
    })),
  };

  try {
    await axios.post(WEBHOOK_URL, { embeds: [embed] }, { timeout: 8000 });
  } catch (err) {
    console.error('[alert] خطا در ارسال webhook:', err.message);
  }
}

function levelEmoji(level) {
  return { critical: '🚨', warning: '⚠️', info: 'ℹ️' }[level] ?? '❓';
}

// ── Alert‌های از پیش‌ساخته شده ─────────────────────────────────────────────

async function alertPaymentFail({ userId, username, amount, authority, error }) {
  return sendAlert({
    level: 'critical',
    title: 'Payment Failed',
    body: `پرداخت ناموفق — مبلغ: **${amount?.toLocaleString()} تومان**`,
    fields: {
      'User ID': userId ?? '—',
      'Username': username ?? '—',
      'Authority': authority ?? '—',
      'Error': error ?? '—',
    },
  });
}

async function alertRconFail({ command, mcUsername, attempts, error }) {
  return sendAlert({
    level: 'critical',
    title: 'RCON Command Failed',
    body: `دستور RCON بعد از ${attempts} تلاش ناموفق — **${mcUsername}**`,
    fields: {
      'Command': command ?? '—',
      'Attempts': attempts ?? '—',
      'Error': error ?? '—',
    },
  });
}

async function alertQueueFail({ processed, failed, error }) {
  return sendAlert({
    level: 'critical',
    title: 'Queue Processing Failed',
    body: `خطا در پردازش صف RCON`,
    fields: {
      'Processed': processed ?? '—',
      'Failed': failed ?? '—',
      'Error': error ?? '—',
    },
  });
}

async function alertStartup(message) {
  return sendAlert({ level: 'info', title: 'Server Started', body: message });
}

async function alertShutdown(message) {
  return sendAlert({ level: 'warning', title: 'Server Shutting Down', body: message });
}

module.exports = {
  sendAlert,
  alertPaymentFail,
  alertRconFail,
  alertQueueFail,
  alertStartup,
  alertShutdown,
};
