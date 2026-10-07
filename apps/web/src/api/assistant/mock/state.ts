/**
 * The assistant's mock state (step-6 plan T3), kept beside the scenario in a WeakMap so no other
 * area's state type changes. The fixtures, with the sample cast:
 * - Ibrahim's threads: a finished turn in Home that found the HDMI cable and the cable box, citing
 *   both; a thread with a turn still running (Garage); an Arabic thread about بيت العائلة;
 * - proposals in Home: an open one moving 2 of the HDMI cables from the desk drawer into Box 3
 *   (the inventory fixture's Box 3 is in Home's hallway closet), an expired one and a conflicted
 *   one, each in its own batch;
 * - Talia's (a viewer's) thread, which nobody else ever sees (D23);
 * - a spoken list in Garage (D213): one open `add_thing` proposal with three items, the third in
 *   a place that doesn't exist yet ("Shelf C", proposed in the same card).
 * Home's AI is paused in step 3's mock (`capture.aiStatus`), so a new question there is refused
 * with `ai_paused`, as the server does (§7.15).
 */
import type { Proposal, ThreadMessage, TurnStatus } from '@kept/shared';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { IDS, type MockState } from '../../mock/fixtures';
import type { Thread } from '../types';

const L = INV_IDS.loc;
const T = INV_IDS.thing;
const P = INV_IDS.place;

const aid = (n: number) => `01926f00-0000-7000-8000-00000006${String(n).padStart(4, '0')}`;

/** Ids tests and demo links can use. */
export const ASSISTANT_IDS = {
  thread: { found: aid(1), running: aid(2), arabic: aid(3), talia: aid(4), list: aid(5) },
  turn: {
    found: aid(11),
    running: aid(12),
    arabic: aid(13),
    talia: aid(14),
    proposed: aid(15),
    list: aid(16),
  },
  proposal: { open: aid(21), expired: aid(22), conflict: aid(23), list: aid(24) },
  batch: { open: aid(31), expired: aid(32), conflict: aid(33), list: aid(34) },
} as const;
const A = ASSISTANT_IDS;

export type StoredThread = Thread & { userId: string };
export type StoredTurn = {
  id: string;
  threadId: string;
  userId: string;
  status: TurnStatus;
  statusReason: string | null;
  pausedUntil: string | null;
  steps: number;
  createdAt: string;
  /** Mock only: how many times the turn was read, to move a new turn along. */
  polls: number;
};
export type StoredMessage = ThreadMessage & { threadId: string };
export type StoredProposal = Proposal & { threadId: string; userId: string };

export type AssistantMockState = {
  threads: StoredThread[];
  turns: StoredTurn[];
  messages: StoredMessage[];
  proposals: StoredProposal[];
};

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const daysAhead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/** A fixed 64-hex stand-in for SHA-256 over the canonical JSON of the args. */
const hash = (seed: string) => seed.padEnd(64, '0').slice(0, 64);

const thread = (
  id: string,
  userId: string,
  title: string,
  context: Thread['context'],
  locale: string,
  minutesAgo: number,
): StoredThread => ({
  id,
  userId,
  title,
  context,
  locale,
  createdAt: ago(minutesAgo + 5),
  updatedAt: ago(minutesAgo),
  expiresAt: daysAhead(90),
});

const turn = (
  id: string,
  threadId: string,
  userId: string,
  status: TurnStatus,
  steps: number,
  minutesAgo: number,
): StoredTurn => ({
  id,
  threadId,
  userId,
  status,
  statusReason: null,
  pausedUntil: null,
  steps,
  createdAt: ago(minutesAgo),
  polls: 0,
});

let seq = 0;
const mid = () => `01926f00-0000-7000-8000-00000007${String(++seq).padStart(4, '0')}`;
const msg = (
  threadId: string,
  turnId: string,
  role: ThreadMessage['role'],
  step: number,
  parts: ThreadMessage['parts'],
  minutesAgo: number,
): StoredMessage => ({
  id: mid(),
  threadId,
  turnId,
  role,
  step,
  parts,
  createdAt: ago(minutesAgo),
});

