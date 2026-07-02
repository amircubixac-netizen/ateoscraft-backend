// routes/subscription.js
'use strict';
const express      = require('express');
const { requireAuth } = require('../middleware/auth');
const { getStatus }   = require('../utils/subscription');

const router = express.Router();

// GET /api/subscription/status
router.get('/status', requireAuth, (req, res) => {
  try {
    const status = getStatus(req.user.id);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطا در دریافت وضعیت سابسکریپشن' });
  }
});

module.exports = router;
