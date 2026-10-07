/**
 * Step 4 in step 2's thing rows and views (T20): the derived states lent, borrowed and in repair
 * on every list, the thing view's loan line, repair vendor and current value (behind the money
 * gate), and the attachment subjects a warranty, a claim and a loan add.
 */
import { newId } from '@kept/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api as client } from '../../client';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { inventoryPaths } from '../../inventory/paths';
import { inventoryApi } from '../../inventory/queries';
import type { AttachmentView, ThingView } from '../../inventory/types';
import { IDS, ownerScenario } from '../../mock/fixtures';
import { createMockApi, type MockApi } from '../../mock/server';
import { householdApi } from '../queries';
import { HOUSEHOLD_IDS as H } from './state';

let mock: MockApi;
const use = (state = ownerScenario()) => {
  mock = createMockApi(state);
  vi.stubGlobal('fetch', mock.fetch);
};
beforeEach(() => use());
afterEach(() => vi.unstubAllGlobals());

const T = INV_IDS.thing;
const thing = (id: string) => client.get<ThingView>(inventoryPaths.thing(id));

describe('derived states in step 2 (T20)', () => {
  it('the drill is lent, with its loan line; the TV is in repair at the service centre', async () => {
    const drill = await thing(T.drill);
    expect(drill.derivedState).toContain('lent');
    expect(drill.loanLine).toMatchObject({
      direction: 'out',
      personName: 'Murdock',
      overdue: true,
    });
    const tv = await thing(T.tv);
    expect(tv.derivedState).toContain('in_repair');
    expect(tv.repairAt).toEqual({ vendorName: 'Samsung Service Centre' });
    expect(tv.loanLine).toBeNull();
  });

  it('a list row carries them too, and the state filter finds them', async () => {
    const lent = await inventoryApi.things({ state: 'lent' });
    expect(lent.items.map((t) => t.id)).toEqual([T.drill]);
    const repair = await inventoryApi.things({ state: 'in_repair' });
    expect(repair.items.map((t) => t.id)).toEqual([T.tv]);
  });

  it('returning the loan clears lent', async () => {
    const loans = await householdApi.thingLoans(T.drill);
    const open = loans.items.find((l) => !l.returnedAt);
    if (!open) throw new Error('fixture');
    await householdApi.returnLoan(open.id, {}, open.rowVersion);
    const drill = await thing(T.drill);
    expect(drill.derivedState).not.toContain('lent');
    expect(drill.loanLine).toBeNull();
  });

  it('the current value is the latest valuation, hidden from a viewer where money is', async () => {
    const tv = await thing(T.tv);
    expect(tv.currentValue).toMatchObject({ amount: '21000', currency: 'EGP', source: 'estimate' });
    const s = ownerScenario();
    const home = s.locations.find((l) => l.id === IDS.home);
    if (!home) throw new Error('fixture');
    home.role = 'viewer';
    home.moneyVisibleToViewers = false;
    use(s);
    expect((await thing(T.tv)).currentValue).toEqual({ moneyHidden: true });
  });
});

describe('attachment subjects (T9, T10)', () => {
  const attach = (subject: object, role: string) =>
    client.post<AttachmentView>(inventoryPaths.attachments, {
      id: newId(),
      locationId: IDS.home,
      url: 'https://example.com/card.pdf',
      subject,
      role,
    });

  it('a warranty document lands on the warranty and comes off with the attachment', async () => {
    const a = await attach({ warrantyId: H.warranty.tvMaker }, 'warranty_doc');
    let w = (await householdApi.warranties(T.tv)).items.find((x) => x.id === H.warranty.tvMaker);
    expect(w?.documents.map((d) => d.id)).toEqual([a.id]);
    await client.del(inventoryPaths.attachment(a.id));
    w = (await householdApi.warranties(T.tv)).items.find((x) => x.id === H.warranty.tvMaker);
    expect(w?.documents).toEqual([]);
  });

  it('a claim document lands on the claim, a condition photo on the loan', async () => {
    await attach({ claimId: H.claim.tvRepair }, 'document');
    const claim = (await householdApi.claims(T.tv)).items[0];
    expect(claim?.documents).toHaveLength(1);
    await attach({ loanId: H.loan.drill }, 'condition_in');
    const loan = (await householdApi.thingLoans(T.drill)).items[0];
    expect(loan?.conditionIn).toHaveLength(1);
    expect(loan?.conditionIn[0]?.subject).toEqual({ loanId: H.loan.drill });
  });
});
