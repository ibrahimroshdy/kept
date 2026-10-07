/**
 * A confirmation card's rows, drawn from each proposal's `args`, `before` and `refs` (D22, D179;
 * screens §5 "Confirmation card"). Never from model text: the verb and every field label are
 * Kept's own words (./confirm-card.tsx translates the keys here), and each value is the
 * argument the tool will run with, or the target's value when it was proposed. Ids are named
 * through `refs`, which the server looked up when it stored the proposal; values that came from
 * the model (a new thing's name, a person, a note) are user-level text, shown isolated.
 *
 * `add_thing` (D213: a spoken list) gives one row per item, each its own tick and editable name
 * and quantity; a place it names that doesn't exist yet is on the item's row as a new place.
 */
import type { Proposal, ProposalRef } from '@kept/shared';

export type Val =
  | { t: 'text'; v: string }
  | { t: 'path'; v: string[]; isNew?: boolean }
  | { t: 'num'; v: number; unit?: string }
  | { t: 'date'; v: string }
  | { t: 'money'; amount: string; currency: string }
  | { t: 'yes'; v: boolean }
  | { t: 'list'; v: string[] };

export type FieldKey =
  | 'from'
  | 'to'
  | 'place'
  | 'under'
  | 'type'
  | 'brand'
  | 'model'
  | 'notes'
  | 'name'
  | 'aliases'
  | 'condition'
  | 'custom'
  | 'reading'
  | 'when'
  | 'person'
  | 'due'
  | 'kind'
  | 'endsOn'
  | 'term'
  | 'provider'
  | 'reference'
  | 'status'
  | 'vendor'
  | 'total'
  | 'lines'
  | 'amount'
  | 'cost'
  | 'full'
  | 'value'
  | 'until'
  | 'delta'
  | 'quantity';

export type Field = { key: FieldKey; before?: Val; after: Val };

export type Verb =
  | 'move'
  | 'add'
  | 'change'
  | 'seen'
  | 'newPlace'
  | 'attach'
  | 'reading'
  | 'lend'
  | 'return'
  | 'borrow'
  | 'complete'
  | 'snooze'
  | 'warranty'
  | 'claim'
  | 'claimUpdate'
  | 'service'
  | 'fuel'
  | 'stock'
  | 'other';

export type Target =
  | { kind: 'thing' | 'place'; id: string; name: string }
  /** A thing or place the write creates: the name it will get. */
  | { kind: 'new'; name: string };

export type CardRow = {
  /** The proposal's id, or `<id>#<item>` for one item of an `add_thing`. */
  key: string;
  proposalId: string;
  /** The item's index in `args.items` (add_thing only). */
  item?: number;
  tool: string;
  verb: Verb;
  target: Target | null;
  /** "2 of 3 ×": how many, and of how many when only some move (move_thing). */
  count?: { n: number; of?: number };
  fields: Field[];
  /** The location the write happens in, and the destination's when a move crosses into another. */
  location: { from: string; to?: string };
  /** add_thing items: what the person may edit before confirming (D213). */
  editable?: { name: string; quantity: number };
};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A ref's full path: where it is, then its own name. */
const fullPath = (ref: ProposalRef | undefined): string[] | undefined =>
  ref ? [...ref.path, ref.name] : undefined;

function money(v: unknown): Val | undefined {
  const m = rec(v);
  const amount = typeof m.amount === 'number' ? String(m.amount) : str(m.amount);
  const currency = str(m.currency);
  return amount && currency ? { t: 'money', amount, currency } : undefined;
}

