// utils/cron.js
// ─────────────────────────────────────────────────────────────────────────────
// Cron jobs:
//
// 1) هر 30 ثانیه: پردازش صف RCON
// 2) هر 5 دقیقه:  انقضای سابسکریپشن‌ها
// 3) هر 10 دقیقه: sync وایت‌لیست
// 4) هر 24 ساعت:  backup روزانه + پاکسازی بک‌آپ‌های قدیمی
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const cron = require('node-cron');
const { db }                       = require('../db/database');
const { enqueue, processQueue }    = require('./rconQueue');
const { fetchWhitelistFromServer } = require('./rcon');
const { addLog }                   = require('./logger');
const { takeBackup, pruneOldBackups } = require('./backup');
const { alertQueueFail, alertStartup, alertShutdown } = require('./alerts');

// ── Prepared statements ──────────────────────────────────────────────────────
const stmtExpired = db.prepare(`
  SELECT s.*, u.username
  FROM subscriptions s
  LEFT JOIN users u ON u.id = s.user_id
  WHERE s.active = 1 AND s.expire_date <= datetime('now')
`);

const stmtDeactivate = db.prepare(`
  UPDATE subscriptions
  SET active = 0, updated_at = datetime('now')
  WHERE id = ?
`);

const stmtActiveSubs = db.prepare(`
  SELECT mc_username FROM subscriptions
  WHERE active = 1 AND expire_date > datetime('now')
`);

// ─────────────────────────────────────────────────────────────────────────────
// 1. انقضای سابسکریپشن‌ها
// ─────────────────────────────────────────────────────────────────────────────
async function runExpiryCheck() {
  const expired = stmtExpired.all();
  if (!expired.length) return 0;

  for (const sub of expired) {
    stmtDeactivate.run(sub.id);

    enqueue({
      command:     `whitelist remove ${sub.mc_username}`,
      mc_username: sub.mc_username,
      action:      'remove',
      context: {
        user_id:  sub.user_id,
        username: sub.username || null,
        reason:   'subscription_expired',
      },
    });

    addLog({
      user_id:  sub.user_id,
      username: sub.username || null,
      type:     'admin',
      detail:   `سابسکریپشن "${sub.mc_username}" منقضی شد — whitelist remove در صف قرار گرفت`,
    });
  }

  console.log(`🕐 [cron:expiry] ${expired.length} سابسکریپشن منقضی شد`);
  return expired.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. sync وایت‌لیست
// ─────────────────────────────────────────────────────────────────────────────
async function runWhitelistSync() {
  const serverList = await fetchWhitelistFromServer();
  if (serverList === null) {
    addLog({ type: 'error', detail: '[sync] RCON در دسترس نبود — sync رد شد' });
    return;
  }

  const serverSet = new Set(serverList.map(u => u.toLowerCase()));
  const dbActive  = stmtActiveSubs.all().map(r => r.mc_username);
  const dbSet     = new Set(dbActive.map(u => u.toLowerCase()));

  let added = 0, removed = 0;

  for (const mc of dbActive) {
    if (!serverSet.has(mc.toLowerCase())) {
      enqueue({ command: `whitelist add ${mc}`, mc_username: mc, action: 'add', context: { reason: 'sync_repair' } });
      added++;
    }
  }

  for (const mc of serverList) {
    if (!dbSet.has(mc.toLowerCase())) {
      enqueue({ command: `whitelist remove ${mc}`, mc_username: mc, action: 'remove', context: { reason: 'sync_cleanup' } });
      removed++;
    }
  }

  if (added || removed) {
    addLog({ type: 'admin', detail: `[sync] اصلاح وایت‌لیست: +${added} add / -${removed} remove در صف قرار گرفت` });
    console.log(`🔄 [cron:sync] +${added} add, -${removed} remove`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. backup روزانه
// ─────────────────────────────────────────────────────────────────────────────
async function runDailyBackup() {
  try {
    const dest = await takeBackup('daily');
    pruneOldBackups();
    addLog({ type: 'admin', detail: `[backup] روزانه انجام شد: ${dest}` });
  } catch (err) {
    console.error('[cron:backup] خطا:', err.message);
    addLog({ type: 'error', detail: `[backup] خطا: ${err.message}` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// راه‌اندازی همه cron job‌ها
// ─────────────────────────────────────────────────────────────────────────────
function startAllCrons() {
  // --- صف RCON هر 30 ثانیه ---
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const r = await processQueue();
      if (r.processed > 0) {
        console.log(`⚙️  [cron:queue] ${r.processed} آیتم — ✅${r.succeeded} ❌${r.failed}`);
        // alert اگر تعداد failed زیاد بود
        if (r.failed > 0) {
          await alertQueueFail({ processed: r.processed, failed: r.failed, error: `${r.failed} آیتم failed شد` });
        }
      }
    } catch (err) {
      console.error('[cron:queue] خطا:', err.message);
      await alertQueueFail({ processed: 0, failed: 0, error: err.message });
    }
  });

  // --- انقضا هر 5 دقیقه ---
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runExpiryCheck();
    } catch (err) {
      console.error('[cron:expiry] خطا:', err.message);
      addLog({ type: 'error', detail: `[cron:expiry] ${err.message}` });
    }
  });

  // --- sync هر 10 دقیقه ---
  cron.schedule('*/10 * * * *', async () => {
    try {
      await runWhitelistSync();
    } catch (err) {
      console.error('[cron:sync] خطا:', err.message);
      addLog({ type: 'error', detail: `[cron:sync] ${err.message}` });
    }
  });

  // --- backup روزانه ساعت 03:00 ---
  cron.schedule('0 3 * * *', async () => {
    await runDailyBackup();
  });

  console.log('✅ cron jobها فعال شدند (queue:30s / expiry:5m / sync:10m / backup:03:00)');
}

// ─────────────────────────────────────────────────────────────────────────────
// startup checks
// ─────────────────────────────────────────────────────────────────────────────
async function runStartupChecks() {
  console.log('🔍 startup checks ...');
  try { await runExpiryCheck(); }  catch (e) { console.error('[startup:expiry]', e.message); }
  try { await processQueue();   }  catch (e) { console.error('[startup:queue]',  e.message); }
  try { await runWhitelistSync(); } catch (e) { console.error('[startup:sync]',   e.message); }
  console.log('✅ startup checks تمام شد');
}

module.exports = {
  startAllCrons,
  runStartupChecks,
  runExpiryCheck,
  runWhitelistSync,
  runDailyBackup,
  alertShutdown,
};
