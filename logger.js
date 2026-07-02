// utils/logger.js
'use strict';
const { db } = require('../db/database');

const stmtInsert = db.prepare(`
  INSERT INTO logs (user_id, username, type, detail, ip_address)
  VALUES (@user_id, @username, @type, @detail, @ip_address)
`);

function addLog({ user_id = null, username = null, type, detail = '', ip_address = null }) {
  try {
    stmtInsert.run({ user_id, username, type, detail, ip_address });
  } catch (e) {
    console.error('[logger]', e.message);
  }
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

module.exports = { addLog, getClientIp };
