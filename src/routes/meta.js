'use strict';

const express = require('express');
const { query, S } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/companies — the purchasing entities (Paramount, AiA)
router.get('/companies', requireAuth, async (req, res, next) => {
  try {
    const companies = await query(`SELECT * FROM ${S}.companies ORDER BY name`);
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
