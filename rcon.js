// utils/rcon.js
'use strict';
const { Rcon } = require('rcon-client');
require('dotenv').config();

const HOST     = process.env.MC_RCON_HOST     || '127.0.0.1';
const PORT     = parseInt(process.env.MC_RCON_PORT || '25575', 10);
const PASSWORD = process.env.MC_RCON_PASSWORD || '';
const TIMEOUT  = 6000;

/**
 * یک یا چند دستور را روی سرور ماینکرافت اجرا می‌کند.
 * اتصال بعد از هر بار بسته می‌شود.
 * @param {string[]} commands
 * @returns {Promise<{success:boolean, results?:string[], error?:string}>}
 */
async function runCommands(commands) {
  let rcon;
  try {
    rcon = await Rcon.connect({ host: HOST, port: PORT, password: PASSWORD, timeout: TIMEOUT });
    const results = [];
    for (const cmd of commands) {
      results.push(await rcon.send(cmd));
    }
    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (rcon) try { await rcon.end(); } catch (_) { /* ignore */ }
  }
}

/**
 * دستورات یک آیتم را با جایگزینی {username} اجرا می‌کند.
 * @param {string[]} templates
 * @param {string}   mcUsername
 */
async function executeItemCommands(templates, mcUsername) {
  return runCommands(templates.map(c => c.replaceAll('{username}', mcUsername)));
}

/**
 * دریافت لیست whitelist واقعی سرور.
 * خروجی: آرایه‌ای از نام‌های کاربری یا null در صورت خطا.
 */
async function fetchWhitelistFromServer() {
  const result = await runCommands(['whitelist list']);
  if (!result.success) return null;

  const raw = result.results?.[0] || '';
  // خروجی معمول: "There are N whitelisted players: Steve, Alex, ..."
  const match = raw.match(/:\s*(.+)$/);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * تست اتصال RCON.
 */
async function testConnection() {
  return runCommands(['list']);
}

module.exports = { runCommands, executeItemCommands, fetchWhitelistFromServer, testConnection };
