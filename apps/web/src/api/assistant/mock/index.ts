/**
 * Mock handlers for the assistant (step-6 plan T13's routes, for T19 and T20 to build on). Threads
 * are the caller's own only: another person's is a 404, as on the server (D23). A new question
 * makes a queued turn that runs on the next poll and answers on the one after, in the question's
 * language; a location whose AI is paused refuses it (`ai_paused`); a second live turn on a thread
 * is `turn_running`. A question that lists things to add ("I have a drill, a ladder and two
 * paint cans") is answered with one `add_thing` proposal instead (D213). Confirming checks each
 * row's hash and expiry and never runs a model; an `add_thing` row may keep only some items, edited
 * (`items`), and answers one undoable event per thing and per new place.
 */
import { isLiveTurn, PROPOSAL_TTL_MS, THREAD_RETENTION_DAYS, TURN_LIMITS } from '@kept/shared';
import { now } from '../../inventory/mock/db';
import { INV_IDS } from '../../inventory/mock/fixtures';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { assistantPaths as p } from '../paths';
import type {
  AskBody,
  CancelProposalsBody,
  ConfirmBody,
  ConfirmItem,
  ConfirmResult,
  CreateThreadBody,
  ThreadDetail,
  ThreadSummary,
  TurnView,
} from '../types';
import {
  ASSISTANT_IDS,
  assistantMock,
  type StoredProposal,
  type StoredThread,
  type StoredTurn,
} from './state';

type AddItem = {
  name: string;
  quantity?: number;
  place_id?: string;
  new_place?: { name: string; parent_id?: string };
};

const COUNTS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

/**
 * The things a question lists to add, or null when it isn't one: the words after "have" or
 * "add", split at commas and "and" (and Arabic's "عندي"/"أضف", "،" and "و"). Mock only: the real
 * assistant leaves this to the model.
 */
