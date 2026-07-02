// ============================================================
// import_interns.js
// Loads your roster Excel (Google Form export, e.g. "Registration.xlsx")
// into the `interns` table as UNCLAIMED rows (no username/password yet).
// Students later self-signup by verifying their Name + CNIC against these
// rows — see /signup in server.js.
//
// Expected columns (matched by header text, order doesn't matter):
//   Timestamp, Name, Gender, Date of Birth, CNIC #, CNIC Picture,
//   Degree, Province, District, Address, University / Department,
//   semester, Contact Details, Email Address,
//   NDMA Internship Joining Date, Transcript/.../Recommendation Letter
//
// Run:  node import_interns.js
// Safe to re-run: skips rows whose CNIC already exists.
// ============================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { Pool } = require('pg');
const path = require('path');

const SOURCE_FILE = process.env.ROSTER_FILE || 'Registration.xlsx';

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // required by Neon and most hosted Postgres
    })
  : new Pool({
      user: process.env.PGUSER || 'postgres',
      host: process.env.PGHOST || 'localhost',
      database: process.env.PGDATABASE || 'ndma_interns',
      password: process.env.PGPASSWORD || 'admin123',
      port: process.env.PGPORT || 5432,
    });

// ── Helpers ───────────────────────────────────────────────────

// Finds a column index by matching header text (case-insensitive).
// `must` keywords all have to appear; any `mustNot` keyword disqualifies it.
// This makes the script tolerant of the form's columns being re-ordered
// or re-worded slightly, instead of relying on fixed positions.
function findCol(headerRow, must, mustNot = []) {
  for (let i = 0; i < headerRow.length; i++) {
    const h = (headerRow[i] || '').toString().toLowerCase();
    const hasAll = must.every(k => h.includes(k));
    const hasNone = mustNot.every(k => !h.includes(k));
    if (hasAll && hasNone) return i;
  }
  return -1;
}

// Excel stores dates as "serial numbers" when the cell isn't formatted as
// a date. This converts that serial number into a real JS Date.
function excelSerialToDate(serial) {
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return isNaN(d.getTime()) ? null : d;
}

// Handles the three shapes a date can arrive in from this form:
// a real Date object, a raw Excel serial number, or a free-text string
// like "23rd June 2026" / "24-June-2026" / "22 June 2026".
function parseFlexibleDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return excelSerialToDate(value);
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/(\d+)(st|nd|rd|th)\b/i, '$1');
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// CNIC arrives either as a string ("32102-1903100-6") or as a number
// (4550504667919, because Excel treated it as a plain number and may have
// dropped a leading zero). This normalizes both into "XXXXX-XXXXXXX-X".
function normalizeCnicDisplay(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    let digits = Math.round(value).toString();
    if (digits.length < 13) digits = digits.padStart(13, '0');
    if (digits.length !== 13) return digits; // unexpected length, just return raw
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  }
  return value.toString().trim();
}

function clean(value) {
  return (value === null || value === undefined) ? '' : value.toString().trim();
}

// "University of Sindh / Disaster Management" -> university + specialization
function splitUniversityDept(raw) {
  const text = clean(raw);
  if (!text.includes('/')) return { university: text, specialization: '' };
  const parts = text.split('/');
  return {
    university: parts[0].trim(),
    specialization: parts.slice(1).join('/').trim(),
  };
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const wb = XLSX.readFile(path.join(__dirname, SOURCE_FILE), { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const headerRow = raw[0];
  const col = {
    name: findCol(headerRow, ['name'], ['user']),
    gender: findCol(headerRow, ['gender']),
    dob: findCol(headerRow, ['date of birth']),
    cnic: findCol(headerRow, ['cnic'], ['picture']),
    cnicPic: findCol(headerRow, ['cnic', 'picture']),
    degree: findCol(headerRow, ['degree']),
    province: findCol(headerRow, ['province']),
    district: findCol(headerRow, ['district']),
    address: findCol(headerRow, ['address']),
    uniDept: findCol(headerRow, ['university']),
    semester: findCol(headerRow, ['semester']),
    phone: findCol(headerRow, ['contact']),
    email: findCol(headerRow, ['email']),
    joining: findCol(headerRow, ['joining']),
    transcript: findCol(headerRow, ['transcript']),
  };

  const missing = Object.entries(col).filter(([, idx]) => idx === -1).map(([k]) => k);
  if (missing.length) {
    console.warn(`⚠️  Couldn't find a column for: ${missing.join(', ')} — those fields will be left blank.`);
  }
  if (col.name === -1 || col.cnic === -1) {
    console.error('❌ Could not find Name or CNIC columns — check the file headers. Aborting.');
    process.exit(1);
  }

  const rows = raw.slice(1).filter(r => clean(r[col.name]) && clean(r[col.cnic]));
  let inserted = 0, skipped = 0;

  for (const r of rows) {
    const fullName = clean(r[col.name]);
    const cnic = normalizeCnicDisplay(r[col.cnic]);
    const { university, specialization } = splitUniversityDept(r[col.uniDept]);
    const phone = clean(r[col.phone]);
    const email = clean(r[col.email]);
    const gender = clean(r[col.gender]);
    const degree = clean(r[col.degree]);
    const province = clean(r[col.province]);
    const district = clean(r[col.district]);
    const address = clean(r[col.address]);
    const semester = clean(r[col.semester]);
    const cnicPictureUrl = clean(r[col.cnicPic]);
    const transcriptUrl = clean(r[col.transcript]);
    const joiningRaw = clean(r[col.joining]);
    const dob = col.dob !== -1 ? parseFlexibleDate(r[col.dob]) : null;
    const startDate = col.joining !== -1 ? parseFlexibleDate(r[col.joining]) : null;

    const exists = await pool.query(
      `SELECT id FROM interns WHERE regexp_replace(cnic, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')`,
      [cnic]
    );
    if (exists.rows.length) { skipped++; continue; }

    await pool.query(
      `INSERT INTO interns
        (full_name, email, phone, university, specialization, cnic,
         gender, date_of_birth, province, district, address, degree,
         semester, cnic_picture_url, transcript_url, joining_date_raw, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [fullName, email, phone, university, specialization, cnic,
       gender, dob, province, district, address, degree,
       semester, cnicPictureUrl, transcriptUrl, joiningRaw, startDate]
    );
    inserted++;
  }

  console.log(`✅ Inserted ${inserted} new interns, skipped ${skipped} already-present (by CNIC).`);
  console.log(`Students can now go to /signup and verify with their Name + CNIC to create their own login.`);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