export function rowsOf(p: Proposal): CardRow[] {
  const a = rec(p.args);
  const b = rec(p.before);
  const refs = p.refs ?? {};
  const ref = (id: unknown) => (typeof id === 'string' ? refs[id] : undefined);
  const target = (id: unknown): Target | null => {
    const r = ref(id);
    return r && typeof id === 'string' && (r.kind === 'thing' || r.kind === 'place')
      ? { kind: r.kind, id, name: r.name }
      : null;
  };
  const here = refs[p.locationId]?.name ?? '';
  const base = { key: p.id, proposalId: p.id, tool: p.tool, location: { from: here } };
  const fields: Field[] = [];
  const push = (key: FieldKey, after: Val | undefined, before?: Val) => {
    if (after) fields.push(before ? { key, after, before } : { key, after });
  };
  const text = (v: unknown): Val | undefined => {
    const s = str(v);
    return s ? { t: 'text', v: s } : undefined;
  };
  const date = (v: unknown): Val | undefined => {
    const s = str(v);
    return s ? { t: 'date', v: s } : undefined;
  };
  const pathOf = (id: unknown): Val | undefined => {
    const path = fullPath(ref(id));
    return path ? { t: 'path', v: path } : undefined;
  };

  switch (p.tool) {
    case 'add_thing': {
      const items = Array.isArray(a.items) ? a.items.map(rec) : [];
      return items.map((item, i): CardRow => {
        const own: Field[] = [];
        const add = (key: FieldKey, after: Val | undefined) => {
          if (after) own.push({ key, after });
        };
        const np = rec(item.new_place);
        const newName = str(np.name);
        if (newName) {
          const parent = fullPath(ref(np.parent_id)) ?? (here ? [here] : []);
          add('place', { t: 'path', v: [...parent, newName], isNew: true });
        } else add('place', pathOf(item.place_id));
        add('type', text(item.type));
        add('brand', text(item.brand));
        add('model', text(item.model));
        add('notes', text(item.notes));
        const name = str(item.name) ?? '';
        const quantity = num(item.quantity) ?? 1;
        return {
          ...base,
          key: `${p.id}#${i}`,
          item: i,
          verb: 'add',
          target: { kind: 'new', name },
          ...(quantity > 1 ? { count: { n: quantity } } : {}),
          fields: own,
          editable: { name, quantity },
        };
      });
    }
    case 'move_thing': {
      const to = a.to_container_id ?? a.to_place_id;
      push('from', pathOf(b.container_id ?? b.place_id));
      push('to', pathOf(to));
      const n = num(a.quantity);
      const of = num(b.quantity);
      const toLocation = ref(to)?.path[0];
      return [
        {
          ...base,
          verb: 'move',
          target: target(a.thing_id),
          ...(n ? { count: of && of > n ? { n, of } : { n } } : {}),
          fields,
          location:
            toLocation && toLocation !== here ? { from: here, to: toLocation } : base.location,
        },
      ];
    }
    case 'update_thing': {
      const f = rec(a.fields);
      const was = (k: string): Val | undefined => {
        const v = b[k];
        if (Array.isArray(v)) return { t: 'list', v: v.filter((x) => typeof x === 'string') };
        return text(v) ?? (v === null && k in b ? { t: 'text', v: '' } : undefined);
      };
      const setTo = (k: string): Val | undefined => {
        const v = f[k];
        if (Array.isArray(v)) return { t: 'list', v: v.filter((x) => typeof x === 'string') };
        if (v === null) return { t: 'text', v: '' };
        return text(v);
      };
      for (const [k, key] of [
        ['name', 'name'],
        ['aliases', 'aliases'],
        ['notes', 'notes'],
        ['brand', 'brand'],
        ['model', 'model'],
        ['condition', 'condition'],
      ] as const)
        if (k in f) push(key, setTo(k), was(k));
      const custom = rec(f.custom);
      for (const [k, v] of Object.entries(custom))
        push('custom', { t: 'text', v: `${k}: ${v === null ? '' : String(v)}` });
      return [{ ...base, verb: 'change', target: target(a.thing_id), fields }];
    }
    case 'mark_seen':
      return [{ ...base, verb: 'seen', target: target(a.thing_id), fields }];
    case 'create_place':
      push('under', pathOf(a.parent_id) ?? (here ? { t: 'path', v: [here] } : undefined));
      return [
        {
          ...base,
          verb: 'newPlace',
          target: { kind: 'new', name: str(a.name) ?? '' },
          fields,
        },
      ];
    case 'attach_link':
      return [{ ...base, verb: 'attach', target: target(a.subject_id), fields }];
    case 'log_reading': {
      const value = num(a.value);
      const unit = str(b.unit);
      const before = num(b.value);
      if (value !== undefined)
        push(
          'reading',
          { t: 'num', v: value, ...(unit ? { unit } : {}) },
          before !== undefined ? { t: 'num', v: before, ...(unit ? { unit } : {}) } : undefined,
        );
      push('when', date(a.taken_at));
      return [{ ...base, verb: 'reading', target: target(a.thing_id), fields }];
    }
    case 'lend_thing':
      push('person', text(a.person));
      push('due', date(a.due_on));
      return [
        {
          ...base,
          verb: 'lend',
          target: target(a.thing_id),
          ...(num(a.quantity) ? { count: { n: num(a.quantity) as number } } : {}),
          fields,
        },
      ];
    case 'return_thing':
      return [{ ...base, verb: 'return', target: target(a.thing_id), fields }];
    case 'borrow_thing':
      push('person', text(a.person));
      push('place', pathOf(a.place_id));
      push('due', date(a.due_on));
      return [
        { ...base, verb: 'borrow', target: { kind: 'new', name: str(a.name) ?? '' }, fields },
      ];
    case 'complete_schedule':
    case 'snooze_schedule': {
      const r = ref(a.schedule_id);
      if (p.tool === 'complete_schedule') {
        push('when', date(a.done_on));
        if (num(a.value) !== undefined) push('value', { t: 'num', v: num(a.value) as number });
      } else {
        push('until', date(a.until_date));
        if (num(a.until_value) !== undefined)
          push('until', { t: 'num', v: num(a.until_value) as number });
      }
      return [
        {
          ...base,
          verb: p.tool === 'complete_schedule' ? 'complete' : 'snooze',
          target: r ? { kind: 'new', name: r.name } : null,
          fields,
        },
      ];
    }
    case 'add_warranty':
      push('kind', text(a.kind));
      push('endsOn', date(a.ends_on));
      if (num(a.term_months) !== undefined)
        push('term', { t: 'num', v: num(a.term_months) as number });
      push('provider', text(a.provider));
      return [{ ...base, verb: 'warranty', target: target(a.thing_id), fields }];
    case 'open_claim':
    case 'update_claim':
      push('reference', text(a.reference));
      push('status', text(a.status), text(b.status));
      return [
        {
          ...base,
          verb: p.tool === 'open_claim' ? 'claim' : 'claimUpdate',
          target: target(a.thing_id),
          fields,
        },
      ];
    case 'log_service': {
      push('when', date(a.serviced_on));
      push('vendor', text(a.vendor));
      push('total', money(a.total));
      const lines = Array.isArray(a.lines)
        ? a.lines.map((l) => str(rec(l).description)).filter((x): x is string => !!x)
        : [];
      if (lines.length) push('lines', { t: 'list', v: lines });
      return [{ ...base, verb: 'service', target: target(a.thing_id ?? a.place_id), fields }];
    }
    case 'log_fuel': {
      const amount = num(a.amount);
      if (amount !== undefined)
        push('amount', { t: 'num', v: amount, ...(str(a.unit) ? { unit: str(a.unit) } : {}) });
      push('cost', money(a.cost));
      if (typeof a.full === 'boolean') push('full', { t: 'yes', v: a.full });
      if (num(a.reading) !== undefined) push('reading', { t: 'num', v: num(a.reading) as number });
      return [{ ...base, verb: 'fuel', target: target(a.thing_id), fields }];
    }
    case 'adjust_stock':
      if (num(a.delta) !== undefined) push('delta', { t: 'num', v: num(a.delta) as number });
      return [{ ...base, verb: 'stock', target: target(a.thing_id), fields }];
    default:
      return [{ ...base, verb: 'other', target: target(a.thing_id), fields }];
  }
}

/** A card's rows, in the order the proposals came. */
export function cardRows(proposals: readonly Proposal[]): CardRow[] {
  return proposals.flatMap(rowsOf);
}

/** When the card stops taking Confirm: the soonest expiry of its open proposals. */
export function cardExpiry(proposals: readonly Proposal[]): number | null {
  const open = proposals.filter((p) => p.status === 'open').map((p) => Date.parse(p.expiresAt));
  return open.length ? Math.min(...open) : null;
}
