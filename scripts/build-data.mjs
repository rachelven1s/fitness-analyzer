// Reads the exports in ./data through the source modules in ./sources (Fitbit via Google Takeout, Garmin,
// Strava), removes the overlaps between them and writes aggregated JSON to ./public/generated. Raw files are
// never served.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSources } from './sources/index.mjs';
import { makeExclusions } from './lib/exclusions.mjs';
import { segmentRun, summarize, SEGMENT_RULES } from './lib/segments.mjs';
import { matchSyncedCopies, clusterActivities, mergeCluster, mergeWeights, mergeCycles, dayOwner, sourcePriority } from './lib/dedupe.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'public', 'generated');

const MIN = 60e3;
const DAY = 86400e3;

const EXCLUSIONS_FILE = path.join(ROOT, 'exclusions.json');
const excluded = makeExclusions(fs.existsSync(EXCLUSIONS_FILE) ? JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8')) : []);
const excludedCounts = { hrMinutes: 0, nights: 0, days: 0 };
// Dates you know something changed (a move, a new job), shown as markers on the charts.
const EVENTS_FILE = path.join(ROOT, 'events.json');
const lifeEvents = fs.existsSync(EVENTS_FILE) ? JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')) : [];

const t0 = Date.now();
const log = (...a) => console.log(`[build +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------- small utilities ----------

const ms = (s) => Date.parse(s);
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dayDiff = (a, b) => Math.round((ms(`${b}T00:00:00Z`) - ms(`${a}T00:00:00Z`)) / DAY);
const addDays = (d, n) => isoDay(ms(`${d}T00:00:00Z`) + n * DAY);
function bump(map, key, by = 1) { map.set(key, (map.get(key) || 0) + by); }

const days = new Map();
function dayRecord(date) {
  let r = days.get(date);
  if (!r) { r = { date }; days.set(date, r); }
  return r;
}

const coverage = new Map(); // "row|source" -> Map(month -> count)
function cover(row, source, date) {
  const key = `${row}|${source}`;
  if (!coverage.has(key)) coverage.set(key, new Map());
  bump(coverage.get(key), date.slice(0, 7));
}

// ---------- the exports, and which watch owns each day ----------

const sources = openSources(DATA);
const sourceById = new Map(sources.map((s) => [s.id, s]));
const watches = sources.filter((s) => s.kind === 'watch').sort((a, b) => a.firstDay.localeCompare(b.firstDay));
const apps = sources.filter((s) => s.kind === 'app');
if (!watches.length) {
  throw new Error(`No watch export found in ${DATA}. Expected a Garmin export (a garmin* folder holding DI_CONNECT) or a Fitbit Google Takeout (Takeout/Google Health).`);
}
const eras = watches.map((w, i) => ({ source: w, from: w.firstDay, to: watches[i + 1]?.firstDay ?? null }));
const ownerOf = (date) => dayOwner(date, eras);
// The latest watch is the main record: the year-over-year chapters use only its days, when one watch measured
// everything the same way. HANDOVER is its first full day.
const mainWatch = watches[watches.length - 1];
const HANDOVER = mainWatch.firstDay;
const handoverMs = ms(`${HANDOVER}T00:00:00Z`);
log(`watches ${eras.map((e) => `${e.source.label} from ${e.from}`).join(', ')}; apps ${apps.map((a) => a.label).join(', ') || 'none'}`);

// ---------- local time: one UTC offset for every UTC day of the record ----------

// The owning watch's offset wins on its days; any other watch fills the gaps.
const knownOffset = new Map();
for (const w of watches) {
  for (const [date, o] of w.offsets ?? []) {
    if (!knownOffset.has(date) || ownerOf(date) === w) knownOffset.set(date, o);
  }
}
if (!knownOffset.size) throw new Error('None of the exports record a time zone, so local days cannot be worked out');
const offsetDays = [...knownOffset.keys()].sort();
const BASE_DAY = Math.floor(ms(`${offsetDays[0]}T00:00:00Z`) / DAY) - 2;
const LAST_DAY = Math.floor(ms(`${offsetDays[offsetDays.length - 1]}T00:00:00Z`) / DAY) + 2;
const offsetTable = new Float32Array(LAST_DAY - BASE_DAY + 1);
{
  let cur = knownOffset.get(offsetDays[0]);
  for (let d = BASE_DAY; d <= LAST_DAY; d++) {
    const key = isoDay(d * DAY);
    if (knownOffset.has(key)) cur = knownOffset.get(key);
    offsetTable[d - BASE_DAY] = cur;
  }
}
const offsetAt = (t) => {
  const i = Math.floor(t / DAY) - BASE_DAY;
  return offsetTable[Math.max(0, Math.min(offsetTable.length - 1, i))];
};
const toLocal = (t) => t + offsetAt(t) * 3600e3;

// Local date strings are requested millions of times, so they are cached by day number.
const dateCache = new Map();
const dateOfLocal = (local) => {
  const d = Math.floor(local / DAY);
  let s = dateCache.get(d);
  if (!s) { s = isoDay(d * DAY); dateCache.set(d, s); }
  return s;
};

// ---------- one per-minute heart-rate timeline across the watches ----------

const HR_BASE_MIN = Math.floor((BASE_DAY * DAY) / MIN);
const HR_MINUTES = (LAST_DAY - BASE_DAY + 1) * 1440;
const hrSum = new Float32Array(HR_MINUTES);
const hrCnt = new Uint16Array(HR_MINUTES);
const hrPeak = new Uint8Array(HR_MINUTES);

function addHr(t, bpm) {
  const i = Math.floor(t / MIN) - HR_BASE_MIN;
  if (i < 0 || i >= HR_MINUTES) return;
  if (excluded.day(dateOfLocal(toLocal(t)))) { excludedCounts.hrMinutes++; return; }
  hrSum[i] += bpm;
  hrCnt[i]++;
  if (bpm > hrPeak[i]) hrPeak[i] = Math.min(255, bpm);
}
function firstHrMs() {
  for (let i = 0; i < HR_MINUTES; i++) if (hrCnt[i]) return (i + HR_BASE_MIN) * MIN;
  return Infinity;
}
function heartRateBetween(startMs, endMs) {
  let sum = 0; let n = 0; let peak = 0;
  for (let m = Math.floor(startMs / MIN); m <= Math.floor(endMs / MIN); m++) {
    const i = m - HR_BASE_MIN;
    if (i >= 0 && i < HR_MINUTES && hrCnt[i]) { sum += hrSum[i]; n += hrCnt[i]; if (hrPeak[i] > peak) peak = hrPeak[i]; }
  }
  return { hr: n ? sum / n : null, peak: peak || null };
}

// ---------- what the sources push: see sources/index.mjs ----------

let hrSamples = 0;
const droppedHr = {};
// The only direct comparison of two watches: minutes when both recorded, around a switch.
const nearSwitch = new Map(); // source id -> Map(minute -> [sum, count]) within two days of handing over
const watchOverlap = [];
const activityHr = new Map(); // source id -> Map(utc minute -> [sum, count, peak])

const stepIntraday = new Map(); // local date -> [96] 15-minute buckets
const weekHour = Array.from({ length: 7 }, () => new Array(24).fill(0));
const weekHourDays = new Array(7).fill(0);
const seenWeekDays = new Set();
function addIntradaySteps(local, steps) {
  const date = dateOfLocal(local);
  if (excluded.day(date)) return;
  let b = stepIntraday.get(date);
  if (!b) { b = new Array(96).fill(0); stepIntraday.set(date, b); }
  const minOfDay = Math.floor((local % DAY) / MIN);
  b[Math.floor(minOfDay / 15)] += steps;
  const dow = new Date(local).getUTCDay();
  weekHour[dow][Math.floor(minOfDay / 60)] += steps;
  if (!seenWeekDays.has(date)) { seenWeekDays.add(date); weekHourDays[dow]++; }
}
const stressHour = Array.from({ length: 7 }, () => new Array(24).fill(0).map(() => [0, 0]));

const STAGE_CHAR = { LIGHT: 'L', DEEP: 'D', REM: 'R' };
const BIN_MIN = 5;
const NIGHT_ANCHOR_HOUR = 18; // bins count from 18:00 the evening before waking
const TOTAL_BINS = 24 * 12;
const anchorFor = (date) => ms(`${date}T00:00:00Z`) - (24 - NIGHT_ANCHOR_HOUR) * 3600e3;
const nights = [];
function pushNight(n, bins) {
  if (excluded.night(n.date)) { excludedCounts.nights++; return; }
  const first = bins.findIndex((c) => c !== '.');
  let last = TOTAL_BINS - 1;
  while (last > 0 && bins[last] === '.') last--;
  const anchor = anchorFor(n.date);
  const bed = Math.round((n.start - anchor) / MIN);
  const wake = Math.round((n.end - anchor) / MIN);
  nights.push({
    d: n.date,
    src: n.src,
    b: first,
    s: first >= 0 ? bins.slice(first, last + 1).join('') : '',
    score: n.score == null ? null : round(n.score, 0),
    asleep: Math.round(n.asleep),
    deep: Math.round(n.deep),
    rem: Math.round(n.rem),
    light: Math.round(n.light),
    awake: Math.round(n.awake),
    bed,
    wake,
  });
  const r = dayRecord(n.date);
  r.sleepMin = Math.round(n.asleep);
  if (n.score != null) r.score = round(n.score, 0);
  r.deep = Math.round(n.deep);
  r.rem = Math.round(n.rem);
  r.awake = Math.round(n.awake);
  r.inBed = wake - bed;
  r.bed = bed;
  r.wake = wake;
  cover('Sleep', n.src, n.date);
}
// A night with stage timing is painted stage by stage; one without is painted as plain "asleep".
function nightBins(n) {
  const anchor = anchorFor(n.date);
  const bins = new Array(TOTAL_BINS).fill('.');
  const binAt = (t, round) => round((t - anchor) / (BIN_MIN * MIN));
  if (!n.stages) {
    const a = Math.max(0, binAt(n.start, Math.floor));
    const b = Math.min(TOTAL_BINS, binAt(n.end, Math.ceil));
    for (let k = a; k < b; k++) bins[k] = 'A';
    return bins;
  }
  for (const p of n.stages) {
    const ch = STAGE_CHAR[p.type];
    if (!ch) continue;
    const a = Math.max(0, binAt(p.a, Math.floor));
    const b = Math.min(TOTAL_BINS, binAt(p.b, Math.ceil));
    for (let i = a; i < b; i++) if (bins[i] === '.') bins[i] = ch;
  }
  return bins;
}

const activityLists = new Map(); // source id -> activity records
const fitTracks = [];
const plainRoutes = [];
const weightReadings = [];
const cycleLists = new Map(); // source id -> cycles
let iudDate = null;
const foodEntries = [];
const foodSources = new Set();
const hydrationByDay = new Map();
const prs = {};
let stepRecord = null;
const notes = {};

function contextFor(source) {
  const at = eras.findIndex((e) => e.source === source);
  const era = eras[at] ?? null;
  const owns = (date) => ownerOf(date) === source;
  const switchMs = era?.to ? ms(`${era.to}T00:00:00Z`) : null;
  const near = switchMs != null ? new Map() : null;
  if (near) nearSwitch.set(source.id, near);
  const before = at > 0 ? nearSwitch.get(eras[at - 1].source.id) : null;
  return {
    toLocal, dateOfLocal, offsetAt, owns, excluded, firstHrMs,
    era: era && { from: era.from, to: era.to },
    hr(t, bpm) {
      if (near && Math.abs(t - switchMs) < 2 * DAY) {
        const minute = Math.floor(t / MIN);
        const m = near.get(minute) || [0, 0];
        m[0] += bpm; m[1]++;
        near.set(minute, m);
      }
      // Isolated samples from the old watch after it came off the wrist aren't real wear, so require several a minute.
      const old = before?.get(Math.floor(t / MIN));
      if (old && old[1] >= 3) watchOverlap.push(bpm - old[0] / old[1]);
      if (!owns(dateOfLocal(toLocal(t)))) { droppedHr[source.id] = (droppedHr[source.id] || 0) + 1; return; }
      addHr(t, bpm);
      hrSamples++;
    },
    activityHr(t, bpm) {
      if (!activityHr.has(source.id)) activityHr.set(source.id, new Map());
      const minute = Math.floor(t / MIN);
      let m = activityHr.get(source.id).get(minute);
      if (!m) { m = [0, 0, 0]; activityHr.get(source.id).set(minute, m); }
      m[0] += bpm; m[1]++; if (bpm > m[2]) m[2] = bpm;
    },
    steps(t, n) {
      const local = toLocal(t);
      if (owns(dateOfLocal(local))) addIntradaySteps(local, n);
    },
    stress(t, level) {
      const local = toLocal(t);
      const date = dateOfLocal(local);
      if (!owns(date) || excluded.day(date)) return;
      const cell = stressHour[new Date(local).getUTCDay()][new Date(local).getUTCHours()];
      cell[0] += level;
      cell[1]++;
    },
    day(date, fields) {
      if (!owns(date)) return;
      if (excluded.day(date)) { excludedCounts.days++; return; }
      const r = dayRecord(date);
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) r[k] = v;
      if (fields.steps != null) cover('Steps', source.id, date);
      if (fields.stress != null) cover('Stress and recovery', source.id, date);
    },
    estimate(date, fields) {
      if (owns(date)) Object.assign(dayRecord(date), fields);
    },
    night(n) {
      if (owns(n.date)) pushNight({ ...n, src: source.id }, nightBins(n));
    },
    activity(a) {
      if (!activityLists.has(source.id)) activityLists.set(source.id, []);
      activityLists.get(source.id).push({ source: source.id, ...a });
    },
    track(track) { fitTracks.push({ ...track, source: source.id }); },
    route(r) { plainRoutes.push({ ...r, source: source.id }); },
    weight(date, lb) { weightReadings.push({ date, lb, source: source.id }); },
    cycle(c) {
      if (!cycleLists.has(source.id)) cycleLists.set(source.id, []);
      cycleLists.get(source.id).push({ source: source.id, ...c });
    },
    birthControl(date) { iudDate ??= date; },
    food(entry) { foodEntries.push(entry); foodSources.add(source.id); },
    drink(date, ml) { bump(hydrationByDay, date, ml); },
    personalRecord(key, t, sec, current) { (prs[key] ||= []).push({ d: dateOfLocal(toLocal(t)), sec, current }); },
    stepRecord(value) { stepRecord = { value }; },
    note(key, value) { notes[key] = value; },
  };
}

for (const s of [...watches, ...apps]) {
  s.read(contextFor(s));
  log(`read ${s.label}`);
}
log(`heart rate samples ${hrSamples}, dropped on another watch's days ${JSON.stringify(droppedHr)}`);

// Monitoring files often skip the minutes of a recorded activity, so those fill only empty minutes.
let filledFromActivities = 0;
for (const [id, minutes] of activityHr) {
  const source = sourceById.get(id);
  for (const [minute, [s, n, peak]] of minutes) {
    const i = minute - HR_BASE_MIN;
    if (i < 0 || i >= HR_MINUTES || hrCnt[i]) {
      if (i >= 0 && i < HR_MINUTES && peak > hrPeak[i]) hrPeak[i] = Math.min(255, peak);
      continue;
    }
    const minuteDate = dateOfLocal(toLocal(minute * MIN));
    if (ownerOf(minuteDate) !== source || excluded.day(minuteDate)) continue;
    hrSum[i] = s;
    hrCnt[i] = n;
    hrPeak[i] = Math.min(255, peak);
    filledFromActivities++;
  }
}

// ---------- heart-rate aggregates over the merged timeline ----------

const HR_BINS = 48;
const hrGrid = new Map();
const hrIntraday = new Map();
const hrHourYear = {};
const hrDayStats = new Map();
let heartbeats = 0;
let heartbeatsMain = 0;
{
  let lastCovered = -1;
  for (let i = 0; i < HR_MINUTES; i++) {
    if (!hrCnt[i]) continue;
    const bpm = hrSum[i] / hrCnt[i];
    // Integrate only over short gaps so off-wrist stretches don't inflate the count.
    if (lastCovered >= 0) {
      const gap = i - lastCovered;
      if (gap <= 2) {
        const beats = (hrSum[lastCovered] / hrCnt[lastCovered]) * gap;
        heartbeats += beats;
        if ((lastCovered + HR_BASE_MIN) * MIN >= handoverMs) heartbeatsMain += beats;
      }
    }
    lastCovered = i;
    const t = (i + HR_BASE_MIN) * MIN;
    const local = toLocal(t);
    const date = dateOfLocal(local);
    const minOfDay = Math.floor((local % DAY) / MIN);
    let g = hrGrid.get(date);
    if (!g) {
      g = [new Float64Array(HR_BINS), new Uint32Array(HR_BINS)];
      hrGrid.set(date, g);
      hrIntraday.set(date, [new Float64Array(288), new Uint32Array(288)]);
      hrDayStats.set(date, { max: 0, minutes: 0, sum: 0 });
    }
    const bin = Math.floor(minOfDay / 30);
    g[0][bin] += bpm; g[1][bin]++;
    const five = hrIntraday.get(date);
    const fb = Math.floor(minOfDay / 5);
    five[0][fb] += bpm; five[1][fb]++;
    const hd = hrDayStats.get(date);
    if (hrPeak[i] > hd.max) hd.max = hrPeak[i];
    hd.minutes++;
    hd.sum += bpm;
    const y = date.slice(0, 4);
    const hy = (hrHourYear[y] ||= [new Float64Array(24), new Uint32Array(24)]);
    const hour = Math.floor(minOfDay / 60);
    hy[0][hour] += bpm; hy[1][hour]++;
  }
}
for (const [date, hd] of hrDayStats) {
  const r = dayRecord(date);
  r.hrMax = hd.max;
  r.hrCov = round(hd.minutes / 1440, 3);
  r.hrAvg = round(hd.sum / hd.minutes, 1);
  // Raw heart rate at 3-5 AM: the same quantity from any watch, unlike each app's own "resting" formula.
  const g = hrGrid.get(date);
  let nightSum = 0; let nightN = 0;
  for (let b = 6; b < 10; b++) { nightSum += g[0][b]; nightN += g[1][b]; }
  if (nightN >= 30) r.overnight = round(nightSum / nightN, 1);
  let daySum = 0; let dayN = 0;
  for (let b = 20; b < 36; b++) { daySum += g[0][b]; dayN += g[1][b]; }
  if (dayN >= 120) r.daytime = round(daySum / dayN, 1);
  cover('Heart rate', ownerOf(date).id, date);
}
// A watch's resting number can run wild when it barely recorded. Without enough wear, or far above the
// night's own rate, it isn't real.
let rhrDropped = 0;
const rhrDroppedDates = [];
for (const date of [...days.keys()].sort()) {
  const r = days.get(date);
  if (r.rhr == null || !ownerOf(date).checksResting) continue;
  if ((r.hrCov ?? 0) < 0.5 || (r.overnight != null && r.rhr - r.overnight > 15)) {
    r.rhr = null;
    rhrDropped++;
    rhrDroppedDates.push(date);
  }
}
log(`not-worn exclusions ${JSON.stringify(excludedCounts)}`);
log(`resting readings dropped ${rhrDropped}: ${rhrDroppedDates.join(' ')}`);
log(`heart-rate days ${hrGrid.size}, heartbeats ${Math.round(heartbeats)}, filled from activities ${filledFromActivities}`);

nights.sort((a, b) => a.d.localeCompare(b.d));
log(`nights ${nights.length} (skipped ${notes.nightsSkipped ?? 0}); sleep stages vs score file ${notes.sleepStageVsScoreMedianDiffMin ?? '-'} min`);

// ---------- activities from every source ----------

// Activities logged by hand without their own sensor data take heart rate from the all-day record.
for (const list of activityLists.values()) {
  for (const a of list) {
    if (!a.hrFromTimeline) continue;
    const stream = heartRateBetween(a.start, a.end);
    a.avgHr ??= stream.hr;
    a.maxHr ??= stream.peak;
  }
}
const byPriority = [...activityLists.keys()].sort((a, b) => sourcePriority(b) - sourcePriority(a));
const listOf = (id) => activityLists.get(id) || [];
const copies = byPriority.flatMap((id) => listOf(id).filter((r) => r.maybeCopy));
const copySources = [...new Set(copies.map((r) => r.source))];
const syncMatches = [];
const genuineManual = [];
let clockShift = null;
// Manually logged entries are often another source's activity synced across with the clock moved.
for (const id of copySources) {
  const targets = byPriority.filter((other) => other !== id).flatMap((other) => listOf(other).filter((r) => !r.maybeCopy));
  const result = matchSyncedCopies(copies.filter((r) => r.source === id), targets);
  syncMatches.push(...result.matches);
  genuineManual.push(...result.unmatched);
  clockShift ??= result.clockShift;
}
const copySet = new Set(syncMatches.map((m) => m.copy));
const syncedTargets = new Map(syncMatches.map((m) => [m.target, m.copy]));
log(`manual entries ${copies.length}: synced copies ${syncMatches.length} at +${clockShift}h, genuine ${genuineManual.length}`);

const allRecords = byPriority.flatMap((id) => listOf(id).filter((r) => !copySet.has(r)));
const clusters = clusterActivities(allRecords);
const merged = clusters.map((cluster) => {
  const m = mergeCluster(cluster);
  // Note the copies that were folded into this activity.
  for (const r of cluster) {
    const copy = syncedTargets.get(r);
    if (copy && !m.sources.includes(copy.source)) m.sources.push(copy.source);
  }
  return m;
});
merged.sort((a, b) => a.start - b.start);
const isRecording = (r) => sourceById.get(r.source).recordsTracks;
const isApp = (r) => sourceById.get(r.source).kind === 'app';
const distanceDisagreements = [];
const typeDisagreements = [];
clusters.forEach((cluster) => {
  const g = cluster.filter(isRecording);
  const s = cluster.find(isApp);
  if (!g.length || !s) return;
  const best = g.reduce((a, b) => ((b.timerMin || 0) > (a.timerMin || 0) ? b : a));
  if (Math.abs((best.km || 0) - (s.km || 0)) > 0.3) {
    const m = mergeCluster(cluster);
    distanceDisagreements.push({ date: isoDay(best.start), garmin: round(best.km, 2), strava: round(s.km, 2), used: m.distanceFrom, type: m.type, garminMin: Math.round(best.timerMin), stravaMin: Math.round(s.timerMin) });
  }
  const types = new Set(cluster.map((r) => r.type));
  if (types.size > 1) typeDisagreements.push(`${isoDay(best.start)} ${[...types].join('/')}`);
});
log(`distance disagreements ${JSON.stringify(distanceDisagreements)}`);
log(`type disagreements ${typeDisagreements.length}: ${typeDisagreements.join(', ')}`);
const clusterCounts = { garminStrava: 0, garminOnly: 0, stravaOnly: 0, fitbitOnly: 0, sameSource: 0 };
clusters.forEach((c) => {
  const s = new Set(c.map((r) => r.source));
  if (s.has('garmin') && s.has('strava')) clusterCounts.garminStrava++;
  else if (s.has('garmin')) clusterCounts.garminOnly++;
  else if (s.has('strava')) clusterCounts.stravaOnly++;
  else clusterCounts.fitbitOnly++;
  const ofSource = c.reduce((m, r) => { m[r.source] = (m[r.source] || 0) + 1; return m; }, {});
  if (Object.values(ofSource).some((n) => n > 1)) clusterCounts.sameSource++;
});
log(`activities raw ${allRecords.length + syncMatches.length} -> merged ${merged.length} ${JSON.stringify(clusterCounts)}`);

const workouts = merged.map((a) => {
  const off = a.offset != null ? a.offset : offsetAt(a.start);
  const local = a.start + off * 3600e3;
  const date = dateOfLocal(local);
  const r = dayRecord(date);
  const minutes = a.timerMin ?? (a.end - a.start) / MIN;
  r.workouts = (r.workouts || 0) + 1;
  r.workoutMin = (r.workoutMin || 0) + minutes;
  if (a.type === 'Run') r.runKm = (r.runKm || 0) + (a.km || 0);
  const sourcesOf = a.sources.map((id) => sourceById.get(id));
  // Activities that exist only on an app keep the route uploaded there.
  const routeApp = sourcesOf.some((s) => s.recordsTracks) ? null : sourcesOf.find((s) => s.readRoute);
  return {
    d: date,
    h: round((local % DAY) / 3600e3, 2),
    min: Math.round(minutes),
    type: a.type,
    indoor: a.indoor || undefined,
    src: a.sources.map((s) => s[0]).join(''),
    cal: a.calories ? Math.round(a.calories) : null,
    hr: round(a.avgHr, 0),
    peak: round(a.maxHr, 0),
    steps: a.steps ? Math.round(a.steps) : null,
    km: a.km ? round(a.km, 2) : null,
    gainM: a.gainM != null ? Math.round(a.gainM) : null,
    name: a.name && !/^(New York|Running|Walking|Morning|Lunch|Afternoon|Evening|Night)\b.*$/.test(a.name) && !['Outdoor Walk', 'Outdoor Run', 'Outdoor Bike'].includes(a.name) ? a.name : undefined,
    gear: a.gear || undefined,
    effort: a.effort || undefined,
    _start: a.start,
    _end: a.end,
    _file: routeApp && a.file ? a.file : null,
    _app: routeApp,
    _place: a.place ?? null,
  };
});
for (const m of merged) {
  for (const s of m.sources) {
    const w = dateOfLocal(m.start + (m.offset ?? offsetAt(m.start)) * 3600e3);
    cover(`Activities: ${sourceById.get(s).label}`, s, w);
  }
}


// ---------- runs minute by minute: regular running and faster segments analysed separately ----------

const runSegments = [];
for (const track of fitTracks) {
  // Outdoor runs only: treadmill and virtual runs get speed from the wrist, not GPS.
  if (track.sport !== 1 || track.subSport !== 0 || track.recs.length < 60) continue;
  const seg = segmentRun(track.recs);
  if (!seg || (!seg.minutes.length && !seg.hrUnreliable)) continue;
  const start = track.start ?? track.recs[0].t;
  const owner = workouts.find((w) => w.type === 'Run' && Math.abs(w._start - start) <= 3 * MIN);
  if (owner) runSegments.push({ owner, seg, years: (start - handoverMs) / (365.25 * DAY) });
}
// Faster minutes carry you further per beat even with no change in fitness. One slope, fitted on every
// steady minute alongside a time trend, puts every minute on the same 6:00/km footing.
const REF_KMH = 10;
const perBeat = (m) => (m.kmh / 60 * 1000) / m.hr;
let perKmh = 0;
let steadyMinuteCount = 0;
{
  const xs = [];
  for (const { seg, years } of runSegments) for (const m of seg.minutes) xs.push([1, years, m.kmh, perBeat(m)]);
  const xtx = [0, 1, 2].map((i) => [0, 1, 2].map((j) => xs.reduce((sum, x) => sum + x[i] * x[j], 0)));
  const xty = [0, 1, 2].map((i) => xs.reduce((sum, x) => sum + x[i] * x[3], 0));
  const m = xtx.map((r, i) => [...r, xty[i]]);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === j) continue;
      const f = m[j][i] / m[i][i];
      for (let k = i; k < 4; k++) m[j][k] -= f * m[i][k];
    }
  }
  perKmh = m[2][3] / m[2][2];
  steadyMinuteCount = xs.length;
}
for (const { owner, seg } of runSegments) {
  const regular = summarize(seg.minutes.filter((m) => !m.fast));
  // Faster segments use their own blocks, whatever their length, so short reps are included.
  const fast = seg.blocks.reduce((acc, bl) => ({
    min: acc.min + bl.seconds / 60,
    km: acc.km + bl.metres / 1000,
    beats: acc.beats + (bl.hr ? (bl.hr * bl.seconds) / 60 : 0),
  }), { min: 0, km: 0, beats: 0 });
  const adjusted = seg.minutes.length ? mean(seg.minutes.map((m) => perBeat(m) - perKmh * (m.kmh - REF_KMH))) : null;
  owner.seg = {
    rk: round(regular.km, 3), rm: regular.min, rb: Math.round(regular.beats),
    fk: round(fast.km, 3), fm: round(fast.min, 2), fb: Math.round(fast.beats),
    // Faster-segment minutes that have heart rate, so averages aren't diluted by a run whose sensor failed.
    fhm: seg.hrUnreliable ? 0 : round(fast.min, 2),
    fmin: round(seg.fastMinutes, 1),
    reps: seg.blocks.length,
    hrOk: !seg.hrUnreliable,
    adj: round(adjusted, 4),
  };
}
// ---------- heart rate at each pace, year by year ----------

