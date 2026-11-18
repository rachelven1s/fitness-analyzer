// Reads the raw exports in ./data (Fitbit via Google Takeout, Garmin, Strava), removes the overlaps
// between them and writes aggregated JSON to ./public/generated. Raw files are never served.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openZip } from './lib/zip.mjs';
import { decodeFit, fitTimeToMs } from './lib/fit.mjs';
import { makeExclusions } from './lib/exclusions.mjs';
import { segmentRun, summarize, SEGMENT_RULES } from './lib/segments.mjs';
import {
  normalizeType, isIndoorRun, matchSyncedCopies, clusterActivities, mergeCluster,
  isImportedGarminWeight, mergeWeights, mergeCycles, dayOwner,
} from './lib/dedupe.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'public', 'generated');
const GH = path.join(DATA, 'Takeout', 'Google Health');
const PA = path.join(GH, 'Physical Activity_GoogleData');
const HF = path.join(GH, 'Health Fitness Data_GoogleData');

const findExport = (prefix) => {
  const name = fs.readdirSync(DATA).find((f) => f.toLowerCase().startsWith(prefix) && fs.statSync(path.join(DATA, f)).isDirectory());
  if (!name) throw new Error(`No ${prefix} export folder found in ${DATA}`);
  return path.join(DATA, name);
};
const GARMIN = path.join(findExport('garmin'), 'DI_CONNECT');
const STRAVA = findExport('strava');
const GAGG = path.join(GARMIN, 'DI-Connect-Aggregator');
const GWELL = path.join(GARMIN, 'DI-Connect-Wellness');
const GFIT = path.join(GARMIN, 'DI-Connect-Fitness');
const GMET = path.join(GARMIN, 'DI-Connect-Metrics');
const GUP = path.join(GARMIN, 'DI-Connect-Uploaded-Files');

const MIN = 60e3;
const DAY = 86400e3;
const LB_PER_KG = 2.20462;
const GRAMS_PER_LB = 453.592;
// Garmin's activity "calories" are 4.19× Strava's on every matched activity: the export holds kilojoules.
const GARMIN_KJ_PER_KCAL = 4.19002;

