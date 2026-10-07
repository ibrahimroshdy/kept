import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTIONS, type Action, can, MATRIX, QUALIFIERS, ROLES, type Role } from './roles.js';

/**
 * Product design §7.1, copied verbatim (docs/specs/2026-09-25-kept-product-design.md). The drift
 * test below fails if the spec's table changes without this fixture (and roles.ts) following.
 */
const SPEC_7_1 = `| Action | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| See things, places, photos, history, activity feed (redacted per D110) | ✓ | ✓ | ✓ | ✓ |
| Add, edit, move, lend and borrow things; log readings, services and fuel | ✓ | ✓ | ✓ | – |
| Manage schedules; open and update claims | ✓ | ✓ | ✓ | – |
| Print labels; claim blank labels; box check | ✓ | ✓ | ✓ | – |
| Mark seen / not here | ✓ | ✓ | ✓ | – |
| Use AI capture (spends the location owner's budget, D121) | ✓ | ✓ | ✓ | – |
| Ask the assistant (read-only for viewers; spends budget) | ✓ | ✓ | ✓ | ✓ read-only |
| Create people and vendors inline (D11) | ✓ | ✓ | ✓ | – |
| Edit, merge, delete people, vendors, brands; create and edit types and templates | ✓ | ✓ | – | – |
| Trash things (undoable); restore from trash | ✓ | ✓ | ✓ | – |
| Delete permanently | ✓ | ✓ | – | – |
| Tags: create · edit and delete | ✓ | ✓ | create | – |
| Readings, services, fuel: add · edit or delete others' | ✓ | ✓ | add, edit own | – |
| Meters: add or change | ✓ | ✓ | – | – |
| Attachments: add · delete | ✓ | ✓ | add, delete own | – |
| Shared saved views | ✓ | ✓ | ✓ | – |
| Webhooks | ✓ | ✓ | – | – |
| Incidents; claim packs (D158) | ✓ | ✓ | – | – |
| Reveal a secret field | per the field's policy (D116); admins and above by default | | | |
| Set a secret field's policy; convert a field to or from secret | owner only (D177) | | | |
| See money | ✓ | ✓ | ✓ | only if the location allows (D13) |
| Export the location; import into it | ✓ | ✓ | – | – |
| Create share links | ✓ | ✓ | – | – |
| Invite and remove members and viewers; change their roles and expiry | ✓ | ✓ | – | – |
| Promote, demote or remove admins (D48) | ✓ | – | – | – |
| Location settings and modules | ✓ | ✓ | – | – |
| API/MCP tokens for this location | ✓ | ✓ | own, up to own role | own, read-only |
| Require two-factor for the location; grant support access (D71) | ✓ | – | – | – |
| Transfer or delete the location; billing | ✓ | – | – | – |`;

type Cells = readonly [owner: string, admin: string, member: string, viewer: string];

function parseTable(table: string): Map<string, Cells> {
  const rows = new Map<string, Cells>();
  for (const line of table.trim().split('\n').slice(2)) {
    const [label = '', o = '', a = '', m = '', v = ''] = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    rows.set(label, [o, a, m, v]);
  }
  return rows;
}

const SPEC_ROWS = parseTable(SPEC_7_1);

/** A plain row: ✓ (including "✓ read-only") allows, – denies. */
function plain(label: string): Record<Role, boolean> {
  const cells = SPEC_ROWS.get(label);
  if (!cells) throw new Error(`fixture has no row "${label}"`);
  const [owner, admin, member, viewer] = cells.map((c) => {
    if (c.startsWith('✓')) return true;
    if (c === '–') return false;
    throw new Error(`cell "${c}" in "${label}" is not plain; spell it out below`);
  }) as [boolean, boolean, boolean, boolean];
  return { owner, admin, member, viewer };
}

const R = (owner: boolean, admin: boolean, member: boolean, viewer: boolean) => ({
  owner,
  admin,
  member,
  viewer,
});

