/**
 * The step-3 mock answers the capture contract through the real fetchers (../queries.ts), so the
 * parallel web tasks (T23–T31) start from something that behaves like the server: every path in
 * ../paths.ts has a handler, and the fixtures hold what the plan asks for.
 */
import { INBOX_KINDS, PAYLOAD_VERSION } from '@kept/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoApi } from '@/components/history/undo';
import { type ApiError, isApiError } from '../../client';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { inventoryApi } from '../../inventory/queries';
import { memberScenario, ownerScenario } from '../../mock/fixtures';
import { createMockApi, type MockApi } from '../../mock/server';
import { CAPTURE_METHODS, capturePaths } from '../paths';
import { captureApi as api } from '../queries';
import type { LabelClaimedDetails } from '../types';
import { captureMockRoutes } from '.';
import { BLANK_CODES, CAPTURE_IDS, CLAIMED_CODE, HOMEBOX_ASSET } from './state';

let mock: MockApi;
const use = (state = ownerScenario()) => {
  mock = createMockApi(state);
  vi.stubGlobal('fetch', mock.fetch);
};
beforeEach(() => use());
afterEach(() => vi.unstubAllGlobals());

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};
const L = INV_IDS.loc;

describe('the capture mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = captureMockRoutes(ownerScenario());
    const matches = (template: string, path: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((part) => (part.startsWith('%3A') ? '[^/]+' : part.replace(/\./g, '\\.')))
          .join('/')}$`,
      ).test(path);
    const missing: string[] = [];
    for (const [key, methods] of Object.entries(CAPTURE_METHODS)) {
      const v = capturePaths[key as keyof typeof capturePaths];
      const path = typeof v === 'string' ? v : v('x', 'y');
      for (const method of methods) {
        if (!routes.some((r) => r.method === method && matches(r.template, path)))
          missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the inbox: "Mine" by default, chip counts per kind, and one fixture item of each kind', async () => {
    const mine = await api.inbox();
    expect(mine.items.every((i) => i.createdBy.displayName === 'Ibrahim')).toBe(true);
    const everyone = await api.inbox({ mine: false });
    expect(new Set(everyone.items.map((i) => i.kind))).toEqual(new Set(INBOX_KINDS));
    expect(everyone.counts.everyone).toBe(everyone.items.length);
    expect(everyone.counts.mine).toBe(mine.items.length);
    const receipt = everyone.items.find((i) => i.kind === 'receipt');
    expect(receipt?.locationId).toBe(L.family);
    expect(receipt?.receipt?.vendorSeen).toBe('بي تك');
    const currency = everyone.items.find((i) => i.kind === 'currency');
    expect(currency?.currency).toEqual({ seen: '$', options: ['USD', 'CAD'] });
    const draft = everyone.items.find((i) => i.id === CAPTURE_IDS.inbox.draft);
    expect(draft?.thing?.id).toBe(INV_IDS.thing.draft);
    expect(draft?.extraction?.status).toBe('paused_budget');
    expect(draft?.batch?.placePath.map((s) => s.name)).toContain('Office');
  });

  it('three capture batches, one of them in the Arabic household', async () => {
    const page = await api.batches();
    expect(page.items.map((b) => b.locationId).sort()).toEqual([L.family, L.home, L.garage].sort());
  });

  it("Saturday's capture: drafts with what AI accepted, a batch count, and a search", async () => {
    const page = await api.inbox({ batchId: CAPTURE_IDS.batch.garageShelves });
    const driver = page.items.find((i) => i.id === CAPTURE_IDS.inbox.driver);
    expect(driver?.thing?.brand?.name).toBe('Bosch');
    expect(driver?.thing?.type?.id).toBe(INV_IDS.type.powerTool);
    expect(driver?.batch?.count).toBe(6);
    expect(driver?.suggestions?.map((s) => s.field)).toEqual(['serial', 'manufactured_on']);
    expect(driver?.extraction?.call?.tokens).toBe(2502);
    // The drafts are real things (D18).
    expect((await inventoryApi.thing(CAPTURE_IDS.seed.cord)).name).toBe('Extension cord, 5 m');
    const found = await api.inbox({ q: 'extinguisher' });
    expect(found.items.map((i) => i.id)).toEqual([CAPTURE_IDS.inbox.extinguisher]);
    // The chips count everything, whatever the search.
    expect(found.counts.byKind.draft).toBe(page.counts.byKind.draft);
  });

  it('candidates rank for a receipt line, and say why', async () => {
    await api.inbox();
    const first = await api.inboxCandidates(CAPTURE_IDS.inbox.aceReceipt, 0);
    expect(first.things[0]?.id).toBe(CAPTURE_IDS.seed.driver);
    expect(first.things[0]?.match).toBe('brand_model');
    const cord = await api.inboxCandidates(CAPTURE_IDS.inbox.aceReceipt, 1);
    expect(cord.things[0]).toMatchObject({ id: CAPTURE_IDS.seed.cord, match: 'name' });
  });

  it('an accept writes the confirmed suggestions; a merge keeps the survivor it names', async () => {
    await api.inbox();
    // T15 refuses what it can't write, what isn't suggested, and a field both ways.
    const refuse = async (body: { accept?: string[]; reject?: string[] }) =>
      (await fail(api.inboxAccept(CAPTURE_IDS.inbox.driver, body, 1))).status;
    expect(await refuse({ accept: ['price'] })).toBe(400);
    expect(await refuse({ accept: ['serial'], reject: ['serial'] })).toBe(400);
    await api.inboxAccept(CAPTURE_IDS.inbox.driver, { accept: ['serial', 'manufactured_on'] }, 1);
    const driver = await inventoryApi.thing(CAPTURE_IDS.seed.driver);
    expect(driver.derivedState).not.toContain('draft');
    expect(driver.serial).toBe('3601JH2000-0472');
    // A manufacture date is a custom field (T15's suggestedEdit).
    expect(driver.custom.manufactured_on).toBe('2025-11-14');
    // The draft survives; the thing it duplicated is merged into it.
    await api.inboxMerge(CAPTURE_IDS.inbox.duplicate, { into: INV_IDS.thing.cableBox }, 1);
    expect((await fail(inventoryApi.thing(INV_IDS.thing.hdmiCable))).status).toBe(404);
    expect((await inventoryApi.thing(INV_IDS.thing.cableBox)).id).toBe(INV_IDS.thing.cableBox);
    // The merged thing's events are the survivor's history now, marked "merged from" (T15).
    const history = await inventoryApi.thingHistory(INV_IDS.thing.cableBox);
    const moved = history.items.find((e) => e.entity.id === INV_IDS.thing.hdmiCable);
    expect(moved?.mergedFrom).toEqual({ id: INV_IDS.thing.hdmiCable, name: 'HDMI cable, 2 m' });
    expect(history.items.filter((e) => e.entity.id === INV_IDS.thing.cableBox)).not.toContainEqual(
      expect.objectContaining({ mergedFrom: expect.anything() }),
    );
  });

  it('inbox actions need If-Match, and resolve the item', async () => {
    expect((await fail(api.inboxDismiss(CAPTURE_IDS.inbox.labelClaim, 7))).status).toBe(412);
    await api.inboxDismiss(CAPTURE_IDS.inbox.labelClaim, 1);
    const left = await api.inbox({ mine: false, kind: 'label_claim' });
    expect(left.items).toEqual([]);
  });

  it('a photo-only capture is a draft with an inbox item; AI is paused in Home', async () => {
    const id = '01926f00-0000-7000-8000-00000030000a';
    const result = await api.capture(
      {
        id,
        locationId: L.home,
        target: { unplaced: true },
        mode: 'thing',
        batchId: '01926f00-0000-7000-8000-00000030000b',
        files: [{ fileId: '01926f00-0000-7000-8000-00000030000c' }],
      },
      `cap:${id}`,
    );
    expect(result.thing?.derivedState).toContain('draft');
    expect(result.thing?.shortCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(result.extraction?.status).toBe('paused_budget');
    expect(result.inboxItemId).toBeTruthy();
    expect(result.undo?.eventId).toBeTruthy();
    // The capture's undo is step 2's audit route.
    await undoApi.undo(result.undo?.eventId ?? '');
    expect((await fail(inventoryApi.thing(id))).status).toBe(404);
  });

  it('a capture needs a photo or a name, and an Idempotency-Key', async () => {
    const body = {
      id: '01926f00-0000-7000-8000-00000030000d',
      locationId: L.home,
      target: { unplaced: true as const },
      mode: 'thing' as const,
      batchId: '01926f00-0000-7000-8000-00000030000e',
      files: [],
    };
    expect((await fail(api.capture(body, 'k'))).code).toBe('validation');
    const named = await api.capture({ ...body, name: 'Tape measure' }, 'k2');
    expect(named.thing?.derivedState).not.toContain('draft');
    expect(named.inboxItemId).toBeUndefined();
  });

  it('scan outcomes: open, claim, not in your Kept, barcode, not a Kept label', async () => {
    expect(await api.resolveScan({ text: 'https://old.example/l/7KQ4MZ' })).toMatchObject({
      outcome: 'open',
      target: { kind: 'thing' },
    });
    expect(await api.resolveScan({ text: BLANK_CODES[0] })).toEqual({
      outcome: 'claim',
      locationId: L.home,
    });
    expect(await api.resolveScan({ text: 'ZZZZZZ' })).toEqual({ outcome: 'not_in_your_kept' });
    expect(await api.resolveScan({ text: '4006381333931', format: 'ean_13' })).toEqual({
      outcome: 'barcode',
      barcode: { code: '4006381333931', lookupEnabled: false },
    });
    expect(await api.resolveScan({ text: 'hello' })).toEqual({
      outcome: 'not_kept',
      text: 'hello',
    });
    expect(await api.barcode('4006381333931')).toEqual({ enabled: false });
  });

  it('scan outcomes: an old Homebox label opens, or asks which when two collections share it', async () => {
    expect(await api.resolveScan({ text: `http://homebox.lan/a/${HOMEBOX_ASSET.unique}` })).toEqual(
      {
        outcome: 'open',
        target: { kind: 'thing', id: INV_IDS.thing.drill, locationId: L.garage },
      },
    );
    const both = await api.resolveScan({ text: `http://homebox.lan/a/${HOMEBOX_ASSET.ambiguous}` });
    expect(both).toMatchObject({ outcome: 'legacy_ambiguous' });
    expect(both.outcome === 'legacy_ambiguous' && both.candidates.map((c) => c.id)).toEqual([
      INV_IDS.thing.box3,
      INV_IDS.thing.arHdmi,
    ]);
    expect(await api.resolveScan({ text: 'http://homebox.lan/a/000-999' })).toEqual({
      outcome: 'not_in_your_kept',
    });
  });

  it('claims a blank for a new box in one step; the label then opens it', async () => {
    const id = '01926f00-0000-7000-8000-0000009a0001';
    const r = await api.claim(BLANK_CODES[2], {
      newContainer: { id, name: 'Camping box', placeId: INV_IDS.place.hallwayCloset },
    });
    expect(r).toEqual({ outcome: 'claimed', target: { kind: 'thing', id } });
    expect((await inventoryApi.thing(id)).name).toBe('Camping box');
    expect(await api.resolveScan({ text: BLANK_CODES[2] })).toMatchObject({
      outcome: 'open',
      target: { kind: 'thing', id },
    });
  });

  it('claims: a blank once, then 409 label_claimed with the other target', async () => {
    const claimed = await api.claim(BLANK_CODES[1], { thingId: INV_IDS.thing.box3 });
    expect(claimed).toEqual({
      outcome: 'claimed',
      target: { kind: 'thing', id: INV_IDS.thing.box3 },
    });
    const e = await fail(api.claim(CLAIMED_CODE, { thingId: INV_IDS.thing.drill }));
    expect(e.status).toBe(409);
    expect((e.details as LabelClaimedDetails).claimedFor.name).toBe('Box 3');
    expect((await fail(api.claim('ZZZZZZ', { thingId: INV_IDS.thing.drill }))).status).toBe(404);
  });

  it('labels: a blank sheet, the summary, and "Printed OK?"', async () => {
    const before = await api.labelSummary(L.home);
    expect(before.blankUnclaimed).toBe(BLANK_CODES.length);
    const { batch } = await api.createLabelBatch({
      locationId: L.home,
      kind: 'blank',
      blankCount: 2,
      stock: 'a4_24_70x37',
      startCell: 20,
    });
    expect(batch.labels).toHaveLength(2);
    expect((await api.labelSummary(L.home)).blankUnclaimed).toBe(BLANK_CODES.length + 2);
    const printed = await api.labelBatchPrinted(batch.id);
    expect(printed.printedConfirmedAt).not.toBeNull();
  });

  it('labels: a dry run allocates nothing, and "unprinted" drops what was printed (T28)', async () => {
    const before = await api.labelSummary(L.home);
    const blank = await api.previewLabelBatch({
      locationId: L.home,
      kind: 'blank',
      blankCount: 3,
      stock: 'a4_24_70x37',
    });
    expect(blank).toMatchObject({ labels: [], blank: 3 });
    expect((await api.labelSummary(L.home)).blankUnclaimed).toBe(before.blankUnclaimed);

    const body = {
      locationId: L.home,
      kind: 'things' as const,
      unprinted: {},
      stock: 'thermal_50x30',
    };
    const first = await api.previewLabelBatch(body);
    expect(first.labels.length).toBe(before.unprinted);
    expect(first.labels[0]?.url).toMatch(/^https?:\/\/.+\/l\/[0-9A-Z]{6}$/);
    expect(first.labels.every((l) => typeof l.path === 'string')).toBe(true);
    const { batch } = await api.createLabelBatch(body);
    await api.labelBatchPrinted(batch.id);
    expect((await api.previewLabelBatch(body)).labels).toEqual([]);
    expect((await api.labelSummary(L.home)).unprinted).toBe(0);
    // A real batch with nothing left to label is refused, with what was left out (T16).
    const none = await fail(api.createLabelBatch(body));
    expect(none).toMatchObject({ status: 400, code: 'validation' });
    expect(none.details.excluded).toEqual((await api.previewLabelBatch(body)).excluded);
  });

  it('AI: Home is paused until the 1st of next month, and Resume now clears it', async () => {
    const status = await api.aiStatus(L.home);
    expect(status.reason).toBe('cap_money');
    expect(new Date(status.pausedUntil ?? '').getUTCDate()).toBe(1);
    const { caps } = await api.aiCaps({ scope: 'location', locationId: L.home });
    await api.resumeAi(caps[0]?.id ?? '', { raiseTo: { amount: '6.25', currency: 'USD' } });
    expect((await api.aiStatus(L.home)).pausedUntil).toBeNull();
  });

  it('AI keys are write-only: a Groq key gets the recommended model and a hint', async () => {
    const provider = await api.putAiProvider('me', { apiKey: 'gsk_example_key_abcd' });
    expect(provider.kind).toBe('groq');
    expect(provider.keyHint).toBe('abcd');
    expect(JSON.stringify(provider)).not.toContain('gsk_example');
  });

  it('sync: the snapshot holds no money, and ops answer by version and idempotency key', async () => {
    const snap = await api.snapshot();
    expect(snap.complete).toBe(true);
    expect(JSON.stringify(snap)).not.toMatch(/price|amount/i);
    const id = '01926f00-0000-7000-8000-00000030001a';
    const op = {
      clientVersion: '0.1.0',
      payloadVersion: PAYLOAD_VERSION,
      clientId: id,
      idempotencyKey: `cap:${id}`,
      op: 'create_thing' as const,
      takenAt: new Date().toISOString(),
      locationId: L.home,
      payload: {
        id,
        target: { unplaced: true },
        mode: 'thing',
        batchId: '01926f00-0000-7000-8000-00000030001b',
        files: [],
        name: 'Ladder',
      },
    };
    const first = await api.syncOps({ clientVersion: '0.1.0', ops: [op] });
    const again = await api.syncOps({ clientVersion: '0.1.0', ops: [op] });
    expect(first.results[0]?.outcome).toBe('applied');
    expect(again).toEqual(first);
    const outdated = await fail(
      api.syncOps({ clientVersion: '0.1.0', ops: [{ ...op, payloadVersion: 0 }] }),
    );
    expect(outdated.code).toBe('client_outdated');
  });

  it('a viewer or a member without writable locations gets no inbox', async () => {
    const s = memberScenario();
    s.locations = s.locations.map((l) => ({ ...l, role: 'viewer' as const }));
    use(s);
    expect((await fail(api.inbox())).status).toBe(403);
  });
});

