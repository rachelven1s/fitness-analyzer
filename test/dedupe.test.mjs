import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sameEvent, clusterActivities, mergeCluster, matchSyncedCopies, mergeWeights, mergeCycles,
  isImportedGarminWeight, normalizeType, dayOwner,
} from '../scripts/lib/dedupe.mjs';

const MIN = 60e3;
const T0 = Date.UTC(2025, 5, 4, 12, 48);
const act = (source, startMin, lenMin, extra = {}) => ({
  source, start: T0 + startMin * MIN, end: T0 + (startMin + lenMin) * MIN, timerMin: lenMin, type: 'Run', ...extra,
});

test('Garmin and Strava recordings of one run merge', () => {
  assert.equal(sameEvent(act('garmin', 0, 56), act('strava', 0, 56)), true);
});

test('a short walk inside a long run stays separate', () => {
  assert.equal(sameEvent(act('garmin', 0, 120), act('fitbit', 30, 12, { type: 'Walk' })), false);
});

test('a fragment inside another app\'s run of the same type is that run', () => {
  assert.equal(sameEvent(act('strava', 0, 75), act('garmin', 1, 7)), true);
});

test('a longer Strava version of an outdoor run wins over a watch that stopped early', () => {
  const merged = mergeCluster([act('garmin', 0, 150, { km: 24.41 }), act('strava', 0, 176, { km: 30.01 })]);
  assert.equal(merged.km, 30.01);
  assert.equal(merged.timerMin, 176);
});

test('a corrected Strava race distance wins when the time matches', () => {
  const merged = mergeCluster([act('garmin', 0, 19, { km: 6.54 }), act('strava', 0, 19, { km: 5.16 })]);
  assert.equal(merged.km, 5.16);
});

test('treadmill distance stays with the watch', () => {
  const merged = mergeCluster([act('garmin', 0, 64, { km: 10, indoor: true }), act('strava', 0, 64, { km: 8.85 })]);
  assert.equal(merged.km, 10);
});

test('small GPS differences keep the Garmin figure', () => {
  const merged = mergeCluster([act('garmin', 0, 50, { km: 10 }), act('strava', 0, 50, { km: 10.02 })]);
  assert.equal(merged.km, 10);
  assert.equal(merged.distanceFrom, 'garmin');
});

test('a session relabeled on Strava takes Strava\'s type and distance', () => {
  const merged = mergeCluster([
    act('garmin', 0, 40, { km: 4.6, indoor: true, type: 'Run' }),
    act('strava', 0, 40, { km: 2.3, type: 'Elliptical' }),
  ]);
  assert.equal(merged.type, 'Elliptical');
  assert.equal(merged.km, 2.3);
});

test('fragments inside a Strava run collapse into one activity with Strava\'s distance', () => {
  const clusters = clusterActivities([act('strava', 0, 75, { km: 11.6 }), act('garmin', 1, 7, { km: 1.06 }), act('garmin', 11, 7, { km: 0.96 })]);
  assert.equal(clusters.length, 1);
  assert.equal(mergeCluster(clusters[0]).km, 11.6);
});

test('consecutive activities that barely touch stay separate', () => {
  assert.equal(sameEvent(act('garmin', 0, 30), act('strava', 29, 30)), false);
});

test('one source with two different overlapping activities stays separate', () => {
  assert.equal(sameEvent(act('garmin', 0, 60), act('garmin', 10, 30)), false);
});

test('one source logging the same session twice merges', () => {
  assert.equal(sameEvent(act('garmin', 0, 60), act('garmin', 1, 60)), true);
});

test('clustering three sources yields one activity', () => {
  const clusters = clusterActivities([act('garmin', 0, 50), act('strava', 0, 50), act('fitbit', 1, 49), act('garmin', 200, 20)]);
  assert.deepEqual(clusters.map((c) => c.length).sort(), [1, 3]);
});

test('merging prefers Garmin figures, keeps the Strava name and gear, and records every source', () => {
  const merged = mergeCluster([
    act('strava', 0, 50, { name: 'Long run', gear: 'Triumph 22', km: 10.01, type: 'Run' }),
    act('garmin', 0, 50, { name: 'New York Running', km: 10, avgHr: 150 }),
  ]);
  assert.equal(merged.km, 10);
  assert.equal(merged.avgHr, 150);
  assert.equal(merged.name, 'Long run');
  assert.equal(merged.gear, 'Triumph 22');
  assert.deepEqual(merged.sources, ['garmin', 'strava']);
});

test('a specific Strava type replaces a generic Garmin one', () => {
  const merged = mergeCluster([act('garmin', 0, 50, { type: 'Other' }), act('strava', 0, 50, { type: 'Hike' })]);
  assert.equal(merged.type, 'Hike');
});

