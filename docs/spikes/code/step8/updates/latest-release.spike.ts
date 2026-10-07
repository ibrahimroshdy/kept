/**
 * U1 (step-8 T0b): GitHub's "latest release" request, sent through Kept's own guardedFetch
 * (apps/server/src/net/ssrf.ts) exactly as T11 would send it. No token. Prints status, the
 * x-ratelimit-* headers and the fields T11 stores.
 *
 *   export PATH=/opt/homebrew/opt/node@24/bin:$PATH
 *   cd apps/server && pnpm exec tsx ../../docs/spikes/code/step8/updates/latest-release.spike.ts [owner/repo ...]
 */
import { guardedFetch } from '../../../../../apps/server/src/net/ssrf.ts';

const fetchGuarded = guardedFetch({ allowPrivate: false });
const repos = process.argv.slice(2);
if (repos.length === 0) repos.push('restic/restic');

for (const repo of repos) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const t0 = performance.now();
  try {
    const res = await fetchGuarded(url, {
      headers: {
        'User-Agent': 'Kept',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    const rate = Object.fromEntries(
      [...res.headers].filter(([k]) => k.startsWith('x-ratelimit-') || k === 'x-github-api-version-selected'),
    );
    const pick = res.ok
      ? { tag_name: body.tag_name, html_url: body.html_url, draft: body.draft, prerelease: body.prerelease, published_at: body.published_at }
      : body;
    console.log(JSON.stringify({ repo, status: res.status, ms: Math.round(performance.now() - t0), bytes: text.length, rate, body: pick }));
  } catch (e) {
    console.log(JSON.stringify({ repo, error: String(e), cause: String((e as { cause?: unknown }).cause ?? '') }));
  }
}
