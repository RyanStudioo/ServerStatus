import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, getServers, normalizeServerEntries } from '../lib/config.js';

test('getConfig provides safe defaults', () => {
  const config = getConfig({});

  assert.equal(config.windowDays, 28);
  assert.equal(config.cacheTtlSeconds, 60);
  assert.equal(config.allowedOrigins, '*');
  assert.equal(config.sampleIntervalSeconds, 60);
});

test('getConfig parses values', () => {
  const config = getConfig({
    UPTIME_WINDOW_DAYS: '14',
    CACHE_TTL_SECONDS: '30',
    ALLOWED_ORIGINS: 'https://status.example.com, http://localhost:8080',
  });

  assert.equal(config.windowDays, 14);
  assert.equal(config.cacheTtlSeconds, 30);
  assert.deepEqual(config.allowedOrigins, [
    'https://status.example.com',
    'http://localhost:8080',
  ]);
});

test('getConfig clamps the window and cache to the supported range', () => {
  assert.equal(getConfig({ UPTIME_WINDOW_DAYS: '999' }).windowDays, 90);
  assert.equal(getConfig({ UPTIME_WINDOW_DAYS: '0' }).windowDays, 1);
  assert.equal(getConfig({ CACHE_TTL_SECONDS: '-5' }).cacheTtlSeconds, 0);
});

test('normalizeServerEntries maps names, URLs, and process tags', () => {
  const servers = normalizeServerEntries({
    servers: [
      {
        name: 'Web 01',
        url: 'https://healthchecks.io/b/2/abc.json',
        processes: ['API', ' API ', { name: 'Postgres' }, '', null, 'API'],
      },
      { url: 'https://healthchecks.io/b/2/def.json' },
    ],
  });

  assert.equal(servers.length, 2);
  assert.equal(servers[0].name, 'Web 01');
  assert.equal(servers[0].url, 'https://healthchecks.io/b/2/abc.json');
  assert.deepEqual(servers[0].processes, ['API', 'Postgres']);
  assert.equal(servers[1].name, 'Server 2');
  assert.deepEqual(servers[1].processes, []);
});

test('normalizeServerEntries accepts a bare array and rejects other shapes', () => {
  const servers = normalizeServerEntries([
    { name: 'Bare', url: '', processes: ['api'] },
  ]);

  assert.equal(servers[0].name, 'Bare');
  assert.deepEqual(servers[0].processes, ['api']);
  assert.equal(normalizeServerEntries({ nope: true }), null);
  assert.equal(normalizeServerEntries(null), null);
});

test('getServers returns an empty list when the config URL fails with nothing cached', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  const servers = await getServers({}, {
    fetchImpl: async () => {
      throw new Error('network down');
    },
    now: 1_000,
  });

  assert.deepEqual(servers, []);
});

test('getServers rejects payloads that are not server lists', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  const servers = await getServers({}, {
    fetchImpl: async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    now: 2_000,
  });

  assert.deepEqual(servers, []);
});

test('getServers fetches, normalizes, and caches the gist config', async () => {
  const seenUrls = [];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    seenUrls.push(String(url));
    return new Response(
      JSON.stringify({ servers: [{ name: 'Web 01', url: 'x', processes: ['API'] }] }),
      { status: 200 },
    );
  };

  const first = await getServers({}, { fetchImpl, now: 60_000 });
  assert.deepEqual(first, [{ name: 'Web 01', url: 'x', processes: ['API'] }]);
  assert.match(seenUrls[0], /gist\.githubusercontent\.com\/RyanStudioo\/82070a/);

  // Inside the cache window the config is not re-downloaded.
  const second = await getServers({}, { fetchImpl, now: 75_000 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);

  // After the window it is fetched again.
  await getServers({}, { fetchImpl, now: 120_000 });
  assert.equal(calls, 2);
});

test('getServers falls back to the last known config when the fetch fails', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  const servers = await getServers({}, {
    fetchImpl: async () => {
      throw new Error('boom');
    },
    now: 1_000_000,
  });

  assert.deepEqual(servers, [{ name: 'Web 01', url: 'x', processes: ['API'] }]);
});

test('getServers honors the CONFIG_URL override', async () => {
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(String(url));
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const servers = await getServers(
    { CONFIG_URL: 'https://example.com/config.json' },
    { fetchImpl, now: 2_000_000 },
  );

  assert.deepEqual(servers, []);
  assert.equal(seenUrls[0], 'https://example.com/config.json');
});
