// Splits a run's second-by-second record into one-minute pieces so warm-ups, reps, recoveries and
// cool-downs are analysed on their own instead of being averaged into one number per run.

const MIN = 60e3;
export const SEGMENT_RULES = {
  skipFirstMinutes: 10, // heart rate is still climbing at the start of a run
  settleMinutes: 2, // heart rate lags a change of pace by a minute or two
  samePace: 0.08, // minutes within 8% of each other count as the same pace
  // Tuned against 546 laps you marked by hand in 166 interval sessions, and 42 runs held at one pace.
  baselinePercentile: 0.25, // the slower side of the run's minutes, so a rep-heavy session keeps an easy baseline
  fasterBy: 0.1, // a faster segment is at least 10% quicker than that baseline
  fasterMinSeconds: 60, // a 400 m rep is in; strides and GPS blips are out
  mergeGapSeconds: 15, // a brief dip inside a rep (a turn, a GPS wobble) doesn't split it
  pauseSeconds: 20, // a longer gap in recording means the watch was paused
  repSpread: 0.2, // reps in one session are within 20% of the fastest; slower stretches are easy running
  minWorkoutSeconds: 300, // under 5 minutes of faster running in total is a surge, not a workout
  smoothSeconds: 10, // pace is read over a sliding 20-second window to calm GPS jitter
  minKmh: 6.5, // slower than about 9:15 per km is walking or standing
  minRunningHr: 100, // below this while running, the sensor has lost contact (two runs read 63 and 95 bpm)
  maxLowHrShare: 0.25, // past this share of low minutes, none of the run's heart rate is trusted
};

// records: arrays of { t (ms), dist (m, cumulative), hr (bpm or null) }.
export function minuteBins(records) {
  if (records.length < 2) return [];
  const t0 = records[0].t;
  const bins = [];
  for (const r of records) {
    const i = Math.floor((r.t - t0) / MIN);
    let b = bins[i];
    if (!b) {
      b = { index: i, first: r, last: r, hrSum: 0, hrN: 0 };
      bins[i] = b;
    }
    b.last = r;
    if (r.hr) { b.hrSum += r.hr; b.hrN++; }
  }
  return bins.map((b) => {
    if (!b) return null;
    const seconds = (b.last.t - b.first.t) / 1000;
    const metres = b.last.dist - b.first.dist;
    // A minute with a pause or sparse recording can't give a reliable pace.
    if (seconds < 45 || metres <= 0 || !b.hrN) return null;
    return { index: b.index, kmh: (metres / seconds) * 3.6, hr: b.hrSum / b.hrN };
  });
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function segmentRun(records, rules = SEGMENT_RULES) {
  const bins = minuteBins(records);
  const running = bins.filter((b) => b && b.kmh >= rules.minKmh);
  if (!running.length) return null;
  // The baseline is the slower side of the run's own running minutes, so in a rep-heavy session it still
  // reflects the easy running around the reps rather than the reps themselves.
  const sortedKmh = running.map((b) => b.kmh).sort((p, q) => p - q);
  const usual = sortedKmh[Math.floor((sortedKmh.length - 1) * rules.baselinePercentile)];
  const fastLimit = usual * (1 + rules.fasterBy);

  // Faster segments come from the second-by-second record, not whole minutes, so a 400 m rep and its
  // recovery aren't averaged into one minute. Pace is smoothed over a short window to calm GPS jitter.
  // In a session with real reps, easy stretches that merely clear the baseline are much slower than the
  // reps, so only stretches close to the run's fastest one are kept.
  const candidates = fasterBlocks(records, fastLimit, rules);
  const fastestKmh = Math.max(0, ...candidates.map((bl) => (bl.metres / bl.seconds) * 3.6));
  const nearFastest = candidates.filter((bl) => (bl.metres / bl.seconds) * 3.6 >= fastestKmh / (1 + rules.repSpread));
  // A minute or two of surging in an easy run isn't a workout, so a run needs enough faster running in total.
  const totalSeconds = nearFastest.reduce((sum, bl) => sum + bl.seconds, 0);
  const blocks = totalSeconds >= rules.minWorkoutSeconds ? nearFastest : [];
  const blockAt = (t) => blocks.some((bl) => t >= bl.start && t <= bl.end);
  const t0 = records[0].t;
  // A minute that is mostly inside faster segments counts as fast for the steady-minute statistics.
  const fast = new Set();
  bins.forEach((b, i) => {
    if (!b) return;
    let inside = 0;
    for (let s = 0; s < 60; s += 5) if (blockAt(t0 + i * MIN + s * 1000)) inside++;
    if (inside >= 6) fast.add(i);
  });

  // Steady minutes: past the start, and at the same pace as the minutes before, so heart rate has caught up.
  const minutes = [];
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    if (!b || i < rules.skipFirstMinutes || b.kmh < rules.minKmh || b.hr < rules.minRunningHr) continue;
    let settled = true;
    for (let k = 1; k <= rules.settleMinutes; k++) {
      const prev = bins[i - k];
      if (!prev || Math.abs(prev.kmh - b.kmh) / b.kmh > rules.samePace) { settled = false; break; }
    }
    if (!settled) continue;
    minutes.push({ index: i, kmh: b.kmh, hr: b.hr, fast: fast.has(i) });
  }
  const fastMinutes = blocks.reduce((sum, bl) => sum + bl.seconds, 0) / 60;
  // When much of a run reads implausibly low, the sensor wasn't reading properly for the whole run, so
  // its heart rate is dropped. Pace and the faster segments themselves are still usable.
  const lowShare = running.filter((b) => b.hr < rules.minRunningHr).length / running.length;
  if (lowShare > rules.maxLowHrShare) {
    return { usualKmh: usual, minutes: [], fastMinutes, blocks: blocks.map((bl) => ({ ...bl, hr: null })), hrUnreliable: true };
  }
  return { usualKmh: usual, minutes, fastMinutes, blocks };
}

