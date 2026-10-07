// O1: per group, the packages npm installed (from package-lock.json), each one's apparent size,
// and whether that exact name@version is already in Kept's pnpm-lock.yaml (so already in the
// image only if a runtime dependency pulls it; checked by hand for the matches).
//   node measure.mjs ../../../../../pnpm-lock.yaml
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const lock = readFileSync(process.argv[2], 'utf8');
for (const g of ['otel-min', 'otel-sdk-node', 'sentry', 'both', 'sentry-core', 'sentry-node10']) {
  const pl = JSON.parse(readFileSync(`${g}/package-lock.json`, 'utf8'));
  let total = 0, shared = 0; const sharedList = []; let count = 0;
  for (const [k, v] of Object.entries(pl.packages)) {
    if (!k.startsWith('node_modules/')) continue;
    let kb = 0;
    if (!existsSync(`${g}/${k}`)) continue; // optional dep for another platform: not installed
    kb = Number(execFileSync('du', ['-sk', '-A', `${g}/${k}`]).toString().split('\t')[0]); // optional dep for another platform: not installed
    // subtract nested node_modules (counted on their own)
    try { kb -= Number(execFileSync('sh', ['-c', `du -sk -A ${g}/${k}/node_modules 2>/dev/null | cut -f1`]).toString() || 0); } catch {}
    count++; total += kb;
    const name = k.slice(k.lastIndexOf('node_modules/') + 13);
    if (lock.includes(`'${name}@${v.version}'`) || lock.includes(`\n  ${name}@${v.version}:`)) { shared += kb; sharedList.push(`${name}@${v.version} ${kb}K`); }
  }
  console.log(`${g}: ${count} packages installed, ${(total/1024).toFixed(1)} MiB; already in Kept's lock: ${(shared/1024).toFixed(1)} MiB [${sharedList.join(', ')}]; new: ${((total-shared)/1024).toFixed(1)} MiB`);
}