export function listedThings(text: string): AddItem[] | null {
  const m = /\b(?:i have|i've got|add)\b(.+)$/i.exec(text) ?? /(?:عندي|أضف)(.+)$/.exec(text);
  if (!m?.[1]) return null;
  const items = m[1]
    .split(/,|،|\band\b|\sو/)
    .map((x) => x.trim().replace(/[.?!؟]+$/, ''))
    .filter(Boolean)
    .map((words): AddItem => {
      const [first = '', ...rest] = words.split(/\s+/);
      const n = Number(first) || COUNTS[first.toLowerCase()];
      const name = (n ? rest.join(' ') : words).replace(/^the\s+/i, '');
      const cap = name.charAt(0).toUpperCase() + name.slice(1);
      return n && n > 1 ? { name: cap, quantity: n } : { name: cap };
    })
    .filter((x) => x.name);
  return items.length ? items.slice(0, 20) : null;
}

const PAGE = 20;
let next = 0;
const newId = () => `01926f00-0000-7000-8000-00000008${String(++next).padStart(4, '0')}`;
const daysAhead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const summary = ({ userId: _u, locale: _l, createdAt: _c, ...t }: StoredThread): ThreadSummary => t;
const publicThread = ({ userId: _u, ...t }: StoredThread) => t;

export function assistantMockRoutes(state: MockState): MockRoute[] {
  const s = () => assistantMock(state);
  const me = () => state.me.user.id;
  const own = (id: string) => s().threads.find((t) => t.id === id && t.userId === me());
  const liveTurn = (threadId: string) =>
    s().turns.find((t) => t.threadId === threadId && isLiveTurn(t.status));
  const turnView = (t: StoredTurn): TurnView => ({
    status: t.status,
    statusReason: t.statusReason,
    pausedUntil: t.pausedUntil,
    steps: t.steps,
    messages: s()
      .messages.filter((m) => m.turnId === t.id)
      .map(({ threadId: _t, ...m }) => m),
    proposals: s()
      .proposals.filter((x) => x.turnId === t.id)
      .map(({ threadId: _t, userId: _u, ...x }) => x),
  });
  /** A context as the server stores it: a location's id is `locationId`; a place's or a thing's
   * location is looked up. */
  const contextOf = (c: CreateThreadBody['context']): StoredThread['context'] => {
    if (!c || c.kind === 'none') return { kind: 'none' };
    if (c.kind === 'location')
      return c.id ? { kind: 'location', id: c.id, locationId: c.id } : { kind: 'none' };
    const inv = state.inventory;
    const locationId =
      c.kind === 'place'
        ? inv.places.find((x) => x.id === c.id)?.locationId
        : c.kind === 'thing'
          ? inv.things.find((x) => x.id === c.id)?.locationId
          : undefined;
    return { kind: c.kind, ...(c.id ? { id: c.id } : {}), ...(locationId ? { locationId } : {}) };
  };
  /**
   * A mock turn moves on as it's read: queued → running → done with a fixed answer. The fixture's
   * running turn stays running, so a screen can show "Thinking…" (T19).
   */
  const advance = (t: StoredTurn) => {
    t.polls += 1;
    if (t.status === 'queued') {
      t.status = 'running';
      t.steps = 1;
    } else if (t.status === 'running' && t.polls >= 2 && t.id !== ASSISTANT_IDS.turn.running) {
      t.status = 'done';
      t.steps = 2;
      const thread = s().threads.find((x) => x.id === t.threadId);
      const question = s().messages.find((m) => m.turnId === t.id && m.role === 'user')?.parts[0];
      const items = question?.type === 'text' ? listedThings(question.text) : null;
      if (items) {
        const locationId =
          thread?.context.locationId ?? state.me.personalLocationId ?? INV_IDS.loc.home;
        const location = state.locations.find((l) => l.id === locationId);
        const proposal: StoredProposal = {
          id: newId(),
          batchId: newId(),
          threadId: t.threadId,
          userId: t.userId,
          turnId: t.id,
          locationId,
          tool: 'add_thing',
          args: { location_id: locationId, items },
          argsHash: newId().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
          before: {},
          refs: { [locationId]: { kind: 'location', name: location?.name ?? '', path: [] } },
          status: 'open',
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
        };
        s().proposals.push(proposal);
        s().messages.push({
          id: newId(),
          threadId: t.threadId,
          turnId: t.id,
          role: 'assistant',
          step: 2,
          createdAt: now(),
          parts: [{ type: 'proposal', proposalId: proposal.id }],
        });
        return;
      }
      const hdmi = INV_IDS.thing.hdmiCable;
      s().messages.push({
        id: newId(),
        threadId: t.threadId,
        turnId: t.id,
        role: 'assistant',
        step: 2,
        createdAt: now(),
        parts: [
          {
            type: 'text',
            text:
              thread?.locale === 'ar'
                ? `[كابل HDMI، ٢ م](kept:thing/${hdmi}) في المنزل › المكتب › درج المكتب.`
                : `The [HDMI cable, 2 m](kept:thing/${hdmi}) is in Home › Office › Desk drawer.`,
          },
        ],
      });
    }
  };

  return [
    route('GET', p.threads, ({ query }) => {
      const q = (query.get('q') ?? '').trim().toLowerCase();
      const places = query.getAll('locationId');
      const not = query.getAll('not').includes('locationId');
      const from = query.get('from');
      const to = query.get('to');
      const mine = s()
        .threads.filter((t) => t.userId === me())
        .filter((t) => !places.length || places.includes(t.context.locationId ?? '') !== not)
        .filter((t) => (!from || t.updatedAt >= from) && (!to || t.updatedAt < to))
        .filter(
          (t) =>
            !q ||
            (t.title ?? '').toLowerCase().includes(q) ||
            s().messages.some(
              (m) =>
                m.threadId === t.id &&
                m.role !== 'tool' &&
                m.parts.some((x) => x.type === 'text' && x.text.toLowerCase().includes(q)),
            ),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const at = Number(query.get('cursor') ?? 0) || 0;
      const items = mine.slice(at, at + PAGE).map(summary);
      return { items, next_cursor: at + PAGE < mine.length ? String(at + PAGE) : null };
    }),
    route('POST', p.threads, ({ body }) => {
      const b = (body ?? {}) as CreateThreadBody;
      const at = now();
      const t: StoredThread = {
        id: newId(),
        userId: me(),
        title: null,
        context: contextOf(b.context),
        locale: state.me.profile.locale,
        createdAt: at,
        updatedAt: at,
        expiresAt: daysAhead(THREAD_RETENTION_DAYS),
      };
      s().threads.push(t);
      return reply(201, publicThread(t));
    }),
    route('GET', p.thread(':id'), ({ params }) => {
      const t = own(params.id as string);
      if (!t) return notFound();
      const live = liveTurn(t.id);
      const detail: ThreadDetail = {
        thread: publicThread(t),
        messages: s()
          .messages.filter((m) => m.threadId === t.id)
          .map(({ threadId: _t, ...m }) => m),
        proposals: s()
          .proposals.filter((x) => x.threadId === t.id)
          .map(({ threadId: _t, userId: _u, ...x }) => x),
        ...(live
          ? {
              liveTurn: {
                id: live.id,
                status: live.status,
                statusReason: live.statusReason,
                pausedUntil: live.pausedUntil,
                steps: live.steps,
              },
            }
          : {}),
      };
      return detail;
    }),
    route('DELETE', p.thread(':id'), ({ params }) => {
      const t = own(params.id as string);
      if (!t) return notFound();
      const st = s();
      st.threads = st.threads.filter((x) => x.id !== t.id);
      st.turns = st.turns.filter((x) => x.threadId !== t.id);
      st.messages = st.messages.filter((x) => x.threadId !== t.id);
      st.proposals = st.proposals.filter((x) => x.threadId !== t.id);
      return reply(204);
    }),
    route('POST', p.threadTurns(':id'), ({ params, body }) => {
      const t = own(params.id as string);
      if (!t) return notFound();
      const b = body as AskBody;
      const text = (b?.text ?? '').trim();
      if (!text || text.length > TURN_LIMITS.maxQuestionChars)
        return err(400, 'validation', 'The request is not valid.');
      if (liveTurn(t.id))
        return err(409, 'turn_running', 'The assistant is still answering in this thread.');
      const locationId = b.context?.kind === 'location' ? b.context.id : t.context.locationId;
      const ai = locationId ? state.capture.aiStatus[locationId] : undefined;
      if (ai?.pausedUntil)
        return err(409, 'ai_paused', 'AI is paused until the budget resets.', undefined, {
          pausedUntil: ai.pausedUntil,
        });
      const turn: StoredTurn = {
        id: newId(),
        threadId: t.id,
        userId: me(),
        status: 'queued',
        statusReason: null,
        pausedUntil: null,
        steps: 0,
        createdAt: now(),
        polls: 0,
      };
      s().turns.push(turn);
      s().messages.push({
        id: newId(),
        threadId: t.id,
        turnId: turn.id,
        role: 'user',
        step: 0,
        createdAt: now(),
        parts: [{ type: 'text', text }],
      });
      t.title ??= text.slice(0, 60);
      t.locale = b.locale || t.locale;
      t.updatedAt = now();
      t.expiresAt = daysAhead(THREAD_RETENTION_DAYS);
      return reply(202, { turnId: turn.id });
    }),
    route('GET', p.turn(':id'), ({ params }) => {
      const t = s().turns.find((x) => x.id === params.id && x.userId === me());
      if (!t) return notFound();
      advance(t);
      return turnView(t);
    }),
    route('POST', p.turnCancel(':id'), ({ params }) => {
      const t = s().turns.find((x) => x.id === params.id && x.userId === me());
      if (!t) return notFound();
      if (isLiveTurn(t.status)) t.status = 'cancelled';
      return turnView(t);
    }),
    route('POST', p.proposalsConfirm, ({ body }) => {
      const b = body as ConfirmBody;
      const results: ConfirmResult['results'] = [];
      for (const row of b.proposals ?? []) {
        const x = s().proposals.find(
          (q) => q.id === row.id && q.batchId === b.batchId && q.userId === me(),
        );
        if (!x) return notFound();
        // As the server (assistant/proposals.ts): a stale hash refuses the whole confirm.
        if (x.argsHash !== row.argsHash)
          return err(
            409,
            'proposal_conflict',
            'This changed since it was proposed.',
            'review the new values and ask again',
          );
        if (x.status === 'open' && Date.parse(x.expiresAt) <= Date.now()) x.status = 'expired';
        if (x.status === 'conflict') {
          const c = (
            x.result as { conflict?: NonNullable<ConfirmResult['results'][0]['conflict']> }
          )?.conflict;
          results.push({ id: x.id, status: 'conflict', ...(c ? { conflict: c } : {}) });
        } else if (x.status !== 'open') {
          const status = x.status === 'confirmed' || x.status === 'expired' ? x.status : 'failed';
          results.push({ id: x.id, status });
        } else if (x.tool === 'add_thing') {
          const items = (x.args.items ?? []) as AddItem[];
          const kept: ConfirmItem[] = row.items ?? items.map((_, index) => ({ index }));
          if (!kept.length || kept.some((k) => !items[k.index]))
            return err(400, 'validation', 'The request is not valid.');
          const added = kept.map((k) => {
            const item = items[k.index] as AddItem;
            return {
              ...item,
              name: k.name?.trim() || item.name,
              quantity: k.quantity ?? item.quantity ?? 1,
            };
          });
          // One event per new place, then one per thing, in write order (undone newest first).
          const newPlaces = new Set(added.flatMap((a) => (a.new_place ? [a.new_place.name] : [])));
          const eventIds = [...[...newPlaces].map(() => newId()), ...added.map(() => newId())];
          x.status = 'confirmed';
          x.result = { added, eventIds };
          x.audit = { eventId: eventIds[eventIds.length - 1] as string, until: daysAhead(7) };
          results.push({ id: x.id, status: 'confirmed', audit: { ...x.audit, eventIds } });
        } else {
          x.status = 'confirmed';
          const eventId = newId();
          x.audit = { eventId, until: daysAhead(7) };
          results.push({ id: x.id, status: 'confirmed', audit: x.audit });
        }
      }
      return { results };
    }),
    route('POST', p.proposalsCancel, ({ body }) => {
      const b = body as CancelProposalsBody;
      for (const x of s().proposals)
        if (x.batchId === b.batchId && x.userId === me() && x.status === 'open')
          x.status = 'cancelled';
      return reply(204);
    }),
  ];
}
