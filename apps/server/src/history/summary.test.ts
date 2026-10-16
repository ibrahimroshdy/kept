import { AUDIT_ACTIONS, LEGACY_AUDIT_ACTIONS, SUMMARY_KEYS, SUMMARY_LINE_KEYS } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import type { RenderedAuditEvent } from '../audit/render.js';
import { type ArrangedNode, arrangeLines } from './arrange.js';
import { englishOf, linesOf, summarise } from './summary.js';

// #140: every action the server writes reads as a sentence of its own. AuditEventInput takes
// only @kept/shared's AUDIT_ACTIONS (a write with a new action fails the typecheck until it is
// listed), ENGLISH is typed by them (a listed action without English fails it too), and this
// checks what the types can't: that each one says something other than the fallback.

const ev = (action: string, diff: RenderedAuditEvent['diff'] = null): RenderedAuditEvent => ({
  id: '00000000-0000-7000-8000-000000000001',
  at: '2026-10-16T10:00:00.000Z',
  location_id: '00000000-0000-7000-8000-000000000002',
  action,
  actor: { type: 'user', id: null },
  entity: { type: action.split('.')[0] as string, id: '00000000-0000-7000-8000-000000000003' },
  root_thing_id: null,
  diff,
  undo_of: null,
  undoable_until: null,
});
const plain = (before: unknown, after: unknown) => ({ before, after, class: 'plain' as const });

