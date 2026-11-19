import {
  el, svg, esc, figure, tile, redrawAll, theme, dayMs, DAY, isoDay, fmtDay, fmtFullDay, fmtMonth,
  fmtInt, fmt1, fmtCompact, fmtDuration, fmtClockFrom18, fmtClock, fmtHourShort, mean, median,
  rampTable, rampCss, showTip, hideTip, tipRow, linear, howMeasured, renderLegend,
} from './lib.js';
import { lineChart, columnChart, hBars, scatter, raster, cellGrid } from './charts.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STAGE = { L: { label: 'Light', slot: 0 }, R: { label: 'REM', slot: 1 }, D: { label: 'Deep', slot: 2 } };
// Light sleep fills most of every night, so it takes a pale step of its hue and lets REM and deep show.
// Garmin's export has no stage timing, so its nights are a neutral "asleep".
const stageColor = (t, code) => {
  if (code === 'A') return '#a8a79f';
  return code === 'L' ? '#b7d3f6' : t.series[STAGE[code].slot];
};
const SOURCE = { fitbit: { label: 'Fitbit', slot: 0 }, garmin: { label: 'Garmin', slot: 1 }, strava: { label: 'Strava', slot: 2 } };
const SOURCE_LETTER = { f: 'Fitbit', g: 'Garmin', s: 'Strava' };

const CHAPTERS = [
  ['compare', 'Year over year'],
  ['life', 'Life changes'],
  ['running', 'Running'],
  ['heart', 'Heart'],
  ['movement', 'Movement'],
  ['workouts', 'Activities'],
  ['sleep', 'Sleep'],
  ['recovery', 'Stress'],
  ['body', 'Weight', true],
  ['cycle', 'Cycle', true],
  ['links', 'Connections'],
  ['switch', 'The switch'],
  ['fitbit', 'Fitbit years'],
  ['record', 'Merging'],
  ['food', 'Food', true],
  ['notes', 'Notes'],
];

// A small marker for each chapter, shown next to its name wherever the name appears.
const CHAPTER_EMOJI = {
  compare: '📊', life: '🏙️', running: '🏃', heart: '❤️', movement: '👟', workouts: '🚴', sleep: '😴', recovery: '🧘',
  body: '⚖️', cycle: '🗓️', links: '🔗', switch: '⌚', fitbit: '🕰️', record: '🧩', food: '🍌', notes: '📝',
};
// Gives a node a color tone; the stylesheet maps each tone to --accent, --accent-ink and --accent-wash.
const toned = (node, tone) => { node.dataset.tone = tone; return node; };

let data;
let byDate;
let intradayPromise;

const row = (date) => byDate.get(date);
const handover = () => data.meta.handover;
// The watches in the order they were worn. The latest is the main record; an earlier one is shown on its own.
const watches = () => data.meta.watches;
const watchName = () => watches().at(-1).label;
const earlierWatch = () => watches().at(-2) ?? null;
const hasSource = (id) => [...watches(), ...data.meta.apps].some((s) => s.id === id);

function indexDaily(d) {
  const fields = Object.keys(d).filter((k) => k !== 'date');
  const map = new Map();
  d.date.forEach((date, i) => {
    const r = { date };
    for (const f of fields) r[f] = d[f][i];
    map.set(date, r);
  });
  return map;
}

function rolling(dates, get, window = 28, minN = 10) {
  const half = window >> 1;
  return dates.map((date) => {
    const t = dayMs(date);
    const vals = [];
    for (let i = -half; i <= half; i++) {
      const r = row(isoDay(t + i * DAY));
      const v = r ? get(r) : null;
      if (v != null) vals.push(v);
    }
    return vals.length >= minN ? mean(vals) : null;
  });
}