// Contiguous stretches where the smoothed pace stays above the limit, with their own pace and heart rate.
export function fasterBlocks(records, limitKmh, rules = SEGMENT_RULES) {
  const n = records.length;
  const speedAt = new Array(n).fill(0);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const t = records[i].t;
    while (records[lo].t < t - rules.smoothSeconds * 1000) lo++;
    while (hi < n - 1 && records[hi + 1].t <= t + rules.smoothSeconds * 1000) hi++;
    const dt = (records[hi].t - records[lo].t) / 1000;
    speedAt[i] = dt > 0 ? ((records[hi].dist - records[lo].dist) / dt) * 3.6 : 0;
  }
  // Raw spans above the limit, then joined across brief dips, then kept only if long enough.
  const spans = [];
  let start = null;
  for (let i = 0; i < n; i++) {
    const paused = start != null && records[i].t - records[i - 1].t > rules.pauseSeconds * 1000;
    if (paused) { spans.push([start, i - 1]); start = null; }
    if (speedAt[i] >= limitKmh && speedAt[i] >= rules.minKmh) { if (start == null) start = i; } else if (start != null) { spans.push([start, i - 1]); start = null; }
  }
  if (start != null) spans.push([start, n - 1]);
  const joined = [];
  for (const span of spans) {
    const last = joined[joined.length - 1];
    if (last && records[span[0]].t - records[last[1]].t <= rules.mergeGapSeconds * 1000) last[1] = span[1];
    else joined.push([...span]);
  }
  const blocks = [];
  for (const [from, to] of joined) {
    const a = records[from];
    const b = records[to];
    const seconds = (b.t - a.t) / 1000;
    if (seconds < rules.fasterMinSeconds) continue;
    let hrSum = 0; let hrN = 0;
    for (let k = from; k <= to; k++) if (records[k].hr >= rules.minRunningHr) { hrSum += records[k].hr; hrN++; }
    blocks.push({ start: a.t, end: b.t, seconds, metres: b.dist - a.dist, hr: hrN ? hrSum / hrN : null });
  }
  return blocks;
}

// Sums for one group of steady minutes: enough to rebuild pace, heart rate and metres per beat later.
export function summarize(minutes) {
  let km = 0; let beats = 0;
  for (const m of minutes) { km += m.kmh / 60; beats += m.hr; }
  return { min: minutes.length, km, beats };
}
