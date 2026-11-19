// Every export is read by one source module. A source turns its export's own files into the device-neutral
// records below, so the analysis in build.js never touches an export's layout. Supporting another
// watch brand means adding a module here that pushes the same records.
//
// Files are read through a folder (see lib/files.js), which is a folder on disk or a zip in the browser.
// A module exports `detect(folder)`, returning the path of its export inside the folder or null, and
// `open(folder, dir, platform)`, returning a Promise of the source below. `platform` decompresses:
// inflateRaw(bytes) and gunzip(bytes), each returning bytes or a Promise of them.
//
//
//   id, label           'garmin', 'Garmin'. The id is also the source tag on every record.
//   kind                'watch': worn all day. Each calendar day comes from exactly one watch: a watch owns
//                       the days from its firstDay until the next watch's firstDay, and the first watch also
//                       owns everything before it.
//                       'app': activities only (Strava). Never owns a day.
//   firstDay            Watch only: the first full day the watch itself recorded, as YYYY-MM-DD.
//   lastDay             Watch only, may be set by read(): the last day it recorded.
//   offsets             Watch only, optional: Map of date -> UTC offset in hours, wherever the export records
//                       the clock. The owner's offset wins on its days; any other source fills the gaps.
//   recordsTracks       True when the source's own activity files carry the route (see ctx.track), so a
//                       route re-hosted by an app isn't read again.
//   readRoute(file)     App only, optional: a Promise of the {lat, lon} of an activity's uploaded file, read
//                       on demand.
//   avatar              Optional: the path of a profile picture, shown on the overview.
//   checksResting       Watch only: its resting heart rate is dropped on days with little wear or far above
//                       the overnight rate (see build-data.mjs).
//   read(ctx)           Async. Pushes everything else through ctx, described below. Watches are read in the order
//                       they were worn, then apps.
//
// ctx gives a source the clock and the days it owns:
//   ctx.toLocal(t), ctx.dateOfLocal(local), ctx.offsetAt(t)     t is UTC milliseconds
//   ctx.owns(date)              whether this source is the watch for that local date
//   ctx.era                     { from, to } as YYYY-MM-DD; `to` is the next watch's first day, or null
//   ctx.excluded                the exclusions.json ranges (scripts/lib/exclusions.mjs)
//   ctx.firstHrMs()             the earliest heart-rate minute kept so far
//
// and takes records. Anything a source doesn't push is simply missing, and the chapters built on it are left out.
//   ctx.hr(t, bpm)              all-day heart rate. Kept on owned days only.
//   ctx.activityHr(t, bpm)      heart rate recorded during an activity; fills minutes the all-day record lacks.
//   ctx.steps(t, n)             steps taken in the interval ending at t.
//   ctx.stress(t, level)        all-day stress, 1 to 100.
//   ctx.day(date, fields)       one day's summary: steps, distM, active (minutes), cal, rhr, climbM, stress,
//                               battery, resp. Owned days only; skipped on days the watch wasn't worn.
//   ctx.estimate(date, fields)  a value the watch estimates now and then (vo2, vo2g). Owned days only.
//   ctx.night(n)                a night's sleep, by the date it ends: { date, start, end (local ms), asleep,
//                               deep, rem, light, awake (minutes), score, stages: [{ type, a, b }] or null }.
//   ctx.activity(a)             an activity summary: { start, end (UTC ms), timerMin, offset, type, indoor,
//                               km, avgHr, maxHr, calories, gainM, steps, name, ... }. maybeCopy marks a
//                               manually logged entry that may be another source's activity with a shifted
//                               clock; hrFromTimeline fills missing heart rate from the all-day record.
//   ctx.track(track)            a recorded activity from a FIT file (scripts/lib/fit-activity.mjs).
//   ctx.route(route)            a GPS outing with no recorded activity: { lat, lon, start, end }.
//   ctx.weight(date, lb)
//   ctx.cycle(c), ctx.birthControl(date)
//   ctx.food(entry), ctx.drink(date, ml)
//   ctx.personalRecord(key, t, sec, current), ctx.stepRecord(value)
//   ctx.note(key, value)        counts and checks shown in the Data notes chapter.
//   ctx.progress(label, share)  how far a long read has got, share from 0 to 1, for a progress bar.
import * as fitbit from './fitbit.js';
import * as garmin from './garmin.js';
import * as strava from './strava.js';

const MODULES = [fitbit, garmin, strava];

export async function openSources(folder, platform) {
  const sources = [];
  for (const m of MODULES) {
    const dir = m.detect(folder);
    if (dir != null) sources.push(await m.open(folder, dir, platform));
  }
  return sources;
}
