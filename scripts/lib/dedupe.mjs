// The rules that turn overlapping exports into one record. Pure functions, covered by test/dedupe.test.mjs.

const MIN = 60e3;
const HOUR = 3600e3;

// Higher wins when merged records disagree: the Garmin file is the original recording,
// Strava mostly re-hosts it, and Fitbit's copies are lossy.
const PRIORITY = { garmin: 3, strava: 2, fitbit: 1 };

// ---------- activity types ----------

const TYPE_MAP = {
  running: 'Run', treadmill_running: 'Run', virtual_run: 'Run', run: 'Run', 'outdoor run': 'Run', 'treadmill run': 'Run',
  walking: 'Walk', walk: 'Walk', 'outdoor walk': 'Walk',
  hiking: 'Hike', hike: 'Hike',
  cycling: 'Ride', indoor_cycling: 'Ride', ride: 'Ride', bike: 'Ride', 'outdoor bike': 'Ride', spinning: 'Ride',
  lap_swimming: 'Swim', swim: 'Swim',
  elliptical: 'Elliptical',
  strength_training: 'Strength', 'weight training': 'Strength',
  resort_skiing: 'Snow', resort_snowboarding: 'Snow', resort_skiing_snowboarding_ws: 'Snow', 'alpine ski': 'Snow', snowboard: 'Snow',
  canoe: 'Paddle', rowing_v2: 'Row', rowing: 'Row',
  yoga: 'Yoga',
};

export const normalizeType = (raw) => TYPE_MAP[String(raw || '').toLowerCase()] || 'Other';
export const isIndoorRun = (raw) => /treadmill|virtual/i.test(String(raw || ''));

// ---------- Fitbit copies of Garmin activities ----------

// Garmin synced into Fitbit as "manual" workouts with seconds zeroed, calories re-estimated and the
// clock moved by a fixed amount. Only start minute and duration survive, so those are what's compared.
function copyCandidates(copy, targets, maxShiftH) {
  const dur = (copy.end - copy.start) / MIN;
  const out = [];
  for (const t of targets) {
    const delta = (t.start - copy.start) / HOUR;
    if (Math.abs(delta) > maxShiftH) continue;
    const shift = Math.round(delta * 2) / 2;
    if (Math.abs(delta - shift) > 2 / 60) continue;
    const sameLength = [t.timerMin, (t.end - t.start) / MIN].some((v) => v != null && Math.abs(v - dur) <= 1.5);
    if (sameLength) out.push({ target: t, shift });
  }
  return out;
}

