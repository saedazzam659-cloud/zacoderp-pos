-- Shared single-use CAPTCHA state for all PM2 workers on Linux VPS installs.
-- Safe to apply repeatedly; it does not modify existing application tables.
CREATE TABLE IF NOT EXISTS agent_login_captcha_challenges (
  session_hash TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  nonce TEXT NOT NULL,
  answer_digest TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_login_captcha_expires_at_idx
  ON agent_login_captcha_challenges (expires_at);
