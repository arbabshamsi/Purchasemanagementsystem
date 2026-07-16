'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/companies — the purchasing entities (Paramount, AiA)
router.get('/companies', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM companies ORDER BY name').all();
  res.json({ companies: rows });
});

module.exports = router;
