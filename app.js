require('dotenv').config();
const express = require('express');
const path = require('path');
const { seed } = require('./database');
const { authenticate } = require('./middleware/auth');

seed(); // auto-seed fictional data on first run
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); next(); });
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', require('./routes/auth'));
const protectedRoutes = { facilities: 'facilities', inventory: 'inventory', patients: 'patients', beds: 'beds', attendance: 'attendance',
  diagnostics: 'diagnostics', forecasts: 'forecasts', transfers: 'transfers', alerts: 'alerts' };
for (const [p, f] of Object.entries(protectedRoutes)) app.use('/api/' + p, authenticate, require('./routes/' + f));

app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } }));
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err.code && String(err.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: { code: 'CONSTRAINT', message: 'Data conflicts with an existing record or a rule (e.g. duplicate, or invalid count).' } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON body.' } });
  console.error(err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on the server.' } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SwasthyaSetu AI running at http://localhost:${PORT}  (all data is FICTIONAL demo data)`));
