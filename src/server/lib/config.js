const DEFAULT_WINDOW_DAYS = 28;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const MAX_WINDOW_DAYS = 90;
const SAMPLE_INTERVAL_SECONDS = 60;

function toInteger(value, fallback, { min, max } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

function parseOrigins(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '*';
  const raw = String(value).trim();
  if (raw === '*') return '*';
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : '*';
}

export function getConfig(env = {}) {
  return {
    windowDays: toInteger(env.UPTIME_WINDOW_DAYS, DEFAULT_WINDOW_DAYS, {
      min: 1,
      max: MAX_WINDOW_DAYS,
    }),
    cacheTtlSeconds: toInteger(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS, {
      min: 0,
      max: 3600,
    }),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
  };
}
