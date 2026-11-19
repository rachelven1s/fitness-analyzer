// Strava, from a Strava bulk export: data/strava*. Activities only; Strava never owns a day.
import { parseCsvText, readText, decodeText, findFolder, join } from '../lib/files.js';
import { fitRoute } from '../lib/fit-activity.js';
import { normalizeType } from '../lib/dedupe.js';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

export function detect(folder) {
  const dir = findFolder(folder, '', 'strava');
  return dir && folder.exists(join(dir, 'activities.csv')) ? dir : null;
}

export async function open(folder, dir, platform) {
  const avatar = join(dir, 'profile.jpg');
  return {
    id: 'strava',
    label: 'Strava',
    kind: 'app',
    // The profile picture greets you on the overview. Only the image is copied; the rest of the profile isn't read.
    avatar: folder.exists(avatar) ? avatar : null,
    // An activity's uploaded file, for activities that exist only on Strava.
    async readRoute(file) {
      const full = join(dir, file);
      if (!folder.exists(full)) return null;
      let buf = await folder.read(full);
      if (file.endsWith('.gz')) buf = await platform.gunzip(buf);
      if (/\.fit(\.gz)?$/.test(file)) {
        const route = fitRoute(buf);
        return route.lat.length ? route : null;
      }
      const lat = [];
      const lon = [];
      const text = decodeText(buf);
      const pattern = /\.gpx/.test(file)
        ? /lat="(-?[\d.]+)"\s+lon="(-?[\d.]+)"/g
        : /<LatitudeDegrees>(-?[\d.]+)<\/LatitudeDegrees>\s*<LongitudeDegrees>(-?[\d.]+)<\/LongitudeDegrees>/g;
      for (const m of text.matchAll(pattern)) { lat.push(+m[1]); lon.push(+m[2]); }
      return lat.length ? { lat, lon } : null;
    },
    async read(ctx) {
      const rows = parseCsvText(await readText(folder, join(dir, 'activities.csv')));
      const head = rows[0];
      // Strava's header repeats names: the second "Distance" is metres and the first is display units.
      const col = (name, nth = 0) => {
        let seen = 0;
        for (let i = 0; i < head.length; i++) {
          if (head[i] === name && seen++ === nth) return i;
        }
        throw new Error(`Strava column not found: ${name}`);
      };
      const C = {
        date: col('Activity Date'), name: col('Activity Name'), type: col('Activity Type'),
        elapsed: col('Elapsed Time', 1), moving: col('Moving Time'), metres: col('Distance', 1),
        gear: col('Activity Gear'), file: col('Filename'), gain: col('Elevation Gain'),
        maxHr: col('Max Heart Rate', 0), avgHr: col('Average Heart Rate'), calories: col('Calories'),
        effort: col('Relative Effort', 0), steps: col('Total Steps'),
      };
      for (const r of rows.slice(1)) {
        if (r.length <= C.calories) continue;
        const start = Date.parse(`${r[C.date]} UTC`);
        const elapsed = num(r[C.elapsed]) ?? 0;
        const metres = num(r[C.metres]);
        ctx.activity({
          start,
          end: start + elapsed * 1000,
          timerMin: (num(r[C.moving]) ?? elapsed) / 60,
          offset: null,
          type: normalizeType(r[C.type]),
          indoor: /treadmill/i.test(r[C.name]),
          km: metres ? metres / 1000 : null,
          avgHr: num(r[C.avgHr]),
          maxHr: num(r[C.maxHr]),
          calories: num(r[C.calories]) || null,
          gainM: num(r[C.gain]),
          steps: num(r[C.steps]) || null,
          name: r[C.name] || null,
          gear: r[C.gear] || null,
          effort: num(r[C.effort]),
          file: r[C.file] || null,
        });
      }
    },
  };
}
