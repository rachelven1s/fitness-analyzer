# Fitness Analyzer

A visual story of the fitness exports in `data/`: Fitbit (Google Takeout), Garmin and Strava, merged into one record with the duplicates removed.

The main chapters and year-over-year comparisons use only the Garmin years, when one watch measured everything the same way. The Fitbit years and what changed at the switch have their own chapters.

```sh
npm start            # http://127.0.0.1:4173 (builds the data on first run, about 10 seconds)
npm run build:data   # rebuild after changing anything in data/
npm test             # the deduplication rules
SITE_PASSWORD=... npm run build:site   # a password-gated copy in site/ for hosting
```

Needs Node 18 or newer and has no dependencies. FIT and zip files are read by small parsers in `public/js/engine/lib/`; the analysis in `public/js/engine/` runs in Node (`npm run build:data`) and in the browser.

Expected layout: `data/Takeout/`, `data/garmin*/` and `data/strava*/`.

Optional, both git-ignored: `events.json` marks life events on the charts, and `exclusions.json` lists days the watch wasn't worn or you were sick. Copy `events.example.json` and `exclusions.example.json` to start.

**How duplicates are handled** (`public/js/engine/lib/dedupe.js`):

- Each calendar day's heart rate, steps and sleep come from one watch: Fitbit before the first full Garmin day, Garmin after.
- Activities that overlap across apps become one. Garmin figures win, and Strava supplies names and shoes.
- Fitbit's "manual" workouts that are clock-shifted copies of Garmin or Strava activities fold into the original.
- Weights are one per day, without Fitbit values imported into Garmin. Cycles merge by start date.

The Data notes chapter in the app lists every decision with its counts.

**Privacy:** the server binds to `127.0.0.1` and serves only `public/`. The page makes no outside requests. `public/generated/` still holds personal health data, so it and `data/` are git-ignored. Logins, social data, profile files and photos are never read, except Strava's `profile.jpg`, which is copied as-is for the overview. GPS is reduced to relative shapes and density grids with no coordinates, though street patterns can still identify a place. The chapters are grouped into pages (`/trends`, `/fitness`, `/sleep`, `/body`, `/data`), with `/` as the overview, and `/fitness#heart` links to a section. Add `#day=YYYY-MM-DD` to any page's URL to open a specific day.