function months(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

const fmtRace = (sec) => {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const fmtPace = (minPerKm) => {
  const total = Math.round(minPerKm * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const inDays = (from, to, get) => [...byDate.values()].filter((r) => r.date >= from && r.date <= to).map(get);
// Days you were sick are real and stay in the record, but would skew fitness trends, so trend and
// average calculations skip them. Charts shade them so the gap is explained.
const sickRanges = () => (data.meta.dedupe.exclusions || []).filter((x) => x.kind === 'sick');
const isSick = (d) => sickRanges().some((x) => d >= x.from && d <= x.to);
const healthy = (get) => (r) => (isSick(r.date) ? null : get(r));
const sickSpans = (t) => sickRanges().map((x) => ({ x0: dayMs(x.from), x1: dayMs(x.to) + DAY, label: 'Sick', color: t.muted }));

// The main chapters use only the Garmin years, when one watch measured everything the same way.
let garminDayCache;
const garminDays = () => {
  garminDayCache ||= inDays(handover(), data.meta.trackerEnd, (r) => r);
  return garminDayCache;
};
const garminRuns = () => data.workouts.filter((w) => w.type === 'Run' && w.d >= handover());

// A chapter shows its headline, a sentence or two, tiles and lead figure in full. Every figure after that is
// folded to its title and takeaway, so a page can be skimmed and a chart opened when it looks interesting.
// Method and caveats go in a howMeasured() child rather than the intro.
function chapter(id, kicker, heading, intro, ...children) {
  const meta = CHAPTERS.find((c) => c[0] === id);
  const kids = children.flat(Infinity).filter((c) => c != null);
  const lead = kids.findIndex((node) => node.matches?.('figure.fig, .grid-2'));
  kids.slice(lead + 1).forEach((node) => {
    if (lead < 0) return;
    const figs = node.matches?.('figure.fig') ? [node] : [...(node.querySelectorAll?.('figure.fig') ?? [])];
    figs.forEach((f) => f.fold?.());
  });
  return el('section', { id, class: `chapter${meta?.[2] ? ' private' : ''}` },
    el('div', { class: 'kicker', text: `${CHAPTER_EMOJI[id] ?? ''} ${kicker.replace(/^\d+ · /, '')}`.trim() }),
    el('h2', { text: heading }),
    intro ? el('p', { text: intro }) : null,
    kids);
}

const grid2 = (...kids) => el('div', { class: 'grid-2' }, kids);
// Groups a run of folded figures under a label, so a long chapter doesn't read as one flat list.
const subhead = (text) => el('h3', { class: 'chapter-subhead', text });
// Drops the AM from morning times so a "before → after" pair fits on one tile line.
const shortClock = (s) => s.replace(' AM', '');
const tiles = (...kids) => el('div', { class: 'tiles' }, kids);
const dayButton = (date, label = 'Open day') => el('button', { class: 'link-button', type: 'button', text: label, onclick: () => openDay(date) });
const yearTicksFrom = (start, span) => {
  const out = [];
  const first = new Date(start).getUTCFullYear() + 1;
  const last = new Date(start + span * DAY).getUTCFullYear();
  for (let y = first; y <= last; y++) out.push({ at: (Date.UTC(y, 0, 1) - start) / DAY / span, label: String(y) });
  return out;
};
const handoverAnnotation = () => [{ x: dayMs(handover()), label: 'Garmin →' }];

function monthlyTable(cols, from, to) {
  const groups = new Map();
  for (const r of byDate.values()) {
    if ((from && r.date < from) || (to && r.date > to)) continue;
    const m = r.date.slice(0, 7);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(r);
  }
  return {
    columns: ['Month', ...cols.map((c) => c[0])],
    rows: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, rs]) => [
      fmtMonth(m),
      ...cols.map(([, get, f]) => { const v = mean(rs.map(get)); return v == null ? '—' : f(v); }),
    ]),
  };
}

// ---------- hero: the heart-rate fingerprint ----------

function fingerprintFigure({ from, title, sub, marks = [] }) {
  const keep = data.hrGrid.dates.map((d, i) => [d, data.hrGrid.values[i]]).filter(([d]) => d >= from);
  const dates = keep.map(([d]) => d);
  const { bins } = data.hrGrid;
  const start = dayMs(dates[0]);
  const end = dayMs(dates[dates.length - 1]);
  const span = Math.round((end - start) / DAY) + 1;
  const byIndex = new Map(keep.map(([d, v]) => [Math.round((dayMs(d) - start) / DAY), v]));
  const LOW = 50;
  const HIGH = 125;

  return figure({
    title: title(dates),
    sub: sub(dates),
    height: 400,
    render(host, width, t) {
      const colorAt = rampTable(t.ramp);
      const height = Math.max(300, Math.min(420, width * 0.38));
      raster(host, width, t, {
        height,
        columns: span,
        ariaLabel: 'Heart rate by day and time of day. Monthly values are in the table view.',
        yTicks: [0, 6, 12, 18, 24].map((h) => ({ at: h / 24, label: fmtHourShort(h) })),
        xTicks: yearTicksFrom(start, span),
        marks: marks.map((m) => ({ at: (dayMs(m.date) - start) / DAY / span, label: m.label })),
        paint(ctx, { x, y, w, h, dpr }) {
          const pw = Math.round(w * dpr);
          const ph = Math.round(h * dpr);
          const img = ctx.createImageData(pw, ph);
          for (let px = 0; px < pw; px++) {
            const col = byIndex.get(Math.floor((px / pw) * span));
            if (!col) continue;
            for (let py = 0; py < ph; py++) {
              const v = col[Math.floor((py / ph) * bins)];
              if (!v) continue;
              const [r, g, b] = colorAt((v - LOW) / (HIGH - LOW));
              const o = (py * pw + px) * 4;
              img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
            }
          }
          ctx.putImageData(img, Math.round(x * dpr), Math.round(y * dpr));
        },
        hover({ col, fy }) {
          const c = byIndex.get(col);
          if (!c) return null;
          const bin = Math.floor(fy * bins);
          if (!c[bin]) return null;
          return `<b>${esc(fmtDay(isoDay(start + col * DAY)))}, ${esc(fmtClock(bin * 30))}</b>${tipRow(null, 'Average heart rate', `${c[bin]} bpm`)}<div class="hint">Click to open this day</div>`;
        },
        onPick({ col }) { if (byIndex.has(col)) openDay(isoDay(start + col * DAY)); },
      });
    },
    legend: (t) => [{ ramp: rampCss(t.ramp), from: `${LOW} bpm`, to: `${HIGH}+ bpm` }, { gap: true, label: 'Not worn' }],
    table: () => monthlyTable([['Avg HR', (r) => r.hrAvg, fmt1], ['Peak HR', (r) => r.hrMax, fmtInt]], from, data.meta.trackerEnd),
  });
}

function renderHero() {
  const days = garminDays();
  const runs = garminRuns();
  const millions = Math.round(data.totals.heartbeatsGarmin / 1e6);
  const nights = data.nights.filter((n) => n.src === 'garmin');
  const activities = data.workouts.filter((w) => w.d >= handover());
  const sum = (list, get) => list.reduce((s, x) => s + (get(x) || 0), 0);
  return el('div', { id: 'top' },
    el('div', { class: 'hero' },
      data.meta.avatar ? el('img', { class: 'avatar', src: `${dataDir}/profile.jpg`, alt: 'Your Strava profile picture' }) : null,
      el('div', null,
        el('div', { class: 'eyebrow', text: `💓 Since ${fmtDay(handover())} · your Garmin years` }),
        el('h1', null, el('span', { class: 'hero-number', text: `${millions} million` }), ' heartbeats'),
        el('p', { text: 'Recorded by one watch since you started training for your first marathon.' }))),
    tiles(
      toned(tile('🏃 Distance run', `${fmtInt(sum(runs, (r) => r.km))} km`, `${fmtInt(runs.length)} runs`), 'orange'),
      toned(tile('👟 Steps', fmtCompact(sum(days, (r) => r.steps)), `about ${fmtInt(sum(days, (r) => r.distM) / 1000)} km on foot`), 'green'),
      toned(tile('😴 Nights recorded', fmtInt(nights.length), `${fmtInt(sum(nights, (n) => n.asleep) / 60)} hours asleep`), 'purple'),
      toned(tile('🚴 Activities', fmtInt(activities.length), `${fmtInt(sum(activities, (w) => w.min) / 60)} hours`), 'blue'),
    ));
}

// ---------- chapter: year over year ----------

// One blue, lightest for the oldest year; an ordinal ramp validated for steps that stay visible on the page.
const YEAR_RAMP = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
const yearColor = (t, i, count) => YEAR_RAMP[YEAR_RAMP.length - count + i];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function periodStats({ from, to }) {
  const days = inDays(from, to, (r) => r);
  const runs = data.workouts.filter((w) => w.type === 'Run' && w.d >= from && w.d <= to);
  // Heart rate on runs while sick or recovering would skew pace and fitness figures; distance still counts.
  const segs = runs.filter((r) => r.seg && !isSick(r.d)).map((r) => r.seg);
  const weeks = days.length / 7 || 1;
  const nums = (get) => days.map(get).filter((v) => v != null);
  const avg = (get) => mean(nums(get));
  const sum = (list, get) => list.reduce((s, x) => s + (get(x) || 0), 0);
  const rk = sum(segs, (g) => g.rk); const rm = sum(segs, (g) => g.rm); const rb = sum(segs, (g) => g.rb);
  const fk = sum(segs, (g) => g.fk); const fm = sum(segs, (g) => g.fm); const fb = sum(segs, (g) => g.fb);
  const fhm = sum(segs, (g) => g.fhm ?? g.fm);
  return {
    km: sum(runs, (r) => r.km),
    kmPerWeek: sum(runs, (r) => r.km) / weeks,
    runsPerWeek: runs.length / weeks,
    longRuns: runs.filter((r) => r.km >= 30).length,
    longest: runs.length ? Math.max(...runs.map((r) => r.km || 0)) : null,
    marathons: runs.filter((r) => r.km >= 41 && r.km <= 48).length,
    // Fitbit runs have no elevation or minute-by-minute record, so these stay empty for Fitbit years.
    climbPerWeek: runs.some((r) => r.gainM != null) ? sum(runs, (r) => r.gainM) / weeks : null,
    pace: rk ? rm / rk : null,
    runHr: rm ? rb / rm : null,
    fastPace: fk ? fm / fk : null,
    fastHr: fhm ? fb / fhm : null,
    fastPerWeek: segs.length ? sum(segs, (g) => g.fmin) / weeks : null,
    perBeat: rb + fb ? ((rk + fk) * 1000) / (rb + fb) : null,
    perBeatAdj: (() => {
      const list = beatData().runs.filter((r) => r.d >= from && r.d <= to);
      return list.length ? median(list.map((r) => r.adjusted)) : null;
    })(),
    rhr: avg(healthy((r) => r.rhr)),
    overnight: avg(healthy((r) => r.overnight)),
    hrAvg: avg(healthy((r) => r.hrAvg)),
    // Fitbit's estimate stands in before the switch; the row is marked as measured differently.
    vo2: avg(healthy((r) => r.vo2g ?? r.vo2)),
    steps: avg((r) => r.steps),
    active: avg((r) => r.active),
    inBed: avg((r) => r.inBed),
    asleep: avg((r) => r.sleepMin),
    bed: avg((r) => r.bed),
    wake: avg((r) => r.wake),
    deep: avg((r) => r.deep),
    rem: avg((r) => r.rem),
    stress: avg(healthy((r) => r.stress)),
    battery: avg(healthy((r) => r.battery)),
    resp: avg(healthy((r) => r.resp)),
    weight: avg((r) => r.weight),
  };
}

const signed = (v, f) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`;
const sumRows = (get) => (rows) => rows.reduce((s, r) => s + (get(r) || 0), 0);
const avgRows = (get) => (rows) => mean(rows.map(get));
// better: 1 when higher is better, -1 when lower is, 0 when neither, which colors the change column.
// core rows make up the short scorecard. monthly opens a month-by-month chart under the row.
const SCORE_ROWS = [
  { group: 'Running' },
  { key: 'km', across: 'differs', label: 'Distance run', better: 1, total: true, fmt: (v) => `${fmtInt(v)} km`, delta: (v) => signed(v, (x) => `${fmtInt(x)} km`) },
  { key: 'kmPerWeek', across: 'differs', label: 'Per week', core: true, better: 1, fmt: (v) => `${fmt1(v)} km`, delta: (v) => signed(v, (x) => `${fmt1(x)} km`), monthly: { title: 'Kilometres run each month', agg: sumRows((r) => r.runKm), fmt: (v) => `${fmtInt(v)} km` } },
  { key: 'runsPerWeek', across: 'same', label: 'Runs per week', better: 0, fmt: fmt1, delta: (v) => signed(v, fmt1) },
  { key: 'longRuns', across: 'differs', label: 'Runs of 30+ km', better: 0, total: true, fmt: fmtInt, delta: (v) => signed(v, fmtInt) },
  { key: 'marathons', across: 'same', label: 'Marathons', better: 0, total: true, fmt: fmtInt, delta: (v) => signed(v, fmtInt) },
  { key: 'longest', across: 'differs', label: 'Longest run', better: 0, total: true, fmt: (v) => `${fmt1(v)} km`, delta: (v) => signed(v, (x) => `${fmt1(x)} km`) },
  { key: 'pace', label: 'Pace, regular running', core: true, better: -1, fmt: (v) => `${fmtPace(v)} /km`, delta: (v) => signed(v, (x) => fmtPace(x)) },
  { key: 'runHr', label: 'Heart rate, regular running', core: true, better: -1, fmt: (v) => `${fmtInt(v)} bpm`, delta: (v) => signed(v, (x) => `${fmtInt(x)} bpm`) },
  { key: 'fastPerWeek', label: 'Faster segments per week', better: 0, fmt: (v) => `${fmtInt(v)} min`, delta: (v) => signed(v, (x) => `${fmtInt(x)} min`) },
  { key: 'fastPace', label: 'Pace, faster segments', better: -1, fmt: (v) => `${fmtPace(v)} /km`, delta: (v) => signed(v, (x) => fmtPace(x)) },
  { key: 'fastHr', label: 'Heart rate, faster segments', better: -1, fmt: (v) => `${fmtInt(v)} bpm`, delta: (v) => signed(v, (x) => `${fmtInt(x)} bpm`) },
  { key: 'perBeat', label: 'Metres per heartbeat', better: 1, fmt: (v) => v.toFixed(2), delta: (v) => signed(v, (x) => x.toFixed(2)) },
  { key: 'perBeatAdj', label: 'Metres per heartbeat at 6:00/km', core: true, better: 1, fmt: (v) => v.toFixed(2), delta: (v) => signed(v, (x) => x.toFixed(2)) },
  { key: 'climbPerWeek', label: 'Climbing per week', better: 0, fmt: (v) => `${fmtInt(v)} m`, delta: (v) => signed(v, (x) => `${fmtInt(x)} m`) },
  { group: 'Heart' },
  { key: 'rhr', across: 'differs', label: 'Resting heart rate', core: true, better: -1, fmt: (v) => `${fmt1(v)} bpm`, delta: (v) => signed(v, (x) => `${fmt1(x)} bpm`), monthly: { title: 'Resting heart rate, monthly average', agg: avgRows((r) => r.rhr), fmt: (v) => `${fmt1(v)} bpm` } },
  { key: 'overnight', across: 'same', label: 'Heart rate at 3 to 5 AM', better: -1, fmt: (v) => `${fmt1(v)} bpm`, delta: (v) => signed(v, (x) => `${fmt1(x)} bpm`), monthly: { title: 'Heart rate at 3 to 5 AM, monthly average', agg: avgRows((r) => r.overnight), fmt: (v) => `${fmt1(v)} bpm` } },
  { key: 'hrAvg', across: 'same', label: 'All-day heart rate', better: -1, fmt: (v) => `${fmt1(v)} bpm`, delta: (v) => signed(v, (x) => `${fmt1(x)} bpm`) },
  { key: 'vo2', across: 'differs', label: 'VO₂ max estimate', core: true, better: 1, fmt: fmt1, delta: (v) => signed(v, fmt1), monthly: { title: 'VO₂ max estimate, monthly average', agg: avgRows((r) => r.vo2g), fmt: fmt1 } },
  { group: 'Movement' },
  { key: 'steps', across: 'differs', label: 'Steps a day', core: true, better: 1, fmt: fmtInt, delta: (v) => signed(v, fmtInt), monthly: { title: 'Steps a day, monthly average', agg: avgRows((r) => r.steps), fmt: fmtInt, yFmt: (v) => fmtCompact(v) } },
  { key: 'active', across: 'differs', label: 'Intensity minutes a day', better: 1, fmt: fmtInt, delta: (v) => signed(v, fmtInt) },
  { group: 'Sleep' },
  { key: 'inBed', across: 'same', label: 'Time in bed', better: 0, fmt: fmtDuration, delta: (v) => signed(v, fmtDuration) },
  { key: 'asleep', across: 'differs', label: 'Time asleep', core: true, better: 1, fmt: fmtDuration, delta: (v) => signed(v, fmtDuration), monthly: { title: 'Time asleep, monthly average', agg: avgRows((r) => (r.sleepMin == null ? null : r.sleepMin / 60)), fmt: (v) => fmtDuration(v * 60), yFmt: (v) => `${Math.round(v * 10) / 10}h` } },
  { key: 'bed', across: 'same', label: 'Bedtime', core: true, better: 0, fmt: fmtClockFrom18, delta: (v) => `${fmtDuration(Math.abs(v))} ${v < 0 ? 'earlier' : 'later'}` },
  { key: 'wake', across: 'same', label: 'Wake time', better: 0, fmt: fmtClockFrom18, delta: (v) => `${fmtDuration(Math.abs(v))} ${v < 0 ? 'earlier' : 'later'}` },
  { key: 'deep', across: 'differs', label: 'Deep sleep', better: 1, fmt: fmtDuration, delta: (v) => signed(v, fmtDuration) },
  { key: 'rem', across: 'differs', label: 'REM sleep', better: 1, fmt: fmtDuration, delta: (v) => signed(v, fmtDuration) },
  { group: 'Recovery' },
  { key: 'stress', label: 'Stress', core: true, better: -1, fmt: fmt1, delta: (v) => signed(v, fmt1), monthly: { title: 'Stress, monthly average', agg: avgRows((r) => r.stress), fmt: fmt1 } },
  { key: 'battery', label: 'Body Battery peak', better: 1, fmt: fmt1, delta: (v) => signed(v, fmt1), monthly: { title: 'Body Battery peak, monthly average', agg: avgRows((r) => r.battery), fmt: fmt1 } },
  { key: 'resp', label: 'Waking breaths a minute', better: 0, fmt: fmt1, delta: (v) => signed(v, fmt1) },
  { group: 'Body' },
  { key: 'weight', across: 'same', label: 'Weight', private: true, better: 0, fmt: (v) => `${fmt1(v)} lb`, delta: (v) => signed(v, (x) => `${fmt1(x)} lb`), monthly: { title: 'Weight, monthly average', agg: avgRows((r) => r.weight), fmt: (v) => `${fmt1(v)} lb`, isPrivate: true } },
];
// Colors a change by whether it went the better way. Changes under 1% of where it started stay neutral.
const deltaClass = (better, from, to) => {
  if (!better || from == null || to == null) return 'delta';
  const change = to - from;
  if (Math.abs(change) < Math.abs(from) * 0.01) return 'delta';
  return change * better > 0 ? 'delta good' : 'delta bad';
};

function sparkline(values, t) {
  const w = 76;
  const h = 20;
  const present = values.map((v, i) => [v, i]).filter(([v]) => v != null);
  if (present.length < 2) return null;
  const nums = present.map(([v]) => v);
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const x = (i) => 4 + (i / (values.length - 1)) * (w - 8);
  const y = (v) => (hi === lo ? h / 2 : 16 - ((v - lo) / (hi - lo)) * 12);
  const [lastV, lastI] = present.at(-1);
  return svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'presentation' },
    svg('path', { d: `M${present.map(([v, i]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}`, fill: 'none', stroke: t.muted, 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    svg('circle', { cx: x(lastI), cy: y(lastV), r: 3, fill: t.series[0] }));
}

function comparePeriods() {
  const end = data.meta.trackerEnd;
  const startMd = handover().slice(5);
  const endMd = end.slice(5);
  const first = +handover().slice(0, 4);
  const last = +end.slice(0, 4);
  const years = [];
  for (let y = first; y <= last; y++) years.push(y);
  const fitbitStart = data.meta.trackerStart;
  const allYears = [];
  for (let y = +fitbitStart.slice(0, 4); y <= last; y++) allYears.push(y);
  const label = (md) => MONTH_NAMES[+md.slice(0, 2) - 1] + ' ' + +md.slice(3);
  // The same dates each year come first: they're the window every headline on the site uses.
  return {
    same: {
      button: `${label(startMd)} to ${label(endMd)}`,
      title: `${label(startMd)} to ${label(endMd)} of each year`,
      note: `The dates all ${years.length} Garmin years share, so seasons even out.`,
      periods: years.map((y) => ({ label: String(y), from: `${y}-${startMd}`, to: `${y}-${endMd}` })),
    },
    full: {
      button: 'Whole calendar years',
      title: 'whole calendar years',
      partial: true,
      note: `${first} and ${last} are partial (*), so their totals show no change.`,
      periods: years.map((y) => ({ label: y === first || y === last ? `${y}*` : String(y), from: y === first ? handover() : `${y}-01-01`, to: y === last ? end : `${y}-12-31` })),
    },
    ytd: {
      button: `Jan 1 to ${label(endMd)}`,
      title: `Jan 1 to ${label(endMd)} of each year`,
      note: `${first} is left out: the watch arrived in June.`,
      periods: years.slice(1).map((y) => ({ label: String(y), from: `${y}-01-01`, to: `${y}-${endMd}` })),
    },
    both: {
      button: `Both watches, ${allYears[0]} to ${last}`,
      title: 'whole calendar years on both watches',
      partial: true,
      crossDevice: true,
      note: `Fitbit until ${fmtDay(handover())}, Garmin after. Rows marked † are measured differently by each watch, so they show no change.`,
      periods: allYears.map((y) => ({
        label: y === allYears[0] || y === last ? `${y}*` : String(y),
        from: y === allYears[0] ? fitbitStart : `${y}-01-01`,
        to: y === last ? end : `${y}-12-31`,
      })),
    },
  };
}

function monthlyOverlay({ title, sub, agg, fmt, isPrivate, yFmt }) {
  const from = handover();
  const years = [...new Set(garminDays().map((r) => r.date.slice(0, 4)))].slice(-5);
  const series = years.map((year) => ({
    year,
    points: MONTH_NAMES.map((_, m) => {
      const prefix = `${year}-${String(m + 1).padStart(2, '0')}`;
      const rows = garminDays().filter((r) => r.date.startsWith(prefix) && r.date >= from);
      return { x: m + 1, y: rows.length >= 10 ? agg(rows, prefix) : null };
    }),
  }));
  // Opens from a scorecard row, which already carries the numbers, so it has no takeaway of its own.
  return figure({
    title,
    sub,
    private: isPrivate,
    height: 230,
    render(host, width, t) {
      lineChart(host, width, t, {
        series: series.map((s, i) => ({ name: s.year, color: yearColor(t, i, series.length), points: s.points, tipFmt: fmt })),
        xType: 'linear',
        xDomain: [1, 12],
        height: 230,
        rightPad: 14,
        yFmt: yFmt || ((v) => `${Math.round(v * 10) / 10}`),
        xFmt: (x) => MONTH_NAMES[x - 1],
        xTickList: [1, 3, 5, 7, 9, 11].map((m) => ({ v: m, label: MONTH_NAMES[m - 1] })),
      });
    },
    legend: (t) => series.map((s, i) => ({ color: yearColor(t, i, series.length), label: s.year })),
    table: () => ({
      columns: ['Month', ...series.map((s) => s.year)],
      rows: MONTH_NAMES.map((name, m) => [name, ...series.map((s) => (s.points[m].y == null ? '—' : fmt(s.points[m].y)))]),
    }),
  });
}

function renderCompare() {
  const presets = comparePeriods();
  let active = 'same';
  let showAll = false;
  // Rows whose monthly chart is open stay open when the window changes.
  const openCharts = new Set();
  const chartCache = new Map();
  const same = presets.same.periods.map(periodStats);
  const a = same[0];
  const b = same.at(-1);
  const firstLabel = presets.same.periods[0].label;
  const lastLabel = presets.same.periods.at(-1).label;
  const moreRunning = Math.round(((b.kmPerWeek - a.kmPerWeek) / a.kmPerWeek) * 100);
  const allMarathons = data.workouts.filter((w) => w.type === 'Run' && w.km >= 41 && w.km <= 48 && w.d >= handover());
  const scoreTitle = el('div', { class: 'fig-title' });
  const scoreHost = el('div', { class: 'table-scroll' });
  const noteEl = el('div', { class: 'fig-sub' });
  const allToggle = el('button', { type: 'button', class: 'link-button score-more', onclick: () => { showAll = !showAll; drawScore(); } });
  const buttons = Object.entries(presets).map(([key, preset]) => el('button', {
    type: 'button',
    text: preset.button,
    'aria-pressed': key === active ? 'true' : 'false',
    onclick: () => { active = key; drawScore(); },
    'data-preset': key,
  }));
  const chartFor = (row) => {
    if (!chartCache.has(row.key)) chartCache.set(row.key, monthlyOverlay(row.monthly));
    return chartCache.get(row.key);
  };

  function drawScore() {
    const t = theme();
    const preset = presets[active];
    const stats = preset.periods.map(periodStats);
    buttons.forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.preset === active ? 'true' : 'false'));
    scoreTitle.textContent = `Your scorecard: ${preset.title}`;
    const inWindow = allMarathons.filter((m) => preset.periods.some((p) => m.d >= p.from && m.d <= p.to)).length;
    const missing = allMarathons.length - inWindow;
    noteEl.textContent = `${preset.note}${missing ? ` ${missing} of your ${allMarathons.length} marathons fall outside these dates.` : ''} Green is better, red is worse. Rows with ▸ open a monthly chart.`;
    const headers = ['', ...preset.periods.map((p) => p.label), `Change, ${preset.periods[0].label.replace('*', '')} to ${preset.periods.at(-1).label.replace('*', '')}`, 'Trend'];
    // A group heading shows only when at least one of its rows does.
    const visible = (r) => showAll || r.core;
    const shownRows = SCORE_ROWS.filter((row, i) => {
      if (!row.group) return visible(row);
      const next = SCORE_ROWS.slice(i + 1).find((r) => r.group || visible(r));
      return next && !next.group;
    });
    const metricCount = SCORE_ROWS.filter((r) => !r.group).length;
    allToggle.textContent = showAll ? 'Show the key rows only' : `Show all ${metricCount} metrics`;
    scoreHost.replaceChildren(el('table', { class: 'score' },
      el('thead', null, el('tr', null, headers.map((h, i) => el('th', { scope: 'col', text: h, class: i === 0 ? 'label' : null })))),
      el('tbody', null, shownRows.flatMap((row) => {
        if (row.group) return [el('tr', { class: 'group' }, el('td', { colspan: String(headers.length), text: row.group }))];
        const values = stats.map((s) => s[row.key]);
        const firstV = values.find((v) => v != null);
        const lastV = [...values].reverse().find((v) => v != null);
        const crossBlank = preset.crossDevice && row.across !== 'same';
        const blank = firstV == null || lastV == null || (preset.partial && row.total) || crossBlank;
        const label = preset.crossDevice && row.across === 'differs' ? `${row.label} †` : row.label;
        const open = openCharts.has(row.key);
        const labelCell = row.monthly
          ? el('td', { class: 'label' }, el('button', {
            type: 'button',
            class: 'row-toggle',
            'aria-expanded': String(open),
            text: `${open ? '▾' : '▸'} ${label}`,
            onclick: () => { if (open) openCharts.delete(row.key); else openCharts.add(row.key); drawScore(); },
          }))
          : el('td', { class: 'label', text: label });
        const out = [el('tr', { class: row.private ? 'private' : null },
          labelCell,
          values.map((v, i) => el('td', { class: i === values.length - 1 ? 'latest' : null, text: v == null ? '—' : row.fmt(v) })),
          el('td', { class: blank ? 'delta' : deltaClass(row.better, firstV, lastV), text: blank ? '—' : row.delta(lastV - firstV) }),
          el('td', null, sparkline(values, t)))];
        if (open) out.push(el('tr', { class: `chart-row${row.private ? ' private' : ''}` }, el('td', { colspan: String(headers.length) }, chartFor(row))));
        return out;
      }))));
  }

  const runDays = garminDays().map((r) => r.date);
  const cumulative = [...new Set(runDays.map((d) => d.slice(0, 4)))].slice(-5).map((year) => {
    let total = 0;
    const points = [];
    for (const d of runDays) {
      if (!d.startsWith(year)) continue;
      total += row(d).runKm || 0;
      points.push({ x: Math.round((dayMs(d) - Date.UTC(+year, 0, 1)) / DAY) + 1, y: total });
    }
    return { year, points, total };
  });
  const latestRun = cumulative.at(-1);
  const priorRun = cumulative.at(-2);
  const latestDoy = latestRun.points.at(-1)?.x ?? 0;
  const priorByThen = priorRun ? (priorRun.points.filter((pt) => pt.x <= latestDoy).at(-1)?.y ?? 0) : null;
  const doyTicks = MONTH_NAMES.map((name, m) => ({ v: Math.round((Date.UTC(2023, m, 1) - Date.UTC(2023, 0, 1)) / DAY) + 1, label: name })).filter((_, m) => m % 2 === 0);

  return chapter('compare', '1 · Year over year',
    `${firstLabel} to ${lastLabel}: ${moreRunning}% more running, a resting heart rate ${fmt1(a.rhr - b.rhr)} bpm lower, and ${fmtDuration(b.asleep - a.asleep)} more sleep a night`,
    `Comparing the same ${presets.same.button} dates each year, all on one watch.`,
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Comparison window' }, buttons),
    figure({
      title: 'Your scorecard',
      render(host) {
        host.closest('figure')?.querySelector('.fig-title')?.replaceWith(scoreTitle);
        host.append(noteEl, scoreHost, allToggle);
        drawScore();
      },
    }),
    jumpsFigure(),
    figure({
      title: 'Kilometres run, building through each year',
      takeaway: priorRun ? `${latestRun.year} is at ${fmtInt(latestRun.total)} km, ${fmtInt(Math.abs(latestRun.total - priorByThen))} km ${latestRun.total >= priorByThen ? 'ahead of' : 'behind'} ${priorRun.year} on the same date.` : null,
      sub: 'Each line restarts on January 1. Darkest is the latest year.',
      height: 320,
      render(host, width, t) {
        lineChart(host, width, t, {
          series: cumulative.map((s, i) => ({ name: s.year, color: yearColor(t, i, cumulative.length), points: s.points, endLabel: s.year, tipFmt: (v) => `${fmtInt(v)} km` })),
          xType: 'linear',
          xDomain: [1, 366],
          height: 320,
          rightPad: 44,
          left: 46,
          yFmt: (v) => fmtInt(v),
          xFmt: (x) => new Date(Date.UTC(2023, 0, x)).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
          xTickList: doyTicks,
        });
      },
      legend: (t) => cumulative.map((s, i) => ({ color: yearColor(t, i, cumulative.length), label: `${s.year}: ${fmtInt(s.total)} km` })),
      table: () => ({ columns: ['Year', 'Kilometres'], rows: cumulative.map((s) => [s.year, fmtInt(s.total)]) }),
    }));
}

// ---------- chapter: how the sources were merged ----------

function renderRecord() {
  const { coverage, tzSpans, firstDate, lastDate, dedupe } = data.meta;
  const a = dedupe.activities;
  const rawTotal = Object.values(a.raw).reduce((sum, n) => sum + n, 0);
  const allMonths = months(firstDate.slice(0, 7), lastDate.slice(0, 7));
  const order = ['Heart rate', 'Steps', 'Sleep', 'Activities: Fitbit', 'Activities: Garmin', 'Activities: Strava', 'GPS routes', 'Stress and recovery', 'Weight', 'Cycle log', 'Food log'];
  const rows = order.filter((name) => coverage.some((c) => c.row === name));
  const shared = Object.keys(SOURCE).filter((id) => a.raw[id] != null)
    .map((id) => ({ name: SOURCE[id].label, only: a[`${id}Only`], shared: a.raw[id] - a[`${id}Only`] }));
  // Which copies were folded together, for the sources present.
  const copies = [
    a.raw.strava != null && a.raw.garmin != null && 'Strava re-hosts almost every Garmin activity',
    a.clockShift != null && `Garmin's workouts were also copied into Fitbit with the clock moved ${a.clockShift} hours`,
  ].filter(Boolean);
  const away = tzSpans.filter((s) => s.start >= handover() && s.zone !== 'Eastern').length;

  return chapter('record', '14 · How the data was merged',
    `Your ${shared.length > 1 ? 'apps' : shared[0].name} listed ${fmtInt(rawTotal)} activities. ${fmtInt(a.merged)} of them really happened.`,
    'Each day comes from one watch, and each activity counts once.',
    howMeasured(`${copies.length ? `${copies.join(', and ')}. Each of those is now one entry. ` : 'Activities listed twice are now one entry. '}The Data notes below list every rule.`),
    // With a single app there is nothing to split, so the clock figure takes the full width.
    (shared.length > 1 ? grid2 : (...kids) => kids)(
      shared.length < 2 ? null : figure({
        title: 'How much each app adds',
        sub: 'Activities each app listed, split by whether another app has it too.',
        height: 170,
        render(host, width, t) {
          const labelW = 56;
          const rowH = 40;
          const height = shared.length * rowH + 4;
          const max = Math.max(...shared.map((s) => s.only + s.shared));
          const scale = linear(0, max, 0, width - labelW - 60);
          const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Activities per app, unique and shared. A table view follows.' });
          shared.forEach((s, i) => {
            const y = i * rowH + 8;
            root.append(svg('text', { x: labelW - 8, y: y + 15, 'text-anchor': 'end', class: 'note-label', text: s.name }));
            const onlyW = s.only ? Math.max(2, scale(s.only)) : 0;
            const sharedW = s.shared ? Math.max(2, scale(s.shared)) : 0;
            const gap = onlyW && sharedW ? 2 : 0;
            if (onlyW) root.append(svg('rect', { x: labelW, y, width: onlyW, height: 22, rx: 3, fill: t.series[0] }));
            if (sharedW) root.append(svg('rect', { x: labelW + onlyW + gap, y, width: sharedW, height: 22, rx: 3, fill: t.series[1] }));
            root.append(svg('text', { x: labelW + onlyW + sharedW + gap + 6, y: y + 16, class: 'value-label', text: fmtInt(s.only + s.shared) }));
            const hit = svg('rect', { x: 0, y: i * rowH, width, height: rowH, fill: 'transparent' });
            hit.addEventListener('pointermove', (evt) => showTip(evt, `<b>${esc(s.name)}</b>${tipRow(t.series[0], 'Only here', fmtInt(s.only))}${tipRow(t.series[1], 'Also in another app', fmtInt(s.shared))}`));
            hit.addEventListener('pointerleave', hideTip);
            root.append(hit);
          });
          host.append(root);
        },
        legend: (t) => [{ color: t.series[0], label: 'Only in this app' }, { color: t.series[1], label: 'Also in another app' }],
        table: () => ({ columns: ['App', 'Listed', 'Only here', 'Also elsewhere'], rows: shared.map((s) => [s.name, fmtInt(s.only + s.shared), fmtInt(s.only), fmtInt(s.shared)]) }),
      }),
      figure({
        title: 'Where your clock was set',
        sub: `${away} stints outside Eastern time since ${handover().slice(0, 4)}. Hover for dates.`,
        height: 170,
        render(host, width, t) {
          const height = 92;
          const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Time zones over time. A table view follows.' });
          const start = dayMs(tzSpans[0].start);
          const end = dayMs(tzSpans.at(-1).end) + DAY;
          const x = linear(start, end, 0, width);
          for (const s of tzSpans) {
            const home = s.zone === 'Eastern';
            const left = x(dayMs(s.start));
            const rect = svg('rect', { x: left, y: 22, width: Math.max(2, x(dayMs(s.end) + DAY) - left - 1), height: 34, rx: 3, fill: home ? stageColor(t, 'A') : t.series[0] });
            rect.addEventListener('pointermove', (evt) => showTip(evt, `<b>${esc(s.zone)} time</b><div>${esc(fmtDay(s.start))} to ${esc(fmtDay(s.end))}</div>`));
            rect.addEventListener('pointerleave', hideTip);
            root.append(rect);
          }
          for (let y = new Date(start).getUTCFullYear() + 1; y <= new Date(end).getUTCFullYear(); y++) {
            const tickX = x(Date.UTC(y, 0, 1));
            if (tickX > 16 && tickX < width - 16) root.append(svg('text', { x: tickX, y: 76, 'text-anchor': 'middle', class: 'axis-label', text: String(y) }));
          }
          host.append(root);
        },
        legend: (t) => [{ color: stageColor(t, 'A'), label: 'Eastern' }, { color: t.series[0], label: 'Any other zone' }],
        table: () => ({ columns: ['Zone', 'From', 'To'], rows: tzSpans.map((s) => [s.zone, fmtDay(s.start), fmtDay(s.end)]) }),
      })),
    figure({
      title: 'Which app supplied what, and when',
      takeaway: (() => {
        const span = (src) => {
          const ms = coverage.filter((c) => c.source === src).flatMap((c) => c.months.map(([m]) => m)).sort();
          return ms.length ? `${SOURCE[src].label} ${fmtMonth(ms[0])} to ${fmtMonth(ms.at(-1))}` : null;
        };
        return `${['fitbit', 'garmin', 'strava'].map(span).filter(Boolean).join(', ')}.`;
      })(),
      sub: 'Each mark is a month with data, colored by the source used.',
      height: 320,
      render(host, width, t) {
        const labelW = Math.min(150, width * 0.3);
        const rowH = 22;
        const height = rows.length * rowH + 22;
        const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Data coverage by month and source. A table view follows.' });
        const band = (width - labelW) / allMonths.length;
        const xFor = (m) => labelW + allMonths.indexOf(m) * band;
        for (let y = +allMonths[0].slice(0, 4) + 1; y <= +allMonths.at(-1).slice(0, 4); y++) {
          const x = xFor(`${y}-01`);
          root.append(svg('line', { x1: x, x2: x, y1: 0, y2: rows.length * rowH, stroke: t.grid, 'stroke-width': 1 }));
          root.append(svg('text', { x, y: rows.length * rowH + 15, 'text-anchor': 'middle', class: 'axis-label', text: String(y) }));
        }
        rows.forEach((name, i) => {
          const y = i * rowH;
          root.append(svg('text', { x: labelW - 8, y: y + 15, 'text-anchor': 'end', class: 'note-label', text: name }));
          for (const c of coverage.filter((x) => x.row === name)) {
            for (const [m, n] of c.months) {
              if (!allMonths.includes(m)) continue;
              const cell = svg('rect', { x: xFor(m) + 0.5, y: y + 4, width: Math.max(1, band - 1), height: rowH - 8, rx: 2, fill: t.series[SOURCE[c.source].slot] });
              cell.addEventListener('pointermove', (evt) => showTip(evt, `<b>${esc(name)}, ${esc(fmtMonth(m))}</b>${tipRow(null, SOURCE[c.source].label, `${fmtInt(n)} entries`)}`));
              cell.addEventListener('pointerleave', hideTip);
              root.append(cell);
            }
          }
        });
        host.append(root);
      },
      legend: (t) => Object.values(SOURCE).map((s) => ({ color: t.series[s.slot], label: s.label })),
      table: () => ({
        columns: ['Dataset', 'Source', 'First month', 'Last month', 'Months'],
        rows: coverage.map((c) => [c.row, SOURCE[c.source].label, fmtMonth(c.months[0][0]), fmtMonth(c.months.at(-1)[0]), String(c.months.length)]),
      }),
    }));
}

// ---------- chapter: heart ----------

function renderHeart() {
  const dates = garminDays().filter((r) => r.rhr != null).map((r) => r.date);
  const raw = dates.map((d) => ({ x: dayMs(d), y: row(d).rhr }));
  const smooth = rolling(dates, healthy((r) => r.rhr));
  const smoothPts = dates.map((d, i) => ({ x: dayMs(d), y: smooth[i] }));
  const lowDay = dates.map(row).reduce((a, b) => (b.rhr < a.rhr ? b : a));
  const nightDates = garminDays().filter((r) => r.overnight != null).map((r) => r.date);
  const nightSmooth = rolling(nightDates, healthy((r) => r.overnight));
  const nightPts = nightDates.map((d, i) => ({ x: dayMs(d), y: nightSmooth[i] }));
  const vo2Dates = garminDays().filter((r) => r.vo2g != null).map((r) => r.date);
  const vo2g = rolling(vo2Dates, (r) => r.vo2g, 56, 5);
  const vo2Pts = vo2Dates.map((d, i) => ({ x: dayMs(d), y: vo2g[i] }));
  const validG = vo2Pts.filter((p) => p.y != null);
  const years = data.hourYear.filter((y) => +y.year >= +handover().slice(0, 4)).slice(-5);
  const heartPeriods = comparePeriods().same.periods;
  const heartA = periodStats(heartPeriods[0]);
  const heartB = periodStats(heartPeriods.at(-1));

  return chapter('heart', '4 · Heart',
    `Your resting heart rate fell from ${fmt1(heartA.rhr)} bpm in ${heartPeriods[0].label} to ${fmt1(heartB.rhr)} in ${heartPeriods.at(-1).label}`,
    `Your raw 3 to 5 AM heart rate fell too, so it isn't just Garmin's formula. VO₂ max rose from ${fmt1(heartA.vo2)} to ${fmt1(heartB.vo2)}.`,
    howMeasured(`Same ${comparePeriods().same.button} dates each year. Heart rate at 3 to 5 AM went from ${fmt1(heartA.overnight)} to ${fmt1(heartB.overnight)} bpm. ${watches().at(-1).label}'s resting number typically reads about ${Math.abs(data.restingGap).toFixed(0)} bpm ${data.restingGap > 0 ? 'above' : 'below'} it.`),
    figure({
      title: 'Resting heart rate and 3 to 5 AM heart rate',
      sub: '28-day averages over each day\'s reading (faint). Click to open a day.',
      method: 'The averages leave out days you were sick, which are shaded.',
      height: 300,
      render(host, width, t) {
        lineChart(host, width, t, {
          series: [
            { name: 'That day', color: t.series[0], points: raw, faint: true },
            { name: 'Resting, 28-day average', color: t.series[0], points: smoothPts, tipFmt: (v) => `${fmt1(v)} bpm` },
            { name: '3 to 5 AM, 28-day average', color: t.series[1], points: nightPts, tipFmt: (v) => `${fmt1(v)} bpm` },
          ],
          height: 300,
          yFmt: (v) => `${Math.round(v)}`,
          xFmt: (x) => fmtDay(isoDay(x)),
          breakGap: 8 * DAY,
          spans: sickSpans(t),
          marks: [{ x: dayMs(lowDay.date), y: lowDay.rhr, label: `Lowest: ${fmt1(lowDay.rhr)}`, anchor: 'end', dx: -8, dy: 4 }],
          onPick: (x) => openDay(isoDay(x)),
        });
      },
      legend: (t) => [{ color: t.series[0], label: 'Resting heart rate' }, { color: t.series[1], label: 'Heart rate at 3 to 5 AM' }],
      table: () => monthlyTable([['Resting HR', (r) => r.rhr, fmt1], ['3 to 5 AM', (r) => r.overnight, fmt1]], handover(), data.meta.trackerEnd),
    }),
    grid2(
      figure({
        title: 'VO₂ max estimate',
        takeaway: `Latest 8-week average: ${fmt1(validG.at(-1).y)}.`,
        sub: 'Garmin\'s estimate from your runs, 8-week average.',
        height: 240,
        render(host, width, t) {
          lineChart(host, width, t, {
            series: [{ name: 'VO₂ max', color: t.series[0], points: vo2Pts, tipFmt: fmt1 }],
            height: 240,
            yFmt: (v) => `${Math.round(v)}`,
            xFmt: (x) => fmtDay(isoDay(x)),
            breakGap: 30 * DAY,
            marks: [{ x: validG.at(-1).x, y: validG.at(-1).y, label: fmt1(validG.at(-1).y), anchor: 'end', dx: -8, dy: 24 }],
          });
        },
        table: () => monthlyTable([['VO₂ max', (r) => r.vo2g, fmt1]], handover(), data.meta.trackerEnd),
      }),
      figure({
        title: 'A typical day, year by year',
        takeaway: (() => {
          const [y0, y1] = [years[0], years.at(-1)];
          const day = (y) => mean(y.hours.slice(9, 21));
          return `Around 3 AM: ${Math.round(y0.hours[3])} bpm in ${y0.year}, ${Math.round(y1.hours[3])} in ${y1.year}. Daytime: ${Math.round(day(y0))} against ${Math.round(day(y1))}.`;
        })(),
        sub: 'Average for each hour. Darkest is the latest year.',
        height: 240,
        render(host, width, t) {
          lineChart(host, width, t, {
            series: years.map((y, i) => ({
              name: y.year,
              color: yearColor(t, i, years.length),
              points: y.hours.map((v, h) => ({ x: h + 0.5, y: v })),
              tipFmt: (v) => `${Math.round(v)} bpm`,
            })),
            xType: 'linear',
            xDomain: [0, 24],
            height: 240,
            yFmt: (v) => `${Math.round(v)}`,
            xFmt: (x) => fmtClock(Math.floor(x) * 60),
            xTickList: [0, 6, 12, 18, 24].map((h) => ({ v: h, label: fmtHourShort(h) })),
          });
        },
        legend: (t) => years.map((y, i) => ({ color: yearColor(t, i, years.length), label: y.year })),
        table: () => ({
          columns: ['Hour', ...years.map((y) => y.year)],
          rows: Array.from({ length: 24 }, (_, h) => [fmtClock(h * 60), ...years.map((y) => fmtInt(y.hours[h]))]),
        }),
      })));
}

// ---------- heart rate at each pace, year by year ----------

// A bucket needs this many runs before its heart rate is drawn.
const PACE_MIN_RUNS = 10;

function paceHeartFigure() {
  const { edges, years } = data.paceHeart;
  const fmtSec = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
  const buckets = edges.slice(1).map((fast, i) => ({ slow: edges[i], fast, label: `${fmtSec(edges[i])} to ${fmtSec(fast)}`, kmh: 3600 / ((edges[i] + fast) / 2) }));
  const shown = (c) => c.runs >= PACE_MIN_RUNS;
  const rows = years.filter((y) => y.cells.some(shown));
  if (rows.length < 2) return null;
  // Every pace is compared from one base year, the first with enough runs at all of them.
  const base = rows.find((y) => y.cells.every(shown)) ?? rows[0];
  const last = rows.at(-1);
  const change = buckets.map((b, i) => (shown(base.cells[i]) && shown(last.cells[i]) ? { ...b, from: base.cells[i].hr, to: last.cells[i].hr, drop: base.cells[i].hr - last.cells[i].hr } : null)).filter(Boolean);
  if (!change.length) return null;
  const easy = change[0];
  const biggest = change.reduce((p, q) => (q.drop > p.drop ? q : p));
  const smallest = change.reduce((p, q) => (q.drop < p.drop ? q : p));
  return figure({
    title: 'Heart rate at each pace',
    takeaway: `Since ${base.year}, your heart rate has dropped at every pace, by ${Math.round(easy.drop)} bpm at an easy ${easy.label} per km. The biggest drop is at ${biggest.label}, from ${Math.round(biggest.from)} to ${Math.round(biggest.to)} bpm, and the smallest at ${smallest.label}, ${Math.round(smallest.drop)} bpm.`,
    sub: `Median heart rate at each pace, one line per year. Darkest is the latest year. The table gives bpm, with the runs and minutes behind each; a dash means fewer than ${PACE_MIN_RUNS} runs.`,
    method: `These aren't whole-run averages. Each outdoor run is cut into one-minute pieces, each with its own pace and heart rate, and only steady minutes are kept: past the first 10 minutes, and held within 8% of the pace of the two minutes before, so heart rate has caught up with the pace. These are the same minutes the heartbeat figure above uses. Each run with 3 or more steady minutes at a pace counts once there, at the median heart rate of those minutes, so a long race doesn't outweigh a short session, and one run can count at several paces. Each year's number is the median across its runs. A pace needs ${PACE_MIN_RUNS} runs in a year to be drawn, so ${years[0].year}, which starts in ${fmtMonth(handover().slice(0, 7))}, stops short of the faster paces. Fast paces come mostly from races, tempo runs and reps, so they're harder efforts than the easy end. Days you were sick are left out.`,
    height: 280,
    render(host, width, t) {
      lineChart(host, width, t, {
        series: rows.map((y, i) => ({
          name: y.year,
          color: yearColor(t, i, rows.length),
          points: buckets.map((b, k) => ({ x: b.kmh, y: shown(y.cells[k]) ? y.cells[k].hr : null })),
          tipFmt: (v) => `${Math.round(v)} bpm`,
        })),
        xType: 'linear',
        xDomain: [3600 / edges[0], 3600 / edges.at(-1)],
        height: 280,
        yFmt: (v) => `${Math.round(v)}`,
        xFmt: (x) => `${buckets.find((b) => Math.abs(b.kmh - x) < 0.01)?.label ?? fmtSec(3600 / x)} per km`,
        xTickList: [390, 360, 330, 300, 270, 240].map((sec) => ({ v: 3600 / sec, label: fmtSec(sec) })),
      });
      // The legend sits between the chart and the table, which would otherwise push it far below the lines.
      host.append(renderLegend(rows.map((y, i) => ({ color: yearColor(t, i, rows.length), label: y.year }))));
      // The same numbers as a year-by-pace table, with how many runs and minutes each one rests on.
      // Cells are shaded on the site's sequential ramp, darker for higher heart rate.
      const ramp = rampTable(t.ramp);
      const values = years.flatMap((y) => y.cells.filter(shown).map((c) => c.hr));
      const [lo, hi] = [Math.min(...values), Math.max(...values)];
      const cell = (c) => {
        if (!shown(c)) return el('td', { class: 'thin' }, '—', el('span', { class: 'cell-sub', text: `${fmtInt(c.runs)} runs · ${fmtInt(c.minutes)} min` }));
        const f = (c.hr - lo) / (hi - lo || 1);
        const [r, g, b] = ramp(f);
        return el('td', { class: `shaded${f > 0.42 ? ' on-dark' : ''}`, style: `background: rgb(${r}, ${g}, ${b})` },
          `${Math.round(c.hr)}`,
          el('span', { class: 'cell-sub', text: `${fmtInt(c.runs)} runs · ${fmtInt(c.minutes)} min` }));
      };
      host.append(el('div', { class: 'table-scroll' }, el('table', { class: 'score pace-table' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', class: 'label', text: 'Pace per km' }),
          buckets.map((b) => el('th', { scope: 'col', text: b.label.replace(' to ', '–') })))),
        el('tbody', null,
          years.map((y) => el('tr', null, el('th', { scope: 'row', class: 'label', text: y.year }), y.cells.map(cell))),
          el('tr', { class: 'change' },
            el('th', { scope: 'row', class: 'label', text: `Since ${base.year}` }),
            buckets.map((b) => {
              const c = change.find((x) => x.slow === b.slow);
              return el('td', { class: c ? `delta${c.drop > 0 ? ' good' : c.drop < 0 ? ' bad' : ''}` : null, text: c ? `${c.drop > 0 ? '−' : c.drop < 0 ? '+' : ''}${Math.abs(Math.round(c.drop))} bpm` : '—' });
            }))))),
        renderLegend([{ ramp: rampCss(t.ramp), from: `${Math.round(lo)} bpm`, to: `${Math.round(hi)} bpm` }]));
    },
  });
}

