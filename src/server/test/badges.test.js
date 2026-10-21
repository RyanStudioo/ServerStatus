import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BadgeError,
  fetchBadgeStatus,
  normalizeBadgeStatus,
  parseBadgeUrl,
  statusIsUp,
} from '../lib/badges.js';

const BADGE_KEY = 'b31e002e-161a-4cfb-9e24-44fa12a8b52d';

test('parseBadgeUrl extracts the key and converts svg URLs to json', () => {
  const badge = parseBadgeUrl(`https://healthchecks.io/b/2/${BADGE_KEY}.svg`);

  assert.equal(badge.badgeKey, BADGE_KEY);
  assert.equal(badge.states, 2);
  assert.equal(badge.url, `https://healthchecks.io/b/2/${BADGE_KEY}.json`);
});

test('parseBadgeUrl supports three-state badges', () => {
  const badge = parseBadgeUrl(`https://healthchecks.io/b/3/${BADGE_KEY}.json`);

  assert.equal(badge.badgeKey, BADGE_KEY);
  assert.equal(badge.states, 3);
});

test('parseBadgeUrl rejects non-badge URLs', () => {
  assert.equal(
    parseBadgeUrl(`https://healthchecks.io/api/v3/checks/${BADGE_KEY}`),
    null,
  );
  assert.equal(parseBadgeUrl('not a url'), null);
});

test('normalizeBadgeStatus maps late to grace', () => {
  assert.equal(normalizeBadgeStatus('late'), 'grace');
  assert.equal(normalizeBadgeStatus('up'), 'up');
  assert.equal(normalizeBadgeStatus('down'), 'down');
  assert.equal(normalizeBadgeStatus('something-else'), 'unknown');
});

test('statusIsUp treats grace as up', () => {
  assert.equal(statusIsUp('up'), true);
  assert.equal(statusIsUp('grace'), true);
  assert.equal(statusIsUp('down'), false);
});

test('fetchBadgeStatus requests the public JSON endpoint', async () => {
  let capturedUrl;
  let capturedInit;

  const status = await fetchBadgeStatus(`https://healthchecks.io/b/2/${BADGE_KEY}.json`, {
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ status: 'up' }), { status: 200 });
    },
  });

  assert.equal(status, 'up');
  assert.equal(capturedUrl, `https://healthchecks.io/b/2/${BADGE_KEY}.json`);
  assert.equal(capturedInit.cache, 'no-store');
});

test('fetchBadgeStatus throws on non-2xx responses', async () => {
  await assert.rejects(
    () =>
      fetchBadgeStatus(`https://healthchecks.io/b/2/${BADGE_KEY}.json`, {
        fetchImpl: async () => new Response('nope', { status: 404 }),
      }),
    (error) => {
      assert.ok(error instanceof BadgeError);
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test('fetchBadgeStatus throws on invalid JSON', async () => {
  await assert.rejects(
    () =>
      fetchBadgeStatus(`https://healthchecks.io/b/2/${BADGE_KEY}.json`, {
        fetchImpl: async () => new Response('not json', { status: 200 }),
      }),
    (error) => error instanceof BadgeError && error.code === 'invalid_response',
  );
});

test('fetchBadgeStatus throws when the status field is missing', async () => {
  await assert.rejects(
    () =>
      fetchBadgeStatus(`https://healthchecks.io/b/2/${BADGE_KEY}.json`, {
        fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
      }),
    (error) => error instanceof BadgeError && error.code === 'invalid_response',
  );
});
