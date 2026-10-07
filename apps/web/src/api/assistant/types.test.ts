/**
 * The step-6 assistant mock answers its contract through the real fetchers (./queries.ts), so T19
 * and T20 start from something that behaves like the server (plan T3): every path in ./paths.ts
 * has a handler, the answers carry exactly the contract's fields, and the fixtures hold what T3
 * asks for.
 */
import {
  CONTEXT_KINDS,
  isLiveTurn,
  PART_TYPES,
  PROPOSAL_STATUS,
  TURN_STATUSES,
} from '@kept/shared';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { type ApiError, isApiError } from '../client';
import { INV_IDS } from '../inventory/mock/fixtures';
import { type MockState, memberScenario, ownerScenario } from '../mock/fixtures';
import { createMockApi } from '../mock/server';
import { assistantMockRoutes } from './mock';
import { ASSISTANT_IDS as A } from './mock/state';
import { ASSISTANT_METHODS, assistantPaths } from './paths';
import { assistantApi as api } from './queries';
import type { Proposal, ThreadDetail, ThreadMessage, ThreadSummary, TurnView } from './types';

const use = (state: MockState = ownerScenario()) => {
  vi.stubGlobal('fetch', createMockApi(state).fetch);
  return state;
};
beforeEach(() => use());
afterEach(() => vi.unstubAllGlobals());

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};
const keys = (o: object) => Object.keys(o).sort();

function expectMessage(m: ThreadMessage) {
  expect(keys(m)).toEqual(['createdAt', 'id', 'parts', 'role', 'step', 'turnId']);
  for (const part of m.parts) expect(PART_TYPES).toContain(part.type);
}
function expectProposal(x: Proposal) {
  expect(keys(x)).toEqual(
    expect.arrayContaining([
      'args',
      'argsHash',
      'batchId',
      'before',
      'expiresAt',
      'id',
      'locationId',
      'refs',
      'status',
      'tool',
      'turnId',
    ]),
  );
  expect(x.argsHash).toMatch(/^[0-9a-f]{64}$/);
  expect(PROPOSAL_STATUS).toContain(x.status);
}

