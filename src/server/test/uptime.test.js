import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailySeries,
  buildWindow,
  combineOverall,
  roundPercent,
  summarizeDaily,
} from '../lib/uptime.js';

const END = new Date('2026-10-21T12:00:00.000Z');
const WINDOW = buildWindow(END, 28);

test('buildWindow returns 28 UTC calendar days ending today', () => {
  assert.equal(WINDOW.days, 28);
  assert.equal(WINDOW.start.toISOString(), '2026-09-24T00:00:00.000Z');
  assert.equal(WINDOW.end.toISOString(), '2026-10-21T12:00:00.000Z');
});

test('roundPercent never shows 100% when there was downtime', () => {
  assert.equal(roundPercent(99.999, true), 99.99);
  assert.equal(roundPercent(100, false), 100);
  assert.equal(roundPercent(50.555, true), 50.55);
  assert.equal(roundPercent(null, false), null);
});

test('buildDailySeries returns one entry per day and fills missing days', () => {
  const daily = buildDailySeries({
    dailyRows: [
      { day: '2026-09-24', samples: 1440, up_samples: 1440, incidents: 0 },
      { day: '2026-09-25', samples: 1440, up_samples: 720, incidents: 1 },
    ],
    start: WINDOW.start,
    days: 28,
    sampleIntervalSeconds: 60,
  });

  assert.equal(daily.length, 28);
  assert.equal(daily[0].date, '2026-09-24');
  assert.equal(daily[0].uptimePercent, 100);
  assert.equal(daily[1].uptimePercent, 50);
  assert.equal(daily[1].downSeconds, 720 * 60);
  assert.equal(daily[1].incidents, 1);
  assert.equal(daily[2].uptimePercent, null);
  assert.equal(daily.at(-1).date, '2026-10-21');
});

test('summarizeDaily totals samples and downtime', () => {
  const daily = [
    {
      date: '2026-09-24',
      samples: 100,
      upSamples: 90,
      uptimePercent: 90,
      downSeconds: 600,
      incidents: 1,
    },
    {
      date: '2026-09-25',
      samples: 100,
      upSamples: 100,
      uptimePercent: 100,
      downSeconds: 0,
      incidents: 0,
    },
  ];

  const summary = summarizeDaily(daily, 60);

  assert.equal(summary.percent, 95);
  assert.equal(summary.samples, 200);
  assert.equal(summary.upSamples, 190);
  assert.equal(summary.downSamples, 10);
  assert.equal(summary.upSeconds, 11400);
  assert.equal(summary.downSeconds, 600);
  assert.equal(summary.coverageSeconds, 12000);
  assert.equal(summary.incidents, 1);
});

test('combineOverall weights uptime by observed seconds and keeps the earliest data date', () => {
  const result = combineOverall([
    {
      status: 'up',
      uptime: {
        upSeconds: 90,
        downSeconds: 10,
        incidents: 1,
        samples: 100,
        dataSince: '2026-09-25T00:00:00.000Z',
      },
    },
    {
      status: 'down',
      uptime: {
        upSeconds: 0,
        downSeconds: 100,
        incidents: 1,
        samples: 100,
        dataSince: '2026-09-24T00:00:00.000Z',
      },
    },
  ]);

  assert.equal(result.uptimePercent, 45);
  assert.equal(result.status, 'down');
  assert.equal(result.counts.total, 2);
  assert.equal(result.counts.up, 1);
  assert.equal(result.counts.down, 1);
  assert.equal(result.incidents, 2);
  assert.equal(result.samples, 200);
  assert.equal(result.dataSince, '2026-09-24T00:00:00.000Z');
});

test('combineOverall reports unavailable uptime when no samples exist', () => {
  const result = combineOverall([
    {
      status: 'error',
      uptime: null,
    },
  ]);

  assert.equal(result.uptimePercent, null);
  assert.equal(result.status, 'error');
  assert.equal(result.counts.error, 1);
  assert.equal(result.dataSince, null);
});
