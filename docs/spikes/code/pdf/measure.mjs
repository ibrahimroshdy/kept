// Runs one engine script as a child process and samples the RSS of its whole process tree
// (Chromium is several processes) from /proc every 20 ms. Linux only: run it in the container.
// Usage: node measure.mjs <script.mjs> [args...]   ->  one JSON line with wall ms and peak RSS
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

function tree(root) {
  const kids = new Map();
  for (const p of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const ppid = readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1];
      kids.set(ppid, [...(kids.get(ppid) ?? []), p]);
    } catch {}
  }
  const out = [];
  const walk = (p) => { out.push(p); (kids.get(p) ?? []).forEach(walk); };
  walk(String(root));
  return out;
}
const rssKb = (p) => {
  try { return Number(readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]); } catch { return 0; }
};

const t0 = performance.now();
const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (b) => { out += b; });
let peak = 0;
let peakProcs = 0;
const timer = setInterval(() => {
  const ps = tree(child.pid);
  const sum = ps.reduce((a, p) => a + rssKb(p), 0);
  if (sum > peak) { peak = sum; peakProcs = ps.length; }
}, 20);
child.on('exit', (code) => {
  clearInterval(timer);
  console.log(JSON.stringify({ script: process.argv.slice(2).join(' '), code, wallMs: Math.round(performance.now() - t0), peakRssMb: Math.round(peak / 1024), peakProcs, lines: out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return l; } }) }));
});