// Pace buckets in seconds per km, narrower where heart rate changes fastest. A run counts toward a bucket
// when it has 3 or more steady minutes there, and its median heart rate in the bucket is its value, so a
// long race doesn't outweigh a short session.
const PACE_EDGES = [400, 370, 345, 330, 305, 280, 260, 240];
const paceHeart = { edges: PACE_EDGES, years: [] };
{
  const byYear = new Map();
  for (const { owner, seg } of runSegments) {
    if (owner.d < HANDOVER || excluded.sick(owner.d)) continue;
    const year = owner.d.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, PACE_EDGES.slice(1).map(() => ({ runs: [], minutes: 0 })));
    const cells = byYear.get(year);
    PACE_EDGES.slice(1).forEach((fast, i) => {
      const slow = PACE_EDGES[i];
      const hr = seg.minutes.filter((m) => 3600 / m.kmh <= slow && 3600 / m.kmh > fast).map((m) => m.hr);
      if (hr.length < 3) return;
      cells[i].runs.push(median(hr));
      cells[i].minutes += hr.length;
    });
  }
  for (const [year, cells] of [...byYear].sort(([p], [q]) => p.localeCompare(q))) {
    paceHeart.years.push({ year, cells: cells.map((c) => ({ hr: c.runs.length ? round(median(c.runs), 1) : null, runs: c.runs.length, minutes: c.minutes })) });
  }
  log(`pace heart: ${paceHeart.years.map((y) => `${y.year} ${y.cells.map((c) => `${c.hr ?? '-'}/${c.runs}`).join(' ')}`).join('; ')}`);
}