/**
 * How each §7.1 row reads as actions. Plain rows are read straight off the fixture; rows whose
 * cells qualify a verb ("create", "add, edit own", "own, read-only", "owner only") are split,
 * and their expected cells are spelled out by hand next to the cell text they come from.
 */
const EXPECTED: Record<Action, { row: string; roles: Record<Role, boolean> }> = {
  'content.view': {
    row: 'See things, places, photos, history, activity feed (redacted per D110)',
    roles: plain('See things, places, photos, history, activity feed (redacted per D110)'),
  },
  'things.edit': {
    row: 'Add, edit, move, lend and borrow things; log readings, services and fuel',
    roles: plain('Add, edit, move, lend and borrow things; log readings, services and fuel'),
  },
  'schedules-claims.manage': {
    row: 'Manage schedules; open and update claims',
    roles: plain('Manage schedules; open and update claims'),
  },
  'labels.use': {
    row: 'Print labels; claim blank labels; box check',
    roles: plain('Print labels; claim blank labels; box check'),
  },
  'things.mark-seen': { row: 'Mark seen / not here', roles: plain('Mark seen / not here') },
  'ai.capture': {
    row: "Use AI capture (spends the location owner's budget, D121)",
    roles: plain("Use AI capture (spends the location owner's budget, D121)"),
  },
  'assistant.ask': {
    row: 'Ask the assistant (read-only for viewers; spends budget)',
    roles: plain('Ask the assistant (read-only for viewers; spends budget)'),
  },
  'people-vendors.create-inline': {
    row: 'Create people and vendors inline (D11)',
    roles: plain('Create people and vendors inline (D11)'),
  },
  'registries-types.manage': {
    row: 'Edit, merge, delete people, vendors, brands; create and edit types and templates',
    roles: plain(
      'Edit, merge, delete people, vendors, brands; create and edit types and templates',
    ),
  },
  'things.trash': {
    row: 'Trash things (undoable); restore from trash',
    roles: plain('Trash things (undoable); restore from trash'),
  },
  'things.delete-permanently': { row: 'Delete permanently', roles: plain('Delete permanently') },
  // Member cell: "create".
  'tags.create': { row: 'Tags: create · edit and delete', roles: R(true, true, true, false) },
  'tags.edit-delete': { row: 'Tags: create · edit and delete', roles: R(true, true, false, false) },
  // Member cell: "add, edit own".
  'logs.add': {
    row: "Readings, services, fuel: add · edit or delete others'",
    roles: R(true, true, true, false),
  },
  'logs.edit-own': {
    row: "Readings, services, fuel: add · edit or delete others'",
    roles: R(true, true, true, false),
  },
  'logs.edit-delete-others': {
    row: "Readings, services, fuel: add · edit or delete others'",
    roles: R(true, true, false, false),
  },
  'meters.manage': { row: 'Meters: add or change', roles: plain('Meters: add or change') },
  // Member cell: "add, delete own".
  'attachments.add': { row: 'Attachments: add · delete', roles: R(true, true, true, false) },
  'attachments.delete-own': { row: 'Attachments: add · delete', roles: R(true, true, true, false) },
  'attachments.delete-any': {
    row: 'Attachments: add · delete',
    roles: R(true, true, false, false),
  },
  'saved-views.share': { row: 'Shared saved views', roles: plain('Shared saved views') },
  'webhooks.manage': { row: 'Webhooks', roles: plain('Webhooks') },
  'incidents.manage': {
    row: 'Incidents; claim packs (D158)',
    roles: plain('Incidents; claim packs (D158)'),
  },
  // "per the field's policy (D116); admins and above by default": the default, no policy.
  'secrets.reveal': { row: 'Reveal a secret field', roles: R(true, true, false, false) },
  // "owner only (D177)".
  'secrets.set-policy': {
    row: "Set a secret field's policy; convert a field to or from secret",
    roles: R(true, false, false, false),
  },
  // Viewer cell: "only if the location allows (D13)": the default, location does not allow.
  'money.view': { row: 'See money', roles: R(true, true, true, false) },
  'location.export-import': {
    row: 'Export the location; import into it',
    roles: plain('Export the location; import into it'),
  },
  'share-links.create': { row: 'Create share links', roles: plain('Create share links') },
  'members.manage': {
    row: 'Invite and remove members and viewers; change their roles and expiry',
    roles: plain('Invite and remove members and viewers; change their roles and expiry'),
  },
  'admins.manage': {
    row: 'Promote, demote or remove admins (D48)',
    roles: plain('Promote, demote or remove admins (D48)'),
  },
  'location.settings': {
    row: 'Location settings and modules',
    roles: plain('Location settings and modules'),
  },
  // Member cell: "own, up to own role"; viewer cell: "own, read-only".
  'tokens.manage-own': {
    row: 'API/MCP tokens for this location',
    roles: R(true, true, true, true),
  },
  'tokens.manage-all': {
    row: 'API/MCP tokens for this location',
    roles: R(true, true, false, false),
  },
  'location.security': {
    row: 'Require two-factor for the location; grant support access (D71)',
    roles: plain('Require two-factor for the location; grant support access (D71)'),
  },
  'location.transfer-delete': {
    row: 'Transfer or delete the location; billing',
    roles: plain('Transfer or delete the location; billing'),
  },
};

