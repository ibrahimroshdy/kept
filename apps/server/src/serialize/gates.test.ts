import type { ModuleId, Role } from '@kept/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { addMember, ownerTx, seedTenant, seedUser, type Tenant } from '../../test/tenancy.js';
import { type Scope, withScope } from '../db/scope.js';
import {
  customForView,
  forgetGates,
  type Gate,
  gateFor,
  gateOf,
  mayRevealSecret,
  moneyOf,
  moneyProps,
  stripMoney,
} from './gates.js';

// T2 step 2: money and secrets leave the server only through these gates (D13, D110, D116).

const db = await testDb();

function gate(role: Role, modules: ModuleId[], moneyVisibleToViewers = false): Gate {
  return gateOf({
    locationId: '00000000-0000-7000-8000-000000000000',
    role,
    modules: new Set(modules),
    moneyVisibleToViewers,
  });
}

describe('gateOf', () => {
  it('shows money to a member with the money module on', () => {
    expect(gate('member', ['money']).showMoney).toBe(true);
  });

  it('hides money from a viewer while the location keeps it from viewers', () => {
    expect(gate('viewer', ['money'], false).showMoney).toBe(false);
  });

  it('shows money to a viewer once the location allows it', () => {
    expect(gate('viewer', ['money'], true).showMoney).toBe(true);
  });

  it('hides money from everyone, the owner too, when the money module is off', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(gate(role, [], true).showMoney).toBe(false);
    }
  });

  it('shows secrets only with the secrets module on', () => {
    expect(gate('owner', ['money']).showSecrets).toBe(false);
    expect(gate('owner', ['secrets']).showSecrets).toBe(true);
  });
});

describe('response helpers', () => {
  const hidden = gate('viewer', ['money']);
  const shown = gate('member', ['money']);

  it('moneyOf: the pair when shown and set, undefined otherwise', () => {
    expect(moneyOf(shown, '12.5000', 'EGP')).toEqual({ amount: '12.5000', currency: 'EGP' });
    expect(moneyOf(shown, null, 'EGP')).toBeUndefined();
    expect(moneyOf(hidden, '12.5000', 'EGP')).toBeUndefined();
  });

  it('moneyProps: the set fields when shown; only the marker when hidden, never nulls', () => {
    expect(moneyProps(shown, { price: '3.00', currency: 'USD', paid: null })).toEqual({
      price: '3.00',
      currency: 'USD',
    });
    expect(moneyProps(hidden, { price: '3.00', currency: 'USD' })).toEqual({ moneyHidden: true });
    // The marker does not depend on whether there was a value: absence must not tell a viewer
    // that nothing was paid.
    expect(moneyProps(hidden, { price: null })).toEqual({ moneyHidden: true });
  });

  it('stripMoney: removes each path and marks the object that held it', () => {
    const view = {
      name: 'Kettle',
      price: '40.00',
      currency: 'EGP',
      ended: { on: '2026-01-01', price: '10.00', currency: 'EGP' },
      purchase: { lines: [{ unitPrice: '1.00' }, { unitPrice: '2.00' }] },
      none: null,
    };
    const paths = [
      'price',
      'currency',
      'ended.price',
      'ended.currency',
      'purchase.lines[].unitPrice',
      'none.price',
    ];
    expect(stripMoney(shown, view, paths)).toEqual(view);
    const out = stripMoney(hidden, view, paths);
    expect(out).toEqual({
      name: 'Kettle',
      moneyHidden: true,
      ended: { on: '2026-01-01', moneyHidden: true },
      purchase: { lines: [{ moneyHidden: true }, { moneyHidden: true }] },
      none: null,
    });
    expect(JSON.stringify(out)).not.toMatch(/40\.00|10\.00|unitPrice/);
    // The input is left alone.
    expect(view.price).toBe('40.00');
  });

  const fields = [
    { key: 'colour', kind: 'text' as const },
    { key: 'value', kind: 'money' as const },
    { key: 'wifi_password', kind: 'text' as const, secret: true },
  ];
  const custom = {
    colour: 'red',
    value: { amount: '99.00', currency: 'EGP' },
    wifi_password: 'x',
    stray: 1,
  };

  it('customForView: money kinds only with showMoney; secrets and unknown keys never', () => {
    // Money leaves in canonical form (`"99"`, however it was stored).
    expect(customForView(shown, fields, custom)).toEqual({
      colour: 'red',
      value: { amount: '99', currency: 'EGP' },
    });
    expect(customForView(hidden, fields, custom)).toEqual({ colour: 'red' });
    expect(customForView(gate('owner', ['money', 'secrets']), fields, custom)).not.toHaveProperty(
      'wifi_password',
    );
  });

  it("mayRevealSecret: the module, then the field's policy (admins and up by default)", () => {
    const on = (role: Role) => gate(role, ['secrets']);
    expect(mayRevealSecret(on('admin'), {})).toBe(true);
    expect(mayRevealSecret(on('member'), {})).toBe(false);
    expect(mayRevealSecret(on('member'), { revealRoles: ['member'] })).toBe(true);
    expect(mayRevealSecret(gate('owner', []), {})).toBe(false);
  });
});

describe('gateFor (the database)', () => {
  let home: Tenant;
  let viewer: Scope;
  let member: Scope;

  beforeAll(async () => {
    home = await seedTenant(db, 'gates-owner');
    const viewerId = await seedUser(db, 'gates-viewer');
    const memberId = await seedUser(db, 'gates-member');
    await addMember(db, home.locationId, viewerId, 'viewer');
    await addMember(db, home.locationId, memberId, 'member');
    viewer = { userId: viewerId, mfa: false };
    member = { userId: memberId, mfa: false };
  });

  const read = (scope: Scope) =>
    withScope(db.pools.app, scope, (tx) => gateFor(tx, home.locationId, scope));

  it("reads the caller's role, the modules and the viewer toggle", async () => {
    const g = await read(member);
    expect(g).toMatchObject({ role: 'member', showMoney: true, showSecrets: false });
    expect(g.modules.has('money')).toBe(true);
    expect((await read(viewer)).showMoney).toBe(false);
  });

  it('caches per scope and location until forgotten', async () => {
    const scope: Scope = { ...viewer };
    expect((await read(scope)).showMoney).toBe(false);
    await ownerTx(db, (c) =>
      c.query('UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
        home.locationId,
      ]),
    );
    expect((await read(scope)).showMoney).toBe(false);
    forgetGates(scope);
    expect((await read(scope)).showMoney).toBe(true);
    // A new request (a new scope object) never sees another's cache.
    expect((await read({ ...viewer })).showMoney).toBe(true);
  });

  it('hides money from a member once the money module is off there', async () => {
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'money', false)`,
        [home.locationId],
      ),
    );
    const g = await read({ ...member });
    expect(g.modules.has('money')).toBe(false);
    expect(g.showMoney).toBe(false);
  });

  it('is a 404 for a location the caller is not in', async () => {
    const stranger = await seedUser(db, 'gates-stranger');
    await expect(read({ userId: stranger, mfa: false })).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});
