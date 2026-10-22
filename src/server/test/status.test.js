import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStatusPayload, recordSamples, resolveServers } from '../lib/status.js';

const BADGE_KEY = 'b31e002e-161a-4cfb-9e24-44fa12a8b52d';
const BADGE_URL = `https://healthchecks.io/b/2/${BADGE_KEY}.json`;
const NOW = new Date('2026-10-21T12:00:30.000Z');

function badgeResponse(status) {
  return new Response(JSON.stringify({ status }), { status: 200 });
}

function queryDb({ latest = [], daily = [], first = [] } = {}) {
  return {
    prepare(sql) {
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          if (sql.includes('COUNT(*)')) return { results: daily };
          if (sql.includes('MIN(sampled_at)')) return { results: first };
          return { results: latest };
        },
      };
      return statement;
    },
  };
}

function recordDb(latest = []) {
  const inserted = [];

  return {
    inserted,
    prepare(sql) {
      if (sql.includes('MAX(sampled_minute)')) {
        return { all: async () => ({ results: latest }) };
      }

      const statement = {
        bind(...args) {
          inserted.push(args);
          return statement;
        },
      };
      return statement;
    },
    async batch(statements) {
      return statements;
    },
  };
}

test('resolveServers parses badge URLs and keeps display names', () => {
  const servers = resolveServers([
    { name: 'Server 0', url: BADGE_URL },
    { name: '', url: BADGE_URL },
    { name: 'Broken', url: 'https://example.com/nope' },
  ]);

  assert.equal(servers[0].name, 'Server 0');
  assert.equal(servers[0].key, BADGE_KEY);
  assert.equal(servers[0].badge.states, 2);
  assert.equal(servers[1].name, 'Server 2');
  assert.equal(servers[2].badge, null);
  assert.equal(servers[2].key, 'server-3');
});

test('recordSamples inserts the current badge status', async () => {
  const db = recordDb([]);
  const servers = resolveServers([{ name: 'Server 0', url: BADGE_URL }]);
  const expectedMinute = Math.floor(NOW.getTime() / 60000);

  await recordSamples({
    db,
    servers,
    now: NOW,
    fetchImpl: async () => badgeResponse('up'),
  });

  assert.equal(db.inserted.length, 1);
  assert.deepEqual(db.inserted[0], [
    BADGE_KEY,
    expectedMinute,
    new Date(expectedMinute * 60000).toISOString(),
    'up',
    1,
    0,
  ]);
});

test('recordSamples records an incident when a check goes down', async () => {
  const db = recordDb([{ check_key: BADGE_KEY, status: 'up' }]);
  const servers = resolveServers([{ name: 'Server 0', url: BADGE_URL }]);

  await recordSamples({
    db,
    servers,
    now: NOW,
    fetchImpl: async () => badgeResponse('down'),
  });

  assert.equal(db.inserted.length, 1);
  assert.equal(db.inserted[0][3], 'down');
  assert.equal(db.inserted[0][4], 0);
  assert.equal(db.inserted[0][5], 1);
});

test('recordSamples normalizes late to grace', async () => {
  const db = recordDb([]);
  const servers = resolveServers([{ name: 'Server 0', url: BADGE_URL }]);

  await recordSamples({
    db,
    servers,
    now: NOW,
    fetchImpl: async () => badgeResponse('late'),
  });

  assert.equal(db.inserted[0][3], 'grace');
  assert.equal(db.inserted[0][4], 1);
  assert.equal(db.inserted[0][5], 0);
});

test('recordSamples skips failed badge fetches', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  const db = recordDb([]);
  const servers = resolveServers([{ name: 'Server 0', url: BADGE_URL }]);

  await recordSamples({
    db,
    servers,
    now: NOW,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });

  assert.equal(db.inserted.length, 0);
});

test('loadStatusPayload shapes current status and 28 daily buckets', async () => {
  const servers = resolveServers([{ name: 'Server 0', url: BADGE_URL }]);
  const db = queryDb({
    latest: [
      {
        check_key: BADGE_KEY,
        status: 'up',
        sampled_at: '2026-10-21T11:59:00.000Z',
      },
    ],
    daily: [
      {
        check_key: BADGE_KEY,
        day: '2026-09-24',
        samples: 1440,
        up_samples: 1440,
        incidents: 0,
      },
    ],
    first: [{ check_key: BADGE_KEY, first_sample: '2026-09-24T00:00:00.000Z' }],
  });

  const payload = await loadStatusPayload({
    db,
    servers,
    config: { windowDays: 28, sampleIntervalSeconds: 60 },
    now: new Date('2026-10-21T12:00:30.000Z'),
  });

  assert.equal(payload.servers.length, 1);
  assert.equal(payload.servers[0].id, 'server-0');
  assert.equal(payload.servers[0].name, 'Server 0');
  assert.equal(payload.servers[0].status, 'up');
  assert.equal(payload.servers[0].stale, false);
  assert.equal(payload.servers[0].lastSample, '2026-10-21T11:59:00.000Z');
  assert.equal(payload.servers[0].uptime.percent, 100);
  assert.equal(payload.servers[0].uptime.dataSince, '2026-09-24T00:00:00.000Z');
  assert.equal(payload.servers[0].uptime.daily.length, 28);
  assert.equal(payload.servers[0].uptime.daily[0].date, '2026-09-24');
  assert.equal(payload.overall.uptimePercent, 100);
  assert.equal(payload.overall.counts.up, 1);
  assert.equal(payload.overall.dataSince, '2026-09-24T00:00:00.000Z');
});

