// Step-4 spike T0 (V21): a zone's offset changes in a year, from the tz data Node carries.
// Run: node transitions.mjs [zone] [year]   (default Africa/Cairo 2026)
const zone = process.argv[2] ?? 'Africa/Cairo';
const year = Number(process.argv[3] ?? 2026);
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
const off = (t) => fmt.formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName').value;
const wall = new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'short', timeStyle: 'long' });
let prev = off(Date.UTC(year, 0, 1));
for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 15 * 60e3) {
  if (off(t) === prev) continue;
  let lo = t - 15 * 60e3;
  let hi = t;
  while (hi - lo > 1000) {
    const m = Math.floor((lo + hi) / 2);
    if (off(m) === prev) lo = m;
    else hi = m;
  }
  console.log(new Date(hi).toISOString(), prev, '->', off(hi), '| before:', wall.format(new Date(hi - 1000)), '| at:', wall.format(new Date(hi)));
  prev = off(hi);
}
console.log('node', process.version, 'icu', process.versions.icu, 'tz', process.versions.tz);
