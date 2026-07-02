require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 4000;

// If DATABASE_URL is set (e.g. Neon's connection string), use it directly —
// this is the recommended path for deployment. Otherwise fall back to the
// individual PGUSER/PGHOST/etc vars, which is handy for local Postgres.
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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.set('trust proxy', 1); // needed behind a reverse proxy (nginx) on the public internet
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
    secure: process.env.NODE_ENV === 'production', // requires HTTPS in production
    httpOnly: true,
  }
}));

// ── File uploads (Cloudinary) ────────────────────────────────
// Files are uploaded straight to Cloudinary instead of local disk.
// This matters because on free hosts like Render, local disk storage is
// wiped every time the app restarts or redeploys — Cloudinary keeps
// files safe across restarts, and works the same whether you're running
// locally or deployed.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// A minimal custom multer storage engine that streams uploads straight to
// Cloudinary. We write this ourselves instead of using the
// multer-storage-cloudinary package because that package is still pinned to
// Cloudinary SDK v1 as a peer dependency and conflicts with the v2 SDK used
// here — this avoids that conflict entirely.
class CloudinaryStorageEngine {
  _handleFile(req, file, cb) {
    const publicId = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'ndma-intern-portal/weekly-progress',
        resource_type: 'auto', // handles images, PDFs, docx, xlsx, zip, etc.
        public_id: publicId,
      },
      (error, result) => {
        if (error) return cb(error);
        // `path` mirrors what multer-storage-cloudinary exposed, so the rest
        // of the app (req.files.map(f => f.path)) works unchanged.
        cb(null, { path: result.secure_url, filename: result.public_id, size: result.bytes });
      }
    );
    file.stream.pipe(uploadStream);
  }
  _removeFile(req, file, cb) {
    cloudinary.uploader.destroy(file.filename, { resource_type: 'auto' }, cb);
  }
}

const storage = new CloudinaryStorageEngine();

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|jpg|jpeg|png|zip)$/i;
    cb(null, allowed.test(file.originalname));
  }
});

// ── Auth middleware ──────────────────────────────────────────
function requireIntern(req, res, next) {
  if (!req.session.intern) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

const TOTAL_WEEKS = 16; // adjust to your internship duration

function normalizeCnic(s) { return (s || '').replace(/[^0-9]/g, ''); }
function normalizeName(s) { return (s || '').toLowerCase().replace(/^(ms\.?|mr\.?|dr\.?)\s*/i, '').replace(/\s+/g, ' ').trim(); }

async function suggestUsername(name) {
  const clean = normalizeName(name).replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const base = clean.length >= 2 ? `${clean[0]}.${clean[clean.length - 1]}` : (clean[0] || 'intern');
  let candidate = base, n = 1;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM interns WHERE username=$1', [candidate]);
    if (!rows.length) return candidate;
    candidate = `${base}${n}`;
    n++;
  }
}

// ── Intern: self-signup (verify against roster, then set own login) ─
app.get('/signup', (req, res) => res.render('signup', { error: null }));

app.post('/signup/verify', async (req, res) => {
  const { fullName, cnic } = req.body;
  const cnicDigits = normalizeCnic(cnic);
  if (!fullName || cnicDigits.length < 5) {
    return res.render('signup', { error: 'Please enter your full name and CNIC as recorded with NDMA' });
  }

  const { rows } = await pool.query(
    `SELECT * FROM interns WHERE regexp_replace(cnic, '[^0-9]', '', 'g') = $1`,
    [cnicDigits]
  );
  const match = rows.find(r => normalizeName(r.full_name) === normalizeName(fullName));

  if (!match) {
    return res.render('signup', { error: "We couldn't match that name and CNIC to our intern list. Please check for typos, or contact your coordinator." });
  }
  if (match.claimed) {
    return res.render('signup', { error: 'An account already exists for this record. Please use the Log In page — if you forgot your password, contact your coordinator.' });
  }

  req.session.signupInternId = match.id;
  const suggested = await suggestUsername(match.full_name);
  res.render('signup_complete', { error: null, name: match.full_name, suggested });
});

