/**
 * The step-7 mock answers the portability contract through the real fetchers (../queries.ts), so
 * the parallel web tasks (T19–T24) start from something that behaves like the server: every path
 * in ../paths.ts has a handler, the fixtures hold what the plan's T3 asks for, and the rules the
 * screens lean on (roles, the module, If-Match, the passphrase, undo) hold.
 */
import { ARCHIVE_ISSUE_CODES, HB_ISSUE_CODES } from '@kept/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoApi } from '@/components/history/undo';
import { CAPTURE_IDS } from '../../capture/mock/state';
import { captureApi } from '../../capture/queries';
import { type ApiError, isApiError } from '../../client';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { IDS, type MockState, memberScenario, ownerScenario } from '../../mock/fixtures';
import { createMockApi, type MockApi } from '../../mock/server';
import { PORTABILITY_METHODS, portabilityPaths } from '../paths';
import { portabilityApi as api } from '../queries';
import { portabilityMockRoutes } from '.';
import { PORTABILITY_IDS as P, sizeFieldId } from './state';

let mock: MockApi;
const use = (state: MockState = ownerScenario()) => {
  mock = createMockApi(state);
  vi.stubGlobal('fetch', mock.fetch);
  return state;
};
beforeEach(() => use());
afterEach(() => vi.unstubAllGlobals());

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};
const SHA = 'e'.repeat(64);
/** Turns Consumables off in Home, where the fixtures turn it on (T23). */
const consumablesOff = (state: MockState) => {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (!home) throw new Error('no Home');
  home.modules = home.modules.filter((m) => m !== 'consumables');
  if (home.effectiveModules)
    home.effectiveModules = home.effectiveModules.filter((m) => m !== 'consumables');
};