// ---------- metres per heartbeat: what a beat buys you, with pace held fixed ----------

// Built from each run's steady minutes (see scripts/lib/segments.mjs), so warm-ups, cool-downs and the
// switches between reps and recoveries don't blur pace and heart rate together.
let beatCache;
function beatData() {
  if (beatCache) return beatCache;
  const runs = garminRuns().filter((r) => r.seg && r.seg.adj != null && r.seg.rm + r.seg.fm >= 10 && !isSick(r.d)).map((r) => {
    const km = r.seg.rk + r.seg.fk;
    const minutes = r.seg.rm + r.seg.fm;
    const beats = r.seg.rb + r.seg.fb;
    return { ...r, steadyKm: km, steadyMin: minutes, speed: km / (minutes / 60), hrSteady: beats / minutes, mpb: (km * 1000) / beats, adjusted: r.seg.adj };
  });
  const rollingMedian = (key) => runs.map((_, i) => (i >= 12 && i < runs.length - 12 ? median(runs.slice(i - 12, i + 13).map((r) => r[key])) : null));
  const years = [...new Set(runs.map((r) => r.d.slice(0, 4)))];
  const sum = (list, get) => list.reduce((s, r) => s + get(r), 0);
  const byYear = years.map((y) => {
    const list = runs.filter((r) => r.d.startsWith(y));
    const rk = sum(list, (r) => r.seg.rk); const rm = sum(list, (r) => r.seg.rm); const rb = sum(list, (r) => r.seg.rb);
    const fk = sum(list, (r) => r.seg.fk); const fm = sum(list, (r) => r.seg.fm); const fb = sum(list, (r) => r.seg.fb);
    const fhm = sum(list, (r) => r.seg.fhm ?? r.seg.fm);
    return {
      year: y,
      runs: list.length,
      adjusted: median(list.map((r) => r.adjusted)),
      raw: median(list.map((r) => r.mpb)),
      regularPace: rk ? rm / rk : null,
      regularHr: rm ? rb / rm : null,
      fastPace: fk ? fm / fk : null,
      fastHr: fhm ? fb / fhm : null,
    };
  });
  beatCache = { runs, perKmh: data.meta.dedupe.segments.perKmh, adjustedLine: rollingMedian('adjusted'), rawLine: rollingMedian('mpb'), byYear };
  return beatCache;
}

function heartbeatFigure() {
  const { runs, perKmh, adjustedLine, rawLine, byYear } = beatData();
  const first = byYear[0];
  const last = byYear.at(-1);
  const gainAdj = (last.adjusted - first.adjusted) / first.adjusted;
  const gainRaw = (last.raw - first.raw) / first.raw;
  const validAdj = runs.map((r, i) => ({ x: dayMs(r.d), y: adjustedLine[i] })).filter((p) => p.y != null);
  // The trend needs two years of runs, and enough runs for the 25-run median.
  if (byYear.length < 2 || !validAdj.length) return null;
  return figure({
    title: 'How far one heartbeat carries you',
    takeaway: `At the same 6:00/km pace, each beat carries you ${Math.abs(gainAdj * 100).toFixed(0)}% ${gainAdj >= 0 ? 'further' : 'less far'} than in ${first.year}.`,
    sub: 'Metres per heartbeat on outdoor runs. Dots are single runs; click one to open its day.',
    method: `Distance divided by heartbeats, minute by minute. Each run's first 10 minutes and the 2 minutes after any change of pace are left out while heart rate catches up. Faster minutes naturally score higher, about ${perKmh.toFixed(3)} m per beat for every extra km/h, so the blue line puts every minute on the same 6:00/km footing. Unadjusted, the gain is ${(gainRaw * 100).toFixed(1)}%, so ${gainAdj / gainRaw >= 0.9 ? 'nearly all' : gainAdj / gainRaw >= 0.6 ? 'most' : 'only some'} of it holds at a fixed pace.`,
    height: 320,
    render(host, width, t) {
      lineChart(host, width, t, {
        series: [
          { name: 'Each run, at 6:00/km', color: t.series[0], dots: true, points: runs.map((r) => ({ x: dayMs(r.d), y: r.adjusted })) },
          { name: 'At 6:00/km, median of 25 runs', color: t.series[0], points: runs.map((r, i) => ({ x: dayMs(r.d), y: adjustedLine[i] })), tipFmt: (v) => `${v.toFixed(3)} m` },
          { name: 'As run, median of 25 runs', color: t.series[1], points: runs.map((r, i) => ({ x: dayMs(r.d), y: rawLine[i] })), tipFmt: (v) => `${v.toFixed(3)} m` },
        ],
        height: 320,
        yFmt: (v) => v.toFixed(2),
        xFmt: (x) => fmtDay(isoDay(x)),
        breakGap: 120 * DAY,
        marks: [{ x: validAdj.at(-1).x, y: validAdj.at(-1).y, label: `${validAdj.at(-1).y.toFixed(2)} m`, anchor: 'end', dx: -8, dy: 20 }],
        onPick: (x) => openDay(isoDay(x)),
      });
      host.append(el('div', { class: 'table-scroll' }, el('table', { class: 'score' },
        el('thead', null, el('tr', null, ['', ...byYear.map((y) => y.year)].map((h, i) => el('th', { scope: 'col', text: h, class: i === 0 ? 'label' : null })))),
        el('tbody', null,
          el('tr', null, el('td', { class: 'label', text: 'Metres per beat at 6:00/km' }), byYear.map((y, i) => el('td', { class: i === byYear.length - 1 ? 'latest' : null, text: y.adjusted.toFixed(3) }))),
          el('tr', null, el('td', { class: 'label', text: 'Metres per beat, as run' }), byYear.map((y) => el('td', { text: y.raw.toFixed(3) }))),
          el('tr', null, el('td', { class: 'label', text: 'Pace, regular running' }), byYear.map((y) => el('td', { text: `${fmtPace(y.regularPace)} /km` }))),
          el('tr', null, el('td', { class: 'label', text: 'Heart rate, regular running' }), byYear.map((y) => el('td', { text: `${fmtInt(y.regularHr)} bpm` }))),
          el('tr', null, el('td', { class: 'label', text: 'Pace, faster segments' }), byYear.map((y) => el('td', { text: y.fastPace ? `${fmtPace(y.fastPace)} /km` : '—' }))),
          el('tr', null, el('td', { class: 'label', text: 'Heart rate, faster segments' }), byYear.map((y) => el('td', { text: y.fastHr ? `${fmtInt(y.fastHr)} bpm` : '—' }))),
          el('tr', null, el('td', { class: 'label', text: 'Runs' }), byYear.map((y) => el('td', { text: fmtInt(y.runs) })))))));
    },
    legend: (t) => [
      { color: t.series[0], label: 'At 6:00/km pace (dots are single runs)' },
      { color: t.series[1], label: 'As run' },
    ],
    table: () => ({
      columns: ['Date', 'Steady minutes', 'Steady pace /km', 'Steady HR', 'Metres per beat', 'At 6:00/km'],
      rows: runs.map((r) => [fmtDay(r.d), String(r.steadyMin), fmtPace(60 / r.speed), fmtInt(r.hrSteady), r.mpb.toFixed(3), r.adjusted.toFixed(3)]),
    }),
  });
}


// ---------- the biggest short stretches of improvement ----------

// A smoothed daily series: the median of the days, or of the runs, within two weeks either side.
function smoothSeries(from, to, valuesOn) {
  const out = [];
  for (let t = dayMs(from); t <= dayMs(to); t += DAY) {
    const around = [];
    for (let k = -14; k <= 14; k++) {
      const d = isoDay(t + k * DAY);
      // Smoothing never reaches across the range, so one watch's days can't leak into the other's.
      if (d >= from && d <= to) around.push(...valuesOn(d));
    }
    out.push({ d: isoDay(t), v: around.length >= 10 ? median(around) : null });
  }
  return out;
}

function biggestImprovements(series, better, days) {
  const changes = [];
  for (let i = 0; i + days < series.length; i++) {
    const a = series[i].v;
    const b = series[i + days].v;
    if (a == null || b == null) continue;
    changes.push({ from: series[i].d, to: series[i + days].d, a, b, gain: (b - a) * better });
  }
  if (!changes.length) return null;
  const typical = mean(changes.map((c) => Math.abs(c.gain)));
  const best = changes.reduce((x, y) => (y.gain > x.gain ? y : x));
  return { ...best, times: best.gain / typical };
}

let jumpCache;
function jumpData() {
  if (jumpCache) return jumpCache;
  const fitbitEnd = isoDay(dayMs(handover()) - DAY);
  // Two weeks are skipped after the switch so a difference between watches can't look like a gain.
  const garminFrom = isoDay(dayMs(handover()) + 14 * DAY);
  const end = data.meta.trackerEnd;
  const daily = (get) => (d) => { const r = row(d); const v = r && !isSick(d) ? get(r) : null; return v == null ? [] : [v]; };
  const runsOn = new Map();
  for (const r of beatData().runs) {
    if (!runsOn.has(r.d)) runsOn.set(r.d, []);
    runsOn.get(r.d).push(r.adjusted);
  }
  const metrics = [
    { label: 'Heart rate at 3 to 5 AM', watch: 'Fitbit', from: data.meta.trackerStart, to: fitbitEnd, values: daily((r) => r.overnight), better: -1, fmt: (v) => `${fmt1(v)} bpm`, size: (v) => `${fmt1(v)} bpm`, axis: (v) => `${Math.round(v)}` },
    { label: 'Heart rate at 3 to 5 AM', watch: 'Garmin', from: garminFrom, to: end, values: daily((r) => r.overnight), better: -1, fmt: (v) => `${fmt1(v)} bpm`, size: (v) => `${fmt1(v)} bpm`, axis: (v) => `${Math.round(v)}` },
    { label: 'Resting heart rate', watch: 'Fitbit', from: data.meta.trackerStart, to: fitbitEnd, values: daily((r) => r.rhr), better: -1, fmt: (v) => `${fmt1(v)} bpm`, size: (v) => `${fmt1(v)} bpm`, axis: (v) => `${Math.round(v)}` },
    { label: 'Resting heart rate', watch: 'Garmin', from: garminFrom, to: end, values: daily((r) => r.rhr), better: -1, fmt: (v) => `${fmt1(v)} bpm`, size: (v) => `${fmt1(v)} bpm`, axis: (v) => `${Math.round(v)}` },
    { label: 'Metres per heartbeat at 6:00/km', watch: 'Garmin', from: garminFrom, to: end, values: (d) => runsOn.get(d) || [], better: 1, fmt: (v) => `${v.toFixed(3)} m`, size: (v) => `${Math.round(v * 1000)} mm`, axis: (v) => v.toFixed(2) },
    { label: 'VO₂ max estimate', watch: 'Garmin', from: garminFrom, to: end, values: daily((r) => r.vo2g), better: 1, fmt: fmt1, size: (v) => `${fmt1(v)} points`, axis: (v) => `${Math.round(v)}` },
  ];
  jumpCache = metrics.map((m) => {
    const series = smoothSeries(m.from, m.to, m.values);
    return { ...m, series, month: biggestImprovements(series, m.better, 30), quarter: biggestImprovements(series, m.better, 91) };
  });
  return jumpCache;
}

// What else was going on around a stretch: the nearest marathon after it, and life events before it.
function jumpContext(j) {
  const notes = [];
  const marathon = data.workouts.find((w) => w.type === 'Run' && w.km >= 41 && w.km <= 48 && w.d >= j.from && dayMs(w.d) - dayMs(j.to) <= 70 * DAY);
  if (marathon) {
    const weeks = Math.round((dayMs(marathon.d) - dayMs(j.to)) / (7 * DAY));
    notes.push(marathon.d <= j.to ? `Includes your ${fmtDay(marathon.d)} marathon` : `Ended ${weeks === 0 ? 'days' : `${weeks} week${weeks === 1 ? '' : 's'}`} before your ${fmtDay(marathon.d)} marathon`);
  }
  for (const e of lifeEvents()) {
    const months = Math.round((dayMs(j.from) - dayMs(e.date)) / (30.4 * DAY));
    if (e.date <= j.to && months <= 8 && months >= 0) notes.push(months === 0 ? `Began as you ${e.label.charAt(0).toLowerCase()}${e.label.slice(1)}` : `Began ${months} month${months === 1 ? '' : 's'} after "${e.label}"`);
  }
  if (j.from <= '2020-11-30' && j.to >= '2020-08-01') notes.push('The unexplained autumn-2020 drop, with no rise in steps');
  // The medians reach two weeks either side, so mention a sick stretch close enough to have been left out.
  for (const x of sickRanges()) {
    if (dayMs(x.to) >= dayMs(j.from) - 14 * DAY && dayMs(x.from) <= dayMs(j.to) + 14 * DAY) notes.push(`Leaves out the days you were sick, ${fmtDay(x.from)} to ${fmtDay(x.to)}`);
  }
  return notes;
}

function jumpCard(m, watchColor) {
  const q = m.quarter;
  const mo = m.month;
  const verb = (j) => (m.better < 0 ? (j.b < j.a ? 'Fell' : 'Rose') : (j.b > j.a ? 'Rose' : 'Fell'));
  const span = (j) => `${fmtDay(j.from)} to ${fmtDay(j.to)}`;
  const context = jumpContext(q);
  const chartHost = el('div', { class: 'fig-host' });
  const card = el('div', { class: 'jump-card' },
    el('div', { class: 'jump-metric', text: m.label }),
    el('div', { class: 'jump-headline', text: `${verb(q)} ${m.size(Math.abs(q.b - q.a))} in three months` }),
    el('div', { class: 'jump-dates', text: `${span(q)}: ${m.fmt(q.a)} → ${m.fmt(q.b)}` }),
    chartHost,
    el('div', { class: 'jump-badge', text: `${q.times.toFixed(1)}× a typical three-month change` }),
    context.length ? el('ul', { class: 'jump-context' }, context.map((c) => el('li', { text: c }))) : null,
    el('div', { class: 'jump-month' },
      el('strong', { text: 'Best single month: ' }),
      el('span', { text: `${verb(mo)} ${m.size(Math.abs(mo.b - mo.a))}, ${span(mo)} (${mo.times.toFixed(1)}× typical)${mo.from < q.from || mo.to > q.to ? '. A different stretch from the one charted.' : ''}` })));
  // A zoomed view: the stretch plus two months either side, from the same smoothed series it was found in.
  const lo = isoDay(dayMs(q.from) - 60 * DAY);
  const hi = isoDay(dayMs(q.to) + 60 * DAY);
  const pts = m.series.filter((p) => p.d >= lo && p.d <= hi).map((p) => ({ x: dayMs(p.d), y: p.v }));
  const draw = () => {
    const width = chartHost.clientWidth;
    if (!width) return;
    chartHost.replaceChildren();
    const t = theme();
    lineChart(chartHost, width, t, {
      series: [{ name: m.label, color: watchColor(t), points: pts, tipFmt: m.fmt }],
      height: 150,
      left: 40,
      yFmt: m.axis,
      xFmt: (x) => fmtDay(isoDay(x)),
      xTickList: [lo, q.from, q.to, hi].filter((d, i, all) => all.indexOf(d) === i).slice(1, 3).map((d) => ({ v: dayMs(d), label: fmtMonth(d.slice(0, 7)) })),
      spans: [{ x0: dayMs(q.from), x1: dayMs(q.to), color: t.series[1] }],
      marks: [
        { x: dayMs(q.from), y: q.a, label: m.axis(q.a), anchor: 'end', dx: -7, dy: -8, color: watchColor(t) },
        { x: dayMs(q.to), y: q.b, label: m.axis(q.b), anchor: 'start', dx: 7, dy: -8, color: watchColor(t) },
      ],
      onPick: (x) => openDay(isoDay(x)),
    });
  };
  new ResizeObserver(draw).observe(chartHost);
  return card;
}

function jumpsFigure() {
  const rows = jumpData().filter((r) => r.quarter && r.month);
  const group = (watch, note) => {
    const list = rows.filter((r) => r.watch === watch).sort((x, y) => y.quarter.times - x.quarter.times);
    return el('div', { class: 'jump-group' },
      el('h3', { class: 'jump-group-title', text: `${watch} years` }),
      el('p', { class: 'jump-group-note', text: note }),
      el('div', { class: 'jump-grid' }, list.map((r) => jumpCard(r, (t) => t.series[0]))));
  };
  return figure({
    title: 'Your biggest short bursts of improvement',
    takeaway: jumpsTakeaway(),
    sub: 'The three months each measure improved most. 3× a typical change or more is unusual.',
    method: 'Each value is the median of the four weeks around that day, so a single odd day can\'t create a burst, and each watch is only compared with itself. "× a typical change" is how many times bigger the change is than an average stretch of the same length: around 1× is ordinary.',
    render(host) {
      host.append(
        group('Garmin', `From ${fmtDay(isoDay(dayMs(handover()) + 14 * DAY))}, skipping the watch's first two weeks.`),
        group('Fitbit', `Until ${fmtDay(isoDay(dayMs(handover()) - DAY))}.`));
    },
    table: () => ({
      columns: ['Measure', 'Watch', 'Best three months', 'From', 'To', '× typical', 'Best month', 'From', 'To', '× typical'],
      rows: rows.map((r) => [r.label, r.watch, `${fmtDay(r.quarter.from)} to ${fmtDay(r.quarter.to)}`, r.fmt(r.quarter.a), r.fmt(r.quarter.b), r.quarter.times.toFixed(1), `${fmtDay(r.month.from)} to ${fmtDay(r.month.to)}`, r.fmt(r.month.a), r.fmt(r.month.b), r.month.times.toFixed(1)]),
    }),
  });
}

function jumpsTakeaway() {
  const g = jumpData().find((r) => r.label === 'Heart rate at 3 to 5 AM' && r.watch === 'Garmin')?.quarter;
  if (!g) return null;
  return `Best on the Garmin: 3 to 5 AM heart rate fell ${fmt1(g.a - g.b)} bpm, ${fmtMonth(g.from.slice(0, 7))} to ${fmtMonth(g.to.slice(0, 7))}, ${g.times.toFixed(1)}× a typical change.`;
}

// ---------- life changes ----------

const lifeEvents = () => data.meta.dedupe.events || [];
const lifeEventMarks = () => lifeEvents().map((e) => ({ x: dayMs(e.date), label: e.label }));
const isWeekday = (d) => { const g = new Date(dayMs(d)).getUTCDay(); return g >= 1 && g <= 5; };
const shiftYear = (d, n) => `${+d.slice(0, 4) + n}${d.slice(4)}`;