test('synced copies are found at a consistent clock shift, one to one', () => {
  const targets = [0, 600, 1500, 3000].map((m, i) => act('garmin', m, 40 + i));
  const copies = targets.map((t) => ({ source: 'fitbit', start: t.start - 180 * MIN + 12e3, end: t.start - 180 * MIN + 12e3 + t.timerMin * MIN }));
  copies.push({ source: 'fitbit', start: T0 + 90000 * MIN, end: T0 + 90030 * MIN });
  const { matches, unmatched, clockShift } = matchSyncedCopies(copies, targets);
  assert.equal(clockShift, 3);
  assert.equal(matches.length, 4);
  assert.equal(new Set(matches.map((m) => m.target)).size, 4);
  assert.equal(unmatched.length, 1);
});

test('a same-length activity at an unrelated shift is not treated as a copy', () => {
  const targets = [0, 600, 1500].map((m) => act('garmin', m, 45));
  const copies = [...targets.map((t) => ({ source: 'fitbit', start: t.start - 180 * MIN, end: t.start - 135 * MIN })),
    { source: 'fitbit', start: T0 + 2000 * MIN - 300 * MIN, end: T0 + 2000 * MIN - 255 * MIN }];
  targets.push(act('garmin', 2000, 45));
  const { matches } = matchSyncedCopies(copies, targets.slice(0, 3));
  assert.equal(matches.length, 3);
});

test('readings repeated across exports count once per day', () => {
  const [day] = mergeWeights([
    { date: '2025-01-01', lb: 110 }, { date: '2025-01-01', lb: 110 }, { date: '2025-01-01', lb: 112 },
  ]);
  assert.equal(day.lb, 111);
  assert.equal(day.readings, 2);
});

test('imported Garmin rows are dropped only before the watch arrived', () => {
  assert.equal(isImportedGarminWeight('2022-05-01', '8:00 PM', '2022-06-04'), true);
  assert.equal(isImportedGarminWeight('2021-01-01', '7:00 PM', '2022-06-04'), true);
  assert.equal(isImportedGarminWeight('2022-05-01', '9:14 AM', '2022-06-04'), false);
  assert.equal(isImportedGarminWeight('2025-01-01', '8:00 PM', '2022-06-04'), false);
});

test('cycles from two apps within a few days are one cycle, and a confirmed record wins', () => {
  const merged = mergeCycles([
    [{ start: '2022-05-24', confirmed: false, source: 'fitbit' }],
    [{ start: '2022-05-25', confirmed: true, source: 'garmin' }, { start: '2022-06-21', confirmed: true, source: 'garmin' }],
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].confirmed, true);
});

test('every day has exactly one owning watch', () => {
  assert.equal(dayOwner('2022-06-03', '2022-06-04'), 'fitbit');
  assert.equal(dayOwner('2022-06-04', '2022-06-04'), 'garmin');
});

test('activity types from all three exports normalize together', () => {
  for (const raw of ['running', 'Run', 'Outdoor Run', 'treadmill_running']) assert.equal(normalizeType(raw), 'Run');
  assert.equal(normalizeType('resort_skiing'), 'Snow');
  assert.equal(normalizeType('something new'), 'Other');
});

test('excluded stretches drop the days inside them and the nights that end inside them', async () => {
  const { makeExclusions } = await import('../scripts/lib/exclusions.mjs');
  const ex = makeExclusions([{ from: '2026-05-08', to: '2026-05-25' }]);
  assert.equal(ex.day('2026-05-07'), false);
  assert.equal(ex.day('2026-05-08'), true);
  assert.equal(ex.day('2026-05-25'), true);
  assert.equal(ex.day('2026-05-26'), false);
  assert.equal(ex.night('2026-05-08'), false, 'the night before taking it off was worn');
  assert.equal(ex.night('2026-05-09'), true);
  assert.equal(ex.night('2026-05-25'), true);
  assert.equal(ex.night('2026-05-26'), false, 'it went back on the evening of the 25th');
  assert.throws(() => makeExclusions([{ from: '2026-05-25', to: '2026-05-08' }]));
});

test('sick days are flagged but not treated as unworn', async () => {
  const { makeExclusions } = await import('../scripts/lib/exclusions.mjs');
  const ex = makeExclusions([{ from: '2026-01-03', to: '2026-01-12', kind: 'sick' }, { from: '2026-05-08', to: '2026-05-25' }]);
  assert.equal(ex.sick('2026-01-05'), true);
  assert.equal(ex.sick('2026-01-13'), false);
  assert.equal(ex.day('2026-01-05'), false, 'wrist data from sick days is kept');
  assert.equal(ex.night('2026-01-05'), false);
  assert.equal(ex.day('2026-05-10'), true);
  assert.equal(ex.sick('2026-05-10'), false);
  assert.throws(() => makeExclusions([{ from: '2026-01-03', to: '2026-01-12', kind: 'holiday' }]));
});
