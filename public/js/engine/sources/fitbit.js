// Fitbit, from a Google Takeout export: data/Takeout/Google Health.
import { readCsv, readAll, listCsv, readLines, join, basename } from '../lib/files.js';
import { normalizeType, isIndoorRun } from '../lib/dedupe.js';

const MIN = 60e3;
const DAY = 86400e3;
const GRAMS_PER_LB = 453.592;
// Rows the Google Health app estimated or logged by hand rather than the tracker measured.
const APP_ROWS = 'Google Health App';

const ms = (s) => Date.parse(s);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
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
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((ms(`${b}T00:00:00Z`) - ms(`${a}T00:00:00Z`)) / DAY);

export function detect(folder) {
  const dir = join('Takeout', 'Google Health');
  return folder.isDir(join(dir, 'Physical Activity_GoogleData')) ? dir : null;
}

export async function open(folder, dir) {
  const PA = join(dir, 'Physical Activity_GoogleData');
  const HF = join(dir, 'Health Fitness Data_GoogleData');
  const sleepStages = await readAll(folder, HF, 'UserSleepStages_');
  const offsets = new Map();
  for (const s of sleepStages) {
    const o = offsetHours(s.start_utc_offset);
    if (o != null) offsets.set(s.sleep_stage_start.slice(0, 10), o);
  }
  const hrFiles = listCsv(folder, join(PA, 'Heart Rate'), 'heart_rate_');
  const firstDay = [...offsets.keys(), ...hrFiles.map((f) => /(\d{4}-\d{2}-\d{2})/.exec(basename(f))?.[1]).filter(Boolean)].sort()[0];
  const source = {
    id: 'fitbit',
    label: 'Fitbit',
    kind: 'watch',
    firstDay,
    offsets,
    async read(ctx) {
      const { toLocal, dateOfLocal, owns } = ctx;
      const eraEndMs = ctx.era.to ? ms(`${ctx.era.to}T00:00:00Z`) : Infinity;

      let lastHr = -Infinity;
      for (const file of hrFiles) {
        const lines = await readLines(folder, file);
        for (let i = 1; i < lines.length; i++) {
          const comma = lines[i].indexOf(',');
          const t = Date.parse(lines[i].slice(0, comma));
          const bpm = parseFloat(lines[i].slice(comma + 1));
          if (!Number.isFinite(t) || !Number.isFinite(bpm) || bpm <= 0) continue;
          ctx.hr(t, bpm);
          if (t > lastHr) lastHr = t;
        }
      }
      // The tracker's record ends with its last heart-rate reading; the app keeps logging estimates after.
      if (Number.isFinite(lastHr)) source.lastDay = dateOfLocal(toLocal(lastHr));

      // Steps and distance: timestamps logged by both Fitbit sources disagree, and the app's rows are flat
      // estimates of manually logged runs, so the tracker's own rows are the ones kept.
      const daily = new Map();
      const dayOf = (date) => {
        let r = daily.get(date);
        if (!r) { r = {}; daily.set(date, r); }
        return r;
      };
      const stepMinute = new Map();
      const distMinute = new Map();
      let droppedStepRows = 0;
      for (const row of await readAll(folder, join(PA, 'Steps'), 'steps_')) {
        if (row['data source'] === APP_ROWS) { droppedStepRows++; continue; }
        const t = ms(row.timestamp);
        const steps = num(row.steps);
        if (!steps) continue;
        const date = dateOfLocal(toLocal(t));
        if (!owns(date)) { droppedStepRows++; continue; }
        stepMinute.set(Math.floor(t / MIN), steps);
        const r = dayOf(date);
        r.steps = (r.steps || 0) + steps;
        ctx.steps(t, steps);
      }
      ctx.note('droppedStepRows', droppedStepRows);
      for (const row of await readAll(folder, join(PA, 'Distance'), 'distance_')) {
        if (row['data source'] === APP_ROWS) continue;
        const t = ms(row.timestamp);
        const metres = num(row.distance);
        if (!metres) continue;
        const date = dateOfLocal(toLocal(t));
        if (!owns(date)) continue;
        distMinute.set(Math.floor(t / MIN), metres);
        const r = dayOf(date);
        r.distM = (r.distM || 0) + metres;
      }

      for (const row of await readAll(folder, join(PA, 'Active Minutes'), 'active_minutes_')) {
        const date = dateOfLocal(toLocal(ms(row.timestamp)));
        if (!owns(date)) continue; // later rows are back-filled from synced workouts
        const r = dayOf(date);
        r.active = (r.active || 0) + (num(row.moderate) || 0) + (num(row.very) || 0);
      }
      // Before the tracker's first heart-rate reading and after it stops, this file is a flat basal estimate.
      const trackerStartMs = ctx.firstHrMs();
      for (const file of listCsv(folder, join(PA, 'Calories'), 'calories_')) {
        const lines = await readLines(folder, file);
        for (let i = 1; i < lines.length; i++) {
          const [ts, v] = lines[i].split(',');
          const t = Date.parse(ts);
          if (t < trackerStartMs || t >= eraEndMs) continue;
          const date = dateOfLocal(toLocal(t));
          if (!owns(date)) continue;
          const r = dayOf(date);
          r.cal = (r.cal || 0) + (parseFloat(v) || 0);
        }
      }
      for (const row of await readCsv(folder, join(PA, 'Daily Resting Heart Rate', 'daily_resting_heart_rate.csv'))) {
        const v = num(row['beats per minute']);
        if (v) dayOf(row.timestamp.slice(0, 10)).rhr = round(v, 1);
      }
      for (const [date, fields] of daily) ctx.day(date, fields);
      for (const row of await readCsv(folder, join(PA, 'Demographic Vo2max', 'demographic_vo2max.csv'))) {
        const v = num(row['demographic vo2max']);
        if (v) ctx.estimate(row.timestamp.slice(0, 10), { vo2: round(v, 1) });
      }

      // Sleep: the longest staged session ending on each date.
      const stagesBySleep = new Map();
      for (const s of sleepStages) {
        if (!stagesBySleep.has(s.sleep_id)) stagesBySleep.set(s.sleep_id, []);
        stagesBySleep.get(s.sleep_id).push(s);
      }
      const scoreBySleep = new Map((await readAll(folder, HF, 'UserSleepScores_')).map((s) => [s.sleep_id, s]));
      const byDate = new Map();
      const scoreCheck = [];
      for (const session of await readAll(folder, HF, 'UserSleeps_')) {
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
          date, start: parsed[0].a, end: parsed[parsed.length - 1].b, asleep,
          deep: totals.DEEP, rem: totals.REM, light: totals.LIGHT, awake: totals.AWAKE,
          stages: parsed, hasStages: session.sleep_type === 'STAGES', score: score ? num(score.overall_score) : null,
        };
        const existing = byDate.get(date);
        if (!existing || candidate.asleep > existing.asleep) byDate.set(date, candidate);
      }
      for (const { hasStages, ...n } of byDate.values()) {
        if (!hasStages || n.asleep < 180) continue; // naps and stage-less sessions don't describe a night
        ctx.night(n);
      }
      ctx.note('sleepStageVsScoreMedianDiffMin', median(scoreCheck.map(Math.abs)));
      ctx.note('sleepChecked', scoreCheck.length);

      // Workouts. Before the switch, a workout without its own heart rate takes it from the all-day record.
      let swimWorkouts = 0;
      for (const e of await readAll(folder, HF, 'UserExercises_')) {
        const start = ms(e.exercise_start);
        const end = ms(e.exercise_end);
        const own = offsetHours(e.utc_offset);
        const manualKm = num(e.manually_logged_total_distance_mm) ? num(e.manually_logged_total_distance_mm) / 1e6 : null;
        const recorded = start < eraEndMs;
        let steps = 0;
        let metres = 0;
        if (recorded) {
          for (let m = Math.floor(start / MIN); m <= Math.floor(end / MIN); m++) {
            steps += stepMinute.get(m) || 0;
            metres += distMinute.get(m) || 0;
          }
        }
        const type = normalizeType(e.activity_name);
        if (type === 'Swim') swimWorkouts++;
        ctx.activity({
          start,
          end,
          timerMin: (end - start) / MIN,
          // +00:00 appears only in early 2020 and contradicts the sleep offsets for the same weeks.
          offset: own ? own : null,
          type,
          named: Boolean(e.activity_name),
          indoor: isIndoorRun(e.activity_name),
          km: manualKm ?? (metres ? metres / 1000 : null),
          avgHr: num(e.tracker_avg_heart_rate),
          maxHr: num(e.tracker_peak_heart_rate),
          hrFromTimeline: recorded,
          calories: num(e.manually_logged_total_calories) ?? num(e.tracker_total_calories),
          steps: steps || null,
          name: e.activity_name || null,
          // Garmin synced its workouts into Fitbit as "manual" ones with the clock moved.
          maybeCopy: e.log_type === 'MANUAL',
        });
      }
      ctx.note('swimWorkouts', swimWorkouts);
      ctx.note('swimLaps', (await readAll(folder, join(PA, 'Swim Lengths Data'), 'swim_lengths_data_')).length);

      const weightRows = await readCsv(folder, join(PA, 'Weight', 'weight.csv'));
      for (const row of weightRows) {
        const g = num(row['weight grams']);
        const d = row.timestamp.slice(0, 10);
        if (g && owns(d)) ctx.weight(d, g / GRAMS_PER_LB);
      }
      ctx.note('weightRows', weightRows.length);

      for (const row of await readCsv(folder, join(PA, 'Nutrition Log', 'nutrition_log.csv'))) {
        const nutrient = {};
        for (const part of row.nutrients.split(';')) {
          const [k, v] = part.split(':');
          const key = k?.trim();
          if (key) nutrient[key] = (nutrient[key] || 0) + (parseFloat(v) || 0);
        }
        // Times are local midnight stored in UTC, so the leading date is the logged local date.
        ctx.food({ date: row['start time'].slice(0, 10), name: row['food name'].trim(), meal: row['meal type'], protein: nutrient.PROTEIN || 0, fiber: nutrient.DIETARY_FIBER || 0, sugar: nutrient.SUGAR || 0 });
      }
      for (const row of await readAll(folder, join(PA, 'Hydration Log'), 'hydration_log_')) {
        const amount = parseFloat(row['amount consumed']);
        if (Number.isFinite(amount)) ctx.drink(row['start time'].slice(0, 10), amount);
      }

      for (const c of await readCsv(folder, join(PA, 'Menstrual Cycle', 'menstrual_cycle.csv'))) {
        ctx.cycle({
          start: c['start date'],
          len: dayDiff(c['start date'], c['end date']),
          confirmed: c['end date source'] === 'CONFIRMED',
          ovulation: c['ovulation date'] ? dayDiff(c['start date'], c['ovulation date']) : null,
          period: c['confirmed menstrual period'] ? dayDiff(...c['confirmed menstrual period'].split(' to ')) + 1 : null,
        });
      }
      const birthControl = (await readCsv(folder, join(PA, 'Birth Control', 'birth_control.csv')))[0];
      if (birthControl) ctx.birthControl(birthControl.timestamp.slice(0, 10));

      // Phone GPS, split into separate outings at gaps over five minutes. Where the phone and tracker both
      // logged a second, the phone's point is kept.
      const points = new Map();
      for (const row of await readAll(folder, join(PA, 'Gps Location'), 'gps_location_')) {
        const lat = num(row.latitude);
        const lon = num(row.longitude);
        if (lat == null || lon == null) continue;
        const t = Math.floor(ms(row.timestamp) / 1000);
        if (!points.has(t) || row['data source'] === APP_ROWS) points.set(t, [lat, lon]);
      }
      const ordered = [...points.entries()].sort((a, b) => a[0] - b[0]);
      let cur = null;
      ordered.forEach(([t, [lat, lon]], i) => {
        if (!cur || t - ordered[i - 1][0] > 300) {
          if (cur) ctx.route(cur);
          cur = { lat: [], lon: [], start: t * 1000, end: t * 1000 };
        }
        cur.lat.push(lat);
        cur.lon.push(lon);
        cur.end = t * 1000;
      });
      if (cur) ctx.route(cur);
    },
  };
  return source;
}
