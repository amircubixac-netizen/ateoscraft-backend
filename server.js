// routes/server.js
const express = require('express');
const { db } = require('../db/database');
const { runCommands } = require('../utils/rcon');

const router = express.Router();
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const countUsers = db.prepare('SELECT COUNT(*) as c FROM users');

// ── GET /api/server/status ──
router.get('/status', async (req, res) => {
  const ipSetting = getSetting.get('server_ip');
  const ip = ipSetting ? ipSetting.value : (process.env.MC_SERVER_IP || 'play.ateoscraft.ir');

  let players = 0;
  try {
    const result = await runCommands(['list']);
    if (result.success && result.results?.[0]) {
      // مثال خروجی: "There are 5 of a max of 50 players online: ..."
      const match = result.results[0].match(/There are (\d+)/i);
      if (match) players = parseInt(match[1], 10);
    }
  } catch (_) { /* سرور آفلاینه، صفر برمی‌گردونیم */ }

  const usersCount = countUsers.get().c;

  res.json({
    success: true,
    ip,
    players: { smp: players },
    total_users: usersCount
  });
});

module.exports = router;