function lifeStats(p) {
  const base = periodStats(p);
  const days = inDays(p.from, p.to, (r) => r);
  const part = (test, get) => mean(days.filter((r) => test(r.date)).map(get).filter((v) => v != null));
  const runs = data.workouts.filter((w) => w.type === 'Run' && w.d >= p.from && w.d <= p.to);
  const places = new Map();
  for (const w of runs) if (w.place) places.set(w.place, (places.get(w.place) || 0) + 1);
  const topPlace = [...places.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    ...base,
    wakeWeekday: part(isWeekday, (r) => r.wake),
    wakeWeekend: part((d) => !isWeekday(d), (r) => r.wake),
    stressWeekday: part(isWeekday, healthy((r) => r.stress)),
    stressWeekend: part((d) => !isWeekday(d), healthy((r) => r.stress)),
    climbDay: mean(days.map((r) => r.climbM).filter((v) => v != null)),
    runHour: mean(runs.filter((w) => isWeekday(w.d)).map((w) => w.h)),
    topPlace,
  };
}

const LIFE_ROWS = [
  { group: 'Running' },
  { key: 'kmPerWeek', label: 'Kilometres per week', better: 1, fmt: (v) => fmt1(v), delta: (v) => signed(v, fmt1) },
  { key: 'runsPerWeek', label: 'Runs per week', better: 0, fmt: fmt1, delta: (v) => signed(v, fmt1) },
  { key: 'fastPerWeek', label: 'Faster segments, minutes a week', better: 0, fmt: fmtInt, delta: (v) => signed(v, fmtInt) },
  { key: 'pace', label: 'Pace, regular running', better: -1, fmt: (v) => `${fmtPace(v)} /km`, delta: (v) => signed(v, fmtPace) },
  { key: 'runHour', label: 'Weekday run start time', better: 0, fmt: (v) => fmtClock(v * 60), delta: (v) => `${fmtDuration(Math.abs(v * 60))} ${v < 0 ? 'earlier' : 'later'}` },
  { key: 'climbDay', label: 'Metres climbed a day', better: 0, fmt: fmtInt, delta: (v) => signed(v, fmtInt) },
  { group: 'Fitness' },
  { key: 'rhr', label: 'Resting heart rate', better: -1, fmt: (v) => `${fmt1(v)} bpm`, delta: (v) => signed(v, fmt1) },
  { key: 'overnight', label: 'Heart rate at 3 to 5 AM', better: -1, fmt: (v) => `${fmt1(v)} bpm`, delta: (v) => signed(v, fmt1) },
  { key: 'perBeatAdj', label: 'Metres per heartbeat at 6:00/km', better: 1, fmt: (v) => v.toFixed(3), delta: (v) => signed(v, (x) => x.toFixed(3)) },
  { group: 'Days and nights' },
  { key: 'steps', label: 'Steps a day', better: 1, fmt: fmtInt, delta: (v) => signed(v, fmtInt) },
  { key: 'asleep', label: 'Time asleep', better: 1, fmt: fmtDuration, delta: (v) => signed(v, fmtDuration) },
  { key: 'bed', label: 'Bedtime', better: 0, fmt: fmtClockFrom18, delta: (v) => `${fmtDuration(Math.abs(v))} ${v < 0 ? 'earlier' : 'later'}` },
  { key: 'wakeWeekday', label: 'Wake time, weekdays', better: 0, fmt: fmtClockFrom18, delta: (v) => `${fmtDuration(Math.abs(v))} ${v < 0 ? 'earlier' : 'later'}` },
  { key: 'wakeWeekend', label: 'Wake time, weekends', better: 0, fmt: fmtClockFrom18, delta: (v) => `${fmtDuration(Math.abs(v))} ${v < 0 ? 'earlier' : 'later'}` },
  { key: 'stressWeekday', label: 'Stress, weekdays', better: -1, fmt: fmt1, delta: (v) => signed(v, fmt1) },
  { key: 'stressWeekend', label: 'Stress, weekends', better: -1, fmt: fmt1, delta: (v) => signed(v, fmt1) },
  { key: 'battery', label: 'Body Battery peak', better: 1, fmt: fmt1, delta: (v) => signed(v, fmt1) },
];

function lifeTable(period) {
  const before = { from: shiftYear(period.from, -1), to: shiftYear(period.to, -1) };
  const earlier = { from: shiftYear(period.from, -2), to: shiftYear(period.to, -2) };
  const [s0, s1, s2] = [earlier, before, period].map(lifeStats);
  const span = (p) => `${fmtDay(p.from)} to ${fmtDay(p.to)}`;
  return figure({
    title: `${period.label}: ${fmtDay(period.from)} to ${fmtDay(period.to)}`,
    takeaway: `Against a year earlier: running ${fmt1(s1.kmPerWeek)} → ${fmt1(s2.kmPerWeek)} km a week, resting heart rate ${fmt1(s1.rhr)} → ${fmt1(s2.rhr)} bpm.`,
    sub: 'The last column is the same change a year before, for the usual drift.',
    method: `"A year earlier" is ${span(before)}. The last column compares that with ${span(earlier)}, so a change that came with the event stands apart from ordinary year-on-year drift.`,
    render(host) {
      host.append(el('div', { class: 'table-scroll' }, el('table', { class: 'score' },
        el('thead', null, el('tr', null, ['', 'A year earlier', 'After', 'Change', 'Same change, the year before'].map((h, i) => el('th', { scope: 'col', text: h, class: i === 0 ? 'label' : null })))),
        el('tbody', null, LIFE_ROWS.map((r) => {
          if (r.group) return el('tr', { class: 'group' }, el('td', { colspan: '5', text: r.group }));
          const v1 = s1[r.key];
          const v2 = s2[r.key];
          const v0 = s0[r.key];
          return el('tr', null,
            el('td', { class: 'label', text: r.label }),
            el('td', { text: v1 == null ? '—' : r.fmt(v1) }),
            el('td', { class: 'latest', text: v2 == null ? '—' : r.fmt(v2) }),
            el('td', { class: deltaClass(r.better, v1, v2), text: v1 == null || v2 == null ? '—' : r.delta(v2 - v1) }),
            el('td', { class: 'delta', text: v0 == null || v1 == null ? '—' : r.delta(v1 - v0) }));
        })))));
    },
  });
}

function renderLife() {
  const events = lifeEvents();
  if (!events.length) return el('section', { id: 'life' });
  const end = data.meta.trackerEnd;
  const periods = events.map((e, i) => ({ from: e.date, to: i + 1 < events.length ? isoDay(dayMs(events[i + 1].date) - DAY) : end, label: e.label }));
  const first = periods[0];
  const a = lifeStats({ from: shiftYear(first.from, -1), to: shiftYear(first.to, -1) });
  const b = lifeStats(first);
  const flipped = a.wakeWeekend > a.wakeWeekday && b.wakeWeekday > b.wakeWeekend;
  const placeText = a.topPlace && b.topPlace && a.topPlace !== b.topPlace
    ? `Your runs moved from ${a.topPlace} to ${b.topPlace}.`
    : '';
  const later = periods.slice(1).map((p) => {
    const x = lifeStats({ from: shiftYear(p.from, -1), to: shiftYear(p.to, -1) });
    const y = lifeStats(p);
    const sameCity = x.topPlace && y.topPlace && periods.length > 1 && lifeStats({ from: isoDay(dayMs(p.from) - 120 * DAY), to: isoDay(dayMs(p.from) - DAY) }).topPlace === y.topPlace;
    return { p, x, y, sameCity };
  });
  const dates = data.daily.date.filter((d) => d >= handover());
  const wd = rolling(dates, (r) => (isWeekday(r.date) ? r.wake : null), 56, 10);
  const we = rolling(dates, (r) => (!isWeekday(r.date) ? r.wake : null), 56, 6);
  const swd = rolling(dates, healthy((r) => (isWeekday(r.date) ? r.stress : null)), 56, 10);
  const swe = rolling(dates, healthy((r) => (!isWeekday(r.date) ? r.stress : null)), 56, 6);
  const pair = (title, sub, aVals, bVals, yFmt, tipFmt, yTicks) => figure({
    title,
    sub,
    height: 250,
    render(host, width, t) {
      lineChart(host, width, t, {
        series: [
          { name: 'Weekdays', color: t.series[0], points: dates.map((d, i) => ({ x: dayMs(d), y: aVals[i] })), tipFmt },
          { name: 'Weekends', color: t.series[1], points: dates.map((d, i) => ({ x: dayMs(d), y: bVals[i] })), tipFmt },
        ],
        height: 250,
        left: yTicks ? 58 : 38,
        yFmt,
        ...(yTicks ? { yTickList: yTicks, yDomain: [yTicks[0], yTicks.at(-1)] } : {}),
        xFmt: (x) => fmtDay(isoDay(x)),
        breakGap: 8 * DAY,
        annotations: lifeEventMarks(),
        onPick: (x) => openDay(isoDay(x)),
      });
    },
    legend: (t) => [{ color: t.series[0], label: 'Weekdays' }, { color: t.series[1], label: 'Weekends' }],
    table: () => monthlyTable([['Weekdays', (r) => (isWeekday(r.date) ? (title.startsWith('Wake') ? r.wake : r.stress) : null), title.startsWith('Wake') ? fmtClockFrom18 : fmt1], ['Weekends', (r) => (!isWeekday(r.date) ? (title.startsWith('Wake') ? r.wake : r.stress) : null), title.startsWith('Wake') ? fmtClockFrom18 : fmt1]], handover(), end),
  });
  const wakeVals = [...wd, ...we].filter((v) => v != null);
  const wakeTicks = [];
  for (let m = Math.floor(Math.min(...wakeVals) / 60) * 60; m <= Math.ceil(Math.max(...wakeVals) / 60) * 60; m += 60) wakeTicks.push(m);

  return chapter('life', '2 · Life changes',
    flipped ? 'After you left your job, weekday mornings started later than weekends' : 'What changed when you left your job and moved',
    `${placeText} Each period is compared with the same dates a year earlier.`.trim(),
    howMeasured(`Comparing with the same dates a year earlier keeps summer against winter from passing for an effect. Leaving the job, the move, the season and your marathon training all overlap, so these show what changed, not why. ${later.map(({ p, sameCity }) => (sameCity ? `Your runs kept starting in the same city after ${fmtDay(p.from)}, so that move doesn't show up as a location change.` : '')).join(' ')}`.trim()),
    tiles(
      tile('Weekday wake time', `${shortClock(fmtClockFrom18(a.wakeWeekday))} → ${shortClock(fmtClockFrom18(b.wakeWeekday))}`, `AM. Weekends ${shortClock(fmtClockFrom18(a.wakeWeekend))} → ${shortClock(fmtClockFrom18(b.wakeWeekend))}`),
      tile('Weekday stress', `${fmt1(a.stressWeekday)} → ${fmt1(b.stressWeekday)}`, `weekends ${fmt1(a.stressWeekend)} → ${fmt1(b.stressWeekend)}`),
      tile('Kilometres per week', `${fmt1(a.kmPerWeek)} → ${fmt1(b.kmPerWeek)}`),
      tile('Resting heart rate', `${fmt1(a.rhr)} → ${fmt1(b.rhr)}`, 'bpm'),
    ),
    grid2(
      pair('Wake time, weekdays and weekends', '8-week averages. Lower is earlier.', wd, we, fmtClockFrom18, fmtClockFrom18, wakeTicks),
      pair('Stress, weekdays and weekends', '8-week averages.', swd, swe, (v) => `${Math.round(v)}`, fmt1)),
    ...periods.map((p) => lifeTable(p)));
}

// ---------- chapter: running ----------

function prFigure(title, list) {
  if (!list?.length) return null;
  const last = list.at(-1);
  const today = dayMs(data.meta.lastDate);
  // Stepped: a record stands until the next one beats it.
  const points = [];
  list.forEach((p, i) => {
    if (i) points.push({ x: dayMs(p.d), y: list[i - 1].sec, held: true });
    points.push({ x: dayMs(p.d), y: p.sec });
  });
  points.push({ x: today, y: last.sec });
  const secs = list.map((p) => p.sec);
  const stepOptions = [15, 30, 60, 120, 300, 600, 900, 1800];
  const range = Math.max(...secs) - Math.min(...secs);
  const step = stepOptions.find((s) => range / s <= 4) || 3600;
  // One extra step below the record leaves room for its label.
  const lo = Math.floor(Math.min(...secs) / step) * step - step;
  const hi = Math.ceil(Math.max(...secs) / step) * step;
  const yTickList = [];
  for (let v = lo; v <= hi; v += step) yTickList.push(v);
  return figure({
    title,
    takeaway: `${fmtRace(list[0].sec)} → ${fmtRace(last.sec)}, latest record ${fmtDay(last.d)}.`,
    height: 190,
    render(host, width, t) {
      lineChart(host, width, t, {
        series: [{ name: 'Best time', color: t.series[0], points, tipFmt: fmtRace }],
        height: 190,
        left: 52,
        yDomain: [lo, hi],
        yTickList,
        yFmt: fmtRace,
        xFmt: (x) => fmtDay(isoDay(x)),
        xDomain: [dayMs(handover()), today],
        marks: [{ x: dayMs(last.d), y: last.sec, label: fmtRace(last.sec), anchor: 'end', dx: -8, dy: 16 }],
      });
    },
    table: () => ({ columns: ['Date', 'Time'], rows: [...list].reverse().map((p) => [fmtDay(p.d), fmtRace(p.sec)]) }),
  });
}

function placeCard(place, t) {
  const size = 480;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Density of ${place.routes} routes${place.name ? ` around ${place.name}` : ''}, with no map or coordinates.`);
  const cells = [];
  for (let i = 0; i < place.cells.length; i += 3) cells.push([place.cells[i], place.cells[i + 1], place.cells[i + 2]]);
  // Crop to the streets you actually use so a single far-off outing doesn't shrink the picture.
  const xs = cells.map((c) => c[0]).sort((a, b) => a - b);
  const ys = cells.map((c) => c[1]).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.floor((arr.length - 1) * p)];
  const [x0, x1, y0, y1] = [q(xs, 0.01), q(xs, 0.99), q(ys, 0.01), q(ys, 0.99)];
  const extent = Math.max(x1 - x0, y1 - y0, 1);
  const scale = (size - 16) / extent;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, size, size);
  const colorAt = rampTable(t.ramp);
  const maxLog = Math.log(1 + Math.max(...cells.map((c) => c[2])));
  const px = Math.max(1.5, scale);
  const ox = (size - (x1 - x0) * scale) / 2;
  const oy = (size - (y1 - y0) * scale) / 2;
  cells.sort((a, b) => a[2] - b[2]);
  for (const [cx, cy, n] of cells) {
    const f = Math.log(1 + n) / maxLog;
    ctx.fillStyle = `rgb(${colorAt(0.25 + f * 0.75)})`;
    ctx.fillRect(ox + (cx - x0) * scale, size - oy - (cy - y0) * scale - px, px, px);
  }
  const span = place.first === place.last ? `${place.first}` : `${place.first} to ${place.last}`;
  return el('div', { class: 'place' }, canvas,
    el('strong', { text: place.name || 'Elsewhere' }),
    el('span', { text: `${fmtInt(place.routes)} routes, ${fmtInt(place.km)} km, ${span}` }));
}

function renderRunning() {
  const w = data.workouts;
  const runs = w.filter((x) => x.type === 'Run');
  const { prs, shoes } = data;
  const marathons = runs.filter((x) => x.km >= 41 && x.km <= 48 && x.d >= handover());
  const fullList = prs.marathon || [];
  const firstFull = fullList[0];
  const bestFull = fullList.at(-1);
  const sinceWatch = garminRuns();
  const firstWeek = (() => {
    const t = dayMs(sinceWatch[0].d);
    const dow = (new Date(t).getUTCDay() + 6) % 7;
    return t - dow * DAY;
  })();
  const weeks = [];
  for (let t = firstWeek; t <= dayMs(data.meta.lastDate); t += 7 * DAY) weeks.push(isoDay(t));
  const weekIndex = (d) => Math.floor((dayMs(d) - firstWeek) / (7 * DAY));
  const raceWeeks = new Set(marathons.map((m) => weekIndex(m.d)));
  const weekKm = weeks.map(() => 0);
  sinceWatch.forEach((r) => { weekKm[weekIndex(r.d)] += r.km || 0; });
  const peakWeek = weekKm.indexOf(Math.max(...weekKm));
  const years = [...new Set(sinceWatch.map((r) => r.d.slice(0, 4)))];
  const yearKm = years.map((y) => sinceWatch.filter((r) => r.d.startsWith(y)).reduce((s, r) => s + (r.km || 0), 0));
  const biggestYear = yearKm.indexOf(Math.max(...yearKm));
  const totalKm = sinceWatch.reduce((s, r) => s + (r.km || 0), 0);
  const climbM = sinceWatch.reduce((s, r) => s + (r.gainM || 0), 0);
  const everests = climbM / 8849;
  const races = [...marathons].sort((a, b) => a.d.localeCompare(b.d));
  const fastest = races.length ? races.reduce((a, b) => (b.min < a.min ? b : a)) : null;
  const shoeTop = shoes.slice(0, 12);
  const medianShoeKm = median(shoes.filter((s) => s.km > 160).map((s) => s.km));
  const recordKeys = ['1k', '5k', '10k', 'half', 'marathon'];
  const hasRecords = recordKeys.some((k) => prs[k]?.length);

  // The headline leads with the marathon when there are records to compare, and with distance otherwise.
  const headline = fullList.length > 1 && firstFull.sec > bestFull.sec
    ? `A ${fmtRace(bestFull.sec)} marathon, ${Math.round((firstFull.sec - bestFull.sec) / 60)} minutes faster than your first`
    : bestFull
      ? `A ${fmtRace(bestFull.sec)} marathon, and ${fmtInt(totalKm)} km of running since ${years[0]}`
      : `${fmtInt(totalKm)} km of running since ${years[0]}`;
  const yearText = biggestYear === years.length - 1
    ? `${years.at(-1)} is ${years.length > 1 ? 'already your biggest year' : 'the first year'}, at ${fmtInt(yearKm.at(-1))} km.`
    : `Your biggest year was ${years[biggestYear]}, at ${fmtInt(yearKm[biggestYear])} km.`;
  const intro = races.length && firstFull
    ? `${races.length} marathon${races.length === 1 ? '' : 's'} since ${fmtMonth(firstFull.d.slice(0, 7))}, and ${yearText.charAt(0).toLowerCase()}${yearText.slice(1)}`
    : yearText;
  const prFigures = [prFigure('Marathon', prs.marathon), prFigure('Half marathon', prs.half), prFigure('10K', prs['10k']), prFigure('5K', prs['5k'])].filter(Boolean);

  return chapter('running', '3 · Running',
    headline,
    intro,
    hasRecords ? howMeasured(`Records come from ${watchName()}'s own history, which also counts your best splits inside longer runs.`) : null,
    tiles(
      tile('Distance run', `${fmtInt(totalKm)} km`, `${fmtInt(sinceWatch.length)} runs, ${fmtInt(totalKm / (sinceWatch.length || 1))} km each`),
      tile('Biggest week', `${fmt1(weekKm[peakWeek])} km`, `week of ${fmtDay(weeks[peakWeek])}`, dayButton(weeks[peakWeek])),
      tile('Climbed on runs', `${fmtInt(climbM)} m`, `about ${everests.toFixed(1)} Everests`),
      prs['1k'] ? tile('Fastest 1 km', fmtRace(prs['1k'].at(-1).sec), fmtDay(prs['1k'].at(-1).d)) : null,
    ),
    heartbeatFigure(),
    paceHeartFigure(),
    prFigures.length ? [subhead('Race records'), grid2(...prFigures)] : null,
    hasRecords ? figure({
      title: 'Records set each year',
      takeaway: (() => {
        const counts = years.map((y) => recordKeys.filter((k) => (prs[k] || []).some((pt) => pt.d.startsWith(y))).length);
        const best = counts.indexOf(Math.max(...counts));
        return `${years.at(-1)} brought new records at ${counts.at(-1)} of 5 distances${best !== years.length - 1 ? `; ${years[best]} had the most, ${counts[best]}` : years.length > 1 ? ', the most of any year' : ''}.`;
      })(),
      sub: 'The best new record each year. A dash means none that year.',
      render(host) {
        const distances = [['1k', '1 km'], ['5k', '5K'], ['10k', '10K'], ['half', 'Half marathon'], ['marathon', 'Marathon']];
        host.append(el('div', { class: 'table-scroll' }, el('table', { class: 'score' },
          el('thead', null, el('tr', null, ['', ...years].map((h, i) => el('th', { scope: 'col', text: h, class: i === 0 ? 'label' : null })))),
          el('tbody', null, distances.map(([key, label]) => el('tr', null,
            el('td', { class: 'label', text: label }),
            years.map((y) => {
              const inYear = (prs[key] || []).filter((p) => p.d.startsWith(y));
              return el('td', { text: inYear.length ? fmtRace(inYear.at(-1).sec) : '—' });
            })))))));
      },
    }) : null,
    races.length ? figure({
      title: races.length === 1 ? 'Your marathon' : 'Your marathons',
      takeaway: races.length === 1
        ? `On ${fmtDay(fastest.d)}, in ${fmtDuration(fastest.min)} on the watch.`
        : `${races.length} marathons since ${fmtDay(races[0].d)}. The fastest, on ${fmtDay(fastest.d)}, took ${fmtDuration(fastest.min)} on the watch.`,
      sub: `Watch time.${data.meta.apps?.length ? ` Race names from ${data.meta.apps.map((a) => a.label).join(' and ')}.` : ''}`,
      render(host) {
        host.append(el('div', { class: 'table-scroll' }, el('table', { class: 'races' },
          el('thead', null, el('tr', null, ['Date', 'Race', 'Watch time', 'Pace /km', 'Avg HR'].map((h) => el('th', { scope: 'col', text: h })))),
          el('tbody', null, races.map((r) => el('tr', { class: r === fastest ? 'best' : null },
            el('td', { text: fmtDay(r.d) }),
            el('td', null, el('button', { type: 'button', text: r.name || 'Marathon', onclick: () => openDay(r.d) })),
            el('td', { text: fmtDuration(r.min) }),
            el('td', { text: fmtPace(r.min / r.km) }),
            el('td', { text: r.hr ? `${r.hr} bpm` : '—' })))))));
      },
    }) : null,
    subhead('Training'),
    figure({
      title: 'Kilometres every week',
      takeaway: (() => {
        const thisYear = weeks.map((d, i) => [d, weekKm[i]]).filter(([d]) => d.startsWith(years.at(-1))).map(([, v]) => v);
        return `Biggest week ${fmt1(weekKm[peakWeek])} km, from ${fmtDay(weeks[peakWeek])}. ${years.at(-1)} averages ${fmt1(mean(thisYear))} km a week.`;
      })(),
      sub: raceWeeks.size ? 'Marathon weeks highlighted.' : null,
      height: 240,
      render(host, width, t) {
        columnChart(host, width, t, {
          categories: weeks,
          series: [
            { name: 'Kilometres', color: t.series[0], values: weekKm.map((v, i) => (raceWeeks.has(i) ? 0 : v)) },
            { name: 'Marathon week', color: t.series[1], values: weekKm.map((v, i) => (raceWeeks.has(i) ? v : 0)) },
          ],
          height: 240,
          yFmt: (v) => `${Math.round(v)}`,
          catFmt: (d) => `Week of ${fmtDay(d)}`,
          tickEvery: (d, i) => i > 0 && d.slice(0, 4) !== weeks[i - 1].slice(0, 4),
          tickFmt: (d) => d.slice(0, 4),
          onPick: (d) => openDay(d),
        });
      },
      legend: (t) => [{ color: t.series[0], label: 'Kilometres' }, ...(raceWeeks.size ? [{ color: t.series[1], label: 'Marathon week' }] : [])],
      table: () => ({ columns: ['Week of', 'Kilometres'], rows: weeks.map((d, i) => [fmtDay(d), fmt1(weekKm[i])]) }),
    }),
    shoes.length ? figure({
        title: shoes.length === 1 ? 'One pair of shoes' : `${shoes.length} pairs of shoes`,
        takeaway: `Most worn: ${shoes[0].name}, ${fmtInt(shoes[0].km)} km.${medianShoeKm != null ? ` A pair typically lasts about ${fmtInt(medianShoeKm)} km.` : ''}`,
        sub: 'Kilometres on each pair, from Strava.',
        height: 330,
        render(host, width, t) {
          hBars(host, width, t, { rows: shoeTop.map((s) => ({ label: s.name, value: s.km, shoe: s })), labelWidth: Math.min(180, width * 0.48), fmt: (v) => `${v} km`, tipLabel: 'Kilometres', tipExtra: (r) => tipRow(null, 'Runs', fmtInt(r.shoe.runs)) });
        },
        table: () => ({ columns: ['Shoe', 'Kilometres', 'Runs', 'First run', 'Last run'], rows: shoes.map((s) => [s.name, fmtInt(s.km), fmtInt(s.runs), fmtDay(s.first), fmtDay(s.last)]) }),
      }) : null,
    data.places.length || data.routes.length ? subhead('Places') : null,
    data.places.length ? figure({
      title: 'Where you run',
      takeaway: `Most of your routes are ${data.places[0].name ? `around ${data.places[0].name}` : 'in one place'}: ${fmtInt(data.places[0].routes)} routes, ${fmtInt(data.places[0].km)} km.`,
      sub: 'Every GPS trace, darker where you return most.',
      method: 'No map sits behind these, but the street patterns are recognizable, so this figure hides with the private chapters.',
      private: true,
      render(host, width, t) {
        host.append(el('div', { class: 'places' }, data.places.slice(0, 3).map((p) => placeCard(p, t))));
      },
      table: () => ({ columns: ['Place', 'Routes', 'Kilometres', 'First year', 'Last year'], rows: data.places.map((p) => [p.name || 'Elsewhere', fmtInt(p.routes), fmtInt(p.km), String(p.first), String(p.last)]) }),
    }) : null,
    data.routes.length ? figure({
      title: `Your ${data.routes.length} longest outings, as shapes`,
      takeaway: `The longest is a ${fmt1(data.routes[0].km)} km ${(data.routes[0].type || 'outing').toLowerCase()} on ${fmtDay(data.routes[0].d)}.`,
      sub: 'All sports, shapes only. Click one to open its day.',
      render(host, width, t) {
        host.append(el('div', { class: 'routes' }, data.routes.map((r) => routeCard(r, t))));
      },
      table: () => ({ columns: ['Date', 'Type', 'Kilometres', 'Minutes'], rows: data.routes.map((r) => [fmtDay(r.d), r.type || '—', fmt1(r.km), String(r.min)]) }),
    }) : null);
}

