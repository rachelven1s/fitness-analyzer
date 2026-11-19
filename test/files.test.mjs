import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryReader } from '../public/js/engine/lib/zip.js';
import { zipFolder } from '../public/js/engine/zip-folder.js';
import { readCsv, readAll, readJsonGlob, readLines, findFolder, listFiles } from '../public/js/engine/lib/files.js';
import { detect as detectGarmin } from '../public/js/engine/sources/garmin.js';
import { nodePlatform } from '../scripts/lib/disk-folder.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const folderOf = (files) => zipFolder(memoryReader(makeZip(files)), nodePlatform);

test('reads CSV rows, joining files with a prefix in name order', async () => {
  const folder = await folderOf({
    'hr/heart_rate_2.csv': 'timestamp,bpm\r\n2025-01-02,61\r\n',
    'hr/heart_rate_1.csv': '﻿timestamp,bpm\n2025-01-01,60\n"2025-01-01, late","62"\n',
    'hr/other.csv': 'x\n1\n',
  });
  assert.deepEqual(await readAll(folder, 'hr', 'heart_rate_'), [
    { timestamp: '2025-01-01', bpm: '60' },
    { timestamp: '2025-01-01, late', bpm: '62' },
    { timestamp: '2025-01-02', bpm: '61' },
  ]);
  assert.deepEqual(await readCsv(folder, 'hr/missing.csv'), []);
  assert.deepEqual(await readLines(folder, 'hr/heart_rate_2.csv'), ['timestamp,bpm', '2025-01-02,61']);
});

test('reads JSON files matching a test, flattening arrays', async () => {
  const folder = await folderOf({ 'w/b_sleepData.json': '[{"n":2},{"n":3}]', 'w/a_sleepData.json': '{"n":1}', 'w/x.txt': 'no' });
  assert.deepEqual(await readJsonGlob(folder, 'w', (f) => f.endsWith('_sleepData.json')), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(listFiles(folder, 'nowhere', () => true), []);
});

test('finds folders by prefix, ignoring case and files', async () => {
  const folder = await folderOf({ 'Strava-file.txt': 'x', 'STRAVA export/activities.csv': 'a\n' });
  assert.equal(findFolder(folder, '', 'strava'), 'STRAVA export');
  assert.equal(findFolder(folder, '', 'garmin'), null);
});

test('finds the Garmin export at the top of a zip, inside a folder, or in data/garmin*', async () => {
  const f = 'DI_CONNECT/DI-Connect-Aggregator/UDSFile_1.json';
  assert.equal(detectGarmin(await folderOf({ [f]: '[]' })), 'DI_CONNECT');
  assert.equal(detectGarmin(await folderOf({ [`My export/${f}`]: '[]' })), 'My export/DI_CONNECT');
  assert.equal(detectGarmin(await folderOf({ [`garmin - nov/${f}`]: '[]', 'Takeout/x.csv': '' })), 'garmin - nov/DI_CONNECT');
  assert.equal(detectGarmin(await folderOf({ 'a/b/c/DI_CONNECT/x.json': '[]' })), null);
  assert.equal(detectGarmin(await folderOf({ 'strava/activities.csv': '' })), null);
});

test('a multisport parent is skipped in favour of its legs, and an activity without a start is dropped', async () => {
  const { open } = await import('../public/js/engine/sources/garmin.js');
  const leg = (type, start, min) => ({ activityType: type, beginTimestamp: start, startTimeGmt: start, startTimeLocal: start - 4 * 3600e3, duration: min * 60e3, parentId: 1 });
  const t = Date.UTC(2025, 6, 12, 12);
  const folder = await folderOf({
    'DI_CONNECT/DI-Connect-Aggregator/UDSFile_1.json': JSON.stringify([
      { calendarDate: '2025-07-12', totalSteps: 9000, wellnessStartTimeLocal: '2025-07-12T00:00:00.0', wellnessStartTimeGmt: '2025-07-12T04:00:00.0' },
    ]),
    'DI_CONNECT/DI-Connect-Fitness/me_0_summarizedActivities.json': JSON.stringify([{ summarizedActivitiesExport: [
      { activityId: 1, activityType: 'multi_sport', parent: true, startTimeGmt: t, startTimeLocal: t - 4 * 3600e3, duration: 106 * 60e3 },
      leg('open_water_swimming', t, 24),
      leg('road_biking', t + 25 * 60e3, 53),
      { activityType: 'running', duration: 60e3 },
    ] }]),
  });
  const activities = [];
  // Every other record the reader pushes is ignored here.
  const ctx = new Proxy({ activity: (a) => activities.push(a) }, { get: (o, k) => o[k] ?? (() => {}) });
  const source = await open(folder, 'DI_CONNECT', nodePlatform);
  await source.read(ctx);
  assert.deepEqual(activities.map((a) => [a.start, Math.round(a.timerMin)]), [[t, 24], [t + 25 * 60e3, 53]]);
});
