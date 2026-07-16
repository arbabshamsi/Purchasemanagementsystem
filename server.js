'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./src/config');
const dbModule = require('./src/db');
const { attachUser } = require('./src/auth');

// Initialise database (schema + seed) before anything else.
dbModule.init();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(attachUser);

// API routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api', require('./src/routes/meta'));
app.use('/api/suppliers', require('./src/routes/suppliers'));
app.use('/api/items', require('./src/routes/items'));
app.use('/api/rate-lists', require('./src/routes/rateLists'));
app.use('/api/purchase-orders', require('./src/routes/purchaseOrders'));
app.use('/api/users', require('./src/routes/users'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback: send index.html for any non-API GET that isn't a static file.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler (covers multer file-size errors etc.).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large (max 5 MB)' });
  }
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const server = app.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`Purchase Management System running on http://${config.host}:${config.port}`);
});

module.exports = { app, server };