function routeCard(r, t) {
  const xs = r.pts.map((p) => p[0]);
  const ys = r.pts.map((p) => p[1]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 8;
  const box = 100;
  const scale = (box - pad * 2) / size;
  const ox = (box - (maxX - minX) * scale) / 2;
  const oy = (box - (maxY - minY) * scale) / 2;
  const d = `M${r.pts.map(([x, y]) => `${((x - minX) * scale + ox).toFixed(1)},${(box - ((y - minY) * scale + oy)).toFixed(1)}`).join('L')}`;
  return el('button', { class: 'route', type: 'button', onclick: () => openDay(r.d), 'aria-label': `${r.type || 'Route'} on ${fmtDay(r.d)}, ${r.km} km. Open this day.` },
    svg('svg', { viewBox: `0 0 ${box} ${box}`, role: 'presentation' },
      svg('path', { d, fill: 'none', stroke: t.series[0], 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })),
    el('strong', { text: `${fmt1(r.km)} km` }),
    el('span', { text: `${r.type || 'Route'}, ${fmtDay(r.d)}` }));
}

// ---------- chapter: movement ----------

function longestStreak(dates, test) {
  let best = 0; let cur = 0; let prev = null; let bestEnd = null;
  for (const d of dates) {
    const ok = test(row(d));
    const contiguous = prev != null && dayMs(d) - dayMs(prev) === DAY;
    if (ok) { cur = contiguous ? cur + 1 : 1; if (cur > best) { best = cur; bestEnd = d; } } else cur = 0;
    prev = d;
  }
  return { best, end: bestEnd };
}

function renderMovement() {
  const rows = garminDays().filter((r) => r.steps != null);
  const dates = rows.map((r) => r.date);
  const bestDay = rows.reduce((a, b) => (b.steps > a.steps ? b : a));
  const bestWorkout = data.workouts.find((w) => w.d === bestDay.date && w.type === 'Run' && w.km >= 41);
  const hits = rows.filter((r) => r.steps >= 10000).length;
  const streak = longestStreak(dates, (r) => r.steps >= 10000);
  const monthsList = months(dates[0].slice(0, 7), dates.at(-1).slice(0, 7));
  const monthly = monthsList.map((m) => mean(rows.filter((r) => r.date.startsWith(m)).map((r) => r.steps)));
  const peakIdx = monthly.indexOf(Math.max(...monthly));
  const lowIdx = monthly.indexOf(Math.min(...monthly));
  const { steps: weekSteps, days: weekDays } = data.weekHour;
  const perDay = weekSteps.map((hours, dow) => hours.map((v) => v / (weekDays[dow] || 1)));
  const maxCell = Math.max(...perDay.flat());
  const dowTotals = perDay.map((hours) => hours.reduce((a, b) => a + b, 0));
  const topDow = dowTotals.indexOf(Math.max(...dowTotals));
  const lowDow = dowTotals.indexOf(Math.min(...dowTotals));
  const recent = mean(rows.filter((r) => r.date >= '2023').map((r) => r.steps));

  const samePeriods = comparePeriods().full.periods;
  const yearly = samePeriods.map((p) => ({ label: p.label, steps: periodStats(p).steps }));
  const runShare = (i) => {
    const { from, to } = samePeriods[i];
    const total = inDays(from, to, (r) => r.steps).reduce((s, v) => s + (v || 0), 0);
    const inRuns = data.workouts.filter((w) => w.type === 'Run' && w.d >= from && w.d <= to).reduce((s, w) => s + (w.steps || 0), 0);
    return Math.round((inRuns / total) * 100);
  };
  return chapter('movement', '5 · Movement',
    `Your steps have held steady at around ${fmtInt(recent)} a day, but more of them are running`,
    `Runs went from ${runShare(0)}% of your steps in ${yearly[0].label.replace('*', '')} to ${runShare(yearly.length - 1)}% in ${yearly.at(-1).label.replace('*', '')}. With the total flat, you walk less.`,
    tiles(
      tile('Median day', fmtInt(median(rows.map((r) => r.steps))), 'steps'),
      tile('10,000+ step days', `${Math.round((hits / rows.length) * 100)}%`, `${fmtInt(hits)} of ${fmtInt(rows.length)} days`),
      tile('Longest 10K streak', `${streak.best} days`, streak.end ? `ended ${fmtDay(streak.end)}` : null),
      tile('Biggest day', fmtInt(bestDay.steps), bestWorkout ? `${fmtDay(bestDay.date)}, marathon day` : fmtDay(bestDay.date), dayButton(bestDay.date)),
    ),
    calendarFigure(rows),
    grid2(
      figure({
        title: 'Average steps a day, by month',
        takeaway: `Busiest ${fmtMonth(monthsList[peakIdx])}, at ${fmtInt(monthly[peakIdx])} a day. Quietest ${fmtMonth(monthsList[lowIdx])}, at ${fmtInt(monthly[lowIdx])}.`,
        height: 230,
        render(host, width, t) {
          columnChart(host, width, t, {
            categories: monthsList,
            series: [{ name: 'Steps a day', color: t.series[0], values: monthly }],
            height: 230,
            yFmt: (v) => fmtCompact(v),
            catFmt: fmtMonth,
            tickEvery: (m) => m.endsWith('-01'),
            tickFmt: (m) => m.slice(0, 4),
          });
        },
        table: () => ({ columns: ['Month', 'Steps a day'], rows: monthsList.map((m, i) => [fmtMonth(m), fmtInt(monthly[i])]) }),
      }),
      figure({
        title: 'Your week, hour by hour',
        takeaway: (() => {
          const peakCell = perDay.flatMap((hours, d) => hours.map((v, h) => ({ v, d, h }))).reduce((x, y) => (y.v > x.v ? y : x));
          return `${WEEKDAY_NAMES[topDow]} is your biggest day and ${WEEKDAY_NAMES[lowDow]} your smallest. The busiest hour is ${WEEKDAY_NAMES[peakCell.d]} at ${fmtClock(peakCell.h * 60)}.`;
        })(),
        sub: 'Average steps per hour.',
        height: 230,
        render(host, width, t) {
          cellGrid(host, width, t, {
            rows: 7,
            cols: 24,
            cellH: Math.min(26, Math.max(18, (width - 36) / 24)),
            value: (r, c) => perDay[r][c],
            max: maxCell,
            rowLabels: WEEKDAYS,
            colLabels: Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? fmtHourShort(h) : '')),
            tip: (r, c, v) => `<b>${WEEKDAYS[r]}, ${esc(fmtClock(c * 60))}</b>${tipRow(null, 'Average steps', fmtInt(v))}`,
            ariaLabel: 'Average steps by weekday and hour. A table view follows.',
          });
        },
        legend: (t) => [{ ramp: rampCss(t.ramp), from: 'Few', to: `${fmtInt(maxCell)} steps` }],
        table: () => ({
          columns: ['Hour', ...WEEKDAYS],
          rows: Array.from({ length: 24 }, (_, h) => [fmtClock(h * 60), ...perDay.map((d) => fmtInt(d[h]))]),
        }),
      })));
}

function calendarFigure(rows) {
  const values = new Map(rows.map((r) => [r.date, r.steps]));
  const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))];
  const CAP = 35000;
  return figure({
    title: 'Every day, by steps',
    sub: 'Each square is a day. Click one to open it.',
    height: 700,
    render(host, width, t) {
      const colorAt = rampTable(t.ramp);
      const labelW = 36;
      const rowGap = 8;
      const cell = Math.min(13, (width - labelW) / 54);
      const yearH = cell * 7;
      const monthH = 13;
      const height = years.length * (yearH + monthH + rowGap);
      const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Calendar heatmap of daily steps. A table view follows.' });
      years.forEach((year, yi) => {
        const top = yi * (yearH + monthH + rowGap) + monthH;
        root.append(svg('text', { x: 0, y: top + 10, class: 'axis-label', text: year }));
        const jan1 = Date.UTC(+year, 0, 1);
        const offset = new Date(jan1).getUTCDay();
        if (yi === 0 || yi === 1) {
          for (let m = 0; m < 12; m++) {
            const first = Date.UTC(+year, m, 1);
            const week = Math.floor(((first - jan1) / DAY + offset) / 7);
            root.append(svg('text', { x: labelW + week * cell, y: top - 3, class: 'axis-label', text: new Date(first).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) }));
          }
        }
        for (let t2 = jan1; t2 < Date.UTC(+year + 1, 0, 1); t2 += DAY) {
          const date = isoDay(t2);
          const v = values.get(date);
          if (v == null) continue;
          const week = Math.floor(((t2 - jan1) / DAY + offset) / 7);
          const dow = new Date(t2).getUTCDay();
          const rect = svg('rect', { x: labelW + week * cell + 1, y: top + dow * cell + 1, width: cell - 2, height: cell - 2, rx: 2, fill: `rgb(${colorAt(Math.min(1, v / CAP))})` });
          rect.style.cursor = 'pointer';
          rect.addEventListener('pointermove', (evt) => showTip(evt, `<b>${esc(fmtFullDay(date))}</b>${tipRow(null, 'Steps', fmtInt(v))}<div class="hint">Click to open this day</div>`));
          rect.addEventListener('pointerleave', hideTip);
          rect.addEventListener('click', () => openDay(date));
          root.append(rect);
        }
      });
      host.append(root);
    },
    legend: (t) => [{ ramp: rampCss(t.ramp), from: '0', to: '35,000+ steps' }],
    table: () => monthlyTable([['Steps a day', (r) => r.steps, fmtInt], ['Km a day', (r) => (r.distM == null ? null : r.distM / 1000), fmt1]], handover(), data.meta.trackerEnd),
  });
}

// ---------- chapter: activities ----------

const WORKOUT_GROUPS = [
  { name: 'Walk and hike', types: ['Walk', 'Hike'] },
  { name: 'Run', types: ['Run'] },
  { name: 'Ride', types: ['Ride'] },
  { name: 'Swim', types: ['Swim'] },
  { name: 'Snow', types: ['Snow'] },
  { name: 'Paddle and row', types: ['Paddle', 'Row'] },
  { name: 'Everything else', types: ['Elliptical', 'Strength', 'Yoga', 'Other'] },
];

function renderWorkouts() {
  const w = data.workouts.filter((x) => x.d >= handover());
  const monthsList = months(w[0].d.slice(0, 7), w.at(-1).d.slice(0, 7));
  const series = WORKOUT_GROUPS.map((g) => ({
    name: g.name,
    values: monthsList.map((m) => w.filter((x) => x.d.startsWith(m) && g.types.includes(x.type)).reduce((s, x) => s + x.min, 0) / 60),
  }));
  const shareRun = (year) => {
    const inYear = w.filter((x) => x.d.startsWith(year));
    return inYear.filter((x) => x.type === 'Run').reduce((s, x) => s + x.min, 0) / (inYear.reduce((s, x) => s + x.min, 0) || 1);
  };
  const lastYear = w.at(-1).d.slice(0, 4);
  const since = w;
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const x of since) grid[new Date(dayMs(x.d)).getUTCDay()][Math.floor(x.h) % 24]++;
  const maxGrid = Math.max(...grid.flat());
  const dowCount = grid.map((r) => r.reduce((a, b) => a + b, 0));
  const topDow = dowCount.indexOf(Math.max(...dowCount));
  const hourTotals = grid.reduce((acc, r) => acc.map((v, i) => v + r[i]), new Array(24).fill(0));
  const topHour = hourTotals.indexOf(Math.max(...hourTotals));
  const hoursByType = new Map();
  for (const x of w) hoursByType.set(x.type, (hoursByType.get(x.type) || 0) + x.min / 60);
  const typeRows = [...hoursByType.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value: Math.round(value) }));

  const yearShares = [...new Set(w.map((x) => x.d.slice(0, 4)))].map((y) => Math.round(shareRun(y) * 100));
  return chapter('workouts', '6 · Activities',
    `Running fills ${Math.min(...yearShares)}% to ${Math.max(...yearShares)}% of your activity hours every year`,
    'The rest is walks, rides, swims and ski days, which come and go with the seasons.',
    figure({
      title: 'Activity hours each month',
      height: 260,
      render(host, width, t) {
        columnChart(host, width, t, {
          categories: monthsList,
          series: series.map((s, i) => ({ ...s, color: t.series[i] })),
          height: 260,
          yFmt: (v) => (v >= 10 || v === 0 ? `${Math.round(v)}h` : `${v.toFixed(1)}h`),
          catFmt: fmtMonth,
          tickEvery: (m) => m.endsWith('-01'),
          tickFmt: (m) => m.slice(0, 4),
        });
      },
      legend: (t) => series.map((s, i) => ({ color: t.series[i], label: s.name })),
      table: () => ({
        columns: ['Month', ...series.map((s) => s.name)],
        rows: monthsList.map((m, i) => [fmtMonth(m), ...series.map((s) => (s.values[i] ? s.values[i].toFixed(1) : '—'))]),
      }),
    }),
    grid2(
      figure({
        title: 'When you head out',
        takeaway: `Most often on ${WEEKDAY_NAMES[topDow]}s, and at ${fmtClock(topHour * 60)}.`,
        sub: 'Activity start times.',
        height: 230,
        render(host, width, t) {
          cellGrid(host, width, t, {
            rows: 7,
            cols: 24,
            cellH: Math.min(26, Math.max(18, (width - 36) / 24)),
            value: (r, c) => grid[r][c],
            max: maxGrid,
            rowLabels: WEEKDAYS,
            colLabels: Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? fmtHourShort(h) : '')),
            tip: (r, c, v) => `<b>${WEEKDAYS[r]}, ${esc(fmtClock(c * 60))}</b>${tipRow(null, 'Activities started', fmtInt(v))}`,
            ariaLabel: 'Activity starts by weekday and hour. A table view follows.',
          });
        },
        legend: (t) => [{ ramp: rampCss(t.ramp), from: 'Few', to: `${maxGrid} activities` }],
        table: () => ({
          columns: ['Hour', ...WEEKDAYS, 'All'],
          rows: Array.from({ length: 24 }, (_, h) => [fmtClock(h * 60), ...grid.map((d) => String(d[h])), String(hourTotals[h])]),
        }),
      }),
      figure({
        title: 'Hours by activity',
        takeaway: `${typeRows.slice(0, 3).map((r, i) => `${i ? r.label.toLowerCase() : r.label} ${fmtInt(r.value)} h`).join(', then ')}.`,
        render(host, width, t) {
          hBars(host, width, t, { rows: typeRows, labelWidth: 90, fmt: (v) => `${fmtInt(v)} h`, tipLabel: 'Hours', rowH: 25 });
        },
        table: () => ({ columns: ['Activity', 'Hours'], rows: typeRows.map((r) => [r.label, fmtInt(r.value)]) }),
      })));
}

// ---------- chapter: sleep ----------

function nightsFigure({ list, title, sub, takeaway, method, mode }) {
  const START_H = 20; // 8 PM
  const END_H = 38; // 2 PM next day (hours counted from midnight of the evening before)
  const LOW_H = 6;
  const HIGH_H = 10.5;
  // 28-day averages of bedtime and wake time, drawn over the columns so the trend reads through night-to-night noise.
  const avgOf = (key) => list.map((n) => {
    const at = dayMs(n.d);
    const near = list.filter((m) => Math.abs(dayMs(m.d) - at) <= 14 * DAY).map((m) => m[key]);
    return near.length >= 10 ? mean(near) : null;
  });
  const trendLines = [avgOf('bed'), avgOf('wake')];
  return figure({
    title,
    sub,
    takeaway,
    method,
    height: 360,
    render(host, width, t) {
      const height = Math.max(280, Math.min(380, width * 0.34));
      const first = dayMs(list[0].d);
      const last = dayMs(list.at(-1).d);
      const span = Math.round((last - first) / DAY) + 1;
      const byIndex = new Map(list.map((n) => [Math.round((dayMs(n.d) - first) / DAY), n]));
      const stageRgb = { L: rampHex(stageColor(t, 'L')), R: rampHex(stageColor(t, 'R')), D: rampHex(stageColor(t, 'D')) };
      const colorAt = rampTable(t.ramp);
      const rangeMin = (END_H - START_H) * 60;
      raster(host, width, t, {
        height,
        columns: span,
        ariaLabel: 'Sleep per night. Monthly values are in the table view.',
        yTicks: [20, 24, 28, 32, 36].map((h) => ({ at: (h - START_H) / (END_H - START_H), label: fmtHourShort(h) })),
        xTicks: yearTicksFrom(first, span),
        paint(ctx, { x, y, w, h, dpr }) {
          const pw = Math.round(w * dpr);
          const ph = Math.round(h * dpr);
          const img = ctx.createImageData(pw, ph);
          for (let px = 0; px < pw; px++) {
            const n = byIndex.get(Math.floor((px / pw) * span));
            if (!n?.s) continue;
            const nightColor = mode === 'length' ? colorAt(0.2 + 0.8 * Math.max(0, Math.min(1, (n.asleep / 60 - LOW_H) / (HIGH_H - LOW_H)))) : null;
            for (let py = 0; py < ph; py++) {
              // Bins are 5 minutes counted from 6 PM; the picture starts at 8 PM.
              const minutesFrom18 = (py / ph) * rangeMin + (START_H - 18) * 60;
              const code = n.s[Math.floor(minutesFrom18 / 5) - n.b];
              const color = mode === 'length' ? (code === 'A' ? nightColor : null) : stageRgb[code];
              if (!color) continue;
              const o = (py * pw + px) * 4;
              img.data[o] = color[0]; img.data[o + 1] = color[1]; img.data[o + 2] = color[2]; img.data[o + 3] = 255;
            }
          }
          ctx.putImageData(img, Math.round(x * dpr), Math.round(y * dpr));
          const yAt = (m) => y + ((m - (START_H - 18) * 60) / rangeMin) * h;
          const xAt = (n) => x + ((Math.round((dayMs(n.d) - first) / DAY) + 0.5) / span) * w;
          for (const vals of trendLines) {
            const path = new Path2D();
            let prev = null;
            list.forEach((n, i) => {
              const v = vals[i];
              if (v == null) { prev = null; return; }
              if (prev && dayMs(n.d) - dayMs(prev.d) <= 8 * DAY) path.lineTo(xAt(n), yAt(v));
              else path.moveTo(xAt(n), yAt(v));
              prev = n;
            });
            ctx.lineJoin = 'round';
            ctx.strokeStyle = t.surface;
            ctx.lineWidth = 4;
            ctx.stroke(path);
            ctx.strokeStyle = t.ink;
            ctx.lineWidth = 1.5;
            ctx.stroke(path);
          }
        },
        hover({ col }) {
          const n = byIndex.get(col);
          if (!n) return null;
          return `<b>Night ending ${esc(fmtDay(n.d))}</b>${tipRow(null, 'Asleep', fmtDuration(n.asleep))}${tipRow(null, 'Bed to wake', `${fmtClockFrom18(n.bed)} – ${fmtClockFrom18(n.wake)}`)}${n.score != null ? tipRow(null, 'Score', n.score) : ''}<div class="hint">Click to open this day</div>`;
        },
        onPick({ col }) { const n = byIndex.get(col); if (n) openDay(n.d); },
      });
    },
    legend: (t) => (mode === 'length'
      ? [{ ramp: rampCss(t.ramp.slice(3)), from: `${LOW_H}h asleep`, to: `${HIGH_H}h+` }, { color: t.ink, label: '28-day average bedtime and wake time' }, { gap: true, label: 'Awake or not recorded' }]
      : [...Object.keys(STAGE).map((code) => ({ color: stageColor(t, code), label: STAGE[code].label })), { color: t.ink, label: '28-day average bedtime and wake time' }, { gap: true, label: 'Awake or not recorded' }]),
    table: () => monthlyTable([['Asleep', (r) => r.sleepMin, fmtDuration], ['In bed', (r) => r.inBed, fmtDuration], ['Deep', (r) => r.deep, fmtDuration], ['REM', (r) => r.rem, fmtDuration], ['Bedtime', (r) => r.bed, fmtClockFrom18]], list[0].d, list.at(-1).d),
  });
}

