// utils/rconQueue.js
// ─────────────────────────────────────────────────────────────────────────────
// صف دائمی دستورات RCON — با alert برای failed items
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { db }          = require('../db/database');
const { runCommands } = require('./rcon');
const { addLog }      = require('./logger');
const { alertRconFail } = require('./alerts');

const MAX_ATTEMPTS    = 3;
const BACKOFF_MINUTES = [1, 5, 15];

// ── prepared statements ──────────────────────────────────────────────────────
const stmtInsert = db.prepare(`
  INSERT INTO rcon_queue (command, mc_username, action, context, status, next_try_at)
  VALUES (?, ?, ?, ?, 'pending', datetime('now'))
`);

const stmtPickPending = db.prepare(`
  SELECT * FROM rcon_queue
  WHERE status = 'pending' AND next_try_at <= datetime('now')
  ORDER BY id ASC
  LIMIT 20
`);

const stmtMarkProcessing = db.prepare(`
  UPDATE rcon_queue SET status = 'processing' WHERE id = ? AND status = 'pending'
`);

const stmtMarkDone = db.prepare(`
  UPDATE rcon_queue SET status = 'done', attempts = attempts + 1 WHERE id = ?
`);

const stmtMarkRetry = db.prepare(`
  UPDATE rcon_queue
  SET status     = 'pending',
      attempts   = attempts + 1,
      last_error = ?,
      next_try_at = datetime('now', ? || ' minutes')
  WHERE id = ?
`);

const stmtMarkFailed = db.prepare(`
  UPDATE rcon_queue
  SET status     = 'failed',
      attempts   = attempts + 1,
      last_error = ?
  WHERE id = ?
`);

const stmtCountPending = db.prepare(`
  SELECT COUNT(*) c FROM rcon_queue WHERE status IN ('pending','processing')
`);

// اگر آیتم صف به یک خرید (purchases.id) مرتبط باشد، بعد از موفقیت/شکست نهایی
// وضعیت آن خرید هم به‌روزرسانی می‌شود — دیگر برای همیشه "pending" نمی‌ماند
const stmtUpdatePurchaseStatus = db.prepare(`
  UPDATE purchases SET status = ?, rcon_result = ? WHERE id = ?
`);

function syncPurchaseStatus(ctx, status, resultObj) {
  if (!ctx || !ctx.purchase_id) return;
  try {
    stmtUpdatePurchaseStatus.run(status, JSON.stringify(resultObj), ctx.purchase_id);
  } catch (e) {
    console.error('[rconQueue] خطا در sync وضعیت purchase:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function enqueue({ command, mc_username, action, context = {} }) {
  const result = stmtInsert.run(command, mc_username, action, JSON.stringify(context));
  addLog({
    user_id:  context.user_id || null,
    username: context.username || null,
    type:     'rcon',
    detail:   `[QUEUE] ${action.toUpperCase()} ${mc_username} — در صف قرار گرفت (id=${result.lastInsertRowid})`,
  });
  return result.lastInsertRowid;
}

async function processQueue() {
  const items = stmtPickPending.all();
  if (!items.length) return { processed: 0, succeeded: 0, failed: 0 };

  let succeeded = 0;
  let failed    = 0;

  for (const item of items) {
    const claimed = stmtMarkProcessing.run(item.id);
    if (claimed.changes === 0) continue;

    const ctx = (() => { try { return JSON.parse(item.context || '{}'); } catch { return {}; } })();

    const result = await runCommands([item.command]);

    if (result.success) {
      stmtMarkDone.run(item.id);
      succeeded++;
      syncPurchaseStatus(ctx, 'active', result);
      addLog({
        user_id:  ctx.user_id || null,
        username: ctx.username || null,
        type:     'rcon',
        detail:   `[QUEUE OK] ${item.action.toUpperCase()} ${item.mc_username} — "${item.command}" ✅`,
      });
    } else {
      const nextAttempt = item.attempts + 1;

      if (nextAttempt >= MAX_ATTEMPTS) {
        stmtMarkFailed.run(result.error, item.id);
        failed++;
        syncPurchaseStatus(ctx, 'failed', result);
        addLog({
          user_id:  ctx.user_id || null,
          username: ctx.username || null,
          type:     'error',
          detail:   `[QUEUE FAILED] ${item.action.toUpperCase()} ${item.mc_username} — بعد از ${MAX_ATTEMPTS} تلاش: ${result.error}`,
        });
        // 🚨 alert ارسال کن
        await alertRconFail({
          command:    item.command,
          mcUsername: item.mc_username,
          attempts:   MAX_ATTEMPTS,
          error:      result.error,
        });
      } else {
        const backoff = BACKOFF_MINUTES[nextAttempt] ?? 15;
        stmtMarkRetry.run(result.error, String(backoff), item.id);
        addLog({
          user_id:  ctx.user_id || null,
          username: ctx.username || null,
          type:     'rcon',
          detail:   `[QUEUE RETRY ${nextAttempt}/${MAX_ATTEMPTS}] ${item.mc_username} — ${result.error} — retry بعد از ${backoff} دقیقه`,
        });
      }
    }
  }

  return { processed: items.length, succeeded, failed };
}

function pendingCount() {
  return stmtCountPending.get().c;
}

module.exports = { enqueue, processQueue, pendingCount };
