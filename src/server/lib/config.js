const DEFAULT_WINDOW_DAYS = 28;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const MAX_WINDOW_DAYS = 90;
const SAMPLE_INTERVAL_SECONDS = 60;

/*
 * The server list is fetched from this gist at runtime, so editing the gist is
 * enough — no redeploy. Override with the CONFIG_URL variable in wrangler.jsonc.
 */
const DEFAULT_SERVERS_URL =
  'https://gist.githubusercontent.com/RyanStudioo/82070a6601776f83bce51768593affe0/raw/2020a6196ecf22ff787697e7ee1d9747d6101912/server_config.json';

// Re-fetch the config at most this often per isolate.
const CONFIG_CACHE_SECONDS = 30;

// Per-isolate cache of the last successfully fetched server config.
let cachedConfig = null;
let pendingConfig = null;

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

/*
 * Coerces the configured server list into a predictable shape: one entry per
 * check, each with a trimmed display name, a badge URL string, and an optional
 * display-only list of process names running on that server. Accepts either a
 * `{ servers: [...] }` object or a bare array; returns null for other shapes.
 */
export function normalizeServerEntries(raw) {
  const entries = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.servers)
      ? raw.servers
      : null;

  if (entries === null) return null;

  return entries.map((entry, index) => {
    const source = entry && typeof entry === 'object' ? entry : {};
    const name = String(source.name || '').trim() || `Server ${index + 1}`;
    const url = String(source.url || '').trim();

    return {
      name,
      url,
      processes: normalizeProcesses(source.processes),
    };
  });
}

// Process names are display-only tags: trimmed, de-duplicated strings.
function normalizeProcesses(raw) {
  const seen = new Set();
  const processes = [];

  for (const value of Array.isArray(raw) ? raw : []) {
    const source = value && typeof value === 'object' ? value.name : value;
    const name = String(source ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    processes.push(name);
  }

  return processes;
}

/*
 * Fetches the server config from the configured URL (a GitHub gist raw file).
 * Results are cached briefly in the isolate so status requests and cron runs
 * do not re-download it constantly. If the URL is unreachable, the last config
 * that was fetched is reused; with nothing cached, an empty list is returned.
 */
export async function getServers(
  env = {},
  { fetchImpl = fetch, now = Date.now() } = {},
) {
  const url = String(env.CONFIG_URL || DEFAULT_SERVERS_URL).trim();
  if (!url) return [];

  const cached = cachedConfig;
  if (cached && now - cached.fetchedAt < CONFIG_CACHE_SECONDS * 1000) {
    return cached.servers;
  }

  if (pendingConfig) return pendingConfig;

  pendingConfig = (async () => {
    try {
      const response = await fetchImpl(url, { cf: { cacheTtl: 60 } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const servers = normalizeServerEntries(await response.json());
      if (!servers) throw new Error('The config is not a server list.');

      cachedConfig = { servers, fetchedAt: now };
      return servers;
    } catch (error) {
      if (cachedConfig) {
        console.error(
          `Could not refresh the server config (${error.message}); using the last known config.`,
        );
        // Back off so a failing config URL is not retried on every request.
        cachedConfig.fetchedAt = now;
        return cachedConfig.servers;
      }

      console.error(`Could not load the server config (${error.message}).`);
      return [];
    } finally {
      pendingConfig = null;
    }
  })();

  return pendingConfig;
}