function renderSleep() {
  const nights = data.nights.filter((n) => n.src === 'garmin');
  const lastYearNights = nights.filter((n) => n.d >= isoDay(dayMs(data.meta.trackerEnd) - 365 * DAY));
  const nowAsleep = median(lastYearNights.map((n) => n.asleep));
  const eightH = lastYearNights.filter((n) => n.asleep >= 480).length;
  const presets = comparePeriods().same.periods;
  const a = periodStats(presets[0]);
  const b = periodStats(presets.at(-1));
  const totals = nights.reduce((acc, n) => ({ light: acc.light + n.light, deep: acc.deep + n.deep, rem: acc.rem + n.rem }), { light: 0, deep: 0, rem: 0 });
  const totalAsleep = totals.light + totals.deep + totals.rem;
  const dates = nights.map((n) => n.d);
  const weekday = WEEKDAYS.map((name, i) => {
    const subset = nights.filter((n) => new Date(dayMs(n.d)).getUTCDay() === i);
    return { name, bed: median(subset.map((n) => n.bed)) };
  });
  const latest = weekday.reduce((x, y) => (y.bed > x.bed ? y : x));
  const earliest = weekday.reduce((x, y) => (y.bed < x.bed ? y : x));
  const smoothBedLen = rolling(dates, (r) => r.inBed);
  const smoothAsleep = rolling(dates, (r) => r.sleepMin);
  const smoothBed = rolling(dates, (r) => r.bed);
  const monthsList = months(nights[0].d.slice(0, 7), nights.at(-1).d.slice(0, 7));
  const firstYearNights = nights.filter((n) => n.d < isoDay(dayMs(nights[0].d) + 365 * DAY));
  const stageAvg = (list, key) => mean(list.map((n) => n[key]));
  const byMonth = (key) => monthsList.map((m) => {
    const list = nights.filter((n) => n.d.startsWith(m));
    return list.length ? mean(list.map((n) => n[key])) / 60 : 0;
  });

  return chapter('sleep', '7 · Sleep',
    `You sleep ${fmtDuration(b.asleep - a.asleep)} more than in ${presets[0].label}, and go to bed ${fmtDuration(a.bed - b.bed)} earlier`,
    `Over the last year: a median ${fmtDuration(nowAsleep)} a night, and 8 hours or more on ${Math.round((eightH / lastYearNights.length) * 100)}% of nights.`,
    howMeasured(`Same ${comparePeriods().same.button} dates each year: asleep ${fmtDuration(a.asleep)} → ${fmtDuration(b.asleep)}, bedtime ${fmtClockFrom18(a.bed)} → ${fmtClockFrom18(b.bed)}. Garmin counts very little wake time, so its "asleep" runs close to time in bed.`),
    tiles(
      tile('Typical night, last year', `${fmtClockFrom18(median(lastYearNights.map((n) => n.bed)))}`, `to ${fmtClockFrom18(median(lastYearNights.map((n) => n.wake)))}`),
      tile('Deep sleep', `${Math.round((totals.deep / totalAsleep) * 100)}%`, 'of time asleep'),
      tile('REM sleep', `${Math.round((totals.rem / totalAsleep) * 100)}%`, 'of time asleep'),
      tile('Latest bedtime', WEEKDAY_NAMES[WEEKDAYS.indexOf(latest.name)], `${fmtClockFrom18(latest.bed)}. Earliest: ${earliest.name}`),
    ),
    nightsFigure({
      list: nights,
      mode: 'length',
      title: `${fmtInt(nights.length)} nights, side by side`,
      sub: 'One column per night, 8 PM to 2 PM, darker when longer. Lines are 28-day average bedtime and wake time.',
      method: 'Garmin\'s export has nightly stage totals but no timing, so the stages are in their own chart below. Click a night to open it.',
    }),
    grid2(
      figure({
        title: 'Time in bed and time asleep',
        takeaway: `Same dates, ${presets[0].label} to ${presets.at(-1).label}: asleep ${fmtDuration(a.asleep)} → ${fmtDuration(b.asleep)}, in bed ${fmtDuration(a.inBed)} → ${fmtDuration(b.inBed)}.`,
        sub: '28-day averages.',
        height: 240,
        render(host, width, t) {
          lineChart(host, width, t, {
            series: [
              { name: 'In bed', color: t.series[0], points: dates.map((d, i) => ({ x: dayMs(d), y: smoothBedLen[i] == null ? null : smoothBedLen[i] / 60 })), tipFmt: (v) => fmtDuration(v * 60) },
              { name: 'Asleep', color: t.series[1], points: dates.map((d, i) => ({ x: dayMs(d), y: smoothAsleep[i] == null ? null : smoothAsleep[i] / 60 })), tipFmt: (v) => fmtDuration(v * 60) },
            ],
            height: 240,
            yFmt: (v) => `${v}h`,
            xFmt: (x) => fmtDay(isoDay(x)),
            breakGap: 8 * DAY,
            onPick: (x) => openDay(isoDay(x)),
          });
        },
        legend: (t) => [{ color: t.series[0], label: 'In bed' }, { color: t.series[1], label: 'Asleep' }],
        table: () => monthlyTable([['In bed', (r) => r.inBed, fmtDuration], ['Asleep', (r) => r.sleepMin, fmtDuration]], handover(), data.meta.trackerEnd),
      }),
      figure({
        title: 'Bedtime',
        takeaway: `Same dates: ${fmtClockFrom18(a.bed)} in ${presets[0].label}, ${fmtClockFrom18(b.bed)} in ${presets.at(-1).label}.`,
        sub: '28-day average, local time. Lower on the chart is earlier.',
        height: 240,
        render(host, width, t) {
          const vals = smoothBed.filter((v) => v != null);
          const lo = Math.floor(Math.min(...vals) / 60) * 60;
          const hi = Math.ceil(Math.max(...vals) / 60) * 60;
          const yTickList = [];
          for (let m = lo; m <= hi; m += 60) yTickList.push(m);
          lineChart(host, width, t, {
            series: [{ name: 'Bedtime, 28-day average', color: t.series[0], points: dates.map((d, i) => ({ x: dayMs(d), y: smoothBed[i] })), tipFmt: fmtClockFrom18 }],
            height: 240,
            left: 58,
            yDomain: [lo, hi],
            yTickList,
            yFmt: fmtClockFrom18,
            xFmt: (x) => fmtDay(isoDay(x)),
            breakGap: 8 * DAY,
            onPick: (x) => openDay(isoDay(x)),
          });
        },
        table: () => monthlyTable([['Bedtime', (r) => r.bed, fmtClockFrom18], ['Wake', (r) => r.wake, fmtClockFrom18]], handover(), data.meta.trackerEnd),
      })),
    figure({
      title: 'Hours in each sleep stage',
      takeaway: `Last 12 months: ${fmtDuration(stageAvg(lastYearNights, 'deep'))} deep and ${fmtDuration(stageAvg(lastYearNights, 'rem'))} REM a night, against ${fmtDuration(stageAvg(firstYearNights, 'deep'))} and ${fmtDuration(stageAvg(firstYearNights, 'rem'))} in your first year on the watch.`,
      sub: 'Average per night, by month.',
      height: 230,
      render(host, width, t) {
        columnChart(host, width, t, {
          categories: monthsList,
          series: [
            { name: 'Light', color: stageColor(t, 'L'), values: byMonth('light') },
            { name: 'REM', color: stageColor(t, 'R'), values: byMonth('rem') },
            { name: 'Deep', color: stageColor(t, 'D'), values: byMonth('deep') },
          ],
          height: 230,
          yFmt: (v) => (Number.isInteger(v) ? `${v}h` : `${v.toFixed(1)}h`),
          catFmt: fmtMonth,
          tickEvery: (m) => m.endsWith('-01'),
          tickFmt: (m) => m.slice(0, 4),
        });
      },
      legend: (t) => Object.keys(STAGE).map((code) => ({ color: stageColor(t, code), label: STAGE[code].label })),
      table: () => monthlyTable([['REM', (r) => r.rem, fmtDuration], ['Deep', (r) => r.deep, fmtDuration]], handover(), data.meta.trackerEnd),
    }));
}

const rampHex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ---------- chapter: stress and recovery ----------

function renderRecovery() {
  const from = handover();
  const dates = data.daily.date.filter((d) => d >= from && row(d).stress != null);
  const line = (field) => {
    const smooth = rolling(dates, healthy((r) => r[field]));
    return dates.map((d, i) => ({ x: dayMs(d), y: smooth[i] }));
  };
  const grid = data.stressHour;
  const flat = grid.flat().filter((v) => v != null);
  const max = Math.max(...flat);
  const min = Math.min(...flat);
  let peak = { v: -1 };
  let calm = { v: Infinity };
  grid.forEach((r, d) => r.forEach((v, h) => {
    if (v == null) return;
    if (h >= 7 && h <= 22 && v > peak.v) peak = { v, d, h };
    if (v < calm.v) calm = { v, d, h };
  }));
  const dayAvg = grid.map((r) => mean(r.filter((_, h) => h >= 8 && h <= 22)));
  const calmDay = dayAvg.indexOf(Math.min(...dayAvg));
  const busyDay = dayAvg.indexOf(Math.max(...dayAvg));
  const smallLine = (title, sub, field, fmt, unit) => figure({
    title,
    sub,
    takeaway: (() => {
      const vals = line(field).map((pt) => pt.y).filter((v) => v != null);
      return vals.length ? `${fmt(vals[0])}${unit} when you got the watch, ${fmt(vals.at(-1))}${unit} now.` : null;
    })(),
    height: 190,
    render(host, width, t) {
      lineChart(host, width, t, {
        series: [{ name: title, color: t.series[0], points: line(field), tipFmt: (v) => `${fmt(v)}${unit}` }],
        height: 190,
        yFmt: (v) => `${Math.round(v * 10) / 10}`,
        xFmt: (x) => fmtDay(isoDay(x)),
        breakGap: 8 * DAY,
        spans: sickSpans(t),
        onPick: (x) => openDay(isoDay(x)),
      });
    },
    table: () => monthlyTable([[title, (r) => r[field], fmt1]], from, data.meta.trackerEnd),
  });

  return chapter('recovery', '8 · Stress and recovery',
    `${WEEKDAY_NAMES[busyDay]} is your most stressful day, and ${WEEKDAY_NAMES[calmDay]} your calmest`,
    `Your peak hour of the week is around ${fmtClock(peak.h * 60)} on ${WEEKDAY_NAMES[peak.d]}.`,
    howMeasured('Garmin estimates stress and its Body Battery energy score from heart-rate variability, so these are estimates rather than measurements. Exercise itself isn\'t scored, but the hours just after a hard run can read as stress.'),
    figure({
      title: 'Your stress, hour by hour',
      sub: 'Average stress, 1 to 100. Sleep is the calm band on the left.',
      height: 230,
      render(host, width, t) {
        cellGrid(host, width, t, {
          rows: 7,
          cols: 24,
          cellH: 26,
          value: (r, c) => grid[r][c],
          max,
          scale: (v) => (v - min) / (max - min),
          rowLabels: WEEKDAYS,
          colLabels: Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? fmtHourShort(h) : '')),
          tip: (r, c, v) => `<b>${WEEKDAYS[r]}, ${esc(fmtClock(c * 60))}</b>${tipRow(null, 'Average stress', fmt1(v))}`,
          ariaLabel: 'Average stress by weekday and hour. A table view follows.',
        });
      },
      legend: (t) => [{ ramp: rampCss(t.ramp), from: `${fmtInt(min)} of 100`, to: `${fmtInt(max)} of 100` }],
      table: () => ({ columns: ['Hour', ...WEEKDAYS], rows: Array.from({ length: 24 }, (_, h) => [fmtClock(h * 60), ...grid.map((d) => fmt1(d[h]))]) }),
    }),
    subhead('Since you got the watch'),
    grid2(
      smallLine('Daily stress', '28-day average.', 'stress', fmt1, ''),
      smallLine('Body Battery peak', 'Highest energy score each day, 28-day average.', 'battery', fmt1, '')),
    grid2(
      smallLine('Waking breathing rate', 'Breaths a minute, 28-day average.', 'resp', fmt1, ' /min'),
      smallLine('Climbed each day', 'Metres climbed on foot, 28-day average.', 'climbM', fmtInt, ' m')));
}

// ---------- chapter: weight ----------

