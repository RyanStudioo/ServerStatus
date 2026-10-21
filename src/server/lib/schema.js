const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS samples (
  check_key TEXT NOT NULL,
  sampled_minute INTEGER NOT NULL,
  sampled_at TEXT NOT NULL,
  status TEXT NOT NULL,
  up INTEGER NOT NULL,
  incident INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (check_key, sampled_minute)
)`;

const CREATE_INDEX = 'CREATE INDEX IF NOT EXISTS idx_samples_time ON samples (sampled_minute)';

let schemaReady;

export async function ensureSchema(db) {
  if (!db) {
    throw new Error('The D1 database binding is not configured.');
  }

  if (!schemaReady) {
    schemaReady = db
      .batch([db.prepare(CREATE_TABLE), db.prepare(CREATE_INDEX)])
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }

  await schemaReady;
}

export async function pruneSamples(db, { now = new Date(), days = 30 } = {}) {
  const cutoffMinute = Math.floor(now.getTime() / 60000) - days * 24 * 60;
  await db.prepare('DELETE FROM samples WHERE sampled_minute < ?').bind(cutoffMinute).run();
}