test('loadStatusPayload reports downtime and stale data', async () => {
  const servers = resolveServers([{ name: 'Server 0', url: BADGE_URL }]);
  const db = queryDb({
    latest: [
      {
        check_key: BADGE_KEY,
        status: 'down',
        sampled_at: '2026-10-21T11:50:00.000Z',
      },
    ],
    daily: [
      {
        check_key: BADGE_KEY,
        day: '2026-09-24',
        samples: 1440,
        up_samples: 720,
        incidents: 1,
      },
    ],
    first: [{ check_key: BADGE_KEY, first_sample: '2026-09-24T00:00:00.000Z' }],
  });

  const payload = await loadStatusPayload({
    db,
    servers,
    config: { windowDays: 28, sampleIntervalSeconds: 60 },
    now: new Date('2026-10-21T12:00:30.000Z'),
  });

  assert.equal(payload.servers[0].status, 'down');
  assert.equal(payload.servers[0].stale, true);
  assert.equal(payload.servers[0].uptime.percent, 50);
  assert.equal(payload.servers[0].uptime.downSeconds, 720 * 60);
  assert.equal(payload.servers[0].uptime.incidents, 1);
  assert.equal(payload.overall.status, 'down');
});

test('loadStatusPayload marks a check without samples as unavailable', async () => {
  const servers = resolveServers([{ name: 'Server 0', url: BADGE_URL }]);
  const payload = await loadStatusPayload({
    db: queryDb(),
    servers,
    config: { windowDays: 28, sampleIntervalSeconds: 60 },
    now: new Date('2026-10-21T12:00:30.000Z'),
  });

  assert.equal(payload.servers[0].status, 'error');
  assert.equal(payload.servers[0].uptime, null);
  assert.match(payload.servers[0].error, /no status samples/i);
  assert.equal(payload.overall.counts.error, 1);
});

test('loadStatusPayload reports invalid badge URLs', async () => {
  const servers = resolveServers([{ name: 'Broken', url: 'https://example.com/nope' }]);
  const payload = await loadStatusPayload({
    db: queryDb(),
    servers,
    config: { windowDays: 28, sampleIntervalSeconds: 60 },
    now: new Date('2026-10-21T12:00:30.000Z'),
  });

  assert.equal(payload.servers[0].status, 'error');
  assert.equal(payload.servers[0].uptime, null);
  assert.match(payload.servers[0].error, /invalid healthchecks badge url/i);
});

test('loadStatusPayload makes duplicate display names unique', async () => {
  const secondKey = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const servers = resolveServers([
    { name: 'Server', url: BADGE_URL },
    { name: 'Server', url: `https://healthchecks.io/b/2/${secondKey}.json` },
  ]);
  const db = queryDb({
    latest: [
      { check_key: BADGE_KEY, status: 'up', sampled_at: '2026-10-21T11:59:00.000Z' },
      { check_key: secondKey, status: 'up', sampled_at: '2026-10-21T11:59:00.000Z' },
    ],
  });

  const payload = await loadStatusPayload({
    db,
    servers,
    config: { windowDays: 28, sampleIntervalSeconds: 60 },
    now: new Date('2026-10-21T12:00:30.000Z'),
  });

  assert.equal(payload.servers[0].id, 'server');
  assert.equal(payload.servers[1].id, 'server-2');
});

test('loadStatusPayload includes configured process tags', async () => {
  const servers = resolveServers([
    { name: 'Web 01', url: BADGE_URL, processes: ['API', 'Postgres'] },
    { name: 'Bare', url: BADGE_URL },
  ]);
  const payload = await loadStatusPayload({
    db: queryDb(),
    servers,
    config: { windowDays: 28, sampleIntervalSeconds: 60 },
    now: new Date('2026-10-21T12:00:30.000Z'),
  });

  assert.deepEqual(payload.servers[0].processes, ['API', 'Postgres']);
  assert.equal(payload.servers[1].processes, undefined);
});
