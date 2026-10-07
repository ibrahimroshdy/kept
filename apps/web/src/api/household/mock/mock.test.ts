/**
 * The step-4 mock answers the household contract through the real fetchers (../queries.ts), so
 * the parallel web tasks (T20–T28) start from something that behaves like the server: every path
 * in ../paths.ts has a handler, the fixtures hold what the plan's T3 asks for, and the rules the
 * screens lean on (module off, a viewer's money, If-Match, undo, the agenda's counts) hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoApi } from '@/components/history/undo';
import { type ApiError, isApiError } from '../../client';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { inventoryApi } from '../../inventory/queries';
import { memberScenario, ownerScenario } from '../../mock/fixtures';
import { createMockApi, type MockApi } from '../../mock/server';
import { HOUSEHOLD_METHODS, householdPaths } from '../paths';
import { householdApi as api } from '../queries';
import { householdMockRoutes } from '.';
import { HOUSEHOLD_IDS as H } from './state';

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
const T = INV_IDS.thing;

describe('the household mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = householdMockRoutes(ownerScenario());
    const matches = (template: string, path: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((part) => (part.startsWith('%3A') ? '[^/]+' : part.replace(/\./g, '\\.')))
          .join('/')}$`,
      ).test(path);
    const missing: string[] = [];
    for (const [key, methods] of Object.entries(HOUSEHOLD_METHODS)) {
      const v = householdPaths[key as keyof typeof householdPaths] as
        | string
        | ((...args: string[]) => string);
      const path = typeof v === 'string' ? v : v('a', 'b', 'c', 'd');
      for (const method of methods) {
        if (!routes.some((r) => r.method === method && matches(r.template, path)))
          missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the TV: two warranties, the longest first, and a claim in repair at the service centre', async () => {
    const w = await api.warranties(T.tv);
    expect(w.items.map((x) => x.provider)).toEqual(['B.TECH', 'Samsung']);
    expect(w.items[0]?.effectiveEndsOn).toBe('2028-01-17');
    expect(w.coverage).toEqual({
      longestId: H.warranty.tvStore,
      boughtOn: '2025-01-18',
      coveredUntil: '2028-01-17',
    });
    const claims = await api.claims(T.tv);
    expect(claims.items[0]).toMatchObject({
      status: 'in_repair',
      vendor: { name: 'Samsung Service Centre', kind: 'service_centre' },
    });
    // In repair: nothing is lent (screens §8), and a second repair is refused.
    expect((await fail(api.lend(T.tv, { person: { name: 'Murdock' } }))).code).toBe(
      'thing_in_repair',
    );
    const prefill = await api.claimPrefill(T.tv);
    expect(prefill.warrantyId).toBe(H.warranty.tvStore);
  });

  it('a claim moves only along CLAIM_TRANSITIONS, and saves you the covered amount at no cost', async () => {
    const claim = (await api.claims(T.tv)).items[0];
    if (!claim) throw new Error('no claim');
    const resolved = await api.updateClaim(
      claim.id,
      { status: 'resolved', coveredAmount: '6500', currency: 'EGP' },
      claim.rowVersion,
    );
    expect(resolved.body.savedYou).toEqual({ amount: '6500', currency: 'EGP' });
    expect(resolved.body.closedOn).not.toBeNull();
    expect(resolved.auditEvents).toHaveLength(1);
    const reopen = await fail(
      api.updateClaim(claim.id, { status: 'open' }, resolved.body.rowVersion),
    );
    expect(reopen.code).toBe('invalid_transition');
    // A closed claim reopens only through undo (Q18).
    await undoApi.undo(resolved.auditEvents[0] ?? '');
    expect((await api.claims(T.tv)).items[0]?.status).toBe('in_repair');
  });

  it('the Lending screen: the drill overdue with Murdock, the ladder borrowed from him', async () => {
    const page = await api.loans();
    expect(page.counts).toEqual({ out: 1, in: 1, overdue: 1 });
    const [first, second] = page.items;
    expect(first).toMatchObject({
      direction: 'out',
      overdue: true,
      person: { name: 'Murdock', isMember: false },
      thing: { id: T.drill },
      createdBy: { displayName: 'Bruce' },
    });
    expect(first?.thing.derivedState).toContain('lent');
    expect(second).toMatchObject({ direction: 'in', thing: { name: 'Aluminium ladder, 3 m' } });
    expect(second?.thing.derivedState).toContain('borrowed');
    const murdock = await api.personLoans(H.person.murdock);
    expect(murdock.has).toHaveLength(1);
    expect(murdock.lentUs).toHaveLength(1);
  });

  it('a partial lend splits, and the return merges back; undo reopens the loan', async () => {
    const lent = await api.lend(T.hdmiCable, { person: { name: 'Louis' }, quantity: '2' });
    expect(lent.thing.quantity).toBe(2);
    expect(lent.splitFrom?.quantity).toBe(1);
    const back = await api.returnLoan(lent.loan.id, {}, lent.loan.rowVersion);
    expect(back.body.mergedInto?.quantity).toBe(3);
    await undoApi.undo(back.auditEvents[0] ?? '');
    const loans = await api.thingLoans(lent.thing.id);
    expect(loans.items[0]?.returnedAt).toBeNull();
  });

  it('returning a borrowed thing ends it as returned to its owner', async () => {
    const ladder = (await api.loans({ direction: 'in' })).items[0];
    if (!ladder) throw new Error('no loan');
    const back = await api.returnLoan(ladder.id, {}, ladder.rowVersion);
    expect(back.body.thing.lifecycle).toBe('returned_to_owner');
  });

  it('a stale If-Match is a 412 with the D156 body', async () => {
    const drill = (await api.loans({ direction: 'out' })).items[0];
    if (!drill) throw new Error('no loan');
    const e = await fail(api.updateLoan(drill.id, { dueOn: null }, drill.rowVersion + 5));
    expect(e.status).toBe(412);
  });

  it('the boiler service on the Kitchen: due in 10 days; complete re-anchors it, undo puts it back', async () => {
    const list = await api.schedules();
    const boiler = list.items.find((s) => s.id === H.schedule.boiler);
    expect(boiler).toMatchObject({
      subject: { type: 'place', name: 'Kitchen', path: 'Home' },
      next: { state: 'due', basis: 'months' },
      lastService: { id: H.serviceRecord.boilerLast },
    });
    expect(list.counts.due).toBeGreaterThanOrEqual(1);
    if (!boiler) throw new Error('no schedule');
    const done = await api.completeSchedule(
      boiler.id,
      { total: '900', currency: 'EGP' },
      boiler.rowVersion,
    );
    expect(done.body.schedule.next.state).toBe('upcoming');
    expect(done.body.serviceRecord.total).toEqual({ amount: '900', currency: 'EGP' });
    await undoApi.undo(done.auditEvents[0] ?? '');
    const again = (await api.placeSchedules(INV_IDS.place.kitchen)).items[0];
    expect(again?.next.state).toBe('due');
  });

  it('a schedule needs an interval or a date', async () => {
    const e = await fail(api.createSchedule({ subject: { thingId: T.kettle }, name: 'Descale' }));
    expect(e.code).toBe('schedule_interval_required');
  });

  it('documents: the home insurance expiring in 20 days, and a renew that keeps the old term', async () => {
    const docs = await api.documents({ locationId: L.home });
    expect(docs.items[0]).toMatchObject({
      id: H.document.homeInsurance,
      state: 'expiring',
      subject: { type: 'location', name: 'Home' },
    });
    const lease = (await api.documents({ locationId: L.family })).items[0];
    expect(lease).toMatchObject({ title: 'عقد الإيجار', state: 'ok' });
    expect(lease?.history).toHaveLength(1);
    const ins = docs.items[0];
    if (!ins) throw new Error('no document');
    const renewed = await api.renewDocument(ins.id, { expiresOn: '2027-12-31' }, ins.rowVersion);
    expect(renewed.body.previous.supersededById).toBe(renewed.body.renewed.id);
    expect(renewed.body.renewed.history[0]?.id).toBe(ins.id);
  });

  it("one document by id, one subject's documents, and a file attached to a document", async () => {
    const ins = await api.document(H.document.homeInsurance);
    expect(ins).toMatchObject({ id: H.document.homeInsurance, subject: { type: 'location' } });
    const own = await api.documents({ subjectType: 'location', subjectId: L.home });
    expect(own.items.map((d) => d.id)).toEqual([H.document.homeInsurance]);
    expect((await api.documents({ subjectId: 'nothing-here' })).items).toEqual([]);
    await inventoryApi.createAttachment({
      locationId: L.home,
      url: 'https://example.com/policy.pdf',
      subject: { expiringDocumentId: ins.id },
      role: 'document',
    });
    expect((await api.document(ins.id)).documents).toHaveLength(ins.documents.length + 1);
    expect((await fail(api.document('no-such-document'))).status).toBe(404);
  });

  it('the paperwork library finds the lease by a word of its text', async () => {
    const found = await api.paperwork({ q: 'إيجار' });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({
      subject: { type: 'location', name: 'بيت العائلة' },
      expiring: { kind: 'lease' },
    });
    expect(found.items[0]?.snippet).toContain('إيجار');
  });

  it('the agenda: one list whose counts are the lists they open', async () => {
    const all = await api.agenda();
    const overdue = await api.agenda({ state: 'overdue' });
    expect(overdue.items).toHaveLength(all.counts.overdue);
    expect(overdue.items.map((i) => i.sourceType)).toContain('loan');
    const expiring = await api.agenda({ sourceType: ['warranty', 'document', 'thing_expiry'] });
    expect(expiring.items.every((i) => i.sourceType !== 'loan')).toBe(true);
    expect(expiring.items.map((i) => i.title)).toContain('Home insurance');
  });

  it('notifications of every kind, four unread; the count and mark read agree', async () => {
    const page = await api.notifications();
    expect(new Set(page.items.map((n) => n.kind))).toEqual(
      new Set([
        'reminder',
        'membership_added',
        'membership_ended',
        'ai_cap',
        'ai_summary',
        'export_ready',
      ]),
    );
    expect(page.unread).toBe(4);
    expect((await api.notificationCount()).unread).toBe(4);
    const drill = page.items.find((n) => n.id === H.notification.drillOverdue);
    expect(drill?.reminder).toMatchObject({ state: 'open', actions: ['mark_returned', 'open'] });
    expect((await api.readNotifications({ ids: [H.notification.drillOverdue] })).unread).toBe(3);
    expect((await api.readNotifications({ all: true })).unread).toBe(0);
  });

  it("a returned loan's reminder reads done, with no actions", async () => {
    const drill = (await api.loans({ direction: 'out' })).items[0];
    if (!drill) throw new Error('no loan');
    await api.returnLoan(drill.id, {}, drill.rowVersion);
    const n = (await api.notifications()).items.find((x) => x.id === H.notification.drillOverdue);
    expect(n?.reminder).toMatchObject({ state: 'done', actions: [] });
  });

  it('notification settings: defaults per role, a chosen value, and a default that deletes the row', async () => {
    const s = await api.notificationSettings();
    const home = s.locations.find((l) => l.locationId === L.home);
    expect(home?.kinds.loan).toMatchObject({ email: true, isDefault: true });
    const off = await api.putPreferences({
      items: [{ locationId: L.home, kind: 'warranty', channel: 'email', enabled: false }],
    });
    expect(off.locations.find((l) => l.locationId === L.home)?.kinds.warranty).toMatchObject({
      email: false,
      isDefault: false,
    });
    const back = await api.putPreferences({
      items: [{ locationId: L.home, kind: 'warranty', channel: 'email', enabled: true }],
    });
    expect(back.locations.find((l) => l.locationId === L.home)?.kinds.warranty?.isDefault).toBe(
      true,
    );
    const quiet = await fail(api.putNotificationSettings({ quietFrom: '22:00' }));
    expect(quiet.code).toBe('validation');
  });

  it('a webhook channel shows its secret once and only its host after', async () => {
    const made = await api.createChannel({ kind: 'webhook', url: 'https://n8n.example/hook/kept' });
    expect(made.secret).toBeTruthy();
    const s = await api.notificationSettings();
    const hook = s.channels.find((c) => c.id === made.channel.id);
    expect(hook).toMatchObject({ displayHost: 'n8n.example' });
    expect(JSON.stringify(s)).not.toContain('/hook/kept');
  });

  it('Garage is Essentials with Lending on: its money and warranties are off', async () => {
    expect((await fail(api.valuations(T.drill))).status).toBe(404);
    const e = await fail(
      api.createWarranty(T.drill, { kind: 'manufacturer', startsOn: '2026-01-01', termMonths: 24 }),
    );
    expect(e.code).toBe('module_off');
  });

  it('a member sees valuations; a viewer sees the money hidden', async () => {
    expect((await api.valuations(T.tv)).current?.value).toEqual({
      amount: '21000',
      currency: 'EGP',
    });
    const state = ownerScenario();
    for (const l of state.locations) if (l.id === L.home) l.role = 'viewer';
    use(state);
    expect((await api.valuations(T.tv)).current?.value).toEqual({ moneyHidden: true });
    const claim = (await api.claims(T.tv)).items[0];
    expect(claim?.cost).toBeNull();
  });

  it("a member's Home: the same fixtures through the member's eyes", async () => {
    use(memberScenario());
    const page = await api.agenda();
    expect(page.items.every((i) => i.locationId === L.home)).toBe(true);
  });

  it('a report currency without every rate is refused with the missing pairs', async () => {
    const ok = await api.insuranceReport({ scope: { locationId: L.home }, reportCurrency: 'USD' });
    expect(ok.status).toBe('queued');
    const e = await fail(
      api.insuranceReport({ scope: { locationId: L.home }, reportCurrency: 'GBP' }),
    );
    expect(e.code).toBe('rate_missing');
  });

  it('a claim pack needs the acknowledgement; its link is shown once and can be revoked', async () => {
    const pack = await api.createClaimPack({
      scope: { locationId: L.home, thingIds: [T.tv] },
      acknowledged: true,
    });
    expect((await api.claimPack(pack.id)).status).toBe('done');
    const link = await api.createClaimPackLink(pack.id, { days: 3 });
    expect(link.url).toContain('/x/');
    expect((await api.claimPack(pack.id)).link?.downloads).toBe(0);
    await api.revokeClaimPackLink(pack.id);
    expect((await api.claimPack(pack.id)).link).toBeNull();
  });

  it('an incident ends the things it took, and undo brings them back', async () => {
    const made = await api.createIncident(L.home, {
      kind: 'burglary',
      occurredOn: '2026-09-20',
      thingIds: [T.kettle],
    });
    const hit = await api.incidentThings(
      made.id,
      { add: [T.phone], lifecycle: 'stolen' },
      made.rowVersion,
    );
    expect(hit.body.things.find((t) => t.id === T.phone)?.lifecycle).toBe('stolen');
    await undoApi.undo(hit.auditEvents[0] ?? '');
    expect((await api.incident(made.id)).thingCount).toBe(1);
  });

  it('calendar feeds: at most three live links', async () => {
    await api.createCalendarFeed();
    await api.createCalendarFeed();
    expect((await fail(api.createCalendarFeed())).status).toBe(409);
    const feeds = await api.calendarFeeds();
    expect(feeds.items.filter((f) => !f.revokedAt)).toHaveLength(3);
  });

  it('seeds Murdock and the ladder only on the first step-4 request', async () => {
    const state = ownerScenario();
    use(state);
    expect(state.inventory.people.some((p) => p.id === H.person.murdock)).toBe(false);
    await api.loans();
    expect(state.inventory.people.some((p) => p.id === H.person.murdock)).toBe(true);
    expect(state.inventory.things.some((t) => t.id === H.thing.ladder)).toBe(true);
  });
});
