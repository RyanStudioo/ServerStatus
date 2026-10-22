import { fetchBadgeStatus, normalizeBadgeStatus, parseBadgeUrl, statusIsUp } from './badges.js';
import { ensureSchema } from './schema.js';
import {
  buildDailySeries,
  buildWindow,
  combineOverall,
  summarizeDaily,
} from './uptime.js';

const CONCURRENCY = 6;

export function resolveServers(configuredServers) {
  const servers = Array.isArray(configuredServers) ? configuredServers : [];

  return servers.map((entry, index) => {
    const name = String((entry && entry.name) || '').trim() || `Server ${index + 1}`;
    const badge = parseBadgeUrl(entry && entry.url);
    const processes = entry && Array.isArray(entry.processes) ? entry.processes : [];

    return {
      key: badge ? badge.badgeKey : `server-${index + 1}`,
      name,
      badge,
      processes,
    };
  });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function withUniqueIds(servers) {
  const used = new Set();

  return servers.map((server, index) => {
    const base = String(server.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `server-${index + 1}`;
    let id = base;
    let suffix = 2;

    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);

    return { id, slug: id, ...server };
  });
}

async function fetchLatestSamples(db) {
  const result = await db
    .prepare(
      `SELECT s.check_key, s.status, s.sampled_at
       FROM samples s
       JOIN (
         SELECT check_key, MAX(sampled_minute) AS max_minute
         FROM samples
         GROUP BY check_key
       ) latest
         ON latest.check_key = s.check_key
        AND latest.max_minute = s.sampled_minute`,
    )
    .all();

  return new Map((result.results || []).map((row) => [row.check_key, row]));
}

/**
 * Fetch each configured public badge JSON and insert one sample per check for
 * the current minute. Failed fetches are skipped; the previous sample remains
 * the current known state.
 */
export async function recordSamples({
  db,
  servers,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const targets = servers.filter((server) => server.badge);
  if (targets.length === 0) return;

  const sampledMinute = Math.floor(now.getTime() / 60000);
  const sampledAt = new Date(sampledMinute * 60000).toISOString();

  const fetched = await mapWithConcurrency(targets, CONCURRENCY, async (server) => {
    try {
      const rawStatus = await fetchBadgeStatus(server.badge.url, { fetchImpl });
      const status = normalizeBadgeStatus(rawStatus);

      if (status === 'unknown') {
        console.error(`Unexpected badge status for ${server.name}: ${rawStatus}`);
        return { server, status: null };
      }

      return { server, status };
    } catch (error) {
      console.error(`Failed to fetch the badge for ${server.name}:`, error);
      return { server, status: null };
    }
  });

  const latestByKey = new Map(
    [...(await fetchLatestSamples(db)).entries()].map(([key, row]) => [key, row.status]),
  );

  const statements = [];
  for (const item of fetched) {
    if (!item.status) continue;

    const previous = latestByKey.get(item.server.key);
    const isUp = statusIsUp(item.status);
    const incident = previous && statusIsUp(previous) && !isUp ? 1 : 0;

    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO samples
             (check_key, sampled_minute, sampled_at, status, up, incident)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.server.key,
          sampledMinute,
          sampledAt,
          item.status,
          isUp ? 1 : 0,
          incident,
        ),
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

async function hasFreshSamples(db, servers, now) {
  const result = await db
    .prepare(
      `SELECT check_key, MAX(sampled_minute) AS latest
       FROM samples
       GROUP BY check_key`,
    )
    .all();
  const latestByKey = new Map(
    (result.results || []).map((row) => [row.check_key, Number(row.latest)]),
  );
  const nowMinute = Math.floor(now.getTime() / 60000);

  return servers.every((server) => {
    if (!server.badge) return true;
    const latest = latestByKey.get(server.key);
    return Number.isFinite(latest) && nowMinute - latest < 1;
  });
}

export async function loadStatusPayload({
  db,
  servers,
  config,
  now = new Date(),
}) {
  const window = buildWindow(now, config.windowDays);
  const startMinute = Math.floor(window.start.getTime() / 60000);

  const [latestByKey, dailyResult, firstResult] = await Promise.all([
    fetchLatestSamples(db),
    db
      .prepare(
        `SELECT check_key,
                substr(sampled_at, 1, 10) AS day,
                COUNT(*) AS samples,
                SUM(up) AS up_samples,
                SUM(incident) AS incidents
         FROM samples
         WHERE sampled_minute >= ?
         GROUP BY check_key, day
         ORDER BY check_key, day`,
      )
      .bind(startMinute)
      .all(),
    db
      .prepare(
        `SELECT check_key, MIN(sampled_at) AS first_sample
         FROM samples
         WHERE sampled_minute >= ?
         GROUP BY check_key`,
      )
      .bind(startMinute)
      .all(),
  ]);

  const dailyByKey = new Map();
  for (const row of dailyResult.results || []) {
    const rows = dailyByKey.get(row.check_key) || [];
    rows.push(row);
    dailyByKey.set(row.check_key, rows);
  }

  const firstByKey = new Map(
    (firstResult.results || []).map((row) => [row.check_key, row.first_sample]),
  );

  const shaped = withUniqueIds(
    servers.map((server) => {
      if (!server.badge) {
        return {
          name: server.name,
          ...(server.processes.length ? { processes: server.processes } : {}),
          status: 'error',
          lastSample: null,
          stale: true,
          uptime: null,
          error: 'Invalid Healthchecks badge URL in config.json.',
        };
      }

      const latest = latestByKey.get(server.key) || null;
      const daily = buildDailySeries({
        dailyRows: dailyByKey.get(server.key) || [],
        start: window.start,
        days: window.days,
        sampleIntervalSeconds: config.sampleIntervalSeconds,
      });
      const summary = summarizeDaily(daily, config.sampleIntervalSeconds);
      const uptime =
        summary.samples > 0
          ? {
              ...summary,
              dataSince: firstByKey.get(server.key) || null,
              daily,
            }
          : null;

      const status = latest ? latest.status : 'error';
      const lastSample = latest ? latest.sampled_at : null;
      const stale =
        !lastSample ||
        now.getTime() - Date.parse(lastSample) > config.sampleIntervalSeconds * 3 * 1000;

      return {
        name: server.name,
        ...(server.processes.length ? { processes: server.processes } : {}),
        status,
        lastSample,
        stale,
        uptime,
        ...(latest ? {} : { error: 'No status samples have been collected yet.' }),
      };
    }),
  );

  return {
    generatedAt: now.toISOString(),
    window: {
      days: window.days,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    sampleIntervalSeconds: config.sampleIntervalSeconds,
    overall: combineOverall(shaped),
    servers: shaped,
  };
}

export async function getStatusPayload({
  db,
  servers,
  config,
  now = new Date(),
  fetchImpl = fetch,
}) {
  await ensureSchema(db);

  const resolved = resolveServers(servers);
  const fresh = await hasFreshSamples(db, resolved, now);

  if (!fresh) {
    await recordSamples({
      db,
      servers: resolved,
      now,
      fetchImpl,
    });
  }

  return loadStatusPayload({
    db,
    servers: resolved,
    config,
    now,
  });
}