function renderBody() {
  const w = data.weight;
  const d = data.meta.dedupe.weight;
  const pts = w.map((p) => ({ x: dayMs(p.d), y: p.lb }));
  const latest = w.at(-1);
  const first = w[0];
  const low = w.reduce((a, b) => (b.lb < a.lb ? b : a));
  const high = w.reduce((a, b) => (b.lb > a.lb ? b : a));
  const last90Start = isoDay(dayMs(latest.d) - 90 * DAY);
  const recent = w.filter((p) => p.d >= last90Start);
  return chapter('body', '9 · Weight',
    `From ${fmt1(first.lb)} lb in ${first.d.slice(0, 4)} to ${fmt1(latest.lb)} lb now`,
    `${fmtInt(w.length)} days with a scale reading, across your whole history.`,
    howMeasured(`${d.rows.fitbit != null
      ? `Fitbit and Garmin's biometrics file held ${fmtInt(d.rows.fitbit + (d.rows.biometrics ?? 0))} rows between them, most of them repeats or imported placeholders. Scale readings aren't affected by the watch switch.`
      : `Garmin's biometrics file held ${fmtInt(d.rows.biometrics ?? 0)} rows, most of them repeats or imported placeholders.`} The line breaks wherever more than six weeks passed without a reading.`),
    tiles(
      tile('Latest', `${fmt1(latest.lb)} lb`, fmtDay(latest.d)),
      tile('Last 90 days', `${fmt1(mean(recent.map((p) => p.lb)))} lb`, `average of ${recent.length} readings`),
      tile('Highest', `${fmt1(high.lb)} lb`, fmtDay(high.d)),
      tile('Lowest', `${fmt1(low.lb)} lb`, fmtDay(low.d)),
    ),
    figure({
      title: 'Weight over time',
      sub: 'Daily readings in pounds.',
      height: 280,
      render(host, width, t) {
        lineChart(host, width, t, {
          series: [{ name: 'Weight', color: t.series[0], points: pts, tipFmt: (v) => `${fmt1(v)} lb` }],
          height: 280,
          yFmt: (v) => `${Math.round(v)}`,
          xFmt: (x) => fmtDay(isoDay(x)),
          breakGap: 42 * DAY,
          onPick: (x) => openDay(isoDay(x)),
          marks: [{ x: dayMs(latest.d), y: latest.lb, label: fmt1(latest.lb), anchor: 'end', dx: -8, dy: -8 }],
        });
      },
      table: () => ({ columns: ['Date', 'Pounds'], rows: [...w].reverse().map((p) => [fmtDay(p.d), fmt1(p.lb)]) }),
    }));
}

// ---------- chapter: food ----------

function renderFood() {
  const f = data.food;
  const top = f.top[0];
  const allMonths = months(f.byMonth[0].m, f.byMonth.at(-1).m);
  const countByMonth = new Map(f.byMonth.map((x) => [x.m, x.count]));
  const peak = f.byMonth.reduce((a, b) => (b.count > a.count ? b : a));
  const order = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'After dinner'];
  // Export names vary ("Peanut Butter, Smooth"), so foods sharing a first word group merge for display.
  const shortList = (items) => {
    const merged = new Map();
    for (const x of items) {
      const name = x.name.split(',')[0].trim().replace(/s$/, '');
      merged.set(name, (merged.get(name) || 0) + x.count);
    }
    return [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  };
  return chapter('food', '15 · Food',
    `${top.name} is the food you logged most: ${fmtInt(top.count)} times`,
    `${fmtInt(f.entries)} items and ${fmtInt(f.distinct)} different foods on ${fmtInt(f.days)} days, all logged in Fitbit.`,
    howMeasured('Garmin and Strava have almost no food data. Fitbit\'s export has no per-food calories or total carbs and fat, so this is about what you ate rather than how much energy it held.'),
    tiles(
      tile('Protein on a full log day', `${fmtInt(f.medians.protein)} g`, `median of ${fmtInt(f.fullDays)} days with 5+ entries`),
      tile('Fiber', `${fmtInt(f.medians.fiber)} g`, 'same days'),
      tile('Sugar', `${fmtInt(f.medians.sugar)} g`, 'same days'),
      tile('Water', data.hydration.medianMl ? `${(data.hydration.medianMl / 1000).toFixed(1)} L` : '—', `median of ${fmtInt(data.hydration.days)} days logged`),
    ),
    grid2(
      figure({
        title: 'Most logged foods',
        height: 360,
        render(host, width, t) {
          hBars(host, width, t, { rows: f.top.map((x) => ({ label: x.name, value: x.count })), labelWidth: Math.min(170, width * 0.42), fmt: (v) => `${v}` });
        },
        table: () => ({ columns: ['Food', 'Times logged'], rows: f.top.map((x) => [x.name, String(x.count)]) }),
      }),
      el('div', null,
        figure({
          title: 'What each meal looked like',
          render(host) {
            host.append(el('div', { class: 'meals' }, order.filter((m) => f.byMeal[m]).map((m) => el('div', null,
              el('h4', { text: m }),
              el('ol', null, shortList(f.byMeal[m].top).map(([name, count]) => el('li', null, el('span', { text: name }), el('span', { text: count }))))))));
          },
        }),
        figure({
          title: 'Items logged each month',
          takeaway: `Busiest in ${fmtMonth(peak.m)}.`,
          height: 150,
          render(host, width, t) {
            columnChart(host, width, t, {
              categories: allMonths,
              series: [{ name: 'Items', color: t.series[0], values: allMonths.map((m) => countByMonth.get(m) || 0) }],
              height: 150,
              yFmt: (v) => `${Math.round(v)}`,
              catFmt: fmtMonth,
              tickEvery: (m) => m.endsWith('-01'),
              tickFmt: (m) => m.slice(0, 4),
            });
          },
          table: () => ({ columns: ['Month', 'Items'], rows: f.byMonth.map((x) => [fmtMonth(x.m), String(x.count)]) }),
        }))));
}

// ---------- chapter: cycle ----------

function renderCycle() {
  const c = data.cycles;
  // With a logged IUD start the cycles split into before and with it. Without one, every cycle is in 'before'.
  const hasIud = c.iudDate != null;
  const ERAS = hasIud ? {
    before: { label: 'Before IUD', phrase: 'before the IUD', slot: 0, rhr: c.rhrBefore, sleep: c.sleepBefore, inEra: (d) => d < c.iudDate },
    with: { label: 'With IUD', phrase: 'with the IUD', slot: 1, rhr: c.rhrWith, sleep: c.sleepWith, inEra: (d) => d >= c.iudDate },
  } : {
    before: { label: 'All cycles', phrase: 'across your cycles', slot: 0, rhr: c.rhrBefore, sleep: c.sleepBefore, inEra: () => true },
  };
  const VIEWS = hasIud ? [['with', 'With IUD'], ['before', 'Before IUD'], ['both', 'Both']] : [];
  let view = hasIud ? 'with' : 'before';
  const shown = () => (view === 'both' ? ['before', 'with'] : [view]);
  const solid = (fold) => fold.days.filter((x) => x.n >= 15);
  const swing = (fold) => {
    const s = solid(fold);
    const low = s.reduce((a, b) => (b.mean < a.mean ? b : a));
    const high = s.reduce((a, b) => (b.mean > a.mean ? b : a));
    return { low, high, size: high.mean - low.mean };
  };
  const toPts = (fold) => solid(fold).map((x) => ({ x: x.day, y: x.mean, lo: x.mean - 1.96 * x.se, hi: x.mean + 1.96 * x.se }));
  const complete = c.list.filter((x) => x.confirmed && x.len >= 21 && x.len <= 45);
  const iudLabel = hasIud ? fmtMonth(c.iudDate.slice(0, 7)) : null;
  const mainSwing = swing(ERAS[view].rhr);

  const foldFigure = (title, sub, key, unit, table) => figure({
    title,
    sub,
    height: 250,
    render(host, width, t) {
      const tip = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} ${unit}`;
      lineChart(host, width, t, {
        // Each era keeps its color whichever view is chosen.
        series: shown().map((era) => ({ name: ERAS[era].label, color: t.series[ERAS[era].slot], points: toPts(ERAS[era][key]), band: true, tipFmt: tip })),
        xType: 'linear',
        height: 250,
        zeroLine: 0,
        yFmt: (v) => `${v > 0 ? '+' : ''}${v}`,
        xFmt: (x) => `Cycle day ${x}`,
        xTickList: [1, 7, 14, 21, 28].map((v) => ({ v, label: `Day ${v}` })),
        xDomain: [1, 28],
        rightPad: 22,
      });
    },
    legend: (t) => shown().map((era) => ({ color: t.series[ERAS[era].slot], label: `${ERAS[era].label} (${ERAS[era][key].cycles} cycles with enough data)` })),
    table,
  });
  const foldTable = (key) => () => ({
    columns: ['Cycle day', ...shown().map((era) => ERAS[era].label)],
    rows: c.rhrBefore.days.map((x, i) => [String(x.day), ...shown().map((era) => fmt1(ERAS[era][key].days[i].mean))]),
  });

  const rhrFig = foldFigure('Resting heart rate by cycle day', 'Difference from each cycle\'s own average, bpm. Band: 95% interval.', 'rhr', 'bpm', foldTable('rhr'));
  const sleepFig = foldFigure('Time asleep by cycle day', 'Same method, in minutes. Noisier, so read small dips loosely.', 'sleep', 'min', foldTable('sleep'));
  const shownCycles = () => complete.filter((x) => shown().some((era) => ERAS[era].inEra(x.start)));
  const lengthFig = figure({
    title: 'Cycle length',
    takeaway: `A median ${median(complete.map((x) => x.len))} days across ${complete.length} complete cycles, from ${Math.min(...complete.map((x) => x.len))} to ${Math.max(...complete.map((x) => x.len))}.`,
    sub: 'Days in each complete cycle.',
    height: 170,
    render(host, width, t) {
      const list = shownCycles();
      columnChart(host, width, t, {
        categories: list.map((x) => x.start),
        series: shown().map((era) => ({ name: ERAS[era].label, color: t.series[ERAS[era].slot], values: list.map((x) => (ERAS[era].inEra(x.start) ? x.len : 0)) })),
        height: 170,
        yFmt: (v) => `${Math.round(v)}`,
        catFmt: (d) => `Started ${fmtDay(d)}`,
        tickEvery: (d, i) => i > 0 && d.slice(0, 4) !== list[i - 1].start.slice(0, 4),
        tickFmt: (d) => d.slice(0, 4),
      });
    },
    legend: (t) => shown().map((era) => ({ color: t.series[ERAS[era].slot], label: ERAS[era].label })),
    table: () => ({ columns: ['Started', 'Days', 'Period days', 'Source'], rows: shownCycles().map((x) => [fmtDay(x.start), String(x.len), x.period == null ? '—' : String(x.period), SOURCE[x.source].label]) }),
  });

  const tileHost = el('div');
  const summary = el('p', { class: 'aside' });
  function drawTiles() {
    const list = shownCycles();
    const lens = list.map((x) => x.len);
    const parts = shown().map((era) => {
      const s = swing(ERAS[era].rhr);
      return `${ERAS[era].phrase}, resting heart rate swings ${fmt1(s.size)} bpm, lowest around day ${s.low.day} and highest around day ${s.high.day}`;
    });
    summary.textContent = `${parts.join('; ')}.`.replace(/^./, (ch) => ch.toUpperCase());
    const since = view === 'both' || !hasIud ? `from ${fmtMonth(list[0].start.slice(0, 7))}` : `${view === 'with' ? 'since' : 'until'} ${iudLabel}`;
    tileHost.replaceChildren(tiles(
      tile('Complete cycles', String(list.length), since),
      tile('Median cycle', `${median(lens)} days`),
      tile('Range', `${Math.min(...lens)} to ${Math.max(...lens)} days`, 'cycles over 45 days are left out'),
      ...shown().map((era) => tile(`Heart-rate swing, ${ERAS[era].phrase}`, `${fmt1(swing(ERAS[era].rhr).size)} bpm`, 'lowest to highest cycle day')),
    ));
  }
  const buttons = VIEWS.map(([key, label]) => el('button', {
    type: 'button',
    text: label,
    'aria-pressed': key === view ? 'true' : 'false',
    'data-view': key,
    onclick: () => {
      view = key;
      buttons.forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.view === view ? 'true' : 'false'));
      drawTiles();
      [rhrFig, sleepFig, lengthFig].forEach((f) => f.redraw());
    },
  }));
  drawTiles();

  return chapter('cycle', '10 · Cycle',
    `Your resting heart rate follows your cycle, by about ${fmt1(mainSwing.size)} bpm`,
    `So one higher week is often the cycle, not lost fitness.`,
    howMeasured(hasIud
      ? `${c.complete} complete cycles: Fitbit's log until the IUD in ${iudLabel}, and Garmin's after. Each cycle is measured against its own average, so the difference between watches largely cancels out.`
      : `${c.complete} complete cycles from your cycle log. Each cycle is measured against its own average, so slow changes in fitness largely cancel out.`),
    hasIud ? el('div', { class: 'seg', role: 'group', 'aria-label': 'Which cycles to show' }, buttons) : null,
    summary,
    tileHost,
    grid2(rhrFig, sleepFig),
    lengthFig);
}

// ---------- chapter: connections ----------

function renderLinks() {
  const { correlations, contrast, nights } = data;
  const sizable = correlations.filter((c) => Math.abs(c.r) >= 0.2);
  const movement = correlations.filter((c) => c.group === 'movement');
  const quietMovement = movement.every((c) => Math.abs(c.r) < 0.1);
  const heading = quietMovement
    ? 'How much you moved barely touched your sleep. How much you slept showed up the next day.'
    : 'What moved with what';
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const scatterBed = nights.filter((n) => n.src === 'garmin' && n.bed >= 180 && n.bed <= 660 && n.asleep >= 180);
  const stressPts = data.daily.date.filter((d) => row(d).stress != null && row(d).sleepMin != null);

  return chapter('links', '11 · Connections',
    heading,
    `${sizable.length} of ${correlations.length} pairs are clearly linked. You slept ${fmtDuration(contrast.run.sleep)} after runs and ${fmtDuration(contrast.rest.sleep)} after rest days.`,
    howMeasured(`Each pair is compared day to day after removing its 28-day trend, on the Garmin only, so a slow shift like your fitness gain can't create a false link. The sizable ones: ${sizable.map((c) => lower(c.label).replace(' → ', ' with ')).join('; ')}. These are patterns in one person's record, so they don't show cause.`),
    figure({
      title: 'Strength of each day-to-day link',
      sub: 'Correlation from −1 to +1. Gray dots are within chance.',
      height: 420,
      render(host, width, t) {
        const labelW = Math.min(320, width * 0.5);
        const rowH = 34;
        const height = correlations.length * rowH + 24;
        const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Correlation strength for each pair. A table view follows.' });
        const x = linear(-0.5, 0.5, labelW, width - 52);
        for (const v of [-0.4, -0.2, 0, 0.2, 0.4]) {
          root.append(svg('line', { x1: x(v), x2: x(v), y1: 0, y2: height - 22, stroke: v === 0 ? t.axis : t.grid, 'stroke-width': 1 }));
          root.append(svg('text', { x: x(v), y: height - 6, 'text-anchor': 'middle', class: 'axis-label', text: v > 0 ? `+${v}` : `${v}`.replace('-', '−') }));
        }
        correlations.forEach((c, i) => {
          const y = i * rowH + rowH / 2;
          const [from, to] = c.label.split(' → ');
          root.append(svg('text', { x: labelW - 12, y: y - 2, 'text-anchor': 'end', class: 'note-label', text: from }));
          root.append(svg('text', { x: labelW - 12, y: y + 11, 'text-anchor': 'end', class: 'axis-label', text: `→ ${to}` }));
          root.append(svg('line', { x1: x(c.r - c.margin), x2: x(c.r + c.margin), y1: y, y2: y, stroke: t.axis, 'stroke-width': 2, 'stroke-linecap': 'round' }));
          const clears = Math.abs(c.r) > c.margin;
          const fill = !clears ? t.muted : c.r < 0 ? t.neg : t.series[0];
          root.append(svg('circle', { cx: x(c.r), cy: y, r: 5, fill, stroke: t.surface, 'stroke-width': 2 }));
          root.append(svg('text', { x: width - 2, y: y + 4, 'text-anchor': 'end', class: 'value-label', text: `${c.r >= 0 ? '+' : '−'}${Math.abs(c.r).toFixed(2)}` }));
          const hit = svg('rect', { x: 0, y: i * rowH, width, height: rowH, fill: 'transparent' });
          hit.addEventListener('pointermove', (evt) => showTip(evt, `<b>${esc(c.label)}</b>${tipRow(null, 'Correlation', c.r.toFixed(3))}${tipRow(null, 'Noise range', `±${c.margin.toFixed(3)}`)}${tipRow(null, 'Day pairs', fmtInt(c.n))}`));
          hit.addEventListener('pointerleave', hideTip);
          root.append(hit);
        });
        host.append(root);
      },
      legend: (t) => [{ color: t.series[0], label: 'Positive link' }, { color: t.neg, label: 'Negative link' }, { color: t.muted, label: 'Within noise' }],
      table: () => ({ columns: ['Pair', 'r', '± noise', 'Day pairs'], rows: correlations.map((c) => [c.label, c.r.toFixed(3), c.margin.toFixed(3), fmtInt(c.n)]) }),
    }),
    grid2(
      figure({
        title: 'Time asleep against that day\'s stress',
        takeaway: (() => {
          const stressAfter = (test) => mean(stressPts.filter((d) => test(row(d).sleepMin)).map((d) => row(d).stress));
          return `Stress averaged ${fmt1(stressAfter((m) => m < 420))} after under 7 hours asleep, ${fmt1(stressAfter((m) => m >= 480))} after 8 or more.`;
        })(),
        sub: 'Each dot is a day.',
        height: 320,
        render(host, width, t) {
          scatter(host, width, t, {
            points: stressPts.map((d) => ({ x: row(d).sleepMin / 60, y: row(d).stress, color: t.series[0], d })),
            height: 320,
            r: 2.5,
            opacity: 0.4,
            xDomain: [3, 12],
            xTicks: [4, 6, 8, 10, 12],
            yDomain: [0, 70],
            xFmt: (v) => `${v}h`,
            xLabel: 'Hours asleep',
            yLabel: 'Average stress',
            yFmt: (v) => `${v}`,
            tip: (p) => `<b>${esc(fmtDay(p.d))}</b>${tipRow(null, 'Asleep', fmtDuration(row(p.d).sleepMin))}${tipRow(null, 'Stress', row(p.d).stress)}`,
            onPick: (p) => openDay(p.d),
            ariaLabel: 'Hours asleep against average stress. A table view follows.',
          });
        },
        table: () => monthlyTable([['Asleep', (r) => r.sleepMin, fmtDuration], ['Stress', (r) => r.stress, fmt1]], handover(), data.meta.trackerEnd),
      }),
      figure({
        title: 'Bedtime against time asleep',
        takeaway: (() => {
          const asleepIf = (test) => mean(scatterBed.filter((n) => test(n.bed)).map((n) => n.asleep));
          return `Bed before midnight: ${fmtDuration(asleepIf((b) => b < 360))} asleep. After 1 AM: ${fmtDuration(asleepIf((b) => b >= 420))}.`;
        })(),
        sub: 'Each dot is a night.',
        method: 'Part of this link is arithmetic: with a fairly fixed wake time, a later bedtime leaves less night.',
        height: 320,
        render(host, width, t) {
          scatter(host, width, t, {
            points: scatterBed.map((n) => ({ x: n.bed, y: n.asleep / 60, color: t.series[0], night: n })),
            height: 320,
            r: 2.5,
            opacity: 0.4,
            xDomain: [180, 660],
            xTicks: [180, 300, 420, 540, 660],
            yDomain: [3, 12],
            xFmt: fmtClockFrom18,
            xTickFmt: (v) => fmtHourShort(Math.round((v + 18 * 60) / 60)),
            xLabel: 'Bedtime',
            yLabel: 'Hours asleep',
            yFmt: (v) => `${v}h`,
            tip: (p) => `<b>Night ending ${esc(fmtDay(p.night.d))}</b>${tipRow(null, 'Bedtime', fmtClockFrom18(p.night.bed))}${tipRow(null, 'Asleep', fmtDuration(p.night.asleep))}`,
            onPick: (p) => openDay(p.night.d),
            ariaLabel: 'Bedtime against hours asleep for each night. A table view follows.',
          });
        },
        table: () => monthlyTable([['Bedtime', (r) => r.bed, fmtClockFrom18], ['Asleep', (r) => r.sleepMin, fmtDuration]], handover(), data.meta.trackerEnd),
      })));
}

// ---------- chapter: what the watch changed ----------

const SWITCH_META = {
  awake: { label: 'Time awake at night', fmt: fmtDuration, group: 'watch', why: 'Same nights, very different counting. The Fitbit logged many short wake-ups that the Garmin doesn\'t.' },
  sleepMin: { label: 'Time asleep', fmt: fmtDuration, group: 'watch', why: 'This follows from the wake counting. Time in bed barely moved, so you didn\'t suddenly sleep over an hour more.' },
  active: { label: 'Active minutes', fmt: fmtInt, group: 'watch', why: 'Different definitions. Garmin\'s intensity minutes are stricter than Fitbit\'s active minutes, and it halved while your running doubled.' },
  deep: { label: 'Deep sleep', fmt: fmtDuration, group: 'watch', why: 'Each watch classifies stages with its own model.' },
  rem: { label: 'REM sleep', fmt: fmtDuration, group: 'watch', why: 'Each watch classifies stages with its own model.' },
  rhr: { label: 'Resting heart rate', fmt: fmt1, group: 'partly', why: 'Partly the formula. Your raw overnight heart rate fell far less over the same days, as the chart above shows.' },
  runKm: { label: 'Kilometres run a day', fmt: fmt1, group: 'you', why: 'Your marathon training. Fitbit distances were stride estimates, so the exact size is uncertain, but the doubling is too large to be only that.' },
  steps: { label: 'Steps a day', fmt: fmtInt, group: 'unclear', why: 'More running would raise this, and so could a difference in counting. The watches never recorded the same full day, so the two can\'t be separated.' },
  overnight: { label: 'Heart rate at 3 to 5 AM', fmt: fmt1, group: 'none', why: 'The raw reading, with no formula in between. An ordinary month-to-month change.' },
  hrAvg: { label: 'All-day heart rate', fmt: fmt1, group: 'none', why: 'An ordinary month-to-month change, so the sensors read broadly alike.' },
  daytime: { label: 'Heart rate, 10 AM to 6 PM', fmt: fmt1, group: 'none', why: 'An ordinary month-to-month change.' },
  inBed: { label: 'Time in bed', fmt: fmtDuration, group: 'none', why: 'Only needs a bedtime and wake time, so it\'s the fairest sleep comparison across the switch.' },
  bed: { label: 'Bedtime', fmt: fmtClockFrom18, delta: (v) => `${fmtDuration(Math.abs(v))} ${v < 0 ? 'earlier' : 'later'}`, group: 'none', why: 'No real change.' },
  cal: { label: 'Calories a day', fmt: fmtInt, group: 'none', why: 'No real change, even with more running. Treat both watches\' estimates loosely.' },
};
const SWITCH_GROUPS = [
  ['watch', 'Mostly the watch'],
  ['partly', 'Partly the watch'],
  ['you', 'Mostly you'],
  ['unclear', 'Can\'t be separated'],
  ['none', 'Barely changed'],
];

function renderSwitch() {
  const sw = data.switch;
  const byField = new Map(sw.rows.map((r) => [r.field, r]));
  const rhr = byField.get('rhr');
  const overnight = byField.get('overnight');
  const asleep = byField.get('sleepMin');
  const inBedRow = byField.get('inBed');
  const run = byField.get('runKm');
  const allNightDates = data.daily.date.filter((d) => row(d).overnight != null);
  const allRhrDates = data.daily.date.filter((d) => row(d).rhr != null);
  const nightSm = rolling(allNightDates, (r) => r.overnight);
  const rhrSm = rolling(allRhrDates, (r) => r.rhr);

  return chapter('switch', '12 · What the watch changed',
    'Part of the jump at the switch is the watch, and part of it is you',
    `Running doubled because you started marathon training. Sleep jumped ${fmtDuration(asleep.change)} while time in bed barely moved, which is the watch.`,
    howMeasured(`The 30 days either side of ${fmtDay(handover())}. Kilometres run a day went from ${fmt1(run.before)} to ${fmt1(run.after)}, and time in bed moved ${fmtDuration(inBedRow.change)}. Resting heart rate is a mix: it dropped ${fmt1(Math.abs(rhr.change))} bpm while your raw overnight heart rate dropped ${fmt1(Math.abs(overnight.change))}. The only direct comparison is ${sw.overlap.minutes} minutes on one evening when you wore both, when the watches differed by ${fmt1(sw.overlap.meanAbs)} bpm on average. That's too little to calibrate one against the other, so the Fitbit years stay unadjusted.`),
    figure({
      title: 'Resting heart rate against raw overnight heart rate',
      sub: '28-day averages. Read the raw 3 to 5 AM line across the switch.',
      method: `On the Fitbit, the resting number sits about ${fmt1(Math.abs(sw.fitbitGap))} bpm above your 3 to 5 AM rate. On the Garmin it sits about ${fmt1(Math.abs(sw.garminGap))} bpm below. That gap is each watch's formula, so the raw line is the fairer one across the switch.`,
      height: 300,
      render(host, width, t) {
        lineChart(host, width, t, {
          series: [
            { name: 'Resting heart rate', color: t.series[0], points: allRhrDates.map((d, i) => ({ x: dayMs(d), y: rhrSm[i] })), tipFmt: (v) => `${fmt1(v)} bpm` },
            { name: 'Heart rate at 3 to 5 AM', color: t.series[1], points: allNightDates.map((d, i) => ({ x: dayMs(d), y: nightSm[i] })), tipFmt: (v) => `${fmt1(v)} bpm` },
          ],
          height: 300,
          yFmt: (v) => `${Math.round(v)}`,
          xFmt: (x) => fmtDay(isoDay(x)),
          breakGap: 8 * DAY,
          annotations: handoverAnnotation(),
          onPick: (x) => openDay(isoDay(x)),
        });
      },
      legend: (t) => [{ color: t.series[0], label: 'Resting heart rate' }, { color: t.series[1], label: 'Heart rate at 3 to 5 AM' }],
      table: () => monthlyTable([['Resting HR', (r) => r.rhr, fmt1], ['3 to 5 AM', (r) => r.overnight, fmt1]], null, data.meta.trackerEnd),
    }),
    figure({
      title: 'Every metric across the switch',
      takeaway: `Mostly the watch: time asleep ${signed(asleep.change, fmtDuration)} and active minutes ${signed(byField.get('active').change, fmtInt)} a day. Mostly you: kilometres run a day ${fmt1(run.before)} → ${fmt1(run.after)}.`,
      sub: 'Last 30 days on the Fitbit against the first 30 on the Garmin.',
      method: '"Bigger than" compares the change with every other 30-day change in your record: 50% is ordinary, near 100% is unusual. The groupings are a reading of why, not something the data can prove.',
      render(host) {
        host.append(el('div', { class: 'table-scroll' }, el('table', { class: 'score switch-table' },
          el('thead', null, el('tr', null, ['', 'Fitbit', 'Garmin', 'Change', 'Bigger than', 'Why'].map((h, i) => el('th', { scope: 'col', text: h, class: i === 0 || i === 5 ? 'label' : null })))),
          el('tbody', null, SWITCH_GROUPS.flatMap(([key, name]) => [
            el('tr', { class: 'group' }, el('td', { colspan: '6', text: name })),
            ...Object.entries(SWITCH_META).filter(([, m]) => m.group === key).map(([field, m]) => {
              const r = byField.get(field);
              const delta = m.delta ? m.delta(r.change) : signed(r.change, m.fmt);
              return el('tr', null,
                el('td', { class: 'label', text: m.label }),
                el('td', { text: m.fmt(r.before) }),
                el('td', { text: m.fmt(r.after) }),
                el('td', { class: 'delta', text: delta }),
                el('td', { text: `${r.percentile}%` }),
                el('td', { class: 'label why', text: m.why }));
            }),
          ])))));
      },
    }));
}

// ---------- chapter: the Fitbit years ----------

function renderFitbit() {
  const end = isoDay(dayMs(handover()) - DAY);
  const start = data.meta.trackerStart;
  const days = inDays(start, end, (r) => r);
  const nights = data.nights.filter((n) => n.src === 'fitbit');
  const workouts = data.workouts.filter((w) => w.d < handover());
  const monthAvg = (m, get) => mean(days.filter((r) => r.date.startsWith(m)).map(get));
  const rhrAug = monthAvg('2020-08', (r) => r.rhr);
  const rhrNov = monthAvg('2020-11', (r) => r.rhr);
  const stepsAug = monthAvg('2020-08', (r) => r.steps);
  const stepsNov = monthAvg('2020-11', (r) => r.steps);
  const monthsList = months(start.slice(0, 7), end.slice(0, 7));
  const monthlySteps = monthsList.map((m) => monthAvg(m, (r) => r.steps));
  const rhrDates = days.filter((r) => r.rhr != null).map((r) => r.date);
  const rhrSmooth = rolling(rhrDates, (r) => r.rhr);
  const best = nights.filter((n) => n.score != null).reduce((a, b) => (b.score > a.score ? b : a));
  const thirds = { D: [0, 0, 0], R: [0, 0, 0] };
  for (const n of nights) {
    [...n.s].forEach((c, i) => { if (thirds[c]) thirds[c][Math.min(2, Math.floor((3 * i) / n.s.length))]++; });
  }
  const share = (arr, i) => Math.round((arr[i] / arr.reduce((a, b) => a + b, 0)) * 100);
  const hawaii = data.meta.tzSpans.find((s) => s.zone === 'Hawaii');
  const hawaiiBed = hawaii ? median(nights.filter((n) => n.d >= hawaii.start && n.d <= hawaii.end).map((n) => n.bed)) : null;
  const sum = (list, get) => list.reduce((s, x) => s + (get(x) || 0), 0);

  return chapter('fitbit', '13 · The Fitbit years',
    `Your biggest heart-rate change happened on the Fitbit, in autumn 2020`,
    `Resting heart rate fell from ${Math.round(rhrAug)} to ${Math.round(rhrNov)} bpm between August and November 2020, while steps held near ${fmtInt(mean([stepsAug, stepsNov]))} a day.`,
    howMeasured(`Same watch throughout, so it isn't the switch, and it wasn't more walking. The data can't say what it was, though your clock moved to Eastern time that September. This chapter covers ${fmtDay(start)} to ${fmtDay(end)} and isn't directly comparable with the Garmin chapters.`),
    tiles(
      tile('Steps', fmtCompact(sum(days, (r) => r.steps)), `median ${fmtInt(median(days.map((r) => r.steps)))} a day`),
      tile('Nights recorded', fmtInt(nights.length), `median ${fmtDuration(median(nights.map((n) => n.inBed ?? n.wake - n.bed)))} in bed`),
      tile('Activities', fmtInt(workouts.length), 'mostly auto-detected walks'),
      tile('Best sleep score', fmtInt(best.score), `${fmtDay(best.d)}. Only Fitbit exports scores`, dayButton(best.d)),
    ),
    fingerprintFigure({
      from: start,
      title: () => 'All seven years, both watches',
      sub: () => 'Average heart rate every half hour. Note the change in autumn 2020, well before the switch.',
      marks: [{ date: handover(), label: 'Garmin →' }],
    }),
    figure({
      title: 'Resting heart rate on the Fitbit',
      takeaway: `${Math.round(rhrAug)} bpm in August 2020, ${Math.round(rhrNov)} by November, and ${Math.round([...rhrSmooth].reverse().find((v) => v != null))} at the switch to Garmin.`,
      sub: '28-day average of Fitbit\'s own resting number.',
      height: 240,
      render(host, width, t) {
        lineChart(host, width, t, {
          series: [{ name: 'Resting, 28-day average', color: t.series[0], points: rhrDates.map((d, i) => ({ x: dayMs(d), y: rhrSmooth[i] })), tipFmt: (v) => `${fmt1(v)} bpm` }],
          height: 240,
          yFmt: (v) => `${Math.round(v)}`,
          xFmt: (x) => fmtDay(isoDay(x)),
          breakGap: 8 * DAY,
          onPick: (x) => openDay(isoDay(x)),
        });
      },
      table: () => monthlyTable([['Resting HR', (r) => r.rhr, fmt1]], start, end),
    }),
    nightsFigure({
      list: nights,
      mode: 'stages',
      title: `${fmtInt(nights.length)} nights with stage timing`,
      takeaway: `${share(thirds.D, 0)}% of your deep sleep came in the first third of the night, and ${share(thirds.R, 2)}% of your REM in the last third.`,
      sub: 'Only Fitbit exports when each stage happened. Click a night to open it.',
      method: hawaiiBed != null ? `The bump in spring 2021 is a month on Hawaii time, when your median bedtime was ${fmtClockFrom18(hawaiiBed)}.` : null,
    }),
    figure({
      title: 'Average steps a day, by month',
      takeaway: (() => {
        const valid = monthsList.map((m, i) => [m, monthlySteps[i]]).filter(([, v]) => v != null);
        const hi = valid.reduce((x, y) => (y[1] > x[1] ? y : x));
        const lo = valid.reduce((x, y) => (y[1] < x[1] ? y : x));
        return `Busiest ${fmtMonth(hi[0])}, at ${fmtInt(hi[1])} a day. Quietest ${fmtMonth(lo[0])}, at ${fmtInt(lo[1])}.`;
      })(),
      height: 200,
      render(host, width, t) {
        columnChart(host, width, t, {
          categories: monthsList,
          series: [{ name: 'Steps a day', color: t.series[0], values: monthlySteps }],
          height: 200,
          yFmt: (v) => fmtCompact(v),
          catFmt: fmtMonth,
          tickEvery: (m) => m.endsWith('-01'),
          tickFmt: (m) => m.slice(0, 4),
        });
      },
      table: () => ({ columns: ['Month', 'Steps a day'], rows: monthsList.map((m, i) => [fmtMonth(m), fmtInt(monthlySteps[i])]) }),
    }));
}

// ---------- chapter: notes ----------

function renderNotes() {
  const { dedupe: d, checks: c, handover: h } = data.meta;
  const a = d.activities;
  const has = hasSource;
  const main = watchName();
  const earlier = earlierWatch();
  const long = (a.distanceDisagreements || []).find((x) => x.strava - x.garmin > 5 && x.used === 'strava');
  const notWorn = d.exclusions.filter((x) => (x.kind || 'not-worn') === 'not-worn');
  // Each note applies only when its export is there.
  const items = [
    [true, 'Runs on your machine', 'The server listens only on this computer, and the page loads no outside scripts, fonts or maps. Passwords, logins, emails, profile files, social data and photos in your exports are never read.'],
    [earlier, 'One watch per day', () => `Each calendar day comes from one watch: ${earlier.label} before ${fmtDay(h)}, ${main} from then on. ${fmtInt(d.droppedHr?.[earlier.id] ?? 0)} ${earlier.label} heart-rate samples after the switch${d.emptyGarminDays ? ` and ${fmtInt(d.emptyGarminDays)} empty or imported Garmin days before it` : ''} were set aside.`],
    [true, 'Activities merged', () => `${fmtInt(Object.values(a.raw).reduce((x, y) => x + y, 0))} listed, ${fmtInt(a.merged)} kept. Two entries are one activity if they overlap for over half of the shorter one and neither is under 30% the length of the other, so a walk inside a long run stays separate. A fragment inside another app's run of the same type joins that run.${has('garmin') && has('strava') ? ` ${fmtInt(a.garminStrava)} were on both Garmin and Strava, and Strava supplies names, shoes and any activity type you corrected.` : ''}`],
    [has('garmin') && has('strava'), 'When apps disagree on distance', () => `Garmin's figure is used unless they differ by over 300 m, which happened ${a.distanceDisagreements.length} times. Treadmill runs keep Garmin's corrected distance. Outdoors, Strava's version is used, because it's usually a longer recording after the watch stopped early${long ? ` (${fmtDay(long.date)}: ${fmt1(long.garmin)} km on Garmin, ${fmt1(long.strava)} km on Strava)` : ''} or a corrected race distance.`],
    [a.syncedCopies > 0, 'Fitbit\'s copies', () => `${fmtInt(a.syncedCopies)} of Fitbit's "manual" workouts are Garmin or Strava activities, nearly all with the clock moved exactly ${a.clockShift} hours and the seconds zeroed. They match on start minute and duration. ${a.genuineManual} true manual entries remain.`],
    [has('strava') && has('garmin'), 'Kept from one app only', () => `${fmtInt(a.garminOnly)} activities exist only on Garmin, mostly short walks you didn't send to Strava, and ${fmtInt(a.stravaOnly)} only on Strava, including a canoe trip and uploaded runs.${has('fitbit') ? ` ${fmtInt(a.fitbitOnly)} are Fitbit activities from before the Garmin.` : ''}`],
    [d.weight.imports > 0, 'Weight', () => `${fmtInt(d.weight.imports)} Garmin rows before the switch were dropped: Fitbit imports stamped exactly midnight GMT, reading a default 120 lb, a day off, or interpolated.`],
    [d.fitFiles?.ignoredFitbitCsv > 0, 'Fitbit files inside Garmin', () => `Your Garmin archive holds ${d.fitFiles.ignoredFitbitCsv} re-uploaded Fitbit files. Almost all their activity rows read zero steps and their weights are the same placeholders, so they aren't used.`],
    [has('fitbit'), 'Fitbit sleep', () => `Fitbit's "minutes asleep" field is far too low on many nights, so its sleep is summed from stages, which matches the score file (median difference ${c.sleepStageVsScoreMedianDiffMin} min across ${fmtInt(c.sleepChecked)} nights).`],
    [has('garmin'), 'Garmin sleep', () => `Garmin's export has nightly stage totals only, without their timing. ${d.nightsSkipped} Garmin nights that were off-wrist, unconfirmed or under 3 hours are excluded.`],
    [has('garmin'), 'Garmin steps through the day', () => `Decoded from ${fmtInt(d.fitFiles.monitoring)} monitoring files, they match Garmin's own daily totals (median difference ${c.stepCheck.medianPct}% over ${fmtInt(c.stepCheck.days)} days).`],
    [d.segments.runs > 0, 'Pace within each run', () => `Pace, running heart rate and metres per heartbeat use each run minute by minute, from ${fmtInt(d.segments.runs)} outdoor ${main} runs, rather than one average per run. The first ${d.segments.rules.skipFirstMinutes} minutes of a run and the ${d.segments.rules.settleMinutes} minutes after any change of pace over ${Math.round(d.segments.rules.samePace * 100)}% are left out while heart rate catches up. Faster segments, such as interval reps, are found second by second: at least ${d.segments.rules.fasterMinSeconds} seconds at ${Math.round(d.segments.rules.fasterBy * 100)}% or more quicker than the easier side of that run, and close to its fastest stretch. Checked against 546 laps you marked by hand in 166 interval sessions, this finds about 9 in 10 reps, nearly all of those over a minute long, at a pace within 1% of your lap. A run held at one fast pace throughout, such as a race, counts as regular running, and heart rate on short reps reads low because heart rate lags pace. Treadmill runs are left out because their pace comes from the wrist, not GPS.`],
    [has('garmin'), 'Garmin calories', 'Activity "calories" in Garmin\'s export are 4.19× Strava\'s on every matched activity, because they\'re kilojoules. They\'re converted here.'],
    [true, 'Time zones', () => [
      has('fitbit') ? 'Fitbit\'s timestamps are UTC and shifted using the offsets stored with sleep stages.' : null,
      has('garmin') ? 'Garmin\'s use its daily local-time records.' : null,
      'A travel day can be off by a few hours.',
    ].filter(Boolean).join(' ')],
    [earlier, `Main chapters are ${main} only`, () => `From ${fmtDay(h)} one watch measured everything the same way, so those chapters and the year-over-year comparisons use only that. Weight and cycle dates aren't measured by a watch, so they keep their full history. ${earlier.label} data has its own chapter.`],
    [sickRanges().length > 0, 'Days you were sick', () => `${sickRanges().map((x) => `${fmtDay(x.from)} to ${fmtDay(x.to)}`).join('; ')}. Resting heart rate rose to 66 to 67 bpm and Body Battery stayed near empty. These days stay in the day view, calendars, sleep, steps and distance run, but are left out of heart-rate and stress averages, the improvement analysis, heart rate on runs, metres per heartbeat, the cycle analysis and the day-to-day links.`],
    [notWorn.length > 0, 'Days the watch wasn\'t worn', () => `${d.exclusions.filter((x) => (x.kind || 'not-worn') === 'not-worn').map((x) => `${fmtDay(x.from)} to ${fmtDay(x.to)}`).join('; ')}: the watch was on but not on your wrist, so its heart rate, steps, sleep and stress readings are ignored. Runs from those days are kept, since you carried it on them and wore a chest strap. The dates live in exclusions.json in the project folder, where you can add more.`],
    [has('garmin'), 'Resting heart rate', () => `Garmin's export has two resting fields. The one shown is each day's own reading. The other is a 7-day average, which lags and smears any bad day across the next week. ${fmtInt(d.rhrDropped)} daily readings were also dropped, on days with too little wear or reading over 15 bpm above that night's 3 to 5 AM rate.`],
    [has('fitbit') && c.swimLaps > 0, 'Swim laps ignored', () => `Fitbit lists ${fmtInt(c.swimLaps)} swim laps but only ${c.swimWorkouts} swim workouts, so the lap file looks like false detections from arm motion.`],
    [has('garmin') || has('strava'), 'Not used', () => `${[
      has('strava') ? 'Strava weather (on about a quarter of activities), kudos, comments, followers and photos' : null,
      has('garmin') ? 'Garmin golf and aviation folders; and Garmin nutrition, which has calories for only about ten days' : null,
    ].filter(Boolean).join('; ')}.`],
    [true, 'Heartbeats are an estimate', 'The total integrates minute-level readings across gaps of up to 2 minutes, so time off the wrist isn\'t counted.'],
  ].filter(([when]) => when).map(([, heading, body]) => [heading, typeof body === 'function' ? body() : body]);
  return chapter('notes', '16 · Data notes', 'How the record was merged and cleaned', null,
    el('div', { class: 'notes' }, items.map(([heading, b]) => el('details', { class: 'note' }, el('summary', { text: heading }), el('p', { text: b })))));
}

// ---------- day explorer ----------

function openDay(date) {
  const dialog = document.getElementById('dayDialog');
  hideTip();
  // Open first: the charts inside measure the dialog's width.
  if (!dialog.open) dialog.showModal();
  renderDay(dialog, date);
}

function randomDay() {
  const dates = data.hrGrid.dates.filter((d) => row(d)?.steps);
  openDay(dates[Math.floor(Math.random() * dates.length)]);
}

async function renderDay(dialog, date) {
  const r = row(date) || { date };
  const night = data.nights.find((n) => n.d === date);
  const workouts = data.workouts.filter((w) => w.d === date);
  const t = theme();
  const step = (n) => isoDay(dayMs(date) + n * DAY);
  const picker = el('input', { type: 'date', value: date, min: data.meta.firstDate, max: data.meta.lastDate, 'aria-label': 'Choose a date', onchange: (e) => { if (e.target.value) openDay(e.target.value); } });
  const watch = date < data.meta.trackerStart || date > data.meta.trackerEnd ? null : date < handover() ? 'Fitbit' : 'Garmin';
  const notWorn = data.meta.dedupe.exclusions.find((x) => (x.kind || 'not-worn') === 'not-worn' && date >= x.from && date <= x.to);
  const sickDay = isSick(date);

  const stats = [
    r.steps != null ? tile('Steps', fmtInt(r.steps)) : null,
    r.rhr != null ? tile('Resting HR', `${fmt1(r.rhr)}`, 'bpm') : null,
    r.hrMax != null ? tile('Peak HR', fmtInt(r.hrMax), 'bpm') : null,
    r.runKm ? tile('Run', `${fmt1(r.runKm)} km`) : null,
    r.active != null ? tile('Active', `${fmtInt(r.active)} min`) : null,
    night ? tile('Asleep', fmtDuration(night.asleep), night.score != null ? `score ${night.score}` : null) : null,
    r.stress != null ? tile('Stress', fmtInt(r.stress)) : null,
    r.battery != null ? tile('Body Battery', fmtInt(r.battery), 'peak') : null,
    r.weight != null ? el('div', { class: 'private' }, tile('Weight', `${fmt1(r.weight)} lb`)) : null,
  ].filter(Boolean);

  const hrHost = el('div', { class: 'fig-host' });
  const stepHost = el('div', { class: 'fig-host' });
  const stageHost = el('div', { class: 'fig-host' });

  dialog.replaceChildren(
    el('div', { class: 'day-head' },
      el('div', null,
        el('h3', { id: 'dayTitle', text: fmtFullDay(date) }),
        el('p', { text: notWorn ? 'Your watch wasn\'t on your wrist this day, so only activities are shown.' : sickDay ? `Recorded by your ${watch} watch. You were sick, so this day is left out of fitness trends and averages.` : watch ? `Recorded by your ${watch} watch.` : 'Outside the period either watch was recording.' })),
      el('div', { class: 'day-actions' },
        el('button', { type: 'button', text: '← Prev', onclick: () => openDay(step(-1)) }),
        el('button', { type: 'button', text: 'Next →', onclick: () => openDay(step(1)) }),
        picker,
        el('button', { type: 'button', text: 'Random', onclick: randomDay }),
        el('button', { type: 'button', text: 'Close', onclick: () => dialog.close() }))),
    stats.length ? el('div', { class: 'tiles' }, stats) : el('p', { class: 'empty', text: 'Nothing was recorded on this day.' }),
    hrHost, stepHost, stageHost,
    workouts.length ? el('div', { style: 'margin-top:14px' },
      el('div', { class: 'fig-title', text: 'Activities' }),
      el('ul', { class: 'day-list' }, workouts.map((w) => el('li', null,
        el('span', { text: `${w.name || w.type} at ${fmtClock(w.h * 60)}` }),
        el('span', { text: [fmtDuration(w.min), w.km ? `${fmt1(w.km)} km` : null, w.hr ? `${w.hr} bpm avg` : null, w.cal ? `${fmtInt(w.cal)} cal` : null, w.gear || null, [...w.src].map((s) => SOURCE_LETTER[s]).join(' + ')].filter(Boolean).join(' · ') }))))) : null);

  if (night) drawNightStrip(stageHost, night, dialog, t);
  if (date > data.meta.trackerEnd || date < data.meta.trackerStart) return;

  intradayPromise ||= fetch(`${dataDir}/intraday.json`).then((res) => res.json());
  const intraday = await intradayPromise;
  // The user may have moved on while the file was loading.
  if (dialog.querySelector('#dayTitle')?.textContent !== fmtFullDay(date)) return;
  const day = intraday[date];
  if (!day) return;
  const width = hrHost.clientWidth || 780;

  const hrPts = day.hr.map((v, i) => ({ x: i * 5, y: v || null }));
  if (hrPts.some((p) => p.y != null)) {
    hrHost.append(el('div', { class: 'fig-title', text: 'Heart rate' }));
    lineChart(hrHost, width, t, {
      series: [{ name: 'Heart rate', color: t.series[0], points: hrPts, tipFmt: (v) => `${v} bpm` }],
      xType: 'linear',
      xDomain: [0, 1440],
      height: 170,
      breakGap: 30,
      yFmt: (v) => `${Math.round(v)}`,
      xFmt: (x) => fmtClock(x),
      xTickList: [0, 6, 12, 18, 24].map((h) => ({ v: h * 60, label: fmtHourShort(h) })),
    });
  }
  if (day.steps?.some(Boolean)) {
    stepHost.append(el('div', { class: 'fig-title', text: 'Steps, every 15 minutes' }));
    const cats = day.steps.map((_, i) => i * 15);
    columnChart(stepHost, width, t, {
      categories: cats,
      series: [{ name: 'Steps', color: t.series[0], values: day.steps }],
      height: 110,
      yFmt: (v) => fmtCompact(v),
      catFmt: (m) => fmtClock(m),
      tickEvery: (m) => m % 360 === 0,
      tickFmt: (m) => fmtHourShort(m / 60),
    });
  }
}

function drawNightStrip(host, night, dialog, t) {
  const width = dialog.clientWidth - 48 || 780;
  host.append(el('div', { class: 'fig-title', text: `Sleep ending this morning: ${fmtClockFrom18(night.bed)} to ${fmtClockFrom18(night.wake)}` }));
  const bins = night.s.length;
  const height = 42;
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Light ${night.light} minutes, REM ${night.rem} minutes, deep ${night.deep} minutes, awake ${night.awake} minutes` });
  const bw = width / (bins || 1);
  for (let i = 0; i < bins; i++) {
    if (night.s[i] === '.') continue;
    root.append(svg('rect', { x: i * bw, y: 4, width: bw + 0.4, height: 20, fill: stageColor(t, night.s[i]) }));
  }
  root.append(svg('text', { x: 0, y: 38, class: 'axis-label', text: `Light ${fmtDuration(night.light)} · REM ${fmtDuration(night.rem)} · Deep ${fmtDuration(night.deep)} · Awake ${fmtDuration(night.awake)}${night.src === 'garmin' ? ' · stage timing not exported' : ''}` }));
  host.append(root);
}

// ---------- shell ----------

// What each chapter needs from the data. Exports differ: a watch without stress tracking, no Strava, no
// earlier watch to compare with. A chapter is built only when its data is there.
const hasDaily = (field, from = handover()) => data.daily.date.some((d, i) => d >= from && data.daily[field][i] != null);
const CHAPTER_NEEDS = {
  compare: () => hasDaily('steps'),
  life: () => lifeEvents().length > 0,
  running: () => garminRuns().length > 0,
  heart: () => hasDaily('rhr'),
  movement: () => hasDaily('steps'),
  workouts: () => data.workouts.length > 0,
  sleep: () => data.nights.length > 0,
  recovery: () => hasDaily('stress'),
  body: () => data.weight.length > 0,
  cycle: () => (data.cycles.iudDate ? data.cycles.rhrWith : data.cycles.rhrBefore).days.some((x) => x.n >= 15),
  links: () => data.correlations.length > 0,
  // Comparing two watches needs a switch between them.
  switch: () => data.switch != null,
  fitbit: () => data.switch != null,
  record: () => true,
  food: () => data.food.entries > 0,
  notes: () => true,
};

// The chapters are grouped into a few pages at /<page>, each a run of sections. The overview at / is the hero and a card per page.
const PAGES = [
  { id: 'trends', label: 'Trends', emoji: '📈', tone: 'blue', chapters: ['compare', 'life'] },
  { id: 'fitness', label: 'Fitness', emoji: '🏃', tone: 'orange', chapters: ['running', 'heart', 'workouts', 'movement'] },
  { id: 'sleep', label: 'Sleep and stress', emoji: '🌙', tone: 'purple', chapters: ['sleep', 'recovery', 'links'] },
  { id: 'body', label: 'Body', emoji: '🌱', tone: 'green', chapters: ['body', 'cycle', 'food'] },
  { id: 'data', label: 'About the data', emoji: '🗂️', tone: 'amber', chapters: ['switch', 'fitbit', 'record', 'notes'] },
];
const isPrivateChapter = (id) => Boolean(CHAPTERS.find((c) => c[0] === id)?.[2]);
const isPrivatePage = (page) => page.chapters.every(isPrivateChapter);
const pathFor = (page) => (page ? `/${page.id}` : '/');
const pageOfChapter = (id) => PAGES.find((p) => p.chapters.includes(id));
const hidingPrivate = () => document.body.classList.contains('hide-private');

// Reads the page from the address. A link from when each chapter had its own page, like /heart, goes to its section.
function pageFromPath() {
  const id = location.pathname.replace(/^\/+|\/+$/g, '');
  const page = PAGES.find((p) => p.id === id);
  if (page || !id) return page ?? null;
  const owner = pageOfChapter(id);
  if (owner) history.replaceState(null, '', `${pathFor(owner)}#${id}`);
  return owner ?? null;
}

let sections;
let home;

const chapterHeading = (id) => sections.get(id).querySelector('h2').textContent;
const chapterLabel = (id) => `${CHAPTER_EMOJI[id]} ${CHAPTERS.find((c) => c[0] === id)[1]}`;

// A small year-by-year column chart for a highlight card. Bars start at zero; the latest year is in color.
function yearBars(rows, fmt) {
  const w = 56;
  const h = 96;
  const top = 18;
  const max = Math.max(...rows.map((r) => r.v));
  const root = svg('svg', { class: 'year-bars', viewBox: `0 0 ${rows.length * w} ${h + 18}`, role: 'img', 'aria-label': rows.map((r) => `${r.label}: ${fmt(r.v)}`).join(', ') });
  rows.forEach((r, i) => {
    const bh = (r.v / max) * (h - top);
    const latest = i === rows.length - 1;
    root.append(svg('rect', { x: i * w + 8, y: h - bh, width: w - 16, height: bh, rx: 4, class: latest ? 'bar latest' : 'bar' }));
    root.append(svg('text', { x: i * w + w / 2, y: h + 14, 'text-anchor': 'middle', class: 'axis-label', text: r.label }));
    if (latest || i === 0) root.append(svg('text', { x: i * w + w / 2, y: h - bh - 5, 'text-anchor': 'middle', class: 'value-label', text: fmt(r.v) }));
  });
  return root;
}

// Two findings that cut across the record: running economy, and sleep and what it does to the next day.
function renderHighlights() {
  const card = (kicker, heading, body, chart, href, linkText, tone) => el('a', { class: 'highlight', href, 'data-tone': tone },
    el('span', { class: 'kicker', text: kicker }),
    el('span', { class: 'highlight-heading', text: heading }),
    el('span', { class: 'highlight-body', text: body }),
    chart,
    el('span', { class: 'highlight-link', text: `${linkText} →` }));
  const cards = [];
  // Each card needs at least two years to compare, and its chapter to link to.
  const byYear = sections.has('running') ? beatData().byYear : [];
  if (byYear.length > 1) {
    const first = byYear[0];
    const last = byYear.at(-1);
    const gain = (last.adjusted - first.adjusted) / first.adjusted;
    const fullList = data.prs.marathon || [];
    cards.push(card('🏃 Running economy',
      `Each heartbeat now carries you ${(gain * 100).toFixed(0)}% ${gain >= 0 ? 'further' : 'less far'}`,
      `Metres per beat at a 6:00/km pace.${fullList.length > 1 ? ` Marathon: ${fmtRace(fullList[0].sec)} → ${fmtRace(fullList.at(-1).sec)}.` : ''}`,
      yearBars(byYear.map((y) => ({ label: y.year, v: y.adjusted })), (v) => `${v.toFixed(2)} m`),
      '/fitness#running', 'See your running', 'orange'));
  }
  const same = sections.has('sleep') ? comparePeriods().same.periods : [];
  const sleepYears = same.map((p) => ({ label: p.label, v: periodStats(p).asleep })).filter((r) => r.v != null);
  if (sleepYears.length > 1) {
    const change = sleepYears.at(-1).v - sleepYears[0].v;
    const stressDays = data.daily.date.filter((d) => !isSick(d) && row(d).stress != null && row(d).sleepMin != null).map(row);
    const stressAfter = (test) => mean(stressDays.filter((r) => test(r.sleepMin)).map((r) => r.stress));
    const short = stressAfter((m) => m < 420);
    const long = stressAfter((m) => m >= 480);
    cards.push(card('😴 Sleep',
      `You sleep ${fmtDuration(Math.abs(change))} ${change >= 0 ? 'more' : 'less'} a night than in ${sleepYears[0].label}`,
      `Same ${comparePeriods().same.button} dates each year.${short != null && long != null ? ` Next-day stress: ${fmt1(short)} after under 7 hours, ${fmt1(long)} after 8 or more.` : ''}`,
      yearBars(sleepYears, (v) => fmtDuration(v)),
      '/sleep#sleep', 'See your sleep', 'purple'));
  }
  if (!cards.length) return null;
  return el('div', { class: 'highlights-wrap' },
    el('h2', { class: 'overview-heading', text: 'What stands out' }),
    el('div', { class: 'highlights' }, cards));
}

function renderHome() {
  return el('div', null,
    renderHero(),
    renderHighlights(),
    el('h2', { class: 'overview-heading', text: 'Explore' }),
    el('div', { class: 'page-cards' }, PAGES.map((page) => el('div', { class: `page-card${isPrivatePage(page) ? ' private' : ''}`, 'data-tone': page.tone },
      el('a', { class: 'page-card-title', href: pathFor(page), text: `${page.emoji} ${page.label}` }),
      el('ul', null, page.chapters.map((id) => el('li', { class: isPrivateChapter(id) ? 'private' : null },
        el('a', { href: `${pathFor(page)}#${id}` },
          el('span', { class: 'kicker', text: chapterLabel(id) }),
          el('span', { class: 'card-heading', text: chapterHeading(id) })))))))));
}

// The page opens with each chapter's headline, so its takeaways can be read before scrolling.
function pageHeader(page) {
  return el('header', { class: 'page-header' },
    el('h1', { text: `${page.emoji} ${page.label}` }),
    el('nav', { class: 'findings', 'aria-label': 'On this page' },
      el('div', { class: 'findings-label', text: 'On this page' }),
      el('ol', null, page.chapters.map((id) => el('li', { class: isPrivateChapter(id) ? 'private' : null },
        el('a', { href: `#${id}` },
          el('span', { class: 'kicker', text: chapterLabel(id) }),
          el('span', { class: 'finding', text: chapterHeading(id) })))))));
}

// Names the section in view next to the current page in the top bar, so it's clear where one chapter ends.
function updateCrumb() {
  const crumb = document.getElementById('crumb');
  const page = pageFromPath();
  let current = null;
  if (page) {
    for (const id of page.chapters) {
      const node = document.getElementById(id);
      if (node && node.offsetParent && node.getBoundingClientRect().top < 120) current = id;
    }
  }
  crumb.textContent = current ? chapterLabel(current) : '';
  crumb.hidden = !current;
}

// Previous and next skip the private page while it's hidden.
function pageNav(page) {
  const shown = PAGES.filter((p) => p === page || !(isPrivatePage(p) && hidingPrivate()));
  const i = shown.indexOf(page);
  const step = (p, dir) => (p
    ? el('a', { class: `page-step ${dir}`, href: pathFor(p) },
      el('span', { class: 'kicker', text: dir === 'prev' ? '← Previous' : 'Next →' }),
      el('span', { text: `${p.emoji} ${p.label}` }))
    : el('span'));
  return el('nav', { class: 'page-nav', 'aria-label': 'Previous and next page' }, step(shown[i - 1], 'prev'), step(shown[i + 1], 'next'));
}

function showPage({ scroll = true } = {}) {
  const page = pageFromPath();
  const app = document.getElementById('app');
  hideTip();
  if (page) {
    const note = isPrivatePage(page) ? el('p', { class: 'private-note', text: 'This page is private and hidden. Use "Show private" to see it.' }) : null;
    app.replaceChildren(...[
      el('div', { class: isPrivatePage(page) ? 'private' : null }, pageHeader(page), page.chapters.map((id) => sections.get(id))),
      note,
      pageNav(page),
    ].filter(Boolean));
  } else {
    home ||= renderHome();
    app.replaceChildren(home);
  }
  document.title = page ? `${page.label} · Fitness Analyzer` : 'Fitness Analyzer';
  // The page's tone colors its header, labels, tiles and dividers; the overview mixes all of them.
  if (page) document.body.dataset.tone = page.tone;
  else delete document.body.dataset.tone;
  document.querySelectorAll('#nav a').forEach((a) => {
    const current = a.dataset.page === (page?.id ?? '');
    a.classList.toggle('current', current);
    if (current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  redrawAll();
  const target = /^#([a-z]+)$/.exec(location.hash);
  if (target && sections.has(target[1]) && page?.chapters.includes(target[1])) document.getElementById(target[1]).scrollIntoView({ behavior: 'instant' });
  else if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
  updateCrumb();
}

function navigate(href) {
  const url = new URL(href);
  if (url.pathname + url.hash !== location.pathname + location.hash) history.pushState(null, '', url.pathname + url.hash);
  showPage();
}

function setupControls() {
  const nav = document.getElementById('nav');
  nav.append(
    el('a', { href: '/', text: 'Overview', 'data-page': '' }),
    ...PAGES.map((page) => el('a', { href: pathFor(page), text: `${page.emoji} ${page.label}`, 'data-page': page.id, 'data-tone': page.tone, class: isPrivatePage(page) ? 'private' : null })));
  nav.after(el('span', { id: 'crumb', hidden: true }));
  window.addEventListener('scroll', updateCrumb, { passive: true });

  // Links between pages swap the content in place instead of reloading the data.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
    e.preventDefault();
    navigate(a.href);
  });
  window.addEventListener('popstate', () => showPage());

  const privateBtn = document.getElementById('privateToggle');
  const setPrivate = (hidden) => {
    document.body.classList.toggle('hide-private', hidden);
    privateBtn.setAttribute('aria-pressed', String(hidden));
    privateBtn.textContent = hidden ? 'Show private' : 'Hide private';
    localStorage.setItem('hidePrivate', hidden ? '1' : '0');
  };
  privateBtn.title = 'Hides the weight, food and cycle chapters and the run location picture, for example when sharing your screen';
  setPrivate(localStorage.getItem('hidePrivate') === '1');
  privateBtn.addEventListener('click', () => {
    setPrivate(!hidingPrivate());
    // Redraws the page so previous and next follow the setting, and any figure that was hidden gets drawn.
    if (sections) showPage({ scroll: false });
  });

  document.getElementById('randomDay').addEventListener('click', randomDay);
  document.getElementById('dayDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
}

// The hosted copy (npm run build:site) keeps the data in a folder named after the password's hash,
// so the files can't be found without it. Locally the data stays in /generated.
let dataDir = '/generated';

const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

async function tryDataDir(dir) {
  const res = await fetch(`${dir}/summary.json`);
  // Unknown paths on the host fall back to index.html, so anything but JSON means a wrong password.
  return res.ok && (res.headers.get('Content-Type') || '').includes('json');
}

function unlock(app) {
  let saved = null;
  try { saved = sessionStorage.getItem('dataDir'); } catch {}
  return new Promise((resolve) => {
    const input = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password', required: true });
    const error = el('p', { class: 'lock-error', role: 'alert' });
    const form = el('form', { class: 'lock' },
      el('h1', { text: 'Fitness Analyzer' }),
      el('p', { text: 'Enter the password to continue.' }),
      input,
      el('button', { type: 'submit', text: 'Unlock' }),
      error);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const dir = `/${(await sha256(input.value)).slice(0, 32)}`;
      if (!(await tryDataDir(dir))) {
        error.textContent = 'Wrong password.';
        input.select();
        return;
      }
      try { sessionStorage.setItem('dataDir', dir); } catch {}
      resolve(dir);
    });
    const show = () => { app.replaceChildren(form); input.focus(); };
    if (saved) tryDataDir(saved).then((ok) => (ok ? resolve(saved) : show()), show);
    else show();
  });
}

async function main() {
  const app = document.getElementById('app');
  if (document.documentElement.hasAttribute('data-locked')) {
    dataDir = await unlock(app);
    document.documentElement.removeAttribute('data-locked');
    app.replaceChildren(el('p', { class: 'loading', text: 'Reading your data…' }));
  }
  try {
    const res = await fetch(`${dataDir}/summary.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    app.replaceChildren(el('p', { class: 'loading', text: `Couldn't load the generated data (${err.message}). Run "npm run build:data", then reload.` }));
    return;
  }
  byDate = indexDaily(data.daily);
  const renderers = {
    compare: renderCompare,
    life: renderLife,
    running: renderRunning,
    heart: renderHeart,
    movement: renderMovement,
    workouts: renderWorkouts,
    sleep: renderSleep,
    recovery: renderRecovery,
    body: renderBody,
    cycle: renderCycle,
    links: renderLinks,
    switch: renderSwitch,
    fitbit: renderFitbit,
    record: renderRecord,
    food: renderFood,
    notes: renderNotes,
  };
  // Every chapter is built once up front, so the overview can show each one's headline. Figures draw when their page is shown.
  // A chapter whose data the exports don't hold is left out, and so is one that fails anyway, so one
  // chapter's bug can't blank the whole site. Pages keep only the chapters that were built.
  sections = new Map();
  for (const [id] of CHAPTERS) {
    if (!CHAPTER_NEEDS[id]()) continue;
    try {
      sections.set(id, renderers[id]());
    } catch (err) {
      console.error(`Left out the ${id} chapter: ${err.stack}`);
    }
  }
  for (const page of PAGES) page.chapters = page.chapters.filter((id) => sections.has(id));
  PAGES.splice(0, PAGES.length, ...PAGES.filter((page) => page.chapters.length));
  setupControls();
  showPage({ scroll: false });
  const openLinkedDay = () => {
    const linked = /^#day=(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
    if (linked) openDay(linked[1]);
  };
  window.addEventListener('hashchange', openLinkedDay);
  openLinkedDay();
}

main();