log(`run segments: ${runSegments.length} runs, ${steadyMinuteCount} steady minutes, ${runSegments.filter((r) => r.seg.blocks.length).length} with faster segments; pace slope ${perKmh.toFixed(4)} m/beat per km/h`);

// Wrist data from days the watch wasn't worn is dropped everywhere, keeping the activities.
const WRIST_FIELDS = ['steps', 'distM', 'active', 'cal', 'rhr', 'overnight', 'daytime', 'hrAvg', 'hrMax', 'hrCov', 'stress', 'battery', 'resp', 'climbM', 'sleepMin', 'score', 'deep', 'rem', 'awake', 'inBed', 'bed', 'wake'];
for (const [date, r] of days) {
  if (!excluded.day(date)) continue;
  for (const f of WRIST_FIELDS) delete r[f];
}

// ---------- weight: one reading per day across the exports ----------

const weight = mergeWeights(weightReadings).map(({ date, lb }) => {
  dayRecord(date).weight = round(lb, 1);
  cover('Weight', ownerOf(date).id, date);
  return { d: date, lb: round(lb, 1) };
});
log(`weight days ${weight.length}; Fitbit rows ${notes.weightRows ?? 0}, Garmin biometrics ${notes.bioWeightRows ?? 0}; imports dropped ${notes.importedWeights ?? 0}`);

