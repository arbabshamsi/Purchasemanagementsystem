'use strict';

// Vercel serverless entry point. Vercel routes /api/* here (see vercel.json)
// and invokes the exported Express app per request.
const { app } = require('../server');

module.exports = app;
