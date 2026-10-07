/**
 * Settings → Connections' mock state (step-6 plan T3), kept beside the scenario in a WeakMap so no
 * other area's state type changes. Ibrahim's fixtures:
 * - two personal tokens: "Garage dashboard", read-only for Garage, and "Claude Desktop",
 *   read and write for Home, used a few minutes ago;
 * - one connected app (OAuth): "Claude", read-only for Home;
 * - three recent changes by the Home token (the HDMI cable moved, the cable box seen, the old
 *   kettle added), the first two still undoable;
 * - one Home webhook whose last delivery failed (a 500), failing since yesterday.
 * Secrets exist only in the create and rotate answers.
 */

import { summaryOf } from '../../inventory/mock/db';
import { INV_IDS } from '../../inventory/mock/fixtures';
import type { HistoryEvent } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import type { ConnectionChange, TokenRow, WebhookDelivery, WebhookRow } from '../types';

const L = INV_IDS.loc;
const T = INV_IDS.thing;

const cid = (n: number) => `01926f00-0000-7000-8000-00000009${String(n).padStart(4, '0')}`;

/** Ids tests and demo links can use. */
export const CONNECTION_IDS = {
  token: { garageRead: cid(1), homeWrite: cid(2), oauthClaude: cid(3) },
  change: { move: cid(11), seen: cid(12), add: cid(13) },
  webhook: { home: cid(21) },
  delivery: { failed: cid(31), delivered: cid(32) },
} as const;
const C = CONNECTION_IDS;

export type StoredToken = TokenRow & { userId: string };
export type StoredWebhook = WebhookRow & { locationId: string };

export type ConnectionsMockState = {
  tokens: StoredToken[];
  changes: ConnectionChange[];
  webhooks: StoredWebhook[];
  deliveries: (WebhookDelivery & { webhookId: string })[];
};

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const token = (
  id: string,
  userId: string,
  row: Omit<TokenRow, 'id' | 'revokedAt' | 'revokedReason' | 'rowVersion'>,
): StoredToken => ({ id, userId, revokedAt: null, revokedReason: null, rowVersion: 1, ...row });

const change = (
  id: string,
  hoursAgo: number,
  action: string,
  entity: { type: 'thing' | 'place'; id: string; shortCode: string | null },
  name: string,
  diff: HistoryEvent['diff'],
  undoable: boolean,
): ConnectionChange => {
  const until = undoable ? ahead(7 - hoursAgo / 24) : null;
  return {
    id,
    at: ago(hoursAgo),
    location_id: L.home,
    action,
    // As the server answers (audit/render.ts): a token actor has no display name of its own.
    actor: { type: 'token', id: C.token.homeWrite, displayName: null },
    entity,
    root_thing_id: entity.type === 'thing' ? entity.id : null,
    diff,
    undo_of: null,
    undoable_until: until,
    ...summaryOf(action, name),
    token: { id: C.token.homeWrite, name: 'Claude Desktop', kind: 'personal' },
    undo: until ? { eventId: id, until } : null,
  };
};

function fixtures(meId: string): ConnectionsMockState {
  const tokens = [
    token(C.token.garageRead, meId, {
      kind: 'personal',
      name: 'Garage dashboard',
      scope: 'read',
      locations: [{ id: L.garage, name: 'Garage' }],
      createdAt: ago(24 * 20),
      expiresAt: ahead(70),
      lastUsedAt: ago(26),
    }),
    token(C.token.homeWrite, meId, {
      kind: 'personal',
      name: 'Claude Desktop',
      scope: 'write',
      locations: [{ id: L.home, name: 'Home' }],
      createdAt: ago(24 * 6),
      expiresAt: null,
      lastUsedAt: ago(0.1),
    }),
    token(C.token.oauthClaude, meId, {
      kind: 'oauth',
      name: 'Claude',
      clientName: 'Claude',
      scope: 'read',
      locations: [{ id: L.home, name: 'Home' }],
      createdAt: ago(24 * 2),
      expiresAt: null,
      lastUsedAt: ago(3),
    }),
  ];
  const changes = [
    change(
      C.change.move,
      0.1,
      'thing.move',
      { type: 'thing', id: T.hdmiCable, shortCode: '7KQ4MZ' },
      'HDMI cable, 2 m',
      { place_id: { before: 'Desk drawer', after: 'Living room', class: 'plain' } },
      true,
    ),
    change(
      C.change.seen,
      2,
      'thing.seen',
      { type: 'thing', id: T.cableBox, shortCode: 'B0X3QF' },
      'Cable box',
      null,
      true,
    ),
    change(
      C.change.add,
      24 * 8,
      'thing.create',
      { type: 'thing', id: T.kettle, shortCode: null },
      'Old kettle',
      null,
      false,
    ),
  ];
  const webhooks: StoredWebhook[] = [
    {
      id: C.webhook.home,
      locationId: L.home,
      url: 'https://hooks.example.org/kept/home',
      events: ['thing.created', 'thing.moved', 'reading.logged'],
      active: true,
      failingSince: ago(20),
      disabledReason: null,
      createdBy: { id: meId, displayName: 'Ibrahim' },
      lastDelivery: { status: 'failed', at: ago(0.5), httpStatus: 500 },
      rowVersion: 3,
    },
  ];
  const deliveries = [
    {
      id: C.delivery.failed,
      webhookId: C.webhook.home,
      event: 'thing.moved' as const,
      status: 'failed' as const,
      attempts: 4,
      httpStatus: 500,
      createdAt: ago(20),
      nextAttemptAt: ahead(0.1),
    },
    {
      id: C.delivery.delivered,
      webhookId: C.webhook.home,
      event: 'thing.created' as const,
      status: 'delivered' as const,
      attempts: 1,
      httpStatus: 204,
      createdAt: ago(30),
      nextAttemptAt: null,
    },
  ];
  return { tokens, changes, webhooks, deliveries };
}

const states = new WeakMap<MockState, ConnectionsMockState>();

/** Connections' mock state for a scenario, made on first use for its signed-in person. */
export function connectionsMock(state: MockState): ConnectionsMockState {
  let s = states.get(state);
  if (!s) {
    s = fixtures(state.me.user.id);
    states.set(state, s);
  }
  return s;
}