// ---------- food and hydration ----------

const foodCount = new Map();
const mealFoods = {};
const foodByMonth = new Map();
const foodDays = new Map();
const mealCount = new Map();
const MEALS = { BREAKFAST: 'Breakfast', BEFORE_LUNCH: 'Breakfast', LUNCH: 'Lunch', BEFORE_DINNER: 'Snack', DINNER: 'Dinner', AFTER_DINNER: 'After dinner', ANYTIME: 'Snack' };
const foodSource = [...foodSources][0];
for (const e of foodEntries) {
  const d = e.date;
  const name = e.name;
  if (!name) continue;
  bump(foodCount, name);
  bump(foodByMonth, d.slice(0, 7));
  const meal = MEALS[e.meal] || 'Snack';
  bump(mealCount, meal);
  (mealFoods[meal] ||= new Map());
  bump(mealFoods[meal], name);
  const day = foodDays.get(d) || { entries: 0, protein: 0, fiber: 0, sugar: 0 };
  day.entries++;
  day.protein += e.protein;
  day.fiber += e.fiber;
  day.sugar += e.sugar;
  foodDays.set(d, day);
  cover('Food log', foodSource, d);
}
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
const fullDays = [...foodDays.values()].filter((d) => d.entries >= 5);
const food = {
  entries: foodEntries.length,
  distinct: foodCount.size,
  days: foodDays.size,
  fullDays: fullDays.length,
  top: top(foodCount, 20),
  byMeal: Object.fromEntries(Object.entries(mealFoods).map(([k, v]) => [k, { total: mealCount.get(k), top: top(v, 12) }])),
  byMonth: [...foodByMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, count]) => ({ m, count })),
  medians: {
    protein: round(median(fullDays.map((d) => d.protein)), 0),
    fiber: round(median(fullDays.map((d) => d.fiber)), 0),
    sugar: round(median(fullDays.map((d) => d.sugar)), 0),
  },
};

