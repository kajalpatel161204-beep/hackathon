class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bad = m => new ApiError(400, 'VALIDATION_ERROR', m);
const int = (v, name, { min = 0, max = 1e9, required = true } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required.`); return undefined; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
};
const str = (v, name, { max = 120, required = true } = {}) => {
  const s = (v ?? '').toString().trim();
  if (!s) { if (required) throw bad(`${name} is required.`); return null; }
  if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return s;
};
const date = (v, name, required = true) => {
  if (!v) { if (required) throw bad(`${name} is required.`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v))) throw bad(`${name} must be a valid date (YYYY-MM-DD).`);
  return v;
};
const oneOf = (v, name, list) => { if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}.`); return v; };
// wrap route handlers so thrown errors reach the error middleware
const wrap = fn => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
module.exports = { ApiError, int, str, date, oneOf, wrap };