app.post('/signup/complete', async (req, res) => {
  const internId = req.session.signupInternId;
  if (!internId) return res.redirect('/signup');

  const { username, password, confirmPassword } = req.body;
  const cleanUsername = (username || '').trim().toLowerCase().replace(/[^a-z0-9._]/g, '');

  const render = (error) => {
    return pool.query('SELECT full_name FROM interns WHERE id=$1', [internId]).then(({ rows }) =>
      res.render('signup_complete', { error, name: rows[0]?.full_name || '', suggested: cleanUsername || username })
    );
  };

  if (!cleanUsername || cleanUsername.length < 3) return render('Username must be at least 3 characters (letters, numbers, dots)');
  if (!password || password.length < 6) return render('Password must be at least 6 characters');
  if (password !== confirmPassword) return render('Passwords do not match');

  const { rows: current } = await pool.query('SELECT full_name, claimed FROM interns WHERE id=$1', [internId]);
  if (!current.length || current[0].claimed) return render('This account was already set up. Please use the Log In page.');

  const { rows: taken } = await pool.query('SELECT 1 FROM interns WHERE username=$1', [cleanUsername]);
  if (taken.length) return render('That username is already taken — please choose another');

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'UPDATE interns SET username=$1, password_hash=$2, claimed=TRUE WHERE id=$3',
    [cleanUsername, hash, internId]
  );
  delete req.session.signupInternId;
  req.session.intern = { id: internId, name: current[0]?.full_name, mustChange: false };
  res.redirect('/dashboard');
});