const hydration = { days: hydrationByDay.size, medianMl: round(median([...hydrationByDay.values()]), 0) };

// ---------- cycles, merged across the exports ----------

const cycleList = mergeCycles([...cycleLists.values()]);
const complete = cycleList.filter((c) => c.confirmed && c.len >= 21 && c.len <= 45);

function foldByCycleDay(field, list) {
  const maxDay = 28;
  const buckets = Array.from({ length: maxDay }, () => []);
  let used = 0;
  for (const c of list) {
    const vals = [];
    for (let i = 0; i < c.len; i++) {
      const date = addDays(c.start, i);
      const v = excluded.sick(date) ? null : days.get(date)?.[field];
      if (v != null) vals.push([i, v]);
    }
    if (vals.length < 15) continue;
    used++;
    const base = mean(vals.map((x) => x[1]));
    for (const [i, v] of vals) if (i < maxDay) buckets[i].push(v - base);
  }
  return {
    cycles: used,
    days: buckets.map((b, i) => {
      const m = mean(b);
      const sd = b.length > 1 ? Math.sqrt(b.reduce((s, v) => s + (v - m) ** 2, 0) / (b.length - 1)) : 0;
      return { day: i + 1, mean: round(m, 2), se: round(b.length ? sd / Math.sqrt(b.length) : 0, 2), n: b.length };
    }),
  };
}
const beforeIud = complete.filter((c) => !iudDate || c.start < iudDate);
const withIud = complete.filter((c) => iudDate && c.start >= iudDate);
const cycles = {
  list: cycleList,
  complete: complete.length,
  iudDate,
  medianLen: median(complete.map((c) => c.len)),
  minLen: Math.min(...complete.map((c) => c.len)),
  maxLen: Math.max(...complete.map((c) => c.len)),
  medianBefore: median(beforeIud.map((c) => c.len)),
  medianWith: median(withIud.map((c) => c.len)),
  rhrBefore: foldByCycleDay('rhr', beforeIud),
  rhrWith: foldByCycleDay('rhr', withIud),
  sleepBefore: foldByCycleDay('sleepMin', beforeIud),
  sleepWith: foldByCycleDay('sleepMin', withIud),
};
for (const c of cycleList) cover('Cycle log', c.source, c.start);

