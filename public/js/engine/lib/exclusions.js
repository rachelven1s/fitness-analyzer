// Stretches to treat specially, from exclusions.json. Two kinds:
// - "not-worn" (the default): the watch was on but not on the wrist. Activities are kept, and everything
//   measured from the wrist (heart rate, steps, sleep, stress) is ignored.
// - "sick": the data is real and stays in the record, but is kept out of fitness trends.

const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);

export function makeExclusions(ranges) {
  for (const r of ranges) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to) || r.from > r.to || !['not-worn', 'sick', undefined].includes(r.kind)) {
      throw new Error(`Bad exclusion range: ${JSON.stringify(r)}`);
    }
  }
  const notWorn = ranges.filter((r) => (r.kind || 'not-worn') === 'not-worn');
  const sickRanges = ranges.filter((r) => r.kind === 'sick');
  return {
    ranges,
    // Daytime and all-day data, by local date.
    day: (date) => notWorn.some((r) => date >= r.from && date <= r.to),
    // A night belongs to the morning it ends. The night before the first day was still worn,
    // and the night after the last day is when the watch went back on.
    night: (wakeDate) => notWorn.some((r) => wakeDate >= nextDay(r.from) && wakeDate <= r.to),
    sick: (date) => sickRanges.some((r) => date >= r.from && date <= r.to),
  };
}
