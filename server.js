'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./src/config');
const { ensureReady } = require('./src/db');
const { attachUser } = require('./src/auth');

const app = express();
app.set('trust proxy', 1); // behind Vercel's proxy
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check — no database dependency, so it works even before DATABASE_URL
// is configured. Useful to confirm the deployment itself is healthy.
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    hasDb: !!(
      (config.supabaseUrl && config.supabaseServiceKey) ||
      config.databaseUrl ||
      config.supabaseDbPassword
    ),
    dbMode:
      config.supabaseUrl && config.supabaseServiceKey
        ? 'supabase-service-key'
        : config.supabaseDbPassword
        ? 'supabase-pieces'
        : config.databaseUrl
        ? 'database-url'
        : 'none',
    time: new Date().toISOString(),
  })
);

// Ensure the database schema + seed exist before handling API calls.
// Memoised in db.js, so this is effectively a no-op after the first request.
app.use('/api', async (req, res, next) => {
  try {
    await ensureReady();
    next();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db-init]', err.message);
    res.status(503).json({ error: 'Database is not reachable. Check the DATABASE_URL configuration.' });
  }
});

app.use('/api', attachUser);

// API routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api', require('./src/routes/meta'));
app.use('/api/vendors', require('./src/routes/vendors'));
app.use('/api/price-list', require('./src/routes/priceList'));
app.use('/api/requisitions', require('./src/routes/requisitions'));
app.use('/api/users', require('./src/routes/users'));

// Static frontend (used for local dev; on Vercel static files are served by the CDN).
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err && err.message);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large (max 5 MB)' });
  }
  res.status((err && err.status) || 500).json({ error: (err && err.message) || 'Server error' });
});

// Only start a listener when run directly (local dev). On Vercel the app is
// imported by api/index.js and invoked per-request.
if (require.main === module) {
  app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`Purchase Management System running on http://${config.host}:${config.port}`);
  });
}

module.exports = { app };