// ---------- GPS: shapes in metres relative to each route, with no absolute coordinates kept ----------

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1; let at = -1;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((by - ay) * points[i][0] - (bx - ax) * points[i][1] + bx * ay - by * ax) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const tracks = [
  ...fitTracks.filter((t) => t.lat.length).map((t) => ({ lat: t.lat, lon: t.lon, start: t.times[0], end: t.times[t.times.length - 1], source: t.source })),
  ...plainRoutes,
];
let appOnlyTracks = 0;
for (const w of workouts) {
  if (!w._file) continue;
  const track = w._app.readRoute(w._file);
  if (track) { tracks.push({ ...track, start: w._start, end: w._end, source: w._app.id }); appOnlyTracks++; }
}

function trackMetres(t) {
  let metres = 0;
  for (let i = 1; i < t.lat.length; i++) {
    const step = haversine(t.lat[i - 1], t.lon[i - 1], t.lat[i], t.lon[i]);
    if (step < 400) metres += step; // ignore GPS teleports
  }
  return metres;
}

const routeCandidates = [];
for (const t of tracks) {
  t.metres = trackMetres(t);
  if (t.metres < 2000) continue;
  const owner = workouts.find((w) => t.start >= w._start - 120e3 && t.start <= w._end);
  t.place = owner?._place ?? null;
  routeCandidates.push({ t, owner });
}

// Places: tracks grouped by where they start, and a density picture of the visited streets for each.
const CELL_M = 40;
const places = [];
for (const { t } of routeCandidates) {
  let place = places.find((p) => haversine(p.lat0, p.lon0, t.lat[0], t.lon[0]) < 60000);
  if (!place) {
    place = { lat0: t.lat[0], lon0: t.lon[0], tracks: [] };
    places.push(place);
  }
  place.tracks.push(t);
}
places.sort((a, b) => b.tracks.length - a.tracks.length);
const topPlaces = places.slice(0, 4).map((p) => {
  const lat0 = mean(p.tracks.map((t) => t.lat[0]));
  const lon0 = mean(p.tracks.map((t) => t.lon[0]));
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const cells = new Map();
  let metres = 0;
  for (const t of p.tracks) {
    metres += t.metres;
    let prev = null;
    for (let i = 0; i < t.lat.length; i++) {
      const x = Math.round(((t.lon[i] - lon0) * 111320 * cos0) / CELL_M);
      const y = Math.round(((t.lat[i] - lat0) * 110540) / CELL_M);
      if (Math.abs(x) > 500 || Math.abs(y) > 500) continue;
      const key = `${x},${y}`;
      if (key !== prev) bump(cells, key); // a pause in one cell counts once
      prev = key;
    }
  }
  const flat = [];
  for (const [key, n] of cells) { const [x, y] = key.split(',').map(Number); flat.push(x, y, n); }
  const names = new Map();
  for (const t of p.tracks) if (t.place) bump(names, t.place);
  const name = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const years = p.tracks.map((t) => new Date(t.start).getUTCFullYear());
  return { name, routes: p.tracks.length, km: Math.round(metres / 1000), first: Math.min(...years), last: Math.max(...years), cell: CELL_M, cells: flat };
});

const routes = routeCandidates
  .sort((a, b) => b.t.metres - a.t.metres)
  .slice(0, 24)
  .map(({ t, owner }) => {
    const lat0 = t.lat[0];
    const lon0 = t.lon[0];
    const cos0 = Math.cos((lat0 * Math.PI) / 180);
    const pts = t.lat.map((lat, i) => [(t.lon[i] - lon0) * 111320 * cos0, (lat - lat0) * 110540]);
    return {
      d: owner?.d ?? dateOfLocal(toLocal(t.start)),
      km: round(t.metres / 1000, 1),
      min: Math.round((t.end - t.start) / MIN),
      type: owner?.type ?? null,
      name: owner?.name ?? null,
      pts: simplify(pts, 12).map(([x, y]) => [Math.round(x), Math.round(y)]),
    };
  });
for (const { t } of routeCandidates) cover('GPS routes', t.source, dateOfLocal(toLocal(t.start)));
log(`routes ${routeCandidates.length}, places ${places.length}, app-only tracks ${appOnlyTracks}`);

// ---------- records and shoes ----------

// A watch keeps a history of each record; keep only entries that actually beat the one before.
for (const key of Object.keys(prs)) {
  const sorted = prs[key].sort((a, b) => a.d.localeCompare(b.d));
  prs[key] = sorted.filter((p, i) => sorted.slice(0, i).every((q) => p.sec < q.sec));
}

const shoes = new Map();
for (const w of workouts) {
  if (!w.gear || w.type !== 'Run') continue;
  const s = shoes.get(w.gear) || { name: w.gear, km: 0, runs: 0, first: w.d, last: w.d };
  s.km += w.km || 0;
  s.runs++;
  if (w.d > s.last) s.last = w.d;
  shoes.set(w.gear, s);
}
const shoeList = [...shoes.values()].map((s) => ({ ...s, km: Math.round(s.km) })).sort((a, b) => b.km - a.km);

// ---------- correlations, on values with their 28-day trend removed ----------

