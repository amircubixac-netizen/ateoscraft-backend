// utils/backup.js
// ─────────────────────────────────────────────────────────────────────────────
// سیستم backup خودکار برای SQLite
//
// SQLite در WAL mode از hot-backup پشتیبانی می‌کند.
// از API داخلی better-sqlite3 (.backup) استفاده می‌کنیم که:
//   - atomic و consistent است
//   - نیازی به قطع اتصال ندارد
//   - هیچ داده‌ای از دست نمی‌رود
//
// فایل‌های backup:
//   /data/backups/data_YYYY-MM-DD.sqlite
//   /data/backups/data_YYYY-MM-DD_HH-mm.sqlite  (اگر hourly فعال باشد)
//
// Retention: فایل‌های قدیمی‌تر از BACKUP_KEEP_DAYS روز حذف می‌شوند
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const path = require('path');
const fs   = require('fs');
const { db } = require('../db/database');
require('dotenv').config();

const BACKUP_DIR      = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const BACKUP_KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10);

// مطمئن شو پوشه backup وجود دارد
function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`📁 پوشه backup ساخته شد: ${BACKUP_DIR}`);
  }
}

/**
 * یک backup می‌گیرد و مسیر فایل را برمی‌گرداند.
 * @param {string} [suffix] - پسوند اختیاری برای نام فایل
 * @returns {Promise<string>} مسیر فایل backup
 */
async function takeBackup(suffix = '') {
  ensureDir();
  const now    = new Date();
  const date   = now.toISOString().slice(0, 10);           // YYYY-MM-DD
  const time   = now.toTimeString().slice(0, 5).replace(':', '-'); // HH-mm
  const tag    = suffix ? `_${suffix}` : `_${time}`;
  const fname  = `data_${date}${tag}.sqlite`;
  const dest   = path.join(BACKUP_DIR, fname);

  await db.backup(dest);
  const size = fs.statSync(dest).size;
  console.log(`💾 [backup] ${fname} — ${(size / 1024).toFixed(1)} KB`);
  return dest;
}

/**
 * فایل‌های backup قدیمی‌تر از BACKUP_KEEP_DAYS روز را حذف می‌کند.
 */
function pruneOldBackups() {
  ensureDir();
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const file of fs.readdirSync(BACKUP_DIR)) {
    if (!file.endsWith('.sqlite')) continue;
    const full = path.join(BACKUP_DIR, file);
    const mtime = fs.statSync(full).mtimeMs;
    if (mtime < cutoff) {
      fs.unlinkSync(full);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`🗑  [backup] ${removed} فایل قدیمی حذف شد (نگه‌داری: ${BACKUP_KEEP_DAYS} روز)`);
  }
  return removed;
}

/**
 * لیست backup های موجود با اطلاعات آن‌ها
 */
function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sqlite'))
    .map(f => {
      const full  = path.join(BACKUP_DIR, f);
      const stat  = fs.statSync(full);
      return { name: f, path: full, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = { takeBackup, pruneOldBackups, listBackups, BACKUP_DIR };
