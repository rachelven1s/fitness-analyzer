import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentRun, minuteBins, summarize } from '../public/js/engine/lib/segments.js';

// Builds a run from [minutes, km/h, heart rate] pieces, one record every 5 seconds.
function makeRun(pieces) {
  const records = [];
  let t = 0;
  let dist = 0;
  for (const [minutes, kmh, hr] of pieces) {
    for (let s = 0; s < minutes * 60; s += 5) {
      records.push({ t: t * 1000, dist, hr });
      t += 5;
      dist += (kmh / 3.6) * 5;
    }
  }
  return records;
}

test('a minute of steady running gives its own pace and heart rate', () => {
  const bins = minuteBins(makeRun([[3, 10, 140]]));
  assert.equal(bins.filter(Boolean).length, 3);
  assert.ok(Math.abs(bins[1].kmh - 10) < 0.01);
  assert.equal(bins[1].hr, 140);
});

test('warm-up, intervals and cool-down are separated, not averaged', () => {
  const seg = segmentRun(makeRun([
    [15, 10, 135], // warm-up at 6:00/km
    [5, 14, 165], [3, 9, 150], [5, 14, 168], [3, 9, 152], [5, 14, 170], // three fast reps with recoveries
    [10, 10, 140], // cool-down
  ]));
  const fast = seg.minutes.filter((m) => m.fast);
  const regular = seg.minutes.filter((m) => !m.fast);
  assert.ok(fast.length > 0, 'the reps are found');
  assert.ok(fast.every((m) => Math.abs(m.kmh - 14) < 0.1), 'only rep minutes are fast');
  assert.ok(regular.every((m) => m.kmh < 11), 'regular running excludes the reps');
  assert.ok(Math.abs(summarize(fast).km / (summarize(fast).min / 60) - 14) < 0.1);
});

test('the first minutes of a run and of each new pace are left out while heart rate catches up', () => {
  const seg = segmentRun(makeRun([[12, 10, 140], [6, 13, 165]]));
  // 12 easy minutes minus the first 10 leaves 2, and the first 2 minutes at the new pace are dropped.
  assert.equal(seg.minutes.filter((m) => m.kmh < 11).length, 2);
  assert.equal(seg.minutes.filter((m) => m.kmh > 12).length, 4);
});

test('walking and stopped minutes are ignored', () => {
  const seg = segmentRun(makeRun([[12, 10, 140], [5, 4, 100], [5, 10, 140]]));
  assert.ok(seg.minutes.every((m) => m.kmh >= 6.5));
});

test('a steady run has no faster segments', () => {
  const seg = segmentRun(makeRun([[40, 11, 150]]));
  assert.equal(seg.fastMinutes, 0);
  assert.ok(seg.minutes.length >= 28);
});

test('short reps are found one by one with their own pace', () => {
  // 6 x 400 m at 3:30/km (about 84 s) with 60 s of standing recovery
  const pieces = [[15, 10, 135]];
  for (let i = 0; i < 6; i++) pieces.push([84 / 60, 400 / 84 * 3.6, 165], [1, 0, 140]);
  pieces.push([10, 10, 138]);
  const seg = segmentRun(makeRun(pieces));
  assert.equal(seg.blocks.length, 6);
  for (const b of seg.blocks) {
    assert.ok(Math.abs(b.seconds - 84) <= 15, `rep length ${b.seconds}`);
    assert.ok(Math.abs(b.metres / b.seconds * 3.6 - 400 / 84 * 3.6) < 0.6, 'rep pace');
  }
});

test('800 m reps with jogged recoveries are found', () => {
  const pieces = [[15, 10, 135]];
  for (let i = 0; i < 5; i++) pieces.push([3, 16.5, 168], [1.5, 8.5, 150]);
  pieces.push([10, 10, 140]);
  const seg = segmentRun(makeRun(pieces));
  assert.equal(seg.blocks.length, 5);
  assert.ok(Math.abs(seg.fastMinutes - 15) < 1.5);
});

test('20-second strides are not faster segments', () => {
  const pieces = [[15, 10, 135]];
  for (let i = 0; i < 4; i++) pieces.push([20 / 60, 18, 150], [1, 9, 140]);
  pieces.push([10, 10, 138]);
  assert.equal(segmentRun(makeRun(pieces)).blocks.length, 0);
});

test('a short surge under a minute is not a faster segment', () => {
  const seg = segmentRun(makeRun([[15, 10, 140], [0.75, 13, 160], [15, 10, 142]]));
  assert.equal(seg.fastMinutes, 0);
});

test('a brief dip inside a rep does not split it in two', () => {
  // A 6-minute rep, long enough to count as a workout, with an 8-second dip in the middle.
  const seg = segmentRun(makeRun([[15, 10, 140], [3, 14, 165], [8 / 60, 10, 165], [3, 14, 168], [15, 10, 142]]));
  assert.equal(seg.blocks.length, 1);
  assert.ok(seg.blocks[0].seconds > 350);
});

test('easy stretches that clear the baseline are dropped when real reps are much faster', () => {
  const pieces = [[12, 9.5, 130], [2, 11.2, 132], [5, 9.5, 131]];
  for (let i = 0; i < 4; i++) pieces.push([3, 16, 168], [1.5, 0, 140]);
  pieces.push([10, 9.5, 135]);
  const seg = segmentRun(makeRun(pieces));
  assert.equal(seg.blocks.length, 4);
  assert.ok(seg.blocks.every((b) => (b.metres / b.seconds) * 3.6 > 15));
});

test('a couple of brief surges in an easy run are not a workout', () => {
  const seg = segmentRun(makeRun([[15, 10, 140], [1.3, 12, 150], [15, 10, 142], [1.2, 12, 151], [10, 10, 141]]));
  assert.equal(seg.blocks.length, 0);
  assert.equal(seg.fastMinutes, 0);
});

test('minutes where the heart-rate sensor lost contact are left out', () => {
  const seg = segmentRun(makeRun([[15, 10, 140], [10, 10, 90], [10, 10, 141]]));
  assert.ok(seg.minutes.every((m) => m.hr >= 100));
});

test('a run whose sensor read low for much of it has no heart-rate figures', () => {
  const seg = segmentRun(makeRun([[15, 10, 95], [10, 10, 104], [10, 10, 96]]));
  assert.equal(seg.hrUnreliable, true);
  assert.equal(seg.minutes.length, 0);
});
