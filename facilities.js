const router = require('express').Router();
const { db, audit } = require('../database');
const { requireRole, canWriteFacility } = require('../middleware/auth');
const { str, date, oneOf, wrap, ApiError } = require('../middleware/validate');

const today = () => new Date().toISOString().slice(0, 10);
const LIST_SQL = `SELECT f.*, b.total AS beds_total, b.occupied AS beds_occupied, b.out_of_service AS beds_oos,
  (SELECT count FROM footfall WHERE facility_id=f.id AND date=?) AS footfall_today
  FROM facilities f LEFT JOIN beds b ON b.facility_id=f.id`;

router.get('/', wrap((req, res) => {
  let sql = LIST_SQL + ' WHERE 1=1'; const p = [today()];
  if (req.query.type) { sql += ' AND f.type=?'; p.push(oneOf(req.query.type, 'type', ['PHC', 'CHC'])); }
  res.json(db.prepare(sql + ' ORDER BY f.name').all(...p));
}));

router.get('/:id', wrap((req, res) => {
  const f = db.prepare(LIST_SQL + ' WHERE f.id=?').get(today(), req.params.id);
  if (!f) throw new ApiError(404, 'NOT_FOUND', 'Centre not found.');
  res.json(f);
}));

const coord = (v, lim) => { if (v === '' || v == null) return null; const n = Number(v); if (isNaN(n) || Math.abs(n) > lim) throw new ApiError(400, 'VALIDATION_ERROR', 'Latitude/longitude are invalid.'); return n; };
const body = b => ({ name: str(b.name, 'Name'), type: oneOf(b.type, 'Type', ['PHC', 'CHC']),
  district: str(b.district || 'Demo District (Fictional)', 'District'), lat: coord(b.lat, 90), lng: coord(b.lng, 180) });

router.post('/', requireRole('district_admin'), wrap((req, res) => {
  const f = body(req.body);
  const id = db.transaction(() => {
    const id = db.prepare('INSERT INTO facilities(name,type,district,lat,lng,last_report_date) VALUES(?,?,?,?,?,?)').run(f.name, f.type, f.district, f.lat, f.lng, today()).lastInsertRowid;
    db.prepare('INSERT INTO beds(facility_id,total,occupied,out_of_service) VALUES(?,?,?,?)').run(id, f.type === 'CHC' ? 30 : 6, 0, 0);
    return id;
  })();
  audit(req.user.id, 'create', 'facility', { id, ...f });
  res.status(201).json({ id, ...f });
}));

router.put('/:id', requireRole('district_admin'), wrap((req, res) => {
  const f = body(req.body);
  const r = db.prepare('UPDATE facilities SET name=?,type=?,district=?,lat=?,lng=? WHERE id=?').run(f.name, f.type, f.district, f.lat, f.lng, req.params.id);
  if (!r.changes) throw new ApiError(404, 'NOT_FOUND', 'Centre not found.');
  audit(req.user.id, 'update', 'facility', { id: req.params.id, ...f });
  res.json({ id: Number(req.params.id), ...f });
}));

router.delete('/:id', requireRole('district_admin'), wrap((req, res) => {
  const r = db.prepare('DELETE FROM facilities WHERE id=?').run(req.params.id);
  if (!r.changes) throw new ApiError(404, 'NOT_FOUND', 'Centre not found.');
  audit(req.user.id, 'delete', 'facility', { id: req.params.id });
  res.json({ ok: true });
}));

// Mark the centre's periodic report as updated (feeds the "report not updated" alert rule)
router.post('/:id/report', wrap((req, res) => {
  if (!canWriteFacility(req.user, req.params.id)) throw new ApiError(403, 'FORBIDDEN', 'You cannot update this centre.');
  db.prepare('UPDATE facilities SET last_report_date=? WHERE id=?').run(date(req.body.date || today(), 'Date'), req.params.id);
  audit(req.user.id, 'report_update', 'facility', { id: req.params.id });
  res.json({ ok: true });
}));
module.exports = router;
