const router = require('express').Router();
const { db, audit, getSettings } = require('../database');
const { requireRole, canWriteFacility } = require('../middleware/auth');
const { int, str, date, oneOf, wrap, ApiError } = require('../middleware/validate');

// Average daily use (last 14 days), days of stock remaining, and stock-out warning vs lead time.
function enrich(m, s = getSettings()) {
  const c = db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM medicine_txns WHERE medicine_id=? AND type='consume' AND created_at>=datetime('now','-14 days')`).get(m.id).q;
  const avg = c / 14;
  const daysLeft = avg > 0 ? Math.round((m.stock / avg) * 10) / 10 : null;
  const expDays = m.expiry_date ? Math.ceil((new Date(m.expiry_date) - new Date(new Date().toISOString().slice(0, 10))) / 864e5) : null;
  return { ...m, avg_daily_use: Math.round(avg * 10) / 10, days_remaining: daysLeft,
    low_stock: m.stock <= m.min_stock,
    stockout_warning: daysLeft !== null && daysLeft < m.lead_time_days,
    critical: m.essential === 1 && daysLeft !== null && daysLeft <= s.critical_cover_days,
    expiry_days: expDays, expiry_soon: expDays !== null && expDays >= 0 && expDays <= s.expiry_warning_days, expired: expDays !== null && expDays < 0 };
}

router.get('/', wrap((req, res) => {
  let sql = `SELECT m.*, f.name AS facility_name FROM medicines m JOIN facilities f ON f.id=m.facility_id WHERE 1=1`; const p = [];
  if (req.query.facility_id) { sql += ' AND m.facility_id=?'; p.push(req.query.facility_id); }
  if (req.query.q) { sql += ' AND (m.name LIKE ? OR m.batch_no LIKE ?)'; p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  if (req.query.category) { sql += ' AND m.category=?'; p.push(req.query.category); }
  let rows = db.prepare(sql + ' ORDER BY f.name, m.name').all(...p).map(m => enrich(m));
  const f = req.query.filter;
  if (f === 'low') rows = rows.filter(r => r.low_stock || r.stockout_warning);
  if (f === 'expiry') rows = rows.filter(r => r.expiry_soon || r.expired);
  if (f === 'critical') rows = rows.filter(r => r.critical);
  res.json(rows);
}));

const body = b => ({ facility_id: int(b.facility_id, 'Centre', { min: 1 }), name: str(b.name, 'Medicine name'), category: str(b.category, 'Category', { required: false }),
  essential: b.essential ? 1 : 0, unit: str(b.unit || 'tablets', 'Unit', { max: 20 }), stock: int(b.stock, 'Stock', { max: 1e7 }),
  min_stock: int(b.min_stock, 'Minimum stock', { max: 1e7 }), lead_time_days: int(b.lead_time_days ?? 7, 'Lead time (days)', { max: 180 }),
  batch_no: str(b.batch_no, 'Batch number', { max: 40, required: false }), expiry_date: date(b.expiry_date, 'Expiry date', false) });
const guard = (req, fid) => { if (!canWriteFacility(req.user, fid)) throw new ApiError(403, 'FORBIDDEN', 'You can only modify your own centre.'); };
const W = requireRole('district_admin', 'facility_manager');

router.post('/', W, wrap((req, res) => {
  const m = body(req.body); guard(req, m.facility_id);
  const id = db.prepare(`INSERT INTO medicines(facility_id,name,category,essential,unit,stock,min_stock,lead_time_days,batch_no,expiry_date) VALUES(@facility_id,@name,@category,@essential,@unit,@stock,@min_stock,@lead_time_days,@batch_no,@expiry_date)`).run(m).lastInsertRowid;
  audit(req.user.id, 'create', 'medicine', { id, ...m });
  res.status(201).json(enrich(db.prepare('SELECT * FROM medicines WHERE id=?').get(id)));
}));

router.put('/:id', W, wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM medicines WHERE id=?').get(req.params.id);
  if (!cur) throw new ApiError(404, 'NOT_FOUND', 'Medicine not found.');
  guard(req, cur.facility_id);
  const m = body({ ...req.body, facility_id: cur.facility_id });
  db.prepare(`UPDATE medicines SET name=@name,category=@category,essential=@essential,unit=@unit,stock=@stock,min_stock=@min_stock,lead_time_days=@lead_time_days,batch_no=@batch_no,expiry_date=@expiry_date WHERE id=@id`).run({ ...m, id: cur.id });
  audit(req.user.id, 'update', 'medicine', { id: cur.id, ...m });
  res.json(enrich(db.prepare('SELECT * FROM medicines WHERE id=?').get(cur.id)));
}));

router.delete('/:id', W, wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM medicines WHERE id=?').get(req.params.id);
  if (!cur) throw new ApiError(404, 'NOT_FOUND', 'Medicine not found.');
  guard(req, cur.facility_id);
  db.prepare('DELETE FROM medicines WHERE id=?').run(cur.id);
  audit(req.user.id, 'delete', 'medicine', { id: cur.id, name: cur.name });
  res.json({ ok: true });
}));

// Record stock received/consumed atomically; consumption can never exceed current stock.
router.post('/:id/transactions', W, wrap((req, res) => {
  const type = oneOf(req.body.type, 'Type', ['receive', 'consume']);
  const qty = int(req.body.qty, 'Quantity', { min: 1, max: 1e7 });
  const note = str(req.body.note, 'Note', { max: 200, required: false });
  const out = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM medicines WHERE id=?').get(req.params.id);
    if (!cur) throw new ApiError(404, 'NOT_FOUND', 'Medicine not found.');
    guard(req, cur.facility_id);
    if (type === 'consume' && qty > cur.stock) throw new ApiError(400, 'INSUFFICIENT_STOCK', `Only ${cur.stock} ${cur.unit} in stock; cannot consume ${qty}.`);
    db.prepare('UPDATE medicines SET stock=stock+? WHERE id=?').run(type === 'receive' ? qty : -qty, cur.id);
    db.prepare('INSERT INTO medicine_txns(medicine_id,type,qty,note,user_id) VALUES(?,?,?,?,?)').run(cur.id, type, qty, note, req.user.id);
    return db.prepare('SELECT * FROM medicines WHERE id=?').get(cur.id);
  })();
  audit(req.user.id, type, 'medicine', { id: out.id, qty });
  res.status(201).json(enrich(out));
}));

router.get('/:id/transactions', wrap((req, res) =>
  res.json(db.prepare('SELECT * FROM medicine_txns WHERE medicine_id=? ORDER BY created_at DESC, id DESC LIMIT 100').all(req.params.id))));

module.exports = router; module.exports.enrich = enrich;
