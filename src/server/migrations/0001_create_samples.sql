CREATE TABLE IF NOT EXISTS samples (
  check_key TEXT NOT NULL,
  sampled_minute INTEGER NOT NULL,
  sampled_at TEXT NOT NULL,
  status TEXT NOT NULL,
  up INTEGER NOT NULL,
  incident INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (check_key, sampled_minute)
);

CREATE INDEX IF NOT EXISTS idx_samples_time ON samples (sampled_minute);
