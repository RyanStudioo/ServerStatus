import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../lib/config.js';

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
