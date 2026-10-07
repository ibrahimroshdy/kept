#!/usr/bin/env node
// Kept's RTL rule: apps/web/src uses logical CSS only, so Arabic mirrors without overrides.
// Biome can't lint this, so this script does. It fails (exit 1) on:
//   - CSS properties that name a physical side: margin-left, padding-right, border-left,
//     left:, right:, text-align: left, float: right, ...
//   - the same in JS style objects: marginLeft, paddingRight, left:, right:, ...
//   - Tailwind utilities that name a physical side: ml-, pr-, left-, right-, border-l,
//     rounded-r, text-left, float-right, ...
// Use the logical forms instead: margin-inline-start / ms-, padding-inline-end / pe-,
// inset-inline-start / start-, border-s, rounded-e, text-start.
// A line that genuinely needs a physical side (a chart axis, say) can end with the comment
// `logical-css-ignore` and a reason.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = process.argv[2] ?? join(repo, 'apps/web/src');

const CSS_RULES = [
  /(?<![\w-])(margin|padding|border|scroll-margin|scroll-padding)-(left|right)(?![\w-])/,
  /(?<![\w-])(left|right)\s*:/,
  /(?<![\w-])(text-align|float|clear)\s*:\s*(left|right)\b/,
  /(?<![\w-])border-(top|bottom)-(left|right)-radius\b/,
];
const JS_RULES = [
  /\b(margin|padding|border|scrollMargin|scrollPadding)(Left|Right)\b/,
  /\bborder(Top|Bottom)(Left|Right)Radius\b/,
  /(?<![\w-])(left|right)\s*:/,
  /(?<![\w-])(textAlign|float)\s*:\s*['"](left|right)['"]/,
  /(?<![\w\-[/])-?(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-(?!to-)[\w[.]/,
  /(?<![\w-])(text-left|text-right|float-left|float-right|border-l|border-r)(?![\w-])/,
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

const problems = [];
for (const file of walk(root)) {
  const isCss = file.endsWith('.css');
  const isJs = /\.(tsx?|jsx?|mjs)$/.test(file) && !file.endsWith('.gen.ts');
  if (!isCss && !isJs) continue;
  const rules = isCss ? CSS_RULES : JS_RULES;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (isComment(line) || line.includes('logical-css-ignore')) return;
      for (const rule of rules) {
        const m = line.match(rule);
        if (m) {
          problems.push(
            `${relative(repo, file)}:${i + 1}: "${m[0].trim()}" is physical; use the logical form`,
          );
          break;
        }
      }
    });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `\n${problems.length} physical-direction style(s). Kept is RTL-ready: use logical properties.`,
  );
  process.exit(1);
}
console.log(`check-logical-css: ${relative(repo, root) || '.'} uses logical properties only.`);
