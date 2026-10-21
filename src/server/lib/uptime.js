const DAY_MS = 24 * 60 * 60 * 1000;

export function buildWindow(now = new Date(), days = 28) {
  const dayCount = Number.isFinite(days) && days > 0 ? Math.floor(days) : 28;
  const end = new Date(now);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (dayCount - 1));
  return { days: dayCount, start, end };
}

export function roundPercent(value, hasDowntime) {
  if (!Number.isFinite(value)) return null;
  if (value >= 100) return hasDowntime ? 99.99 : 100;
  return Math.floor(value * 100) / 100;
}

/**
 * Turn the per-day SQL aggregates into exactly one entry per day in the
 * window. Days without samples are returned with a null percentage so the
 * client can render them as gray bars.
 */
export function buildDailySeries({
  dailyRows = [],
  start,
  days = 28,
  sampleIntervalSeconds = 60,
}) {
  const startDate = start instanceof Date ? start : new Date(start);
  const startMs = startDate.getTime();
  const byDate = new Map();

  for (const row of dailyRows) {
    const date = row.day || row.date;
    if (date) byDate.set(date, row);
  }

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(startMs + index * DAY_MS).toISOString().slice(0, 10);
    const row = byDate.get(date);
    const samples = Number(row && row.samples) || 0;
    const upSamples = Number(row && (row.up_samples ?? row.upSamples)) || 0;
    const downSamples = Math.max(0, samples - upSamples);
    const incidents = Number(row && row.incidents) || 0;

    return {
      date,
      samples,
      upSamples,
      uptimePercent:
        samples > 0 ? roundPercent((upSamples / samples) * 100, downSamples > 0) : null,
      downSeconds: Math.round(downSamples * sampleIntervalSeconds),
      incidents,
    };
  });
}

export function summarizeDaily(daily, sampleIntervalSeconds = 60) {
  let samples = 0;
  let upSamples = 0;
  let incidents = 0;

  for (const day of daily) {
    samples += day.samples;
    upSamples += day.upSamples;
    incidents += day.incidents;
  }

  const downSamples = Math.max(0, samples - upSamples);

  return {
    percent:
      samples > 0 ? roundPercent((upSamples / samples) * 100, downSamples > 0) : null,
    samples,
    upSamples,
    downSamples,
    upSeconds: Math.round(upSamples * sampleIntervalSeconds),
    downSeconds: Math.round(downSamples * sampleIntervalSeconds),
    coverageSeconds: Math.round(samples * sampleIntervalSeconds),
    incidents,
  };
}

export function combineOverall(servers) {
  const counts = {
    total: servers.length,
    up: 0,
    grace: 0,
    down: 0,
    new: 0,
    paused: 0,
    error: 0,
  };

  let upSeconds = 0;
  let downSeconds = 0;
  let incidents = 0;
  let samples = 0;
  let dataSince = null;

  for (const server of servers) {
    if (Object.hasOwn(counts, server.status) && server.status !== 'total') {
      counts[server.status] += 1;
    }

    if (server.uptime) {
      upSeconds += Number(server.uptime.upSeconds) || 0;
      downSeconds += Number(server.uptime.downSeconds) || 0;
      incidents += Number(server.uptime.incidents) || 0;
      samples += Number(server.uptime.samples) || 0;

      if (
        server.uptime.dataSince &&
        (!dataSince || Date.parse(server.uptime.dataSince) < Date.parse(dataSince))
      ) {
        dataSince = server.uptime.dataSince;
      }
    }
  }

  const knownSeconds = upSeconds + downSeconds;
  let status = 'unknown';
  if (counts.down > 0) status = 'down';
  else if (counts.grace > 0) status = 'grace';
  else if (counts.error > 0) status = 'error';
  else if (counts.up > 0) status = 'up';

  return {
    status,
    uptimePercent:
      knownSeconds > 0 ? roundPercent((upSeconds / knownSeconds) * 100, downSeconds > 0) : null,
    upSeconds,
    downSeconds,
    incidents,
    samples,
    dataSince,
    counts,
  };
}
