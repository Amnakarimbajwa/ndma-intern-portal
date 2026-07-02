# NDMA Intern Weekly Progress Portal

Each of your 100 interns gets their own username/password. They log in, pick a week,
and type/upload what they worked on. You (admin) see everyone's submissions in one
filterable table and can export to Excel any time.

## 1. Database setup (pgAdmin4)

1. In pgAdmin4, create a new database, e.g. `ndma_interns`.
2. Open the Query Tool on that database, paste in `schema.sql`, and run it.
   This creates three tables: `interns`, `weekly_progress`, `admins`.

## 2. Project setup

```bash
cd ndma-intern-portal
npm install
cp .env.example .env
```

Edit `.env` with your real Postgres password and a random `SESSION_SECRET`
(any long random string — this signs login cookies, keep it secret).

## 3. Load your roster (so students can self-signup)

Put your roster file (`NDMA_Internship_2026_with_Province.xlsx`) in this folder,
matching the `ROSTER_FILE` name in `.env`, then:

```bash
npm run import-interns
```

This loads every row (name, CNIC, university, etc.) into the `interns` table
as **unclaimed** — no username or password yet. Nothing is sent to anyone.
Safe to re-run later if you add more interns; it skips CNICs already loaded.

### How students get in: self-signup

You don't email or hand out any passwords. Each student:
1. Goes to `https://yourdomain.com/signup`
2. Types their **full name + CNIC** exactly as on your roster
3. If it matches an unclaimed row, they immediately pick their own username
   (the system suggests one like `ali.khan`, editable) and set their own password
4. They're logged straight into their dashboard

If the name/CNIC doesn't match anything (typo, or not on the roster), signup
is rejected — so this stays locked to only your actual interns, no open
public registration. Only tell students the one shared URL; no distribution
work on your end.

If someone loses access or needs a password reset later, run this in pgAdmin4
to un-claim their row so they can sign up again:
```sql
UPDATE interns SET username=NULL, password_hash=NULL, claimed=FALSE WHERE cnic='12345-1234567-1';
```

## 4. Create your own admin/coordinator login

```bash
node create_admin.js akb "YourStrongPassword!" "AKB"
```

## 5. Run it

```bash
npm start
```

- Interns go to `https://yourdomain.com/login`
- You go to `https://yourdomain.com/admin/login`

## 6. Giving interns access (since you're going public-internet)

Since signup is self-service (Section 3 above), all you do is share **one URL**
with all 100 interns at once — a WhatsApp group message, an email blast, or a
notice board post all work: *"Register at https://yourdomain.com/signup using
your name and CNIC exactly as on your internship form."*

No per-student distribution, no credentials file to protect. The name+CNIC
check keeps signup restricted to people actually on your roster.

## 7. Making it reachable on the public internet

Right now this only listens on `localhost`. To make it real:

**Option A — cheapest/fastest: a small cloud VPS**
- Get a $5–6/mo droplet (DigitalOcean, Linode, Vultr) or a free-tier Render/Railway app.
- Install Node + Postgres there (or use a managed Postgres add-on).
- Point a domain (or subdomain like `internship.ndma.gov.pk` if IT allows it) at the server's IP.
- Put **nginx** in front of the Node app as a reverse proxy, and get a free HTTPS
  certificate with **Certbot/Let's Encrypt**. This is what makes `secure: true`
  cookies and safe login over the internet actually work.
- Run the app with **pm2** (`npm i -g pm2 && pm2 start server.js`) so it survives
  reboots and restarts if it crashes.

**Option B — if NDMA already has a public-facing server**
- Ask IT for a subdomain + open port, deploy the same way (nginx + certbot + pm2).

Either way, before going live:
- Set `NODE_ENV=production` in `.env` so cookies require HTTPS.
- Use a strong, random `SESSION_SECRET`.
- Take regular `pg_dump` backups of the database (weekly progress data is exactly
  the kind of thing you don't want to lose).

## 8. Optional next steps I can help with
- Self-service "forgot password" via email (nodemailer + reset tokens)
- Weekly reminder emails to interns who haven't submitted yet
- A supervisor role per NDMA department (only sees their own interns)
- Combining this with your existing `server.js` dashboard (province maps, stats)
  so it's one unified app instead of two