describe('the assistant mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = assistantMockRoutes(ownerScenario());
    const matches = (template: string, path: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((part) => (part.startsWith('%3A') ? '[^/]+' : part))
          .join('/')}$`,
      ).test(path);
    const missing: string[] = [];
    for (const [key, methods] of Object.entries(ASSISTANT_METHODS)) {
      const v = assistantPaths[key as keyof typeof assistantPaths] as
        | string
        | ((id: string) => string);
      const path = typeof v === 'string' ? v : v('a');
      for (const method of methods)
        if (!routes.some((r) => r.method === method && matches(r.template, path)))
          missing.push(`${method} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it('lists only the caller’s threads, newest first, with the contract’s fields', async () => {
    const page = await api.threads();
    expectTypeOf(page.items).toEqualTypeOf<ThreadSummary[]>();
    expect(page.next_cursor).toBeNull();
    expect(page.items.map((t) => t.id)).toEqual([
      A.thread.running,
      A.thread.list,
      A.thread.found,
      A.thread.arabic,
    ]);
    for (const t of page.items) {
      expect(keys(t)).toEqual(['context', 'expiresAt', 'id', 'title', 'updatedAt']);
      expect(CONTEXT_KINDS).toContain(t.context.kind);
    }
    // Talia's thread is hers alone, private even from the instance admin (D23).
    expect(page.items.map((t) => t.id)).not.toContain(A.thread.talia);
    expect((await fail(api.thread(A.thread.talia))).status).toBe(404);
    expect((await api.threads({ q: 'garage' })).items.map((t) => t.id)).toEqual([
      A.thread.running,
      A.thread.list,
    ]);
  });

  it('a finished turn citing two things, an Arabic thread, a running turn', async () => {
    const found: ThreadDetail = await api.thread(A.thread.found);
    expect(keys(found)).toEqual(['messages', 'proposals', 'thread']);
    found.messages.forEach(expectMessage);
    const answer = found.messages.find(
      (m) => m.role === 'assistant' && m.parts[0]?.type === 'text',
    );
    const text = answer?.parts[0]?.type === 'text' ? answer.parts[0].text : '';
    expect(text).toContain(`kept:thing/${INV_IDS.thing.hdmiCable}`);
    expect(text).toContain(`kept:thing/${INV_IDS.thing.cableBox}`);
    const result = found.messages.flatMap((m) => m.parts).find((x) => x.type === 'tool_result');
    expect(result).toMatchObject({ tool: 'where_is', locationIds: [INV_IDS.loc.home] });

    const arabic = await api.thread(A.thread.arabic);
    expect(arabic.thread.locale).toBe('ar');
    expect(JSON.stringify(arabic.messages)).toMatch(/[؀-ۿ]/);

    const running = await api.thread(A.thread.running);
    expect(running.liveTurn).toMatchObject({ id: A.turn.running, status: 'running' });
    const turn: TurnView = await api.turn(A.turn.running);
    expect(keys(turn)).toEqual([
      'messages',
      'pausedUntil',
      'proposals',
      'status',
      'statusReason',
      'steps',
    ]);
    expect(TURN_STATUSES).toContain(turn.status);
  });

  it('holds an open, an expired and a conflicted proposal, drawn from args, before and refs', async () => {
    const { proposals } = await api.thread(A.thread.found);
    proposals.forEach(expectProposal);
    expect(proposals.map((x) => [x.id, x.status])).toEqual([
      [A.proposal.open, 'open'],
      [A.proposal.expired, 'expired'],
      [A.proposal.conflict, 'conflict'],
    ]);
    const open = proposals[0] as Proposal;
    expect(open).toMatchObject({
      tool: 'move_thing',
      args: { thing_id: INV_IDS.thing.hdmiCable, to_container_id: INV_IDS.thing.box3, quantity: 2 },
    });
    expect(open.refs[INV_IDS.thing.hdmiCable]?.name).toBe('HDMI cable, 2 m');
    expect(open.refs[INV_IDS.thing.box3]?.name).toBe('Box 3');
  });

  it('confirms a row with its hash; an expired or conflicted row is never applied', async () => {
    const { proposals } = await api.thread(A.thread.found);
    const [open, expired, conflict] = proposals as [Proposal, Proposal, Proposal];
    expect(
      (
        await fail(
          api.confirm({
            batchId: open.batchId,
            proposals: [{ id: open.id, argsHash: '0'.repeat(64) }],
          }),
        )
      ).code,
    ).toBe('proposal_conflict');
    const done = await api.confirm({
      batchId: open.batchId,
      proposals: [{ id: open.id, argsHash: open.argsHash }],
    });
    expect(done.results).toEqual([
      {
        id: open.id,
        status: 'confirmed',
        audit: { eventId: expect.any(String), until: expect.any(String) },
      },
    ]);
    const late = await api.confirm({
      batchId: expired.batchId,
      proposals: [{ id: expired.id, argsHash: expired.argsHash }],
    });
    expect(late.results[0]?.status).toBe('expired');
    const clash = await api.confirm({
      batchId: conflict.batchId,
      proposals: [{ id: conflict.id, argsHash: conflict.argsHash }],
    });
    expect(clash.results[0]).toMatchObject({ status: 'conflict', conflict: { by: 'Bruce' } });
  });

  it('asks: a queued turn runs, answers, and one turn at a time', async () => {
    const thread = await api.createThread({
      context: { kind: 'location', id: INV_IDS.loc.garage },
    });
    expect(thread.title).toBeNull();
    const { turnId } = await api.ask(thread.id, {
      text: 'Where is the HDMI cable?',
      context: { kind: 'location', id: INV_IDS.loc.garage },
      locale: 'en',
    });
    expect((await fail(api.ask(thread.id, { text: 'again', locale: 'en' }))).code).toBe(
      'turn_running',
    );
    let turn = await api.turn(turnId);
    expect(turn.status).toBe('running');
    turn = await api.turn(turnId);
    expect(isLiveTurn(turn.status)).toBe(false);
    expect(turn.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((await api.thread(thread.id)).thread.title).toBe('Where is the HDMI cable?');
    expect((await fail(api.ask(thread.id, { text: 'x'.repeat(2001), locale: 'en' }))).code).toBe(
      'validation',
    );
  });

  it('refuses a question while the location’s AI is paused (ai_paused, §7.15)', async () => {
    const e = await fail(
      api.ask(A.thread.found, {
        text: 'And the remote?',
        context: { kind: 'location', id: INV_IDS.loc.home },
        locale: 'en',
      }),
    );
    expect(e.code).toBe('ai_paused');
    expect(e.details.pausedUntil).toEqual(expect.any(String));
  });

  it('cancels a live turn, deletes a thread at once', async () => {
    expect((await api.cancelTurn(A.turn.running)).status).toBe('cancelled');
    await api.deleteThread(A.thread.arabic);
    expect((await fail(api.thread(A.thread.arabic))).status).toBe(404);
  });

  it('adds a spoken list as one card: kept items, edited, one event each (D213)', async () => {
    const { proposals } = await api.thread(A.thread.list);
    const list = proposals[0] as Proposal;
    expect(list).toMatchObject({ tool: 'add_thing', status: 'open' });
    expect((list.args.items as unknown[]).length).toBe(3);
    const done = await api.confirm({
      batchId: list.batchId,
      proposals: [
        {
          id: list.id,
          argsHash: list.argsHash,
          items: [{ index: 0 }, { index: 2, name: 'Paint tin', quantity: 3 }],
        },
      ],
    });
    // A new place ("Shelf C"), then the two things: three events, in write order.
    expect(done.results[0]?.status).toBe('confirmed');
    expect(done.results[0]?.audit?.eventIds).toHaveLength(3);
  });

  it('answers a listed question with one add_thing proposal', async () => {
    const thread = await api.createThread({
      context: { kind: 'location', id: INV_IDS.loc.garage },
    });
    const { turnId } = await api.ask(thread.id, {
      text: 'In the garage I have a drill, a ladder and two paint cans',
      locale: 'en',
    });
    await api.turn(turnId);
    const turn = await api.turn(turnId);
    expect(turn.proposals).toHaveLength(1);
    expect(turn.proposals[0]?.args.items).toEqual([
      { name: 'Drill' },
      { name: 'Ladder' },
      { name: 'Paint cans', quantity: 2 },
    ]);
  });

  it('shows another person only their own threads', async () => {
    use(memberScenario());
    expect((await api.threads()).items).toEqual([]);
  });
});