const CELLS = Object.entries(EXPECTED).flatMap(([action, { roles }]) =>
  ROLES.map((role) => ({ action: action as Action, role, allowed: roles[role] })),
);

describe('role matrix (product design §7.1)', () => {
  it('matches the table in the product design spec (drift guard)', () => {
    const specPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../docs/specs/2026-09-25-kept-product-design.md',
    );
    const spec = readFileSync(specPath, 'utf8');
    const section = spec.slice(spec.indexOf('### 7.1 Role matrix'));
    const start = section.indexOf('| Action |');
    const table = section.slice(start, section.indexOf('\n\n', start));
    expect(parseTable(table)).toEqual(SPEC_ROWS);
  });

  it('has an action for every row of §7.1 and no action from outside it', () => {
    const covered = new Set(Object.values(EXPECTED).map((e) => e.row));
    expect([...covered].sort()).toEqual([...SPEC_ROWS.keys()].sort());
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
  });

  it.each(CELLS)('$role · $action → $allowed', ({ action, role, allowed }) => {
    expect(can(role, action)).toBe(allowed);
  });
});

describe('conditional cells', () => {
  it('lets a viewer see money only when the location allows it (D13)', () => {
    expect(can('viewer', 'money.view', { moneyVisibleToViewers: false })).toBe(false);
    expect(can('viewer', 'money.view', { moneyVisibleToViewers: true })).toBe(true);
    expect(can('member', 'money.view', { moneyVisibleToViewers: false })).toBe(true);
  });

  it("widens a secret's reveal to the roles its field policy names, never narrows it (D116)", () => {
    expect(can('member', 'secrets.reveal', { secretRevealRoles: ['member'] })).toBe(true);
    expect(can('viewer', 'secrets.reveal', { secretRevealRoles: ['member'] })).toBe(false);
    expect(can('admin', 'secrets.reveal', { secretRevealRoles: [] })).toBe(true);
  });

  it('ignores the context for every other action', () => {
    expect(can('viewer', 'things.edit', { moneyVisibleToViewers: true })).toBe(false);
    expect(can('member', 'secrets.set-policy', { secretRevealRoles: ['member'] })).toBe(false);
  });

  it('records the cell qualifiers the boolean cannot carry', () => {
    expect(QUALIFIERS['assistant.ask']?.viewer).toBe('read-only');
    expect(QUALIFIERS['tokens.manage-own']?.member).toBe('up-to-own-role');
    expect(QUALIFIERS['tokens.manage-own']?.viewer).toBe('read-only');
  });

  it('rejects an unknown role or action as denied (fail closed)', () => {
    expect(can('superuser' as Role, 'content.view')).toBe(false);
    expect(can('owner', 'nope' as Action)).toBe(false);
  });
});