describe('the portability mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = portabilityMockRoutes(ownerScenario());
    const matches = (template: string, path: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((part) => (part.startsWith('%3A') ? '[^/]+' : part.replace(/\./g, '\\.')))
          .join('/')}$`,
      ).test(path);
    const missing: string[] = [];
    for (const [key, methods] of Object.entries(PORTABILITY_METHODS)) {
      if (key === 'thingsCsv') continue; // a download link (T16), never fetched as JSON
      const v = portabilityPaths[key as keyof typeof portabilityPaths] as
        | string
        | ((...args: string[]) => string);
      const path = typeof v === 'string' ? v : v('a');
      for (const method of methods) {
        if (!routes.some((r) => r.method === method && matches(r.template, path)))
          missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('archive imports', () => {
  it('the Homebox fixture: checked, with a report carrying every archive and hb_ issue', async () => {
    const run = await api.archiveRun(P.homeboxRun);
    expect(run).toMatchObject({ source: 'homebox_zip', status: 'checked', locationId: IDS.home });
    const codes = run.report?.rows.flatMap((r) => r.issues.map((i) => i.code)) ?? [];
    expect([...new Set(codes)].sort()).toEqual([...ARCHIVE_ISSUE_CODES, ...HB_ISSUE_CODES].sort());
    expect(run.report?.rows.every((r) => r.ref.name)).toBe(true);
  });

  it('declares, uploads, inspects, targets a new location, dry-runs and runs a Kept export', async () => {
    const id = '01926f00-0000-7000-8000-0000000d7999';
    const draft = await api.createArchiveImport({
      id,
      source: 'kept_zip',
      bytes: 1000,
      sha256: SHA,
    });
    expect(draft).toMatchObject({ status: 'draft', locationId: null, archiveReadyAt: null });
    // Dry-running before the target is refused.
    expect((await fail(api.archiveDryRun(id))).code).toBe('import_target_needed');
    const bad = await api.putArchive(id, new Blob(['PK']), 'f'.repeat(64));
    expect(bad.status).toBe(400);
    const ok = await api.putArchive(id, new Blob(['PK']), SHA);
    expect(((await ok.json()) as { archiveReadyAt: string | null }).archiveReadyAt).not.toBeNull();
    const inspect = await api.inspect(id);
    expect(inspect.source).toBe('kept_zip');
    // A Kept export goes only into a new location (plan Q8).
    expect((await fail(api.setTarget(id, { locationId: IDS.home }))).code).toBe('validation');
    const targeted = await api.setTarget(id, {
      newLocation: {
        name: 'Home (moved)',
        kind: 'apartment',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
      },
    });
    expect(targeted.locationId).not.toBeNull();
    const { report } = await api.archiveDryRun(id);
    expect(report.source).toBe('kept_zip');
    await captureApi.runImport(id);
    let run = await api.archiveRun(id);
    for (let i = 0; i < 5 && run.status === 'running'; i++) run = await api.archiveRun(id);
    expect(run.status).toBe('done');
    const estimate = await api.enrichEstimate(id);
    expect(estimate).toMatchObject({
      calls: Math.ceil(estimate.things / 20),
      costSource: 'price_table',
    });
  });

  it('refuses an archive over the upload cap, and a hostile one on inspect', async () => {
    expect(
      (
        await fail(
          api.createArchiveImport({
            id: 'x',
            source: 'homebox_zip',
            bytes: 5 * 1024 ** 3 + 1,
            sha256: SHA,
          }),
        )
      ).code,
    ).toBe('archive_too_large');
    const id = '01926f00-0000-7000-8000-0000000d7998';
    const sha = `bad${'0'.repeat(61)}`;
    await api.createArchiveImport({ id, source: 'homebox_zip', bytes: 10, sha256: sha });
    await api.putArchive(id, new Blob(['PK']), sha);
    const e = await fail(api.inspect(id));
    expect(e.code).toBe('archive_invalid');
    expect((await api.archiveRun(id)).status).toBe('failed');
  });

  it('checks the passphrase, and counts wrong tries', async () => {
    expect((await fail(api.importPassphrase(P.keptRun, 'not the one at all'))).code).toBe(
      'passphrase_wrong',
    );
    const run = await api.importPassphrase(P.keptRun, P.passphrase);
    expect(run.secrets).toEqual({ present: true, unlocked: true });
  });

  it('connects to Homebox for the version, currency and members; a private address needs the setting', async () => {
    const c = await api.homeboxConnect(P.homeboxRun, {
      baseUrl: 'https://homebox.example',
      apiKey: 'hb_x',
    });
    expect(c).toMatchObject({ version: 'v0.26.2', collections: [{ currency: 'USD' }] });
    const e = await fail(
      api.homeboxConnect(P.homeboxRun, { baseUrl: 'http://192.168.1.20:7745', apiKey: 'hb_x' }),
    );
    expect(e.code).toBe('private_address');
  });

  it("still answers step 3's CSV runs through the shared routes", async () => {
    const run = await captureApi.importRun(CAPTURE_IDS.importRun.done);
    expect(run.source).toBe('csv');
    const list = await captureApi.imports();
    const sources = new Set(list.items.map((r) => r.source as string));
    expect(sources).toEqual(new Set(['csv', 'homebox_zip', 'kept_zip']));
  });
});

describe('exports', () => {
  it('holds one of each state, and a download URL only while done and unexpired', async () => {
    const page = await api.exports();
    const byId = new Map(page.items.map((r) => [r.id, r]));
    expect(byId.get(P.export.queued)?.status).toBe('queued');
    expect(byId.get(P.export.running)?.status).toBe('running');
    expect(byId.get(P.export.failed)).toMatchObject({ status: 'failed', error: 'no_space' });
    expect(byId.get(P.export.done)?.fileUrl).toBeTruthy();
    const expired = byId.get(P.export.expired);
    expect(expired?.status).toBe('expired');
    expect(expired?.fileUrl).toBeUndefined();
  });

  it('secrets are the owner’s and need the passphrase twice; one export at a time per location', async () => {
    mock.state.me.instance.recoveryKitAcknowledged = true;
    const weak = await fail(
      api.createExport({
        scope: { locationId: IDS.garage },
        includeSecrets: true,
        passphrase: 'short',
        passphraseAgain: 'short',
      }),
    );
    expect(weak.code).toBe('passphrase_weak');
    // Home has a queued export in the fixtures.
    expect((await fail(api.createExport({ scope: { locationId: IDS.home } }))).code).toBe(
      'export_running',
    );
    await api.cancelExport(P.export.running);
    const run = await api.createExport({
      scope: { locationId: IDS.garage },
      includeSecrets: true,
      passphrase: P.passphrase,
      passphraseAgain: P.passphrase,
    });
    expect(run).toMatchObject({ status: 'queued', includesSecrets: true });
  });

  it('a member can export their own data, not the location', async () => {
    use(memberScenario());
    expect((await fail(api.createExport({ scope: { locationId: IDS.home } }))).code).toBe(
      'forbidden',
    );
    expect((await api.createExport({ scope: { me: true } })).scope).toBe('me');
  });
});

describe('consumables', () => {
  it('off in a location: 404 on the list and the rule, 409 on a write', async () => {
    consumablesOff(mock.state);
    // The rule's 404 reads as none.
    expect(await api.stockRule(INV_IDS.thing.batteries)).toBeNull();
    expect((await fail(api.consumables({ locationId: IDS.home }))).code).toBe('not_found');
    expect(
      (await fail(api.putStockRule(INV_IDS.thing.batteries, { minQuantity: 4 }, 1))).code,
    ).toBe('module_off');
  });

  it('reads a thing’s rule, and none as null', async () => {
    expect(await api.stockRule(INV_IDS.thing.batteries)).toMatchObject({
      minQuantity: 16,
      rowVersion: 1,
    });
    expect(await api.stockRule(INV_IDS.thing.kettle)).toBeNull();
  });

  it('lists the AA batteries as low, adjusts them with undo, and refuses a non-consumable', async () => {
    const page = await api.consumables({ locationId: IDS.home, state: 'low' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ minQuantity: 16, low: true, thing: { quantity: 12 } });
    const t = mock.state.inventory.things.find((x) => x.id === INV_IDS.thing.batteries);
    const adjusted = await api.adjust(INV_IDS.thing.batteries, { delta: 4 }, t?.rowVersion ?? 0);
    expect(adjusted.body.quantity).toBe(16);
    expect((await api.consumables({ locationId: IDS.home, state: 'low' })).items).toHaveLength(0);
    await undoApi.undo(adjusted.auditEvents[0] ?? '');
    expect((await api.consumables({ locationId: IDS.home, state: 'low' })).items).toHaveLength(1);
    const kettle = await fail(api.putStockRule(INV_IDS.thing.kettle, { minQuantity: 1 }));
    expect(kettle.code).toBe('not_consumable');
  });
});

describe('field conversion', () => {
  it('previews across Home and Garage, counts only', async () => {
    const id = sizeFieldId(mock.state);
    const preview = await api.convertPreview(id, { kind: 'number' });
    const byName = Object.fromEntries(preview.locations.map((l) => [l.name, l]));
    expect(byName.Home).toMatchObject({ convertible: 3, toNotes: 2 });
    expect(byName.Garage).toMatchObject({ values: 2, convertible: 1, toNotes: 1 });
    expect(preview.total).toBe(7);
    expect(JSON.stringify(preview)).not.toContain('about 6');
  });

  it('blocks a kind that converts to nothing, and anyone but the account owner', async () => {
    const id = sizeFieldId(mock.state);
    expect((await fail(api.convertPreview(id, { kind: 'money' }))).code).toBe(
      'field_convert_blocked',
    );
    use(memberScenario());
    expect((await fail(api.convertPreview(id, { toSecret: true }))).code).toBe('forbidden');
  });
});