const firstTracked = dateOfLocal(toLocal(firstHrMs()));
const lastTracked = mainWatch.lastDay ?? [...days.keys()].sort().at(-1);
const allTracked = [...days.keys()].filter((d) => d >= firstTracked && d <= lastTracked).sort();
// Compared on the main watch only, so a difference between the devices can't pass for a link.
const sortedDates = allTracked.filter((d) => d >= HANDOVER);
// Sick days are real but would read as the strongest "links" in the record, so they're left out here.
const validDay = (r) => r && (r.hrCov ?? 0) >= 0.5 && !excluded.sick(r.date);
for (const d of allTracked) {
  const r = days.get(d);
  if (validDay(r) && r.runKm == null) r.runKm = 0;
}

function detrended(field) {
  const out = new Map();
  for (const d of sortedDates) {
    const r = days.get(d);
    if (!validDay(r) || r[field] == null) continue;
    const window = [];
    for (let i = -14; i <= 14; i++) {
      const nb = days.get(addDays(d, i));
      if (validDay(nb) && nb[field] != null) window.push(nb[field]);
    }
    if (window.length >= 10) out.set(d, r[field] - mean(window));
  }
  return out;
}
function pearson(pairs) {
  const n = pairs.length;
  if (n < 30) return null;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
const trend = {};
const trendOf = (f) => (trend[f] ||= detrended(f));
const PAIRS = [
  { x: 'runKm', y: 'sleepMin', lag: 1, group: 'movement', label: 'Distance run today → time asleep tonight' },
  { x: 'active', y: 'sleepMin', lag: 1, group: 'movement', label: 'Active minutes today → time asleep tonight' },
  { x: 'active', y: 'deep', lag: 1, group: 'movement', label: 'Active minutes today → deep sleep tonight' },
  { x: 'steps', y: 'sleepMin', lag: 1, group: 'movement', label: 'Steps today → time asleep tonight' },
  { x: 'runKm', y: 'rhr', lag: 1, group: 'heart', label: 'Distance run today → resting HR tomorrow' },
  { x: 'sleepMin', y: 'rhr', lag: 0, group: 'heart', label: 'Time asleep last night → resting HR today' },
  { x: 'sleepMin', y: 'steps', lag: 0, group: 'other', label: 'Time asleep last night → steps today' },
  { x: 'sleepMin', y: 'stress', lag: 0, group: 'stress', label: 'Time asleep last night → stress today' },
  { x: 'stress', y: 'sleepMin', lag: 1, group: 'stress', label: 'Stress today → time asleep tonight' },
  { x: 'runKm', y: 'stress', lag: 1, group: 'stress', label: 'Distance run today → stress tomorrow' },
  { x: 'bed', y: 'sleepMin', lag: 0, group: 'bedtime', label: 'Later bedtime → time asleep that night' },
  { x: 'sleepMin', y: 'battery', lag: 0, group: 'stress', label: 'Time asleep last night → Body Battery today' },
];
const correlations = PAIRS.map((p) => {
  const xs = trendOf(p.x);
  const ys = trendOf(p.y);
  const pairs = [];
  for (const [d, x] of xs) {
    const y = ys.get(addDays(d, p.lag));
    if (y != null) pairs.push([x, y]);
  }
  const r = pearson(pairs);
  return { label: p.label, group: p.group, r: round(r, 3), n: pairs.length, margin: round(1.96 / Math.sqrt(pairs.length || 1), 3) };
}).filter((c) => c.r != null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

// Measured on the main watch only: watches count sleep differently, so a comparison across a switch
// would mostly reflect the devices.
const afterRun = { yes: [], no: [] };
for (const d of sortedDates) {
  const r = days.get(d);
  const next = days.get(addDays(d, 1));
  if (!validDay(r) || next?.sleepMin == null || r.runKm == null) continue;
  (r.runKm >= 1.5 ? afterRun.yes : afterRun.no).push(next);
}
const contrast = {
  run: { n: afterRun.yes.length, sleep: round(mean(afterRun.yes.map((x) => x.sleepMin)), 0) },
  rest: { n: afterRun.no.length, sleep: round(mean(afterRun.no.map((x) => x.sleepMin)), 0) },
};

// ---------- what changed at the switch to the main watch: each jump against that metric's ordinary variation ----------

const SWITCH_METRICS = ['awake', 'sleepMin', 'inBed', 'active', 'deep', 'rem', 'rhr', 'overnight', 'hrAvg', 'daytime', 'cal', 'steps', 'runKm', 'bed'];
function windowMeans(field, centre, size) {
  const pre = [];
  const post = [];
  for (let i = 1; i <= size; i++) {
    const a = days.get(addDays(centre, -i))?.[field];
    const b = days.get(addDays(centre, i - 1))?.[field];
    if (a != null) pre.push(a);
    if (b != null) post.push(b);
  }
  return [pre.length >= 10 ? mean(pre) : null, post.length >= 10 ? mean(post) : null];
}
const switchRows = eras.length < 2 ? null : SWITCH_METRICS.map((field) => {
  const [before, after] = windowMeans(field, HANDOVER, 30);
  const others = [];
  for (let i = 0; i < allTracked.length; i += 7) {
    const c = allTracked[i];
    if (Math.abs(dayDiff(c, HANDOVER)) < 40) continue;
    const [x, y] = windowMeans(field, c, 30);
    if (x != null && y != null) others.push(Math.abs(y - x));
  }
  const change = after - before;
  const percentile = others.filter((v) => v < Math.abs(change)).length / (others.length || 1);
  return { field, before: round(before, 2), after: round(after, 2), change: round(change, 2), percentile: round(percentile * 100, 0) };
});
const gapOf = (from, to) => {
  const diffs = [];
  for (const d of allTracked) {
    if (d < from || d >= to) continue;
    const r = days.get(d);
    if (r.rhr != null && r.overnight != null) diffs.push(r.rhr - r.overnight);
  }
  return round(mean(diffs), 1);
};
const switchAnalysis = eras.length < 2 ? null : {
  from: eras[eras.length - 2].source.id,
  rows: switchRows,
  // Autumn 2020 sits inside the Fitbit years and has its own unexplained shift, so the gap uses the settled period.
  fitbitGap: gapOf('2021-01-01', HANDOVER),
  garminGap: gapOf(HANDOVER, '2099-01-01'),
  overlap: {
    minutes: watchOverlap.length,
    meanDiff: round(mean(watchOverlap), 1),
    meanAbs: round(mean(watchOverlap.map(Math.abs)), 1),
  },
};
// How far the main watch's resting number sits from the raw 3 to 5 AM rate, which is the watch's own formula.
const restingGap = gapOf(HANDOVER, '2099-01-01');
if (switchAnalysis) log(`switch overlap ${JSON.stringify(switchAnalysis.overlap)}; RHR minus overnight: before ${switchAnalysis.fitbitGap}, after ${switchAnalysis.garminGap}`);

// ---------- assemble ----------

const allDates = [...days.keys()].sort();
const FIELDS = ['overnight', 'daytime', 'awake', 'inBed', 'steps', 'distM', 'active', 'cal', 'rhr', 'vo2', 'vo2g', 'sleepMin', 'score', 'deep', 'rem', 'bed', 'wake', 'hrAvg', 'hrMax', 'hrCov', 'weight', 'workouts', 'workoutMin', 'runKm', 'stress', 'battery', 'resp', 'climbM'];
const INTEGER_FIELDS = new Set(['distM', 'cal', 'workoutMin', 'active', 'steps']);
const daily = { date: allDates };
for (const f of FIELDS) {
  daily[f] = allDates.map((d) => {
    const v = days.get(d)[f];
    if (v == null) return null;
    if (f === 'runKm') return round(v, 2);
    return INTEGER_FIELDS.has(f) ? Math.round(v) : v;
  });
}

const gridDates = [...hrGrid.keys()].sort();
const hrGridOut = {
  dates: gridDates,
  bins: HR_BINS,
  values: gridDates.map((d) => {
    const [s, n] = hrGrid.get(d);
    return Array.from(s, (v, i) => (n[i] ? Math.round(v / n[i]) : 0));
  }),
};
const hourYear = Object.entries(hrHourYear).sort(([a], [b]) => a.localeCompare(b)).map(([year, [s, n]]) => ({
  year,
  samples: n.reduce((a, b) => a + b, 0),
  hours: Array.from(s, (v, i) => (n[i] ? round(v / n[i], 1) : null)),
}));

// Offset history for the time-zone strip. Offsets alone can't name a place, so only Hawaii and the
// two home zones get names; everything else is reported as its offset.
const zoneName = (o) => (o <= -9.5 ? 'Hawaii' : o === -8 || o === -7 ? 'Pacific' : o === -5 || o === -4 ? 'Eastern' : `UTC${o >= 0 ? '+' : ''}${o}`);
const tzSpans = [];
for (let d = BASE_DAY + 2; d <= LAST_DAY - 2; d++) {
  const date = isoDay(d * DAY);
  const zone = zoneName(offsetTable[d - BASE_DAY]);
  const last = tzSpans[tzSpans.length - 1];
  if (last && last.zone === zone) last.end = date;
  else tzSpans.push({ zone, start: date, end: date });
}

const coverageOut = [...coverage.entries()].map(([key, m]) => {
  const [row, source] = key.split('|');
  return { row, source, months: [...m.entries()].sort(([a], [b]) => a.localeCompare(b)) };
});

const sumField = (f) => allDates.reduce((s, d) => s + (days.get(d)[f] || 0), 0);
const runs = workouts.filter((w) => w.type === 'Run');
const summary = {
  meta: {
    generatedAt: new Date().toISOString(),
    trackerStart: firstTracked,
    trackerEnd: lastTracked,
    handover: HANDOVER,
    watches: eras.map((e) => ({ id: e.source.id, label: e.source.label, from: e.from, to: e.to })),
    apps: apps.map((a) => ({ id: a.id, label: a.label })),
    firstDate: allDates[0],
    lastDate: allDates[allDates.length - 1],
    tzSpans,
    coverage: coverageOut,
    stepRecord,
    dedupe: {
      activities: {
        raw: Object.fromEntries(sources.map((s) => [s.id, listOf(s.id).length])),
        merged: merged.length,
        ...clusterCounts,
        syncedCopies: syncMatches.length,
        clockShift,
        genuineManual: genuineManual.length,
        distanceDisagreements,
        typeDisagreements: typeDisagreements.length,
      },
      weight: {
        days: weight.length,
        rows: { fitbit: notes.weightRows, biometrics: notes.bioWeightRows },
        imports: notes.importedWeights,
      },
      cycles: { ...Object.fromEntries([...cycleLists].map(([id, list]) => [id, list.length])), merged: cycleList.length },
      fitFiles: notes.fitFiles,
      droppedHr,
      rhrDropped,
      exclusions: excluded.ranges.map((r) => ({ ...r })),
      events: lifeEvents,
      segments: { runs: runSegments.length, perKmh: round(perKmh, 4), refKmh: REF_KMH, rules: SEGMENT_RULES },
      excludedCounts,
      droppedStepRows: notes.droppedStepRows,
      emptyGarminDays: notes.emptyGarminDays,
      nightsSkipped: notes.nightsSkipped,
    },
    checks: {
      sleepStageVsScoreMedianDiffMin: notes.sleepStageVsScoreMedianDiffMin,
      sleepChecked: notes.sleepChecked,
      stepCheck: notes.stepCheck,
      swimLaps: notes.swimLaps,
      swimWorkouts: notes.swimWorkouts,
    },
  },
  totals: {
    heartbeats: Math.round(heartbeats),
    heartbeatsGarmin: Math.round(heartbeatsMain),
    hrSamples,
    hrDays: hrGrid.size,
    steps: sumField('steps'),
    km: round(sumField('distM') / 1000, 0),
    nights: nights.length,
    sleepHours: Math.round(nights.reduce((s, n) => s + n.asleep, 0) / 60),
    workouts: workouts.length,
    workoutHours: Math.round(workouts.reduce((s, w) => s + w.min, 0) / 60),
    runs: runs.length,
    runKm: Math.round(runs.reduce((s, w) => s + (w.km || 0), 0)),
    climbM: Math.round(runs.reduce((s, w) => s + (w.gainM || 0), 0)),
    weighIns: weight.length,
    foodEntries: foodEntries.length,
  },
  daily,
  hrGrid: hrGridOut,
  hourYear,
  weekHour: { steps: weekHour, days: weekHourDays },
  stressHour: stressHour.map((row) => row.map(([s, n]) => (n ? round(s / n, 1) : null))),
  nights,
  workouts: workouts.map(({ _start, _end, _file, _app, _place, ...w }) => (_place ? { ...w, place: _place } : w)),
  prs,
  shoes: shoeList,
  weight,
  food,
  hydration,
  cycles,
  routes,
  places: topPlaces,
  correlations,
  contrast,
  switch: switchAnalysis,
  restingGap,
  paceHeart,
};

const intraday = {};
for (const d of gridDates) {
  const [s, n] = hrIntraday.get(d);
  intraday[d] = {
    hr: Array.from(s, (v, i) => (n[i] ? Math.round(v / n[i]) : 0)),
    steps: stepIntraday.get(d) || null,
  };
}

fs.mkdirSync(OUT, { recursive: true });
const avatar = sources.find((s) => s.avatar)?.avatar;
summary.meta.avatar = Boolean(avatar);
if (avatar) fs.copyFileSync(avatar, path.join(OUT, 'profile.jpg'));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary));
fs.writeFileSync(path.join(OUT, 'intraday.json'), JSON.stringify(intraday));
const size = (f) => (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(2);
log(`wrote summary.json ${size('summary.json')} MB, intraday.json ${size('intraday.json')} MB`);