describe('summaries (#140)', () => {
  it('gives every audit action a sentence of its own, never the fallback', () => {
    for (const action of [...AUDIT_ACTIONS, ...LEGACY_AUDIT_ACTIONS]) {
      const s = summarise(ev(action), { name: 'Desk lamp' });
      expect(s.summaryKey, action).not.toBe('event');
      expect(s.summaryKey, action).toBe(action);
      expect(s.summary, action).not.toMatch(/\{|undefined|_/);
    }
  });

  it('has English for every key and every line', () => {
    for (const key of SUMMARY_KEYS) {
      expect(englishOf(key, { name: 'Desk lamp', count: '2', action: 'x.y' }), key).toBeTruthy();
    }
    expect(new Set(SUMMARY_KEYS).size).toBe(SUMMARY_KEYS.length);
    expect(SUMMARY_LINE_KEYS.length).toBeGreaterThan(0);
  });

  it('keeps the fallback for an action this build does not know', () => {
    const s = summarise(ev('gizmo.frobnicate'), { name: null });
    expect(s).toMatchObject({
      summaryKey: 'event',
      summaryParams: { action: 'gizmo.frobnicate' },
      summary: 'Gizmo frobnicate',
    });
  });

  it('refines a capture, a photo, a report and a label batch by what the row says', () => {
    const name = { name: 'Wireless keyboard' };
    expect(
      summarise(ev('thing.capture', { file_ids: plain(null, ['f']), name: plain(null, 'x') }), name)
        .summary,
    ).toBe('Captured Wireless keyboard from a photo');
    expect(
      summarise(ev('thing.capture', { attachment_ids: plain(null, ['a']) }), name).summary,
    ).toBe('Added a photo to Wireless keyboard');
    expect(summarise(ev('attachment.create', { role: plain(null, 'photo') }), name).summary).toBe(
      'Added a photo to Wireless keyboard',
    );
    expect(
      summarise(ev('report.generate', { kind: plain(null, 'insurance') }), { name: 'Beach house' })
        .summary,
    ).toBe('Made an insurance report for Beach house');
    expect(
      summarise(
        ev('label_batch.create', { kind: plain(null, 'blank'), code_count: plain(null, 24) }),
        { name: null },
      ).summary,
    ).toBe('Made 24 blank labels');
    expect(summarise(ev('inbox.discard'), { name: null }).summary).toBe('Discarded a draft');
    expect(summarise(ev('capture.batch_undo'), { name: null }).summary).toBe('Undid a capture');
  });
});

describe('detail lines: the field table in words (#140)', () => {
  it("names a report's things and photos, a trash's contents and an undone capture's things", () => {
    const report = ev('report.generate', {
      include: plain(null, { photos: true }),
      filters: plain(null, { thingIds: ['a', 'b', 'c'] }),
      locale: plain(null, 'en'),
      digits: plain(null, 'arab'),
    });
    expect(linesOf(report)).toEqual([
      { key: 'line.things', params: { count: '3' } },
      { key: 'line.photos', params: {} },
    ]);
    const trash = ev('place.trash', { trashed: plain(null, 4), moved: plain(null, 0) });
    expect(summarise(trash, { name: 'Shelf 2' }).summaryLines?.map((l) => l.text)).toEqual([
      'With 3 things inside',
    ]);
    const undone = ev('capture.batch_undo', { trashed: plain([], ['a']) });
    expect(summarise(undone, { name: null }).summaryLines?.map((l) => l.text)).toEqual(['1 thing']);
    expect(linesOf(ev('thing.update', { name: plain('a', 'b') }))).toEqual([]);
  });
});

describe('arrangements in words (#140)', () => {
  const n = (id: string, more: Partial<ArrangedNode> = {}): ArrangedNode => ({
    id,
    s: 'thing',
    x: 0,
    z: 0,
    w: null,
    d: null,
    rot: 0,
    model: 'device',
    kind: null,
    surface: null,
    host: null,
    ...more,
  });
  const room = (id: string, more: Partial<ArrangedNode> = {}) =>
    n(id, { s: 'place', model: null, kind: 'room', surface: 'wood', w: 300, d: 400, ...more });
  const names = new Map([
    ['webcam', { name: 'HD webcam', room: 'Study' }],
    ['desk', { name: 'Corner desk', room: 'Study' }],
    ['shelf', { name: 'Shelf 2', room: 'Study' }],
    ['tv', { name: 'TV', room: 'Lounge' }],
    ['study', { name: 'Study', room: null }],
  ]);
  const text = (lines: ReturnType<typeof arrangeLines>) =>
    lines.map((l) => `${l.key} ${JSON.stringify(l.params)}`);

  it('puts on and takes off the map, and onto and off a host', () => {
    expect(text(arrangeLines([], [n('webcam')], names))).toEqual([
      'map.put.room {"name":"HD webcam","room":"Study"}',
    ]);
    expect(text(arrangeLines([n('webcam')], [], names))).toEqual([
      'map.remove {"name":"HD webcam"}',
    ]);
    expect(
      text(
        arrangeLines([n('desk'), n('webcam')], [n('desk'), n('webcam', { host: 'desk' })], names),
      ),
    ).toEqual(['map.on {"name":"HD webcam","host":"Corner desk"}']);
    expect(
      text(
        arrangeLines([n('desk'), n('webcam', { host: 'desk' })], [n('desk'), n('webcam')], names),
      ),
    ).toEqual(['map.off {"name":"HD webcam","host":"Corner desk"}']);
  });

  it('moves, turns and changes shape; a hosted thing moving with its host says nothing', () => {
    expect(
      text(
        arrangeLines(
          [n('desk'), n('webcam', { host: 'desk' }), n('tv'), n('shelf', { model: 'desk' })],
          [
            n('desk', { x: 50 }),
            n('webcam', { host: 'desk', x: 50 }),
            n('tv', { rot: 90 }),
            n('shelf', { model: 'webcam' }),
          ],
          names,
        ),
      ),
    ).toEqual([
      'map.move {"name":"Corner desk"}',
      'map.shape {"name":"Shelf 2","from":"desk","to":"webcam","vocab":"model"}',
      'map.turn {"name":"TV"}',
    ]);
  });

  it('says what changed in a room', () => {
    expect(
      text(
        arrangeLines(
          [room('study')],
          [room('study', { w: 350, kind: 'balcony', surface: 'tile' })],
          names,
        ),
      ),
    ).toEqual([
      'map.resize {"name":"Study"}',
      'map.kind {"name":"Study","from":"room","to":"balcony","vocab":"kind"}',
      'map.floor {"name":"Study","from":"wood","to":"tile","vocab":"surface"}',
    ]);
    expect(text(arrangeLines([], [room('study')], names))).toEqual(['map.put {"name":"Study"}']);
  });

  it('names nothing the reader cannot see', () => {
    expect(text(arrangeLines([], [n('hidden'), n('elsewhere', { s: 'place' })], names))).toEqual([
      'map.put {"name":"a place"}',
      'map.put {"name":"a thing"}',
    ]);
  });

  it('collapses more than five changes into a count', () => {
    const many = ['a', 'b', 'c'].map((id) => n(id));
    const s = summarise(
      ev('place.arrange', {
        layout: plain(
          many,
          many.map((x) => ({ ...x, x: 9, rot: 90 })),
        ),
      }),
      { name: 'Home', nodes: new Map() },
    );
    expect(s.summaryKey).toBe('place.arrange.many');
    expect(s.summary).toBe('Arranged the map: 6 changes');
    expect(s.summaryLines).toHaveLength(6);
    const few = summarise(ev('place.arrange', { layout: plain([], [n('webcam')]) }), {
      name: 'Home',
      nodes: names,
    });
    expect(few.summary).toBe('Arranged the map');
    expect(few.summaryLines?.map((l) => l.text)).toEqual(['Put HD webcam on the map in Study']);
  });
});