describe('the AI mock (T29, T29a)', () => {
  it('lists calls per scope, filtered in the URL form, newest first', async () => {
    const mine = await api.aiCalls({ scope: 'me' });
    expect(mine.items.length).toBeGreaterThan(3);
    const [a, b] = mine.items.map((c) => c.at);
    expect((a ?? '') >= (b ?? '')).toBe(true);
    const oldest = await api.aiCalls({ scope: 'me', dir: 'asc' });
    const [c, d] = oldest.items.map((x) => x.at);
    expect((c ?? '') <= (d ?? '')).toBe(true);
    const receipts = await api.aiCalls({ scope: 'me', task: 'extract_receipt' });
    expect(receipts.items.map((c) => c.task)).toEqual(['extract_receipt']);
    const notOk = await api.aiCalls({ scope: 'me', outcome: 'ok', not: ['outcome'] });
    expect(notOk.items.every((c) => c.outcome !== 'ok')).toBe(true);
    const home = await api.aiCalls({ scope: 'location', locationId: L.home });
    expect(home.items.every((c) => c.location?.id === L.home)).toBe(true);
    const instance = await api.aiCalls({ scope: 'instance' });
    expect(instance.items.every((c) => c.paidBy.scope === 'instance' && !c.location)).toBe(true);
  });

  it('the CSV export answers text/csv with the same filters, defusing formula cells', async () => {
    const first = mock.state.capture.calls[0];
    if (first) first.model = '=cmd';
    const res = await fetch(api.aiCallsCsvUrl({ scope: 'me', task: 'extract_thing' }));
    expect(res.headers.get('content-type')).toContain('text/csv');
    // The server's shape (D169): a BOM first (text() decodes it away), and CRLF after every
    // row, the last one too.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = await res.text();
    expect(body.endsWith('\r\n')).toBe(true);
    const [header, ...rows] = body.slice(0, -2).split('\r\n');
    expect(header?.split(',')).toContain('cost');
    expect(rows.every((r) => r.includes('extract_thing'))).toBe(true);
    expect(rows.some((r) => r.includes("'=cmd"))).toBe(true);
  });

  it('a member reads no location or account usage; the viewer gate hides cost', async () => {
    const s = memberScenario();
    use(s);
    expect((await fail(api.aiUsage({ scope: 'account' }))).status).toBe(404);
    expect((await fail(api.aiCalls({ scope: 'location', locationId: L.home }))).status).toBe(404);
    const status = await api.aiStatus(L.home);
    expect(status.canResume).toBe(false);
    expect(status.manager?.displayName).toBe('Ibrahim');
  });

  it('resume raises the cap, ends the pause and re-sends the paused extraction', async () => {
    const caps = await api.aiCaps({ scope: 'account' });
    const home = caps.caps.find((c) => c.scope === 'location');
    expect(home?.state).toBe('paused');
    const out = await api.resumeAi(home?.id ?? '', {
      raiseTo: { amount: '6.25', currency: 'USD' },
    });
    expect(out.resumed).toBe(1);
    expect(out.cap.monthlyCap?.amount).toBe('6.25');
    expect((await api.aiStatus(L.home)).pausedUntil).toBeNull();
  });

  it("T9's contract: replacing a provider needs If-Match; a failed listing is 409", async () => {
    const saved = await api.putAiProvider('account', { reasoning: 'medium' }, 1);
    expect(saved.rowVersion).toBe(2);
    expect((await fail(api.putAiProvider('account', { reasoning: 'low' }))).status).toBe(428);
    const stale = await fail(api.putAiProvider('account', { reasoning: 'low' }, 1));
    expect(stale).toMatchObject({ status: 412, code: 'precondition_failed' });
    const local = await api.putAiProvider(
      'account',
      { kind: 'openai_compatible', baseUrl: 'http://ollama.invalid:11434/v1', apiKey: 'sk-local' },
      2,
    );
    const listing = await fail(api.aiModels(local.id, true));
    expect(listing).toMatchObject({ status: 409, code: 'ai_unavailable' });
  });

  it("T9's contract: the instance's caps have no label, and Remove keeps the cap's row", async () => {
    const instance = await api.putAiCap({ scope: 'instance', tokensPerMonth: 5_000_000 });
    expect(instance.target.label).toBe('');
    const paused = await api.pauseAi({ scope: 'instance' });
    expect(paused.target.label).toBe('');
    const home = (await api.aiCaps({ scope: 'account' })).caps.find((c) => c.scope === 'location');
    const out = await api.resumeAi(home?.id ?? '', { remove: true });
    expect(out.cap).toMatchObject({ id: home?.id, state: 'active', percent: null });
    expect(out.cap.monthlyCap).toBeUndefined();
    const after = await api.aiCaps({ scope: 'location', locationId: L.home });
    expect(after.caps.map((c) => c.id)).toEqual([home?.id]);
  });

  it("T9's contract: usage is this UTC month by default; the instance list is newest first only", async () => {
    const usage = await api.aiUsage({ scope: 'me' });
    const now = new Date();
    expect(usage.from).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    );
    expect(usage.soFar).toBe(true);
    const newest = await api.aiCalls({ scope: 'instance' });
    const asc = await api.aiCalls({ scope: 'instance', dir: 'asc' });
    expect(asc.items.map((c) => c.id)).toEqual(newest.items.map((c) => c.id));
    expect(newest.items.every((c) => c.paidBy.label === '')).toBe(true);
  });

  it("T9's contract: a price from the prefill says when the provider listed it", async () => {
    const listed = await api.addAiPrice({
      providerKind: 'groq',
      model: 'qwen/qwen3.8-27b',
      inputPerMtok: '0.11',
      outputPerMtok: '0.33',
      currency: 'USD',
      listingFetchedAt: '2026-09-28T10:00:00.000Z',
    });
    expect(listed).toMatchObject({
      source: 'provider_listing',
      listingFetchedAt: '2026-09-28T10:00:00.000Z',
    });
  });

  it('a pasted Groq key picks the recommended model; the listing splits vision from text', async () => {
    mock.state.capture.providers = [];
    mock.state.me.instance.recoveryKitAcknowledged = true;
    const saved = await api.putAiProvider('account', { apiKey: 'gsk_test0000abcd' });
    expect(saved).toMatchObject({ kind: 'groq', keyHint: 'abcd' });
    expect(saved.models.vision).toBe('qwen/qwen3.8-27b');
    expect(JSON.stringify(saved)).not.toContain('gsk_test');
    const listing = await api.aiModels(saved.id);
    expect(listing.models.filter((m) => m.vision).map((m) => m.id)).toEqual(['qwen/qwen3.8-27b']);
  });
});
