#!/usr/bin/env node
// Release versions and image tags (step 8 T17; D186, D187, plan Q14).
//
//   node scripts/release/version.mjs check <version> [existing v-tags...]   exit 1 unless newer
//   node scripts/release/version.mjs tags <version> [existing v-tags...]    the image tags, one a line
//   node scripts/release/version.mjs last [existing v-tags...]              the newest tag, or nothing
//   node scripts/release/version.mjs dry-run [existing v-tags...]           a version for a dry run
//   node scripts/release/version.mjs unsigned <version>                      exit 1 unless it may ship unsigned
//
// A version is semver 2.0 without build metadata (an image tag can't hold `+`). The image always
// gets `X.Y.Z`; `X.Y` and `X` only when this is a final release and the newest of that line, so a
// patch to an old line never moves the newer line's tags. A prerelease gets its exact tag only,
// so a release candidate never moves a floating tag. Never `latest` (Q14).

import { pathToFileURL } from 'node:url';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/** @returns {{major:number, minor:number, patch:number, pre:string[]} | null} */
export function parse(version) {
  const m = SEMVER.exec(version);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function compareIds(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: negative, zero or positive. */
export function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return Math.sign(x[k] - y[k]);
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const c = compareIds(x.pre[i], y.pre[i]);
    if (c) return c;
  }
  return 0;
}

/** The versions behind `v*` tags; tags that aren't versions are ignored. */
export function versionsOf(tags) {
  return tags
    .map((t) => t.trim())
    .filter((t) => t.startsWith('v') && parse(t.slice(1)))
    .map((t) => t.slice(1));
}

/** The newest existing version, or null. */
export function newest(tags) {
  const vs = versionsOf(tags);
  return vs.length ? vs.reduce((a, b) => (compare(a, b) >= 0 ? a : b)) : null;
}

/** null when `version` may be released after `tags`, else the reason it may not. */
export function refusal(version, tags) {
  if (!parse(version)) {
    return `'${version}' is not a release version: X.Y.Z or X.Y.Z-<prerelease>, no leading v, no +build`;
  }
  const last = newest(tags);
  if (last && compare(version, last) <= 0) return `${version} is not newer than v${last}`;
  return null;
}

/** The image tags for `version`, given the releases that exist. */
export function imageTags(version, tags) {
  const v = parse(version);
  if (!v) throw new Error(`not a version: ${version}`);
  const out = [version];
  if (v.pre.length) return out;
  const finals = versionsOf(tags)
    .map(parse)
    .filter((x) => !x.pre.length);
  const newerIn = (same) => finals.some((x) => same(x) && compare(x, v) > 0);
  if (!newerIn((x) => x.major === v.major && x.minor === v.minor))
    out.push(`${v.major}.${v.minor}`);
  if (!newerIn((x) => x.major === v.major)) out.push(`${v.major}`);
  return out;
}

/**
 * null when `version` may be released unsigned (KEPT_RELEASE_UNSIGNED=1), else the reason it may
 * not. Before 1.0 (and a 1.0 prerelease) a release may go out unsigned while no cosign key exists;
 * 1.0.0 and every final release after it must be signed.
 */
export function unsignedRefusal(version) {
  const v = parse(version);
  if (!v) return `not a version: ${version}`;
  if (v.major >= 1 && !v.pre.length) {
    return `${version} must be signed: an unsigned release (KEPT_RELEASE_UNSIGNED=1) is for prereleases and versions below 1.0.0 only`;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'check') {
    const why = refusal(rest[0] ?? '', rest.slice(1));
    if (why) {
      console.error(why);
      process.exit(1);
    }
  } else if (cmd === 'tags') {
    const why = parse(rest[0] ?? '') ? null : `not a version: ${rest[0]}`;
    if (why) {
      console.error(why);
      process.exit(1);
    }
    for (const t of imageTags(rest[0], rest.slice(1))) console.log(t);
  } else if (cmd === 'unsigned') {
    const why = unsignedRefusal(rest[0] ?? '');
    if (why) {
      console.error(why);
      process.exit(1);
    }
  } else if (cmd === 'dry-run') {
    // A version for a dry run, newer than every tag: the next patch, as a prerelease.
    const last = parse(newest(rest) ?? '0.0.0');
    console.log(
      `${last.major}.${last.minor}.${last.patch + 1}-dry.${Math.floor(Date.now() / 1000)}`,
    );
  } else if (cmd === 'last') {
    const last = newest(rest);
    if (last) console.log(`v${last}`);
  } else {
    console.error(
      'usage: version.mjs check|tags <version> [tags...] | unsigned <version> | last|dry-run [tags...]',
    );
    process.exit(2);
  }
}
