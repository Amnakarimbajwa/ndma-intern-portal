// Run: node create_admin.js <username> <password> "<Full Name>"
// Example: node create_admin.js akb Sup3rSecret! "AKB"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const [,, username, password, fullName] = process.argv;
if (!username || !password) {
  console.log('Usage: node create_admin.js <username> <password> "<Full Name>"');
  process.exit(1);
}

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

(async () => {
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO admins (username, password_hash, full_name) VALUES ($1,$2,$3)
     ON CONFLICT (username) DO UPDATE SET password_hash=$2, full_name=$3`,
    [username, hash, fullName || username]
  );
  console.log(`✅ Admin account ready: ${username}`);
  await pool.end();
})();