const EXCLUSIONS_FILE = path.join(ROOT, 'exclusions.json');
const excluded = makeExclusions(fs.existsSync(EXCLUSIONS_FILE) ? JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8')) : []);
const excludedCounts = { hrMinutes: 0, nights: 0, days: 0 };
// Dates you know something changed (a move, a new job), shown as markers on the charts.
const EVENTS_FILE = path.join(ROOT, 'events.json');
const lifeEvents = fs.existsSync(EVENTS_FILE) ? JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')) : [];

const t0 = Date.now();
const log = (...a) => console.log(`[build +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------- file helpers ----------

// Handles quoted fields containing newlines, which Strava descriptions do.
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') {
      row.push(cur.endsWith('\r') ? cur.slice(0, -1) : cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsvText(readText(file));
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((cols) => Object.fromEntries(head.map((h, i) => [h, cols[i] ?? ''])));
}

function listFiles(dir, test) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(test).sort().map((f) => path.join(dir, f));
}
const listCsv = (dir, prefix) => listFiles(dir, (f) => f.endsWith('.csv') && f.startsWith(prefix));
const readAll = (dir, prefix) => listCsv(dir, prefix).flatMap(readCsv);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonGlob = (dir, test) => listFiles(dir, test).flatMap((f) => {
  const v = readJson(f);
  return Array.isArray(v) ? v : [v];
});
const readLines = (file) => {
  const lines = readText(file).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

// ---------- small utilities ----------

const ms = (s) => Date.parse(s);
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const offsetHours = (s) => {
  const m = /^([+-])(\d\d):(\d\d)$/.exec(s || '');
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] + +m[3] / 60) : null;
};
const gmtMs = (s) => Date.parse(`${s}Z`);
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

// ---------- the switch between watches ----------

const uds = readJsonGlob(GAGG, (f) => f.startsWith('UDSFile')).sort((a, b) => a.calendarDate.localeCompare(b.calendarDate));
// Garmin holds rows back to 2019 from a Fitbit import, recognisable by a local time equal to GMT, and a
// partial one from the day the watch was set up. The switch is the first full day the watch itself recorded.
const recordedByWatch = (u) => u.wellnessStartTimeLocal && u.wellnessStartTimeLocal !== u.wellnessStartTimeGmt;
const HANDOVER = uds.find((u) => u.totalSteps >= 5000 && recordedByWatch(u))?.calendarDate;
if (!HANDOVER) throw new Error('Could not find the first full Garmin day');
const realUds = uds.filter((u) => u.calendarDate >= HANDOVER);
log(`watch handover ${HANDOVER}; Garmin daily rows ${uds.length}, usable ${realUds.length}`);

// ---------- local time: one UTC offset for every UTC day of the record ----------

const sleepSessions = readAll(HF, 'UserSleeps_');
const sleepScores = readAll(HF, 'UserSleepScores_');
const sleepStages = readAll(HF, 'UserSleepStages_');
const fitbitExercises = readAll(HF, 'UserExercises_');

const knownOffset = new Map();
for (const s of sleepStages) {
  const o = offsetHours(s.start_utc_offset);
  if (o != null) knownOffset.set(s.sleep_stage_start.slice(0, 10), o);
}
for (const u of realUds) {
  if (!u.wellnessStartTimeGmt || !u.wellnessStartTimeLocal) continue;
  const o = (gmtMs(u.wellnessStartTimeLocal) - gmtMs(u.wellnessStartTimeGmt)) / 3600e3;
  knownOffset.set(u.calendarDate, o);
}
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

// ---------- one per-minute heart-rate timeline across both watches ----------

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

let hrSamples = 0;
let droppedFitbitHr = 0;
// The only direct comparison of the watches: minutes when both recorded, around the switch.
const fitbitNearSwitch = new Map();
const watchOverlap = [];
for (const file of listCsv(path.join(PA, 'Heart Rate'), 'heart_rate_')) {
  const lines = readLines(file);
  for (let i = 1; i < lines.length; i++) {
    const comma = lines[i].indexOf(',');
    const t = Date.parse(lines[i].slice(0, comma));
    const bpm = parseFloat(lines[i].slice(comma + 1));
    if (!Number.isFinite(t) || !Number.isFinite(bpm) || bpm <= 0) continue;
    if (Math.abs(t - ms(`${HANDOVER}T00:00:00Z`)) < 2 * DAY) {
      const minute = Math.floor(t / MIN);
      const m = fitbitNearSwitch.get(minute) || [0, 0];
      m[0] += bpm; m[1]++;
      fitbitNearSwitch.set(minute, m);
    }
    if (dayOwner(dateOfLocal(toLocal(t)), HANDOVER) !== 'fitbit') { droppedFitbitHr++; continue; }
    addHr(t, bpm);
    hrSamples++;
  }
}
log(`Fitbit heart rate samples ${hrSamples}, dropped after handover ${droppedFitbitHr}`);

// ---------- Fitbit steps and distance (tracker rows only) ----------

const stepMinute = new Map();
const distMinute = new Map();
const stepIntraday = new Map(); // local date -> [96] 15-minute buckets
const weekHour = Array.from({ length: 7 }, () => new Array(24).fill(0));
const weekHourDays = new Array(7).fill(0);
const seenWeekDays = new Set();
let droppedStepRows = 0;

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

// Timestamps logged by both Fitbit sources disagree; the "Google Health App" rows are flat
// estimates of manually logged runs, so the tracker's own rows are the ones kept.
for (const row of readAll(path.join(PA, 'Steps'), 'steps_')) {
  if (row['data source'] !== 'Inspire HR') { droppedStepRows++; continue; }
  const t = ms(row.timestamp);
  const steps = num(row.steps);
  if (!steps) continue;
  const local = toLocal(t);
  const date = dateOfLocal(local);
  if (dayOwner(date, HANDOVER) !== 'fitbit') { droppedStepRows++; continue; }
  stepMinute.set(Math.floor(t / MIN), steps);
  const r = dayRecord(date);
  r.steps = (r.steps || 0) + steps;
  addIntradaySteps(local, steps);
  cover('Steps', 'fitbit', date);
}
for (const row of readAll(path.join(PA, 'Distance'), 'distance_')) {
  if (row['data source'] !== 'Inspire HR') continue;
  const t = ms(row.timestamp);
  const metres = num(row.distance);
  if (!metres) continue;
  const date = dateOfLocal(toLocal(t));
  if (dayOwner(date, HANDOVER) !== 'fitbit') continue;
  distMinute.set(Math.floor(t / MIN), metres);
  const r = dayRecord(date);
  r.distM = (r.distM || 0) + metres;
}

const handoverMs = ms(`${HANDOVER}T00:00:00Z`);
let fitbitStartMs = Infinity;
for (let i = 0; i < HR_MINUTES; i++) {
  if (hrCnt[i]) { fitbitStartMs = (i + HR_BASE_MIN) * MIN; break; }
}

for (const row of readAll(path.join(PA, 'Active Minutes'), 'active_minutes_')) {
  const t = ms(row.timestamp);
  const date = dateOfLocal(toLocal(t));
  if (dayOwner(date, HANDOVER) !== 'fitbit') continue; // later rows are back-filled from synced workouts
  const r = dayRecord(date);
  r.active = (r.active || 0) + (num(row.moderate) || 0) + (num(row.very) || 0);
}
for (const file of listCsv(path.join(PA, 'Calories'), 'calories_')) {
  // After the tracker stops this file is a flat basal estimate, not a measurement.
  const lines = readLines(file);
  for (let i = 1; i < lines.length; i++) {
    const [ts, v] = lines[i].split(',');
    const t = Date.parse(ts);
    if (t < fitbitStartMs || t >= handoverMs) continue;
    const date = dateOfLocal(toLocal(t));
    if (dayOwner(date, HANDOVER) !== 'fitbit') continue;
    const r = dayRecord(date);
    r.cal = (r.cal || 0) + (parseFloat(v) || 0);
  }
}
for (const row of readCsv(path.join(PA, 'Daily Resting Heart Rate', 'daily_resting_heart_rate.csv'))) {
  const d = row.timestamp.slice(0, 10);
  const v = num(row['beats per minute']);
  if (v && d < HANDOVER) dayRecord(d).rhr = round(v, 1);
}
for (const row of readCsv(path.join(PA, 'Demographic Vo2max', 'demographic_vo2max.csv'))) {
  const d = row.timestamp.slice(0, 10);
  const v = num(row['demographic vo2max']);
  if (v) dayRecord(d).vo2 = round(v, 1);
}
log('Fitbit daily activity done');

// ---------- Garmin daily summaries ----------

for (const u of realUds) {
  if (!(u.totalSteps > 0)) continue; // a handful of days the watch never recorded
  if (excluded.day(u.calendarDate)) { excludedCounts.days++; continue; }
  const r = dayRecord(u.calendarDate);
  r.steps = u.totalSteps;
  r.distM = u.totalDistanceMeters ?? null;
  r.active = (u.moderateIntensityMinutes || 0) + (u.vigorousIntensityMinutes || 0);
  r.cal = u.totalKilocalories ?? null;
  // "restingHeartRate" is a trailing 7-day average of this field, so it lags and smears any bad days.
  if (u.currentDayRestingHeartRate) r.rhr = u.currentDayRestingHeartRate;
  if (u.floorsAscendedInMeters) r.climbM = round(u.floorsAscendedInMeters, 0);
  const stress = u.allDayStress?.aggregatorList?.find((x) => x.type === 'TOTAL');
  if (stress?.averageStressLevel > 0) r.stress = stress.averageStressLevel;
  const stats = u.bodyBattery?.bodyBatteryStatList || [];
  const high = stats.find((s) => s.bodyBatteryStatType === 'HIGHEST');
  if (high?.statsValue != null) r.battery = high.statsValue;
  if (u.respiration?.avgWakingRespirationValue > 0) r.resp = u.respiration.avgWakingRespirationValue;
  cover('Steps', 'garmin', u.calendarDate);
  if (r.stress != null) cover('Stress and recovery', 'garmin', u.calendarDate);
}
for (const m of readJsonGlob(GMET, (f) => f.startsWith('MetricsMaxMet'))) {
  // Walking-based values are a different scale from the running estimate.
  if (m.vo2MaxValue && m.sport === 'RUNNING') dayRecord(m.calendarDate).vo2g = m.vo2MaxValue;
}

// ---------- Garmin FIT archives: all-day heart rate, steps, stress, sleep stages, GPS ----------

const stepEvents = new Map(); // activity type -> numbers packing timestamp and running step count
const stressHour = Array.from({ length: 7 }, () => new Array(24).fill(0).map(() => [0, 0]));
const activityHr = new Map(); // utc minute -> [sum, count, peak]
const garminTracks = [];
const fitFiles = { activity: 0, monitoring: 0, sleep: 0, other: 0, ignoredFitbitCsv: 0 };
const WANTED = new Set([0, 18, 20, 55, 227]);

for (const zipFile of listFiles(GUP, (f) => f.endsWith('.zip'))) {
  const zip = openZip(zipFile);
  for (const entry of zip.entries) {
    if (!entry.name.endsWith('.fit')) { fitFiles.ignoredFitbitCsv++; continue; } // Fitbit files re-uploaded to Garmin
    const buf = zip.read(entry);
    let type = null;
    let last = null;
    let track = null;
    decodeFit(buf, (global, f, compressedTs) => {
      if (global === 0) {
        if (type == null) {
          type = f[0];
          if (type === 4) { fitFiles.activity++; track = { lat: [], lon: [], times: [], lastT: 0, recs: [], sport: null }; } else if (type === 32) fitFiles.monitoring++;
          else if (type === 49) fitFiles.sleep++;
          else fitFiles.other++;
        }
        return;
      }
      if (global === 55 && type === 32) {
        if (f[253] != null) last = f[253];
        let ts = f[253];
        if (ts == null && f[26] != null && last != null) {
          ts = Math.floor(last / 65536) * 65536 + f[26];
          if (ts < last) ts += 65536;
          last = ts;
        }
        if (ts == null) return;
        const t = fitTimeToMs(ts);
        if (f[27]) {
          // Isolated Fitbit samples after it came off the wrist aren't real wear, so require several a minute.
          const fb = fitbitNearSwitch.get(Math.floor(t / MIN));
          if (fb && fb[1] >= 3) watchOverlap.push(f[27] - fb[0] / fb[1]);
          if (dateOfLocal(toLocal(t)) >= HANDOVER) { addHr(t, f[27]); hrSamples++; }
        }
        const kind = f[5] ?? (f[24] != null ? f[24] & 0x1f : null);
        if (f[3] != null && (kind === 1 || kind === 6)) {
          if (!stepEvents.has(kind)) stepEvents.set(kind, []);
          stepEvents.get(kind).push(ts * 1048576 + f[3]);
        }
      } else if (global === 227 && type === 32) {
        const v = f[0];
        if (f[1] == null || v == null || v < 1 || v > 100) return;
        const local = toLocal(fitTimeToMs(f[1]));
        if (excluded.day(dateOfLocal(local))) return;
        const cell = stressHour[new Date(local).getUTCDay()][new Date(local).getUTCHours()];
        cell[0] += v;
        cell[1]++;
      } else if (global === 18 && type === 4) {
        track.sport = f[5];
        track.subSport = f[6];
        if (f[2] != null) track.start = fitTimeToMs(f[2]);
      } else if (global === 20 && type === 4) {
        const ts = f[253] ?? compressedTs;
        if (ts == null) return;
        const t = fitTimeToMs(ts);
        // Distance is in centimetres; kept for minute-by-minute pace within the run.
        if (f[5] != null) track.recs.push({ t, dist: f[5] / 100, hr: f[3] || null });
        if (f[3]) {
          const minute = Math.floor(t / MIN);
          let m = activityHr.get(minute);
          if (!m) { m = [0, 0, 0]; activityHr.set(minute, m); }
          m[0] += f[3]; m[1]++; if (f[3] > m[2]) m[2] = f[3];
        }
        if (f[0] != null && f[1] != null && t - track.lastT >= 5000) {
          track.lat.push((f[0] * 180) / 2147483648);
          track.lon.push((f[1] * 180) / 2147483648);
          track.times.push(t);
          track.lastT = t;
        }
      }
    }, WANTED);
    if (track && (track.lat.length || track.recs.length)) garminTracks.push(track);
  }
  zip.close();
}
log(`Garmin archives ${JSON.stringify(fitFiles)}, tracks ${garminTracks.length}, activity HR minutes ${activityHr.size}`);

// Monitoring files often skip the minutes of a recorded activity, so those fill only empty minutes.
let filledFromActivities = 0;
for (const [minute, [s, n, peak]] of activityHr) {
  const i = minute - HR_BASE_MIN;
  if (i < 0 || i >= HR_MINUTES || hrCnt[i]) {
    if (i >= 0 && i < HR_MINUTES && peak > hrPeak[i]) hrPeak[i] = Math.min(255, peak);
    continue;
  }
  const minuteDate = dateOfLocal(toLocal(minute * MIN));
  if (minuteDate < HANDOVER || excluded.day(minuteDate)) continue;
  hrSum[i] = s;
  hrCnt[i] = n;
  hrPeak[i] = Math.min(255, peak);
  filledFromActivities++;
}

// Step counts in monitoring files are running totals per activity type that reset each midnight.
let stepCheck;
{
  const stepTotals = new Map();
  for (const packed of stepEvents.values()) {
    const sorted = Float64Array.from(packed).sort();
    let prev = 0;
    let prevPacked = -1;
    for (const p of sorted) {
      if (p === prevPacked) continue; // the same message in a re-synced file
      prevPacked = p;
      const ts = Math.floor(p / 1048576);
      const count = p - ts * 1048576;
      const delta = count >= prev ? count - prev : count;
      prev = count;
      if (delta <= 0) continue;
      const local = toLocal(fitTimeToMs(ts));
      const date = dateOfLocal(local);
      if (date < HANDOVER) continue;
      addIntradaySteps(local, delta);
      bump(stepTotals, date, delta);
    }
  }
  const diffs = realUds.filter((u) => u.totalSteps > 2000 && stepTotals.has(u.calendarDate))
    .map((u) => Math.abs(stepTotals.get(u.calendarDate) - u.totalSteps) / u.totalSteps);
  log(`intraday steps vs Garmin daily total: median difference ${(median(diffs) * 100).toFixed(1)}% over ${diffs.length} days`);
  stepCheck = { medianPct: round(median(diffs) * 100, 1), days: diffs.length };
}

// ---------- heart-rate aggregates over the merged timeline ----------

const HR_BINS = 48;
const hrGrid = new Map();
const hrIntraday = new Map();
const hrHourYear = {};
const hrDayStats = new Map();
let heartbeats = 0;
let heartbeatsGarmin = 0;
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
        if ((lastCovered + HR_BASE_MIN) * MIN >= handoverMs) heartbeatsGarmin += beats;
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
  // Raw heart rate at 3-5 AM: the same quantity from either watch, unlike each app's own "resting" formula.
  const g = hrGrid.get(date);
  let nightSum = 0; let nightN = 0;
  for (let b = 6; b < 10; b++) { nightSum += g[0][b]; nightN += g[1][b]; }
  if (nightN >= 30) r.overnight = round(nightSum / nightN, 1);
  let daySum = 0; let dayN = 0;
  for (let b = 20; b < 36; b++) { daySum += g[0][b]; dayN += g[1][b]; }
  if (dayN >= 120) r.daytime = round(daySum / dayN, 1);
  cover('Heart rate', dayOwner(date, HANDOVER), date);
}
// Garmin's resting number can run wild when the watch barely recorded: May 2026 reports up to 115 bpm
// beside a 55 bpm overnight rate. Without enough wear, or far above the night's own rate, it isn't real.
let rhrDropped = 0;
const rhrDroppedDates = [];
for (const u of realUds) {
  const r = days.get(u.calendarDate);
  if (r?.rhr == null) continue;
  if ((r.hrCov ?? 0) < 0.5 || (r.overnight != null && r.rhr - r.overnight > 15)) {
    r.rhr = null;
    rhrDropped++;
    rhrDroppedDates.push(u.calendarDate);
  }
}
log(`not-worn exclusions ${JSON.stringify(excludedCounts)}`);
log(`resting readings dropped ${rhrDropped}: ${rhrDroppedDates.join(' ')}`);
log(`heart-rate days ${hrGrid.size}, heartbeats ${Math.round(heartbeats)}, filled from activities ${filledFromActivities}`);

// ---------- sleep: Fitbit stages until the handover, Garmin stages after ----------

const STAGE_CHAR = { LIGHT: 'L', DEEP: 'D', REM: 'R' };
const BIN_MIN = 5;
const NIGHT_ANCHOR_HOUR = 18; // bins count from 18:00 the evening before waking
const TOTAL_BINS = 24 * 12;
const anchorFor = (date) => ms(`${date}T00:00:00Z`) - (24 - NIGHT_ANCHOR_HOUR) * 3600e3;

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

const nights = [];
const stagesBySleep = new Map();
for (const s of sleepStages) {
  if (!stagesBySleep.has(s.sleep_id)) stagesBySleep.set(s.sleep_id, []);
  stagesBySleep.get(s.sleep_id).push(s);
}
const scoreBySleep = new Map(sleepScores.map((s) => [s.sleep_id, s]));
const fitbitByDate = new Map();
const scoreCheck = [];
for (const session of sleepSessions) {
  const stages = stagesBySleep.get(session.sleep_id);
  if (!stages?.length) continue;
  const parsed = stages.map((s) => {
    const off = offsetHours(s.start_utc_offset) ?? 0;
    return { type: s.sleep_stage_type, a: ms(s.sleep_stage_start) + off * 3600e3, b: ms(s.sleep_stage_end) + off * 3600e3 };
  }).sort((x, y) => x.a - y.a);
  const totals = { LIGHT: 0, DEEP: 0, REM: 0, AWAKE: 0 };
  for (const p of parsed) if (p.type in totals) totals[p.type] += (p.b - p.a) / MIN;
  const asleep = totals.LIGHT + totals.DEEP + totals.REM;
  const date = isoDay(parsed[parsed.length - 1].b);
  const score = scoreBySleep.get(session.sleep_id);
  if (session.sleep_type === 'STAGES' && score && num(score.sleep_time_minutes) != null) scoreCheck.push(asleep - num(score.sleep_time_minutes));
  const candidate = {
    date, src: 'fitbit', start: parsed[0].a, end: parsed[parsed.length - 1].b, asleep,
    deep: totals.DEEP, rem: totals.REM, light: totals.LIGHT, awake: totals.AWAKE,
    parsed, hasStages: session.sleep_type === 'STAGES', score: score ? num(score.overall_score) : null,
  };
  const existing = fitbitByDate.get(date);
  if (!existing || candidate.asleep > existing.asleep) fitbitByDate.set(date, candidate);
}
for (const n of fitbitByDate.values()) {
  if (!n.hasStages || n.asleep < 180 || n.date >= HANDOVER) continue; // naps and stage-less sessions don't describe a night
  const anchor = anchorFor(n.date);
  const bins = new Array(TOTAL_BINS).fill('.');
  for (const p of n.parsed) {
    const ch = STAGE_CHAR[p.type];
    if (!ch) continue;
    const a = Math.max(0, Math.floor((p.a - anchor) / (BIN_MIN * MIN)));
    const b = Math.min(TOTAL_BINS, Math.ceil((p.b - anchor) / (BIN_MIN * MIN)));
    for (let i = a; i < b; i++) if (bins[i] === '.') bins[i] = ch;
  }
  pushNight(n, bins);
}

// Garmin's export has nightly stage totals but no timing: its sleep_level messages only hold 0 or 1,
// and the stages themselves are computed on Garmin's servers. Those nights are painted as plain "asleep".
const garminSleep = readJsonGlob(GWELL, (f) => f.endsWith('_sleepData.json'));
let garminNightsSkipped = 0;
for (const s of garminSleep) {
  const seconds = (s.deepSleepSeconds || 0) + (s.lightSleepSeconds || 0) + (s.remSleepSeconds || 0);
  if (s.calendarDate < HANDOVER || seconds < 3 * 3600 || /OFF_WRIST|UNCONFIRMED/.test(s.sleepWindowConfirmationType || '')) {
    garminNightsSkipped++;
    continue;
  }
  const startT = gmtMs(s.sleepStartTimestampGMT);
  const endT = gmtMs(s.sleepEndTimestampGMT);
  const off = offsetAt(endT) * 3600e3;
  const anchor = anchorFor(s.calendarDate);
  const bins = new Array(TOTAL_BINS).fill('.');
  const a = Math.max(0, Math.floor((startT + off - anchor) / (BIN_MIN * MIN)));
  const b = Math.min(TOTAL_BINS, Math.ceil((endT + off - anchor) / (BIN_MIN * MIN)));
  for (let k = a; k < b; k++) bins[k] = 'A';
  pushNight({
    date: s.calendarDate, src: 'garmin', start: startT + off, end: endT + off, asleep: seconds / 60,
    deep: (s.deepSleepSeconds || 0) / 60, rem: (s.remSleepSeconds || 0) / 60, light: (s.lightSleepSeconds || 0) / 60, awake: (s.awakeSleepSeconds || 0) / 60, score: null,
  }, bins);
}
nights.sort((a, b) => a.d.localeCompare(b.d));
const absDiffs = scoreCheck.map(Math.abs);
log(`nights ${nights.length} (Garmin skipped ${garminNightsSkipped}); Fitbit stages vs score file ${median(absDiffs)} min`);

// ---------- activities from all three sources ----------

function streamMetrics(startMs, endMs) {
  let sum = 0; let n = 0; let peak = 0; let steps = 0; let metres = 0;
  for (let m = Math.floor(startMs / MIN); m <= Math.floor(endMs / MIN); m++) {
    const i = m - HR_BASE_MIN;
    if (i >= 0 && i < HR_MINUTES && hrCnt[i]) { sum += hrSum[i]; n += hrCnt[i]; if (hrPeak[i] > peak) peak = hrPeak[i]; }
    steps += stepMinute.get(m) || 0;
    metres += distMinute.get(m) || 0;
  }
  return { hr: n ? sum / n : null, peak: peak || null, steps, metres };
}

const garminActivities = readJsonGlob(GFIT, (f) => f.endsWith('_summarizedActivities.json'))
  .flatMap((x) => x.summarizedActivitiesExport || [])
  .map((a) => {
    const start = +a.beginTimestamp;
    const elapsed = a.elapsedDuration ?? a.duration ?? 0;
    return {
      source: 'garmin',
      start,
      end: start + elapsed,
      timerMin: (a.duration ?? elapsed) / MIN,
      offset: a.startTimeLocal != null ? (a.startTimeLocal - a.startTimeGmt) / 3600e3 : null,
      type: normalizeType(a.activityType),
      indoor: isIndoorRun(a.activityType),
      km: a.distance ? a.distance / 1e5 : null,
      avgHr: a.avgHr ?? null,
      maxHr: a.maxHr ?? null,
      calories: a.calories ? a.calories / GARMIN_KJ_PER_KCAL : null,
      gainM: a.elevationGain != null ? a.elevationGain / 100 : null,
      steps: a.steps ?? null,
      name: a.name ?? null,
      place: a.locationName ?? null,
    };
  });

const stravaRows = parseCsvText(readText(path.join(STRAVA, 'activities.csv')));
const SH = stravaRows[0];
// Strava's header repeats names: the second "Distance" is metres and the first is display units.
const stravaCol = (name, nth = 0) => {
  let seen = 0;
  for (let i = 0; i < SH.length; i++) {
    if (SH[i] === name && seen++ === nth) return i;
  }
  throw new Error(`Strava column not found: ${name}`);
};
const SC = {
  date: stravaCol('Activity Date'), name: stravaCol('Activity Name'), type: stravaCol('Activity Type'),
  elapsed: stravaCol('Elapsed Time', 1), moving: stravaCol('Moving Time'), metres: stravaCol('Distance', 1),
  gear: stravaCol('Activity Gear'), file: stravaCol('Filename'), gain: stravaCol('Elevation Gain'),
  maxHr: stravaCol('Max Heart Rate', 0), avgHr: stravaCol('Average Heart Rate'), calories: stravaCol('Calories'),
  effort: stravaCol('Relative Effort', 0), steps: stravaCol('Total Steps'),
};
const stravaActivities = stravaRows.slice(1).filter((r) => r.length > SC.calories).map((r) => {
  const start = Date.parse(`${r[SC.date]} UTC`);
  const elapsed = num(r[SC.elapsed]) ?? 0;
  const metres = num(r[SC.metres]);
  return {
    source: 'strava',
    start,
    end: start + elapsed * 1000,
    timerMin: (num(r[SC.moving]) ?? elapsed) / 60,
    offset: null,
    type: normalizeType(r[SC.type]),
    indoor: /treadmill/i.test(r[SC.name]),
    km: metres ? metres / 1000 : null,
    avgHr: num(r[SC.avgHr]),
    maxHr: num(r[SC.maxHr]),
    calories: num(r[SC.calories]) || null,
    gainM: num(r[SC.gain]),
    steps: num(r[SC.steps]) || null,
    name: r[SC.name] || null,
    gear: r[SC.gear] || null,
    effort: num(r[SC.effort]),
    file: r[SC.file] || null,
  };
});

const fitbitRecords = fitbitExercises.map((e) => {
  const start = ms(e.exercise_start);
  const end = ms(e.exercise_end);
  const own = offsetHours(e.utc_offset);
  const manualKm = num(e.manually_logged_total_distance_mm) ? num(e.manually_logged_total_distance_mm) / 1e6 : null;
  const stream = start < handoverMs ? streamMetrics(start, end) : { hr: null, peak: null, steps: 0, metres: 0 };
  const km = manualKm ?? (stream.metres ? stream.metres / 1000 : null);
  return {
    source: 'fitbit',
    log: e.log_type,
    start,
    end,
    timerMin: (end - start) / MIN,
    // +00:00 appears only in early 2020 and contradicts the sleep offsets for the same weeks.
    offset: own ? own : null,
    type: normalizeType(e.activity_name),
    named: Boolean(e.activity_name),
    indoor: isIndoorRun(e.activity_name),
    km,
    avgHr: num(e.tracker_avg_heart_rate) ?? stream.hr,
    maxHr: num(e.tracker_peak_heart_rate) ?? stream.peak,
    calories: num(e.manually_logged_total_calories) ?? num(e.tracker_total_calories),
    steps: stream.steps || null,
    name: e.activity_name || null,
  };
});

const typeDisagreements = [];
const copies = fitbitRecords.filter((r) => r.log === 'MANUAL');
const syncTargets = [...garminActivities, ...stravaActivities];
const { matches: syncMatches, unmatched: genuineManual, clockShift } = matchSyncedCopies(copies, syncTargets);
const copySet = new Set(syncMatches.map((m) => m.copy));
const syncedTargets = new Map(syncMatches.map((m) => [m.target, m.copy]));
log(`Fitbit manual ${copies.length}: synced copies ${syncMatches.length} at +${clockShift}h, genuine ${genuineManual.length}`);

const allRecords = [...garminActivities, ...stravaActivities, ...fitbitRecords.filter((r) => !copySet.has(r))];
const clusters = clusterActivities(allRecords);
const merged = clusters.map((cluster) => {
  const m = mergeCluster(cluster);
  // Note the Fitbit copies that were folded into this activity.
  if (cluster.some((r) => syncedTargets.has(r)) && !m.sources.includes('fitbit')) m.sources.push('fitbit');
  return m;
});
merged.sort((a, b) => a.start - b.start);
const distanceDisagreements = [];
clusters.forEach((cluster) => {
  const g = cluster.filter((r) => r.source === 'garmin');
  const s = cluster.find((r) => r.source === 'strava');
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
    _file: a.sources.includes('strava') && !a.sources.includes('garmin') ? a.file : null,
    _place: a.place ?? null,
  };
});
for (const m of merged) {
  for (const s of m.sources) {
    const w = dateOfLocal(m.start + (m.offset ?? offsetAt(m.start)) * 3600e3);
    cover(`Activities: ${s[0].toUpperCase()}${s.slice(1)}`, s, w);
  }
}

// ---------- runs minute by minute: regular running and faster segments analysed separately ----------

const runSegments = [];
for (const track of garminTracks) {
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

// ---------- weight: one reading per day across Fitbit and the Garmin biometrics file ----------

const weightReadings = [];
const fitbitWeight = readCsv(path.join(PA, 'Weight', 'weight.csv'));
for (const row of fitbitWeight) {
  const g = num(row['weight grams']);
  const d = row.timestamp.slice(0, 10);
  if (g && d < HANDOVER) weightReadings.push({ date: d, lb: g / GRAMS_PER_LB, source: 'fitbit' });
}
let importedWeights = 0;
let bioWeightRows = 0;
const bioFile = listFiles(GWELL, (f) => f.endsWith('_userBioMetrics.json'))[0];
for (const b of readJson(bioFile)) {
  if (!b.weight?.weight) continue;
  bioWeightRows++;
  const date = b.metaData.calendarDate.slice(0, 10);
  if (isImportedGarminWeight(date, b.weight.timestampGMT, HANDOVER)) { importedWeights++; continue; }
  weightReadings.push({ date, lb: Math.round((b.weight.weight / GRAMS_PER_LB) * 10) / 10, source: 'garmin-bio' });
}
const weight = mergeWeights(weightReadings).map(({ date, lb }) => {
  dayRecord(date).weight = round(lb, 1);
  cover('Weight', dayOwner(date, HANDOVER), date);
  return { d: date, lb: round(lb, 1) };
});
log(`weight days ${weight.length}; rows fitbit ${fitbitWeight.length}, biometrics ${bioWeightRows}; imports dropped ${importedWeights}`);

// ---------- food and hydration ----------

const foodRows = readCsv(path.join(PA, 'Nutrition Log', 'nutrition_log.csv'));
const foodCount = new Map();
const mealFoods = {};
const foodByMonth = new Map();
const foodDays = new Map();
const mealCount = new Map();
const MEALS = { BREAKFAST: 'Breakfast', BEFORE_LUNCH: 'Breakfast', LUNCH: 'Lunch', BEFORE_DINNER: 'Snack', DINNER: 'Dinner', AFTER_DINNER: 'After dinner', ANYTIME: 'Snack' };
for (const row of foodRows) {
  // Times are local midnight stored in UTC, so the leading date is the logged local date.
  const d = row['start time'].slice(0, 10);
  const name = row['food name'].trim();
  if (!name) continue;
  bump(foodCount, name);
  bump(foodByMonth, d.slice(0, 7));
  const meal = MEALS[row['meal type']] || 'Snack';
  bump(mealCount, meal);
  (mealFoods[meal] ||= new Map());
  bump(mealFoods[meal], name);
  const day = foodDays.get(d) || { entries: 0, protein: 0, fiber: 0, sugar: 0 };
  day.entries++;
  for (const part of row.nutrients.split(';')) {
    const [k, v] = part.split(':');
    const key = k?.trim();
    const val = parseFloat(v);
    if (key === 'PROTEIN') day.protein += val || 0;
    else if (key === 'DIETARY_FIBER') day.fiber += val || 0;
    else if (key === 'SUGAR') day.sugar += val || 0;
  }
  foodDays.set(d, day);
  cover('Food log', 'fitbit', d);
}
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
const fullDays = [...foodDays.values()].filter((d) => d.entries >= 5);
const food = {
  entries: foodRows.length,
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

const hydrationByDay = new Map();
for (const row of readAll(path.join(PA, 'Hydration Log'), 'hydration_log_')) {
  const d = row['start time'].slice(0, 10);
  const amount = parseFloat(row['amount consumed']);
  if (Number.isFinite(amount)) bump(hydrationByDay, d, amount);
}
// Garmin's activity entries are estimated sweat loss rather than water drunk, so only logged drinks count.
for (const h of readJsonGlob(GAGG, (f) => f.startsWith('HydrationLogFile'))) {
  if (h.hydrationSource !== 'GARMIN_ACTIVITY' && h.valueInML > 0) bump(hydrationByDay, h.calendarDate, h.valueInML);
}
const hydration = { days: hydrationByDay.size, medianMl: round(median([...hydrationByDay.values()]), 0) };

// ---------- cycles: Fitbit to mid-2022, Garmin after ----------

const fitbitCycles = readCsv(path.join(PA, 'Menstrual Cycle', 'menstrual_cycle.csv')).map((c) => ({
  source: 'fitbit',
  start: c['start date'],
  len: dayDiff(c['start date'], c['end date']),
  confirmed: c['end date source'] === 'CONFIRMED',
  ovulation: c['ovulation date'] ? dayDiff(c['start date'], c['ovulation date']) : null,
  period: c['confirmed menstrual period'] ? dayDiff(...c['confirmed menstrual period'].split(' to ')) + 1 : null,
}));
const garminCycles = readJsonGlob(GWELL, (f) => f.endsWith('_MenstrualCycles.json')).map((c) => ({
  source: 'garmin',
  start: c.startDate,
  len: c.actualCycleLength ?? c.applicableMenstrualCycleLength,
  confirmed: c.status === 'PAST' && c.actualCycleLength != null,
  ovulation: null,
  period: c.actualPeriodLength ?? null,
}));
const cycleList = mergeCycles([fitbitCycles, garminCycles]);
const complete = cycleList.filter((c) => c.confirmed && c.len >= 21 && c.len <= 45);
const birthControl = readCsv(path.join(PA, 'Birth Control', 'birth_control.csv'))[0];
const iudDate = birthControl ? birthControl.timestamp.slice(0, 10) : null;

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

const tracks = garminTracks.filter((t) => t.lat.length).map((t) => ({ lat: t.lat, lon: t.lon, start: t.times[0], end: t.times[t.times.length - 1], source: 'garmin' }));

// Fitbit-era phone GPS, split into separate outings at gaps over five minutes.
{
  const points = new Map();
  for (const row of readAll(path.join(PA, 'Gps Location'), 'gps_location_')) {
    const lat = num(row.latitude);
    const lon = num(row.longitude);
    if (lat == null || lon == null) continue;
    const t = Math.floor(ms(row.timestamp) / 1000);
    if (!points.has(t) || row['data source'] !== 'Inspire HR') points.set(t, [lat, lon]);
  }
  const ordered = [...points.entries()].sort((a, b) => a[0] - b[0]);
  let cur = null;
  ordered.forEach(([t, [lat, lon]], i) => {
    if (!cur || t - ordered[i - 1][0] > 300) {
      if (cur) tracks.push(cur);
      cur = { lat: [], lon: [], start: t * 1000, end: t * 1000, source: 'fitbit' };
    }
    cur.lat.push(lat);
    cur.lon.push(lon);
    cur.end = t * 1000;
  });
  if (cur) tracks.push(cur);
}

// Activities that exist only on Strava keep their own uploaded track.
function readStravaTrack(file) {
  const full = path.join(STRAVA, file);
  if (!fs.existsSync(full)) return null;
  let buf = fs.readFileSync(full);
  if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const lat = [];
  const lon = [];
  if (/\.fit(\.gz)?$/.test(file)) {
    decodeFit(buf, (g, f) => {
      if (g === 20 && f[0] != null && f[1] != null) { lat.push((f[0] * 180) / 2147483648); lon.push((f[1] * 180) / 2147483648); }
    }, new Set([20]));
  } else {
    const text = buf.toString('utf8');
    const pattern = /\.gpx/.test(file)
      ? /lat="(-?[\d.]+)"\s+lon="(-?[\d.]+)"/g
      : /<LatitudeDegrees>(-?[\d.]+)<\/LatitudeDegrees>\s*<LongitudeDegrees>(-?[\d.]+)<\/LongitudeDegrees>/g;
    for (const m of text.matchAll(pattern)) { lat.push(+m[1]); lon.push(+m[2]); }
  }
  return lat.length ? { lat, lon } : null;
}
let stravaOnlyTracks = 0;
for (const w of workouts) {
  if (!w._file) continue;
  const track = readStravaTrack(w._file);
  if (track) { tracks.push({ ...track, start: w._start, end: w._end, source: 'strava' }); stravaOnlyTracks++; }
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
for (const { t } of routeCandidates) cover('GPS routes', t.source === 'strava' ? 'strava' : t.source, dateOfLocal(toLocal(t.start)));
log(`routes ${routeCandidates.length}, places ${places.length}, Strava-only tracks ${stravaOnlyTracks}`);

// ---------- records and shoes ----------

const prRows = readJsonGlob(GFIT, (f) => f.endsWith('_personalRecord.json')).flatMap((x) => x.personalRecords || []);
const PR_TYPES = { 'Best 1km Run': '1k', 'Best 5km Run': '5k', 'Best 10km Run': '10k', 'Best Half Marathon': 'half', 'Best Full Marathon': 'marathon' };
const prs = {};
for (const p of prRows) {
  const key = PR_TYPES[p.personalRecordType];
  if (!key) continue;
  const t = Date.parse(p.prStartTimeGMT);
  if (!Number.isFinite(t)) continue;
  (prs[key] ||= []).push({ d: dateOfLocal(toLocal(t)), sec: Math.round(p.value), current: Boolean(p.current) });
}
// Garmin keeps a history of each record; keep only entries that actually beat the one before.
for (const key of Object.keys(prs)) {
  const sorted = prs[key].sort((a, b) => a.d.localeCompare(b.d));
  prs[key] = sorted.filter((p, i) => sorted.slice(0, i).every((q) => p.sec < q.sec));
}
const stepRecord = prRows.find((p) => p.personalRecordType === 'Most Steps in a Day');

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

const firstTracked = dateOfLocal(toLocal(fitbitStartMs));
const lastTracked = realUds[realUds.length - 1].calendarDate;
const allTracked = [...days.keys()].filter((d) => d >= firstTracked && d <= lastTracked).sort();
// Compared on one watch only, so a difference between the devices can't pass for a link.
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

// Measured on one watch only: Garmin and Fitbit count sleep differently, so a comparison across
// the switch would mostly reflect the devices.
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

// ---------- what changed at the switch: each jump against that metric's ordinary variation ----------

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
const switchRows = SWITCH_METRICS.map((field) => {
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
const switchAnalysis = {
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
log(`switch overlap ${JSON.stringify(switchAnalysis.overlap)}; RHR minus overnight: Fitbit ${switchAnalysis.fitbitGap}, Garmin ${switchAnalysis.garminGap}`);

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
    firstDate: allDates[0],
    lastDate: allDates[allDates.length - 1],
    tzSpans,
    coverage: coverageOut,
    stepRecord: stepRecord ? { value: stepRecord.value } : null,
    dedupe: {
      activities: {
        raw: { fitbit: fitbitRecords.length, garmin: garminActivities.length, strava: stravaActivities.length },
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
        rows: { fitbit: fitbitWeight.length, biometrics: bioWeightRows },
        imports: importedWeights,
      },
      cycles: { fitbit: fitbitCycles.length, garmin: garminCycles.length, merged: cycleList.length },
      fitFiles,
      droppedFitbitHr,
      rhrDropped,
      exclusions: excluded.ranges.map((r) => ({ ...r })),
      events: lifeEvents,
      segments: { runs: runSegments.length, perKmh: round(perKmh, 4), refKmh: REF_KMH, rules: SEGMENT_RULES },
      excludedCounts,
      droppedStepRows,
      emptyGarminDays: uds.length - realUds.length,
      nightsSkipped: garminNightsSkipped,
    },
    checks: {
      sleepStageVsScoreMedianDiffMin: median(absDiffs),
      sleepChecked: scoreCheck.length,
      stepCheck,
      swimLaps: readAll(path.join(PA, 'Swim Lengths Data'), 'swim_lengths_data_').length,
      swimWorkouts: fitbitRecords.filter((w) => w.type === 'Swim').length,
    },
  },
  totals: {
    heartbeats: Math.round(heartbeats),
    heartbeatsGarmin: Math.round(heartbeatsGarmin),
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
    foodEntries: foodRows.length,
  },
  daily,
  hrGrid: hrGridOut,
  hourYear,
  weekHour: { steps: weekHour, days: weekHourDays },
  stressHour: stressHour.map((row) => row.map(([s, n]) => (n ? round(s / n, 1) : null))),
  nights,
  workouts: workouts.map(({ _start, _end, _file, _place, ...w }) => (_place ? { ...w, place: _place } : w)),
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
// The Strava profile picture greets you on the overview. Only the image is copied; the rest of the profile isn't read.
const avatar = path.join(STRAVA, 'profile.jpg');
summary.meta.avatar = fs.existsSync(avatar);
if (summary.meta.avatar) fs.copyFileSync(avatar, path.join(OUT, 'profile.jpg'));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary));
fs.writeFileSync(path.join(OUT, 'intraday.json'), JSON.stringify(intraday));
const size = (f) => (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(2);
log(`wrote summary.json ${size('summary.json')} MB, intraday.json ${size('intraday.json')} MB`);
