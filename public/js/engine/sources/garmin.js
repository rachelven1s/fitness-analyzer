// Garmin, from a Garmin Connect data export: the DI_CONNECT folder, in data/garmin*/ or at the top of the zip.
import { openZip } from '../lib/zip.js';
import { decodeFit, fitTimeToMs } from '../lib/fit.js';
import { activityCollector, ACTIVITY_FILE, ACTIVITY_MESSAGES } from '../lib/fit-activity.js';
import { readJson, readJsonGlob, listFiles, join } from '../lib/files.js';
import { normalizeType, isIndoorRun, isImportedGarminWeight } from '../lib/dedupe.js';

const MIN = 60e3;
const GRAMS_PER_LB = 453.592;
// Garmin's activity "calories" are 4.19× Strava's on every matched activity: the export holds kilojoules.
const GARMIN_KJ_PER_KCAL = 4.19002;
const MONITORING_FILE = 32;
const SLEEP_FILE = 49;
const WANTED = new Set([...ACTIVITY_MESSAGES, 55, 227]); // plus monitoring and stress

const gmtMs = (s) => Date.parse(`${s}Z`);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The export's DI_CONNECT folder, at the top or up to two folders down: a zip may hold it directly or inside
// a folder, and ./data holds the unzipped export in a garmin* folder.
export function detect(folder) {
  const search = (dir, depth) => {
    if (folder.isDir(join(dir, 'DI_CONNECT'))) return join(dir, 'DI_CONNECT');
    if (depth === 0) return null;
    for (const name of folder.list(dir).sort()) {
      const sub = join(dir, name);
      const found = folder.isDir(sub) ? search(sub, depth - 1) : null;
      if (found) return found;
    }
    return null;
  };
  return search('', 2);
}

