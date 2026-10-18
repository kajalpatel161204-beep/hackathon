const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db, audit } = require('../database');
const { sign, authenticate } = require('../middleware/auth');
const { str, ApiError, wrap } = require('../middleware/validate');

const attempts = new Map(); // tiny brute-force guard: 8 tries / 10 min / username
router.post('/login', wrap((req, res) => {
  const username = str(req.body.username, 'Username', { max: 50 }), password = str(req.body.password, 'Password', { max: 100 });
  const rec = attempts.get(username) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 600000) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 8) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again in 10 minutes.');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) { rec.n++; attempts.set(username, rec); throw new ApiError(401, 'BAD_CREDENTIALS', 'Incorrect username or password.'); }
  attempts.delete(username);
  audit(u.id, 'login', 'user', { username });
  res.json({ token: sign(u), user: { id: u.id, name: u.full_name, role: u.role, facility_id: u.facility_id } });
}));
router.get('/me', authenticate, (req, res) => res.json({ user: req.user }));
module.exports = router;