const cableRefs: Proposal['refs'] = {
  [T.hdmiCable]: {
    kind: 'thing',
    name: 'HDMI cable, 2 m',
    path: ['Home', 'Office', 'Desk drawer'],
  },
  [T.cableBox]: { kind: 'thing', name: 'Cable box', path: ['Home', 'Office', 'Desk drawer'] },
  [T.box3]: { kind: 'thing', name: 'Box 3', path: ['Home', 'Hallway closet'] },
  [P.deskDrawer]: { kind: 'place', name: 'Desk drawer', path: ['Home', 'Office'] },
  [L.home]: { kind: 'location', name: 'Home', path: [] },
};

const move = (
  id: string,
  batchId: string,
  status: Proposal['status'],
  expiresAt: string,
): StoredProposal => ({
  id,
  batchId,
  threadId: A.thread.found,
  userId: IDS.ibrahim,
  turnId: A.turn.proposed,
  locationId: L.home,
  tool: 'move_thing',
  args: { thing_id: T.hdmiCable, to_container_id: T.box3, quantity: 2 },
  argsHash: hash(`a1${id.slice(-4)}`),
  before: { container_id: T.cableBox, place_id: P.deskDrawer, quantity: 3, rowVersion: 4 },
  refs: cableRefs,
  status,
  expiresAt,
});

/** D213: "in the garage I have a drill, a ladder and two paint cans", as one card. */
const spokenList = (): StoredProposal => ({
  id: A.proposal.list,
  batchId: A.batch.list,
  threadId: A.thread.list,
  userId: IDS.ibrahim,
  turnId: A.turn.list,
  locationId: L.garage,
  tool: 'add_thing',
  args: {
    location_id: L.garage,
    items: [
      { name: 'Drill', place_id: P.shelves },
      { name: 'Ladder', place_id: P.shelves },
      { name: 'Paint can', quantity: 2, new_place: { name: 'Shelf C', parent_id: P.shelves } },
    ],
  },
  argsHash: hash('d213a0'),
  before: {},
  refs: {
    [P.shelves]: { kind: 'place', name: 'Shelves', path: ['Garage'] },
    [L.garage]: { kind: 'location', name: 'Garage', path: [] },
  },
  status: 'open',
  expiresAt: inMinutes(9),
});