export function matchSyncedCopies(copies, targets, maxShiftH = 14) {
  const sorted = [...targets].sort((a, b) => a.start - b.start);
  const shifts = new Map();
  for (const c of copies) {
    for (const { shift } of copyCandidates(c, sorted, maxShiftH)) {
      if (shift !== 0) shifts.set(shift, (shifts.get(shift) || 0) + 1);
    }
  }
  // A wrong shift matches only by coincidence, so the true one is by far the most common.
  const clockShift = [...shifts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const used = new Set();
  const matches = [];
  const unmatched = [];
  for (const c of copies) {
    const cands = copyCandidates(c, sorted, maxShiftH).filter((x) => !used.has(x.target));
    const pick = cands.find((x) => x.shift === 0) || cands.find((x) => x.shift === clockShift);
    if (pick) {
      used.add(pick.target);
      matches.push({ copy: c, target: pick.target, shift: pick.shift });
    } else unmatched.push(c);
  }
  return { matches, unmatched, clockShift };
}

// ---------- the same event seen by several sources ----------

export function sameEvent(a, b) {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return false;
  const lenA = a.end - a.start;
  const lenB = b.end - b.start;
  const shorter = Math.min(lenA, lenB);
  const longer = Math.max(lenA, lenB);
  if (!shorter) return false;
  // The same source only repeats itself exactly (a treadmill run also logged as a virtual run).
  if (a.source === b.source) return overlap / shorter >= 0.9 && shorter / longer >= 0.9;
  // Nobody runs twice at once: a fragment inside another app's run of the same type is that run.
  if (a.type && a.type === b.type && a.type !== 'Other' && overlap / shorter >= 0.9) return true;
  // The length test stops a short walk from being swallowed by a long run that contains it.
  return overlap / shorter >= 0.5 && shorter / longer >= 0.3;
}

export function clusterActivities(records) {
  const sorted = [...records].sort((a, b) => a.start - b.start);
  const parent = sorted.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
      if (sameEvent(sorted[i], sorted[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  sorted.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });
  return [...groups.values()];
}

// Which recording to trust for distance and time when the apps disagree.
export function pickDistanceRecord(ordered, type) {
  const measured = ordered.filter((r) => r.km != null && r.source !== 'fitbit');
  if (measured.length < 2) return ordered.find((r) => r.km != null) || ordered[0];
  const garmin = measured.filter((r) => r.source === 'garmin');
  const strava = measured.find((r) => r.source === 'strava');
  if (!garmin.length || !strava) return measured[0];
  const best = garmin.reduce((a, b) => ((b.timerMin || 0) > (a.timerMin || 0) ? b : a));
  // A session relabeled on Strava (a treadmill run that was really the elliptical) follows Strava.
  if (garmin.every((g) => g.type !== type) && strava.type === type) return strava;
  // Treadmill distance is corrected on the watch at the end, and Strava re-derives its own.
  if (ordered.some((r) => r.indoor)) return best;
  if (Math.abs(best.km - strava.km) <= 0.3) return best;
  // Outdoors, a real disagreement means Strava holds a stitched, uploaded or edited version:
  // usually a longer one after the watch stopped early, or a corrected race distance.
  return strava;
}

export function mergeCluster(cluster) {
  const ordered = [...cluster].sort((a, b) => PRIORITY[b.source] - PRIORITY[a.source]);
  const first = (key) => ordered.map((r) => r[key]).find((v) => v != null && v !== '');
  const merged = { ...ordered[0] };
  for (const key of ['offset', 'timerMin', 'km', 'avgHr', 'maxHr', 'calories', 'gainM', 'steps', 'name', 'gear', 'effort', 'file', 'place']) {
    merged[key] = first(key) ?? null;
  }
  // Strava names are user-written ("Canoe trip day 2"); Garmin's are generated ("New York Running").
  merged.name = ordered.find((r) => r.source === 'strava')?.name || merged.name;
  // Strava's type is what you chose or corrected, and a Garmin "other" often has a real type there.
  const stravaType = ordered.find((r) => r.source === 'strava')?.type;
  merged.type = (stravaType && stravaType !== 'Other' ? stravaType : null) || ordered.map((r) => r.type).find((t) => t && t !== 'Other') || 'Other';
  const distanceRecord = pickDistanceRecord(ordered, merged.type);
  merged.km = distanceRecord.km ?? merged.km;
  merged.timerMin = distanceRecord.timerMin ?? merged.timerMin;
  merged.distanceFrom = distanceRecord.source;
  merged.start = Math.min(...cluster.map((r) => r.start));
  merged.end = Math.max(...cluster.map((r) => r.end));
  merged.indoor = ordered.some((r) => r.indoor);
  merged.sources = [...new Set(ordered.map((r) => r.source))];
  return merged;
}

// ---------- weight ----------

// Before the watch arrived, Garmin held rows imported from Fitbit: a default of 120 lb filled in daily,
// plus real values moved a day early and gaps interpolated. All sit at midnight GMT, shown as 7 or 8 PM.
export const isImportedGarminWeight = (date, clock, handover) => date < handover && /^[78]:00 PM$/.test(clock);

export function mergeWeights(readings) {
  const byDay = new Map();
  for (const r of readings) {
    const list = byDay.get(r.date) || [];
    list.push(r);
    byDay.set(r.date, list);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => {
    // The same reading can appear in two exports, so count distinct values once each.
    const values = [...new Set(list.map((r) => r.lb.toFixed(1)))].map(Number);
    return { date, lb: values.reduce((s, v) => s + v, 0) / values.length, readings: values.length };
  });
}

// ---------- cycles ----------

export function mergeCycles(lists, toleranceDays = 3) {
  const out = [];
  const day = (d) => Date.parse(`${d}T00:00:00Z`) / 86400e3;
  for (const c of lists.flat().sort((a, b) => a.start.localeCompare(b.start))) {
    const clash = out.find((o) => Math.abs(day(o.start) - day(c.start)) <= toleranceDays);
    if (!clash) out.push(c);
    else if (!clash.confirmed && c.confirmed) Object.assign(clash, c);
  }
  return out;
}

// ---------- handover between watches ----------

// Each calendar day comes from exactly one watch, so nothing is double counted at the switch.
export const dayOwner = (date, handover) => (date < handover ? 'fitbit' : 'garmin');