// ── Intern: login ────────────────────────────────────────────
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM interns WHERE username=$1', [username]);
  if (!rows.length) return res.render('login', { error: 'Invalid username or password' });

  const intern = rows[0];
  const ok = await bcrypt.compare(password, intern.password_hash);
  if (!ok) return res.render('login', { error: 'Invalid username or password' });

  req.session.intern = { id: intern.id, name: intern.full_name, mustChange: intern.must_change_password };
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// ── Intern: change password (forced on first login) ─────────
app.get('/change-password', requireIntern, (req, res) => res.render('change_password', { error: null }));
app.post('/change-password', requireIntern, async (req, res) => {
  const { newPassword, confirmPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.render('change_password', { error: 'Password must be at least 6 characters' });
  }
  if (newPassword !== confirmPassword) {
    return res.render('change_password', { error: 'Passwords do not match' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE interns SET password_hash=$1, must_change_password=FALSE WHERE id=$2', [hash, req.session.intern.id]);
  req.session.intern.mustChange = false;
  res.redirect('/dashboard');
});

// ── Intern: dashboard (their own submission history) ────────
app.get('/dashboard', requireIntern, async (req, res) => {
  if (req.session.intern.mustChange) return res.redirect('/change-password');
  const { rows } = await pool.query(
    'SELECT * FROM weekly_progress WHERE intern_id=$1 ORDER BY week_number ASC',
    [req.session.intern.id]
  );
  const submittedWeeks = new Set(rows.map(r => r.week_number));
  const weeks = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1);
  res.render('dashboard', {
    intern: req.session.intern,
    submissions: rows,
    weeks,
    submittedWeeks
  });
});

// ── Intern: submit / edit a week's task ──────────────────────
app.get('/submit/:week', requireIntern, async (req, res) => {
  const week = parseInt(req.params.week);
  const { rows } = await pool.query(
    'SELECT * FROM weekly_progress WHERE intern_id=$1 AND week_number=$2',
    [req.session.intern.id, week]
  );
  res.render('submit', { intern: req.session.intern, week, existing: rows[0] || null, error: null });
});

// NOTE: attachments are now stored as full Cloudinary URLs (comma-separated),
// not local filenames. Any view that renders attachment links (dashboard.ejs,
// submit.ejs, admin_dashboard.ejs) should link directly to the stored value,
// e.g. `<a href="<%= url %>">` instead of `<a href="/uploads/<%= filename %>">`.
app.post('/submit/:week', requireIntern, upload.array('attachments', 5), async (req, res) => {
  const week = parseInt(req.params.week);
  const { taskText, weekStartDate } = req.body;
  if (!taskText || !taskText.trim()) {
    return res.render('submit', { intern: req.session.intern, week, existing: null, error: 'Task description is required' });
  }
  // multer-storage-cloudinary sets file.path to the uploaded file's Cloudinary URL
  const newFiles = req.files ? req.files.map(f => f.path) : [];

  const { rows } = await pool.query(
    'SELECT * FROM weekly_progress WHERE intern_id=$1 AND week_number=$2',
    [req.session.intern.id, week]
  );

  if (rows.length) {
    let attachments = rows[0].attachments ? rows[0].attachments.split(',') : [];
    attachments = attachments.concat(newFiles);
    await pool.query(
      `UPDATE weekly_progress SET task_text=$1, week_start_date=$2, attachments=$3, updated_at=NOW()
       WHERE intern_id=$4 AND week_number=$5`,
      [taskText.trim(), weekStartDate || null, attachments.join(','), req.session.intern.id, week]
    );
  } else {
    await pool.query(
      `INSERT INTO weekly_progress (intern_id, week_number, week_start_date, task_text, attachments)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.session.intern.id, week, weekStartDate || null, taskText.trim(), newFiles.join(',')]
    );
  }
  res.redirect('/dashboard');
});

// ── Admin: login ──────────────────────────────────────────────
app.get('/admin/login', (req, res) => res.render('admin_login', { error: null }));
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM admins WHERE username=$1', [username]);
  if (!rows.length) return res.render('admin_login', { error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return res.render('admin_login', { error: 'Invalid credentials' });
  req.session.admin = { id: rows[0].id, name: rows[0].full_name };
  res.redirect('/admin');
});
app.get('/admin/logout', (req, res) => { req.session.destroy(() => res.redirect('/admin/login')); });

// ── Admin: view all interns' progress ─────────────────────────
app.get('/admin', requireAdmin, async (req, res) => {
  const { week, intern, status } = req.query;
  let query = `
    SELECT wp.*, i.full_name, i.university, i.department, i.status AS intern_status
    FROM weekly_progress wp
    JOIN interns i ON i.id = wp.intern_id
    WHERE 1=1`;
  const params = [];
  if (week) { params.push(week); query += ` AND wp.week_number = $${params.length}`; }
  if (intern) { params.push(`%${intern.toLowerCase()}%`); query += ` AND LOWER(i.full_name) LIKE $${params.length}`; }
  query += ' ORDER BY wp.week_number DESC, i.full_name ASC';
  const { rows: submissions } = await pool.query(query, params);

  const { rows: internList } = await pool.query('SELECT id, full_name FROM interns ORDER BY full_name');
  const { rows: countRows } = await pool.query('SELECT COUNT(DISTINCT intern_id) AS c FROM weekly_progress WHERE week_number=$1', [week || 1]);

  res.render('admin_dashboard', {
    admin: req.session.admin,
    submissions,
    internList,
    weeks: Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1),
    filters: { week, intern },
    totalInterns: internList.length
  });
});

// ── Admin: export current filtered view to Excel ──────────────
app.get('/admin/export', requireAdmin, async (req, res) => {
  const { week, intern } = req.query;
  let query = `
    SELECT wp.week_number, i.full_name, i.university, i.department, wp.task_text, wp.attachments, wp.submitted_at, wp.updated_at
    FROM weekly_progress wp JOIN interns i ON i.id = wp.intern_id WHERE 1=1`;
  const params = [];
  if (week) { params.push(week); query += ` AND wp.week_number = $${params.length}`; }
  if (intern) { params.push(`%${intern.toLowerCase()}%`); query += ` AND LOWER(i.full_name) LIKE $${params.length}`; }
  query += ' ORDER BY wp.week_number, i.full_name';
  const { rows } = await pool.query(query, params);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Weekly Progress');
  ws.columns = [
    { header: 'Week', key: 'week_number', width: 8 },
    { header: 'Intern', key: 'full_name', width: 30 },
    { header: 'University', key: 'university', width: 30 },
    { header: 'Department', key: 'department', width: 20 },
    { header: 'Task', key: 'task_text', width: 60 },
    { header: 'Attachments', key: 'attachments', width: 50 },
    { header: 'Submitted At', key: 'submitted_at', width: 20 },
  ];
  rows.forEach(r => ws.addRow(r));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=weekly_progress.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

app.get('/', (req, res) => res.redirect(req.session.intern ? '/dashboard' : '/login'));

app.listen(PORT, () => console.log(`✅ NDMA Intern Portal running at http://localhost:${PORT}`));
