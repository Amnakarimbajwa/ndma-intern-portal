-- ============================================================
-- NDMA Intern Weekly Progress Portal — Database Schema
-- Run this in pgAdmin4 (Query Tool) on a fresh database, e.g. "ndma_interns"
--
-- Safe to re-run on an EXISTING database too: the ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS statements below will add the new registration-form fields
-- without touching any data you already have.
-- ============================================================

CREATE TABLE IF NOT EXISTS interns (
  id              SERIAL PRIMARY KEY,
  full_name       VARCHAR(150) NOT NULL,
  username        VARCHAR(50)  UNIQUE,             -- NULL until the student signs up
  password_hash   TEXT,                            -- NULL until the student signs up
  email           VARCHAR(150),
  phone           VARCHAR(30),
  university      VARCHAR(150),
  specialization  VARCHAR(150),
  cnic            VARCHAR(20) NOT NULL,             -- used to verify identity at signup
  cnic_digits     VARCHAR(15) GENERATED ALWAYS AS (regexp_replace(cnic, '[^0-9]', '', 'g')) STORED,
  gender          VARCHAR(20),
  date_of_birth   DATE,
  province        VARCHAR(50),
  district        VARCHAR(100),
  address         TEXT,
  degree          VARCHAR(150),
  semester        VARCHAR(50),
  cnic_picture_url TEXT,                           -- link from the registration form (e.g. Google Drive)
  transcript_url   TEXT,                           -- link from the registration form (e.g. Google Drive)
  joining_date_raw VARCHAR(100),                   -- original text from the form (kept as-is, formats vary)
  department      VARCHAR(100),          -- NDMA department/wing assigned to (filled in by admin later)
  start_date      DATE,                  -- best-effort parsed internship start date
  end_date        DATE,
  status          VARCHAR(20) DEFAULT 'active',   -- active | completed | dropped
  claimed         BOOLEAN DEFAULT FALSE,           -- true once the student has signed up
  must_change_password BOOLEAN DEFAULT FALSE,      -- kept for legacy admin-created accounts
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Adds the new columns above if you're running this against a database
-- that was already set up before the registration-form fields existed.
ALTER TABLE interns ADD COLUMN IF NOT EXISTS gender VARCHAR(20);
ALTER TABLE interns ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE interns ADD COLUMN IF NOT EXISTS province VARCHAR(50);
ALTER TABLE interns ADD COLUMN IF NOT EXISTS district VARCHAR(100);
ALTER TABLE interns ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE interns ADD COLUMN IF NOT EXISTS degree VARCHAR(150);
ALTER TABLE interns ADD COLUMN IF NOT EXISTS semester VARCHAR(50);
ALTER TABLE interns ADD COLUMN IF NOT EXISTS cnic_picture_url TEXT;
ALTER TABLE interns ADD COLUMN IF NOT EXISTS transcript_url TEXT;
ALTER TABLE interns ADD COLUMN IF NOT EXISTS joining_date_raw VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_interns_cnic_digits ON interns(cnic_digits);

CREATE TABLE IF NOT EXISTS weekly_progress (
  id              SERIAL PRIMARY KEY,
  intern_id       INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
  week_number     INTEGER NOT NULL,
  week_start_date DATE,
  task_text       TEXT NOT NULL,
  attachments     TEXT,                  -- comma-separated Cloudinary URLs (see server.js)
  submitted_at    TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE (intern_id, week_number)        -- one submission per intern per week (editable)
);

CREATE TABLE IF NOT EXISTS admins (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(50) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       VARCHAR(150)
);

CREATE INDEX IF NOT EXISTS idx_weekly_progress_intern ON weekly_progress(intern_id);
CREATE INDEX IF NOT EXISTS idx_weekly_progress_week ON weekly_progress(week_number);