function fixtures(): AssistantMockState {
  seq = 0;
  const me = IDS.ibrahim;
  const threads = [
    thread(
      A.thread.found,
      me,
      'Where is the HDMI cable?',
      { kind: 'location', locationId: L.home },
      'en',
      30,
    ),
    thread(
      A.thread.running,
      me,
      'What is in the garage shelves?',
      { kind: 'place', id: P.shelves, locationId: L.garage },
      'en',
      1,
    ),
    thread(
      A.thread.arabic,
      me,
      'وين كابل الـ HDMI؟',
      { kind: 'location', locationId: L.family },
      'ar',
      120,
    ),
    thread(
      A.thread.list,
      me,
      'In the garage I have a drill, a ladder and two paint cans',
      { kind: 'location', locationId: L.garage },
      'en',
      3,
    ),
    thread(
      A.thread.talia,
      'u-talia',
      'Can you move the kettle?',
      { kind: 'location', locationId: L.home },
      'en',
      60,
    ),
  ];
  const turns = [
    turn(A.turn.found, A.thread.found, me, 'done', 2, 30),
    turn(A.turn.proposed, A.thread.found, me, 'done', 1, 25),
    turn(A.turn.running, A.thread.running, me, 'running', 1, 1),
    turn(A.turn.arabic, A.thread.arabic, me, 'done', 2, 120),
    turn(A.turn.talia, A.thread.talia, 'u-talia', 'done', 1, 60),
    turn(A.turn.list, A.thread.list, me, 'done', 1, 3),
  ];
  const whereIs = {
    data: {
      items: [
        {
          id: T.hdmiCable,
          short_code: '7KQ4MZ',
          location_id: L.home,
          untrusted: {
            name: 'HDMI cable, 2 m',
            path: ['Home', 'Office', 'Desk drawer', 'Cable box'],
          },
        },
        {
          id: T.cableBox,
          short_code: 'B0X3QF',
          location_id: L.home,
          untrusted: { name: 'Cable box', path: ['Home', 'Office', 'Desk drawer'] },
        },
      ],
    },
    as_of: ago(30),
  };
  const messages = [
    msg(
      A.thread.found,
      A.turn.found,
      'user',
      0,
      [{ type: 'text', text: 'Where is the HDMI cable?' }],
      30,
    ),
    msg(
      A.thread.found,
      A.turn.found,
      'assistant',
      1,
      [{ type: 'tool_call', callId: 'call_1', tool: 'where_is', input: { query: 'HDMI cable' } }],
      30,
    ),
    msg(
      A.thread.found,
      A.turn.found,
      'tool',
      1,
      [
        {
          type: 'tool_result',
          callId: 'call_1',
          tool: 'where_is',
          locationIds: [L.home],
          output: whereIs,
        },
      ],
      30,
    ),
    msg(
      A.thread.found,
      A.turn.found,
      'assistant',
      2,
      [
        {
          type: 'text',
          text: `The [HDMI cable, 2 m](kept:thing/${T.hdmiCable}) is in the [Cable box](kept:thing/${T.cableBox}), in Home › Office › Desk drawer. There are 3.`,
        },
      ],
      29,
    ),
    msg(
      A.thread.found,
      A.turn.proposed,
      'user',
      0,
      [{ type: 'text', text: 'Move 2 of them to Box 3' }],
      25,
    ),
    msg(
      A.thread.found,
      A.turn.proposed,
      'assistant',
      1,
      [{ type: 'proposal', proposalId: A.proposal.open }],
      25,
    ),
    msg(
      A.thread.running,
      A.turn.running,
      'user',
      0,
      [{ type: 'text', text: 'What is in the garage shelves?' }],
      1,
    ),
    msg(
      A.thread.running,
      A.turn.running,
      'assistant',
      1,
      [
        {
          type: 'tool_call',
          callId: 'call_9',
          tool: 'list_contents',
          input: { place_id: P.shelves, depth: 1 },
        },
      ],
      1,
    ),
    msg(
      A.thread.arabic,
      A.turn.arabic,
      'user',
      0,
      [{ type: 'text', text: 'وين كابل الـ HDMI؟' }],
      120,
    ),
    msg(
      A.thread.arabic,
      A.turn.arabic,
      'assistant',
      2,
      [
        {
          type: 'text',
          text: `[كابل HDMI](kept:thing/${T.arHdmi}) في غرفة المعيشة في بيت العائلة.`,
        },
      ],
      119,
    ),
    msg(
      A.thread.list,
      A.turn.list,
      'user',
      0,
      [{ type: 'text', text: 'In the garage I have a drill, a ladder and two paint cans' }],
      3,
    ),
    msg(
      A.thread.list,
      A.turn.list,
      'assistant',
      1,
      [{ type: 'proposal', proposalId: A.proposal.list }],
      3,
    ),
    msg(
      A.thread.talia,
      A.turn.talia,
      'user',
      0,
      [{ type: 'text', text: 'Can you move the kettle?' }],
      60,
    ),
    msg(
      A.thread.talia,
      A.turn.talia,
      'assistant',
      1,
      [{ type: 'text', text: "Viewers can't make changes here. Ask an admin of Home." }],
      60,
    ),
  ];
  const proposals = [
    move(A.proposal.open, A.batch.open, 'open', inMinutes(8)),
    move(A.proposal.expired, A.batch.expired, 'expired', ago(40)),
    {
      ...move(A.proposal.conflict, A.batch.conflict, 'conflict', inMinutes(6)),
      result: {
        conflict: {
          field: 'container_id',
          before: T.cableBox,
          now: T.box3,
          by: 'Bruce',
        },
      },
    },
    spokenList(),
  ];
  return { threads, turns, messages, proposals };
}

const states = new WeakMap<MockState, AssistantMockState>();

/** The assistant's mock state for a scenario, made on first use. */
export function assistantMock(state: MockState): AssistantMockState {
  let s = states.get(state);
  if (!s) {
    s = fixtures();
    states.set(state, s);
  }
  return s;
}