export async function open(folder, dir, platform) {
  const GAGG = join(dir, 'DI-Connect-Aggregator');
  const GWELL = join(dir, 'DI-Connect-Wellness');
  const GFIT = join(dir, 'DI-Connect-Fitness');
  const GMET = join(dir, 'DI-Connect-Metrics');
  const GUP = join(dir, 'DI-Connect-Uploaded-Files');

  const uds = (await readJsonGlob(folder, GAGG, (f) => f.startsWith('UDSFile'))).sort((a, b) => a.calendarDate.localeCompare(b.calendarDate));
  // Garmin can hold rows imported from another tracker, recognisable by a local time equal to GMT, and a
  // partial one from the day the watch was set up. The watch starts on the first full day it recorded itself.
  const recordedByWatch = (u) => u.wellnessStartTimeLocal && u.wellnessStartTimeLocal !== u.wellnessStartTimeGmt;
  const firstDay = uds.find((u) => u.totalSteps >= 5000 && recordedByWatch(u))?.calendarDate;
  if (!firstDay) throw new Error(`Could not find the first full day the Garmin watch recorded in ${GAGG}`);
  const realUds = uds.filter((u) => u.calendarDate >= firstDay);
  const offsets = new Map();
  for (const u of realUds) {
    if (!u.wellnessStartTimeGmt || !u.wellnessStartTimeLocal) continue;
    offsets.set(u.calendarDate, (gmtMs(u.wellnessStartTimeLocal) - gmtMs(u.wellnessStartTimeGmt)) / 3600e3);
  }

  return {
    id: 'garmin',
    label: 'Garmin',
    kind: 'watch',
    firstDay,
    lastDay: realUds[realUds.length - 1].calendarDate,
    offsets,
    recordsTracks: true,
    // Garmin's resting number can run wild when the watch barely recorded: May 2026 reports up to 115 bpm
    // beside a 55 bpm overnight rate.
    checksResting: true,
    async read(ctx) {
      const { toLocal, dateOfLocal, offsetAt } = ctx;
      ctx.note('emptyGarminDays', uds.length - realUds.length);

      for (const u of realUds) {
        if (!(u.totalSteps > 0)) continue; // a handful of days the watch never recorded
        const stress = u.allDayStress?.aggregatorList?.find((x) => x.type === 'TOTAL');
        const high = (u.bodyBattery?.bodyBatteryStatList || []).find((s) => s.bodyBatteryStatType === 'HIGHEST');
        ctx.day(u.calendarDate, {
          steps: u.totalSteps,
          distM: u.totalDistanceMeters ?? null,
          active: (u.moderateIntensityMinutes || 0) + (u.vigorousIntensityMinutes || 0),
          cal: u.totalKilocalories ?? null,
          // "restingHeartRate" is a trailing 7-day average of this field, so it lags and smears any bad days.
          rhr: u.currentDayRestingHeartRate || undefined,
          climbM: u.floorsAscendedInMeters ? round(u.floorsAscendedInMeters, 0) : undefined,
          stress: stress?.averageStressLevel > 0 ? stress.averageStressLevel : undefined,
          battery: high?.statsValue ?? undefined,
          resp: u.respiration?.avgWakingRespirationValue > 0 ? u.respiration.avgWakingRespirationValue : undefined,
        });
      }
      for (const m of await readJsonGlob(folder, GMET, (f) => f.startsWith('MetricsMaxMet'))) {
        // Walking-based values are a different scale from the running estimate.
        if (m.vo2MaxValue && m.sport === 'RUNNING') ctx.estimate(m.calendarDate, { vo2g: m.vo2MaxValue });
      }

      // FIT archives: all-day heart rate, steps and stress, and every recorded activity.
      const stepEvents = new Map(); // activity type -> numbers packing timestamp and running step count
      const fitFiles = { activity: 0, monitoring: 0, sleep: 0, other: 0, ignoredFitbitCsv: 0 };
      const zipFiles = listFiles(folder, GUP, (f) => f.endsWith('.zip'));
      for (const [i, zipFile] of zipFiles.entries()) {
        const zip = await openZip(await folder.reader(zipFile), platform.inflateRaw, zipFile);
        let done = 0;
        for (const entry of zip.entries) {
          if (++done % 2000 === 0) ctx.progress(`Reading Garmin's activity and all-day files, part ${i + 1} of ${zipFiles.length}`, (i + done / zip.entries.length) / zipFiles.length);
          if (!entry.name.endsWith('.fit')) { fitFiles.ignoredFitbitCsv++; continue; } // other trackers' files re-uploaded to Garmin
          const buf = await zip.read(entry);
          let type = null;
          let last = null;
          let activity = null;
          decodeFit(buf, (global, f, compressedTs) => {
            if (global === 0) {
              if (type == null) {
                type = f[0];
                if (type === ACTIVITY_FILE) { fitFiles.activity++; activity = activityCollector({ onHr: ctx.activityHr }); } else if (type === MONITORING_FILE) fitFiles.monitoring++;
                else if (type === SLEEP_FILE) fitFiles.sleep++;
                else fitFiles.other++;
              }
              return;
            }
            if (type === ACTIVITY_FILE) activity.message(global, f, compressedTs);
            else if (global === 55 && type === MONITORING_FILE) {
              if (f[253] != null) last = f[253];
              let ts = f[253];
              if (ts == null && f[26] != null && last != null) {
                ts = Math.floor(last / 65536) * 65536 + f[26];
                if (ts < last) ts += 65536;
                last = ts;
              }
              if (ts == null) return;
              if (f[27]) ctx.hr(fitTimeToMs(ts), f[27]);
              const kind = f[5] ?? (f[24] != null ? f[24] & 0x1f : null);
              if (f[3] != null && (kind === 1 || kind === 6)) {
                if (!stepEvents.has(kind)) stepEvents.set(kind, []);
                stepEvents.get(kind).push(ts * 1048576 + f[3]);
              }
            } else if (global === 227 && type === MONITORING_FILE) {
              const v = f[0];
              if (f[1] == null || v == null || v < 1 || v > 100) return;
              ctx.stress(fitTimeToMs(f[1]), v);
            }
          }, WANTED);
          if (activity && (activity.track.lat.length || activity.track.recs.length)) ctx.track(activity.track);
        }
        zip.close();
      }
      ctx.note('fitFiles', fitFiles);

      // Step counts in monitoring files are running totals per activity type that reset each midnight.
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
          const t = fitTimeToMs(ts);
          const date = dateOfLocal(toLocal(t));
          if (date < firstDay) continue;
          ctx.steps(t, delta);
          stepTotals.set(date, (stepTotals.get(date) || 0) + delta);
        }
      }
      const diffs = realUds.filter((u) => u.totalSteps > 2000 && stepTotals.has(u.calendarDate))
        .map((u) => Math.abs(stepTotals.get(u.calendarDate) - u.totalSteps) / u.totalSteps);
      ctx.note('stepCheck', { medianPct: round(median(diffs) * 100, 1), days: diffs.length });

      // The export has nightly stage totals but no timing: its sleep_level messages only hold 0 or 1, and the
      // stages themselves are computed on Garmin's servers. Those nights are painted as plain "asleep".
      let nightsSkipped = 0;
      for (const s of await readJsonGlob(folder, GWELL, (f) => f.endsWith('_sleepData.json'))) {
        const seconds = (s.deepSleepSeconds || 0) + (s.lightSleepSeconds || 0) + (s.remSleepSeconds || 0);
        if (s.calendarDate < firstDay || seconds < 3 * 3600 || /OFF_WRIST|UNCONFIRMED/.test(s.sleepWindowConfirmationType || '')) {
          nightsSkipped++;
          continue;
        }
        const startT = gmtMs(s.sleepStartTimestampGMT);
        const endT = gmtMs(s.sleepEndTimestampGMT);
        const off = offsetAt(endT) * 3600e3;
        ctx.night({
          date: s.calendarDate, start: startT + off, end: endT + off, asleep: seconds / 60,
          deep: (s.deepSleepSeconds || 0) / 60, rem: (s.remSleepSeconds || 0) / 60, light: (s.lightSleepSeconds || 0) / 60, awake: (s.awakeSleepSeconds || 0) / 60, score: null,
          stages: null,
        });
      }
      ctx.note('nightsSkipped', nightsSkipped);

      for (const a of (await readJsonGlob(folder, GFIT, (f) => f.endsWith('_summarizedActivities.json'))).flatMap((x) => x.summarizedActivitiesExport || [])) {
        const start = +a.beginTimestamp;
        const elapsed = a.elapsedDuration ?? a.duration ?? 0;
        ctx.activity({
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
        });
      }

      let bioWeightRows = 0;
      let importedWeights = 0;
      const bioFile = listFiles(folder, GWELL, (f) => f.endsWith('_userBioMetrics.json'))[0];
      for (const b of bioFile ? await readJson(folder, bioFile) : []) {
        if (!b.weight?.weight) continue;
        bioWeightRows++;
        const date = b.metaData.calendarDate.slice(0, 10);
        if (isImportedGarminWeight(date, b.weight.timestampGMT, firstDay)) { importedWeights++; continue; }
        ctx.weight(date, Math.round((b.weight.weight / GRAMS_PER_LB) * 10) / 10);
      }
      ctx.note('bioWeightRows', bioWeightRows);
      ctx.note('importedWeights', importedWeights);

      // Activity entries are estimated sweat loss rather than water drunk, so only logged drinks count.
      for (const h of await readJsonGlob(folder, GAGG, (f) => f.startsWith('HydrationLogFile'))) {
        if (h.hydrationSource !== 'GARMIN_ACTIVITY' && h.valueInML > 0) ctx.drink(h.calendarDate, h.valueInML);
      }

      for (const c of await readJsonGlob(folder, GWELL, (f) => f.endsWith('_MenstrualCycles.json'))) {
        ctx.cycle({
          start: c.startDate,
          len: c.actualCycleLength ?? c.applicableMenstrualCycleLength,
          confirmed: c.status === 'PAST' && c.actualCycleLength != null,
          ovulation: null,
          period: c.actualPeriodLength ?? null,
        });
      }

      const prRows = (await readJsonGlob(folder, GFIT, (f) => f.endsWith('_personalRecord.json'))).flatMap((x) => x.personalRecords || []);
      const PR_TYPES = { 'Best 1km Run': '1k', 'Best 5km Run': '5k', 'Best 10km Run': '10k', 'Best Half Marathon': 'half', 'Best Full Marathon': 'marathon' };
      for (const p of prRows) {
        const key = PR_TYPES[p.personalRecordType];
        const t = Date.parse(p.prStartTimeGMT);
        if (key && Number.isFinite(t)) ctx.personalRecord(key, t, Math.round(p.value), Boolean(p.current));
      }
      const stepRecord = prRows.find((p) => p.personalRecordType === 'Most Steps in a Day');
      if (stepRecord) ctx.stepRecord(stepRecord.value);
    },
  };
}
