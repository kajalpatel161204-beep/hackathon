// SQLite setup, schema and FICTIONAL demo seed data.
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'swasthyasetu.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('district_admin','facility_manager','viewer')),
    facility_id INTEGER REFERENCES facilities(id));
  CREATE TABLE IF NOT EXISTS facilities(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('PHC','CHC')),
    district TEXT NOT NULL, lat REAL, lng REAL, last_report_date TEXT);
  CREATE TABLE IF NOT EXISTS medicines(
    id INTEGER PRIMARY KEY, facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    name TEXT NOT NULL, category TEXT, essential INTEGER NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT 'tablets',
    stock INTEGER NOT NULL CHECK(stock>=0), min_stock INTEGER NOT NULL CHECK(min_stock>=0),
    lead_time_days INTEGER NOT NULL DEFAULT 7 CHECK(lead_time_days>=0), batch_no TEXT, expiry_date TEXT);
  CREATE TABLE IF NOT EXISTS medicine_txns(
    id INTEGER PRIMARY KEY, medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN('receive','consume','transfer_in','transfer_out','adjust')),
    qty INTEGER NOT NULL CHECK(qty>0), note TEXT, user_id INTEGER, created_at TEXT NOT NULL DEFAULT(datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_txn_med ON medicine_txns(medicine_id, created_at);
  CREATE TABLE IF NOT EXISTS footfall(
    id INTEGER PRIMARY KEY, facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    date TEXT NOT NULL, count INTEGER NOT NULL CHECK(count>=0), UNIQUE(facility_id,date));
  CREATE TABLE IF NOT EXISTS beds(
    facility_id INTEGER PRIMARY KEY REFERENCES facilities(id) ON DELETE CASCADE,
    total INTEGER NOT NULL CHECK(total>=0), occupied INTEGER NOT NULL CHECK(occupied>=0),
    out_of_service INTEGER NOT NULL DEFAULT 0 CHECK(out_of_service>=0), updated_at TEXT DEFAULT(datetime('now')),
    CHECK(occupied+out_of_service<=total));
  CREATE TABLE IF NOT EXISTS doctors(
    id INTEGER PRIMARY KEY, facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    name TEXT NOT NULL, speciality TEXT, shift TEXT NOT NULL DEFAULT 'Morning 9am-2pm');
  CREATE TABLE IF NOT EXISTS attendance(
    id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('present','absent','on_leave')),
    source TEXT NOT NULL DEFAULT 'manual_demo' CHECK(source IN('manual_demo','verified')),
    UNIQUE(doctor_id,date));
  CREATE TABLE IF NOT EXISTS tests(
    id INTEGER PRIMARY KEY, facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    name TEXT NOT NULL, essential INTEGER NOT NULL DEFAULT 1, available INTEGER NOT NULL DEFAULT 1,
    reason TEXT, last_verified TEXT);
  CREATE TABLE IF NOT EXISTS transfers(
    id INTEGER PRIMARY KEY, medicine_name TEXT NOT NULL,
    from_facility_id INTEGER NOT NULL REFERENCES facilities(id), to_facility_id INTEGER NOT NULL REFERENCES facilities(id),
    from_medicine_id INTEGER NOT NULL, to_medicine_id INTEGER NOT NULL, qty INTEGER NOT NULL CHECK(qty>0),
    urgency TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
    decided_by INTEGER, decided_at TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')));
  CREATE TABLE IF NOT EXISTS alerts(
    id INTEGER PRIMARY KEY, alert_key TEXT UNIQUE NOT NULL, facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    type TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN('critical','high','medium','low')),
    reason TEXT NOT NULL, action TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','acknowledged','resolved')),
    assigned_to TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT);
  CREATE TABLE IF NOT EXISTS interventions(
    id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    assignee TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT(datetime('now')));
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_logs(
    id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, entity TEXT, detail TEXT,
    created_at TEXT NOT NULL DEFAULT(datetime('now')));
  `);
}

function reset() {
  db.pragma('foreign_keys = OFF');
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())
    db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  db.pragma('foreign_keys = ON');
  init();
}

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM facilities').get().c) return false;
  const rng = mulberry32(42);
  const today = new Date();
  const day = n => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const future = n => day(-n);

  const FACS = [ // [name,type,lat,lng,lastReportDaysAgo]  -- ALL FICTIONAL
    ['CHC Rampur Kalan', 'CHC', 26.90, 80.95, 0], ['PHC Devpur', 'PHC', 26.84, 80.88, 0],
    ['PHC Madhopur', 'PHC', 26.95, 81.02, 1], ['CHC Shivgarh', 'CHC', 26.78, 81.05, 0],
    ['PHC Nayagaon', 'PHC', 26.88, 81.10, 0], ['PHC Chandpur', 'PHC', 26.72, 80.92, 6],
    ['PHC Kishanpur', 'PHC', 26.98, 80.86, 1], ['CHC Bhawanipur', 'CHC', 26.81, 80.80, 0],
    ['PHC Sultanpur Road', 'PHC', 26.92, 80.78, 0], ['PHC Rampur Khurd', 'PHC', 26.86, 81.00, 2]];
  // name, category, essential, unit, base daily use (PHC), lead time
  const MEDS = [['Paracetamol 500mg', 'Analgesic', 1, 'tablets', 120, 7], ['Amoxicillin 500mg', 'Antibiotic', 1, 'capsules', 40, 7],
    ['ORS Sachets', 'Rehydration', 1, 'sachets', 25, 5], ['Metformin 500mg', 'Antidiabetic', 1, 'tablets', 60, 10],
    ['Amlodipine 5mg', 'Antihypertensive', 1, 'tablets', 50, 10], ['Iron-Folic Acid', 'Supplement', 1, 'tablets', 70, 10],
    ['Oxytocin 10IU', 'Maternal', 1, 'ampoules', 4, 7], ['Cetirizine 10mg', 'Antihistamine', 0, 'tablets', 30, 7]];
  const COVER = { '2:Paracetamol 500mg': 3, '1:Paracetamol 500mg': 85, '2:Amoxicillin 500mg': 4, '4:Amoxicillin 500mg': 90,
    '7:ORS Sachets': 5, '3:ORS Sachets': 70, '6:Oxytocin 10IU': 6 };
  const TESTS = [['Malaria RDT', 1], ['Blood Glucose', 1], ['Haemoglobin', 1], ['Urine Pregnancy Test', 1], ['HIV Rapid Test', 1], ['CBC', 0], ['X-Ray', 0]];
  const DOCS = ['Anil Verma', 'Sunita Rao', 'Ramesh Gupta', 'Priya Nair', 'Imran Sheikh', 'Kavita Joshi', 'Mohan Das', 'Neha Tiwari'];

  db.transaction(() => {
    const insF = db.prepare('INSERT INTO facilities(name,type,district,lat,lng,last_report_date) VALUES(?,?,?,?,?,?)');
    const insM = db.prepare('INSERT INTO medicines(facility_id,name,category,essential,unit,stock,min_stock,lead_time_days,batch_no,expiry_date) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const insT = db.prepare('INSERT INTO medicine_txns(medicine_id,type,qty,note,created_at) VALUES(?,?,?,?,?)');
    const insFF = db.prepare('INSERT INTO footfall(facility_id,date,count) VALUES(?,?,?)');
    const insB = db.prepare('INSERT INTO beds(facility_id,total,occupied,out_of_service) VALUES(?,?,?,?)');
    const insD = db.prepare('INSERT INTO doctors(facility_id,name,speciality,shift) VALUES(?,?,?,?)');
    const insA = db.prepare('INSERT INTO attendance(doctor_id,date,status,source) VALUES(?,?,?,?)');
    const insTest = db.prepare('INSERT INTO tests(facility_id,name,essential,available,reason,last_verified) VALUES(?,?,?,?,?,?)');
    let docN = 0;
    FACS.forEach((f, i) => {
      const fid = insF.run(f[0], f[1], 'Demo District (Fictional)', f[2], f[3], day(f[4])).lastInsertRowid;
      const chc = f[1] === 'CHC', scale = chc ? 2.5 : 1;
      MEDS.forEach(m => {
        const daily = m[4] * scale;
        const cover = COVER[`${fid}:${m[0]}`] ?? Math.round(20 + rng() * 25);
        const stock = Math.round(daily * cover);
        const expiry = (fid === 5 && m[0] === 'ORS Sachets') ? future(20) : future(120 + Math.round(rng() * 280));
        const mid = insM.run(fid, m[0], m[1], m[2], m[3], stock, Math.ceil(daily * 7), m[5], `B${2400 + fid}${m[0].slice(0, 2).toUpperCase()}`, expiry).lastInsertRowid;
        for (let d = 29; d >= 0; d--) insT.run(mid, 'consume', Math.max(1, Math.round(daily * (0.8 + rng() * 0.4) * (d < 10 ? 1.1 : 1))), 'Daily dispensing (demo)', day(d) + ' 12:00:00');
      });
      for (let d = 29; d >= 0; d--) {
        const dow = new Date(day(d)).getDay();
        insFF.run(fid, day(d), Math.round((chc ? 260 : 90) * (dow === 1 ? 1.3 : dow === 0 ? 0.5 : 1) * (0.85 + rng() * 0.3)));
      }
      if (chc) insB.run(fid, 30, f[0] === 'CHC Shivgarh' ? 28 : 17, f[0] === 'CHC Shivgarh' ? 1 : 2); // Shivgarh: ~93% occupancy
      else insB.run(fid, 6, 3, 0);
      const nDoc = chc ? 5 : 3;
      for (let k = 0; k < nDoc; k++) {
        const did = insD.run(fid, 'Dr. ' + DOCS[(docN++) % DOCS.length] + ' (fictional)', k === 0 ? 'General Medicine' : chc ? ['Paediatrics', 'Gynaecology', 'Surgery', 'Orthopaedics'][k - 1] : 'MBBS', k % 2 ? 'Afternoon 2pm-8pm' : 'Morning 9am-2pm').lastInsertRowid;
        for (let d = 6; d >= 0; d--) {
          let st = rng() < 0.9 ? 'present' : (rng() < 0.5 ? 'on_leave' : 'absent');
          if (f[0] === 'PHC Chandpur' && d <= 3) st = k === 0 && d === 0 ? 'present' : 'absent'; // staff shortage scenario
          insA.run(did, day(d), st, 'manual_demo');
        }
      }
      TESTS.forEach(t => {
        if (t[0] === 'CBC' && !chc && fid % 2) return;
        if (t[0] === 'X-Ray' && !chc) return;
        const bad = (f[0] === 'PHC Chandpur' && t[0] === 'Haemoglobin') || (f[0] === 'PHC Devpur' && t[0] === 'Malaria RDT');
        insTest.run(fid, t[0], t[1], bad ? 0 : 1, bad ? 'Reagent kits out of stock (demo)' : null, f[0] === 'PHC Kishanpur' ? day(40) : day(Math.round(rng() * 10)));
      });
    });
    const insU = db.prepare('INSERT INTO users(username,password_hash,full_name,role,facility_id) VALUES(?,?,?,?,?)');
    insU.run('admin', bcrypt.hashSync('Admin@12345', 10), 'District Admin (Demo)', 'district_admin', null);
    insU.run('manager', bcrypt.hashSync('Manager@12345', 10), 'Facility Manager - PHC Devpur (Demo)', 'facility_manager', 2);
    insU.run('viewer', bcrypt.hashSync('Viewer@12345', 10), 'Read-only Viewer (Demo)', 'viewer', null);
    const insS = db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    Object.entries({ occupancy_threshold: 85, attendance_threshold: 60, report_stale_days: 2, critical_cover_days: 3, audit_overdue_days: 14, expiry_warning_days: 30 })
      .forEach(([k, v]) => insS.run(k, String(v)));
  })();
  return true;
}

function audit(userId, action, entity, detail) {
  db.prepare('INSERT INTO audit_logs(user_id,action,entity,detail) VALUES(?,?,?,?)').run(userId || null, action, entity || null, detail ? JSON.stringify(detail) : null);
}

function getSettings() {
  const s = {}; for (const r of db.prepare('SELECT key,value FROM settings').all()) s[r.key] = Number(r.value); return s;
}

init();
if (require.main === module) {
  if (process.argv.includes('--reset')) reset();
  console.log(seed() ? 'Database seeded with FICTIONAL demo data.' : 'Database already has data (use: npm run seed to reset).');
  console.log('Demo logins -> admin/Admin@12345, manager/Manager@12345, viewer/Viewer@12345');
}
module.exports = { db, seed, reset, audit, getSettings };
