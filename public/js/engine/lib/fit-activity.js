// Reads a recorded activity out of a FIT file: its sport, the second-by-second distance and heart rate, and
// the GPS track. FIT is the format every watch brand exports activities in, so this is shared by any source.
import { decodeFit, fitTimeToMs } from './fit.js';

const degrees = (semicircles) => (semicircles * 180) / 2147483648;
export const ACTIVITY_FILE = 4;
export const ACTIVITY_MESSAGES = [0, 18, 20]; // file id, session, record

// Collects one activity file's messages as they are decoded, for callers that decode a file once for
// several purposes. `onHr(t, bpm)` sees every heart-rate reading, including those without distance.
export function activityCollector({ onHr } = {}) {
  const track = { lat: [], lon: [], times: [], lastT: 0, recs: [], sport: null };
  return {
    track,
    message(global, f, compressedTs) {
      if (global === 18) {
        track.sport = f[5];
        track.subSport = f[6];
        if (f[2] != null) track.start = fitTimeToMs(f[2]);
      } else if (global === 20) {
        const ts = f[253] ?? compressedTs;
        if (ts == null) return;
        const t = fitTimeToMs(ts);
        // Distance is in centimetres; kept for minute-by-minute pace within the run.
        if (f[5] != null) track.recs.push({ t, dist: f[5] / 100, hr: f[3] || null });
        if (f[3] && onHr) onHr(t, f[3]);
        if (f[0] != null && f[1] != null && t - track.lastT >= 5000) {
          track.lat.push(degrees(f[0]));
          track.lon.push(degrees(f[1]));
          track.times.push(t);
          track.lastT = t;
        }
      }
    },
  };
}

// Just the GPS points of a FIT file, for an app that only re-hosts the route.
export function fitRoute(buf) {
  const lat = [];
  const lon = [];
  decodeFit(buf, (g, f) => {
    if (g === 20 && f[0] != null && f[1] != null) { lat.push(degrees(f[0])); lon.push(degrees(f[1])); }
  }, new Set([20]));
  return { lat, lon };
}
