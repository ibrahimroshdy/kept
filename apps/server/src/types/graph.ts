import type { Capability, FieldKind } from '@kept/shared';
import type pg from 'pg';
import type { ResolvedField } from './view.js';

// An account's type tree in memory (T11; D92, D154, D192; plan Q4): the built-ins and the
// account's own types, with their own fields. Everything the type editor answers is resolved
// from it: a type's fields along its chain and field groups, its capabilities, its descendants,
// and whether a change would bring a field key in twice or put a type under itself. The
// database's guards (0014, 0024) refuse the same things; checking here first lets a 409 say
// which (`reason`, `key`: the T28 contract decision), and the guards stay the backstop for races.
// The library is ~100 rows and an account adds tens, so loading it per request is cheap.

export type TypeRow = {
  id: string;
  owner_account_id: string | null;
  builtin_key: string | null;
  copied_from_id: string | null;
  parent_id: string | null;
  name: string | null;
  icon: string;
  colour: string | null;
  capabilities: Capability[];
  default_meter: { kind: string; unit: string } | null;
  is_field_group: boolean;
  field_groups: string[];
  default_warranty_months: number | null;
  archived_at: Date | null;
  row_version: number;
};

export type FieldRow = {
  id: string;
  owner_account_id: string | null;
  type_id: string | null;
  place_kind_id: string | null;
  key: string;
  label: string | null;
  kind: FieldKind;
  unit: string | null;
  options: string[] | null;
  repeatable: boolean;
  required: boolean;
  sort: number;
  secret: boolean;
  archived_at: Date | null;
  row_version: number;
};

export const TYPE_COLUMNS = `t.id, t.owner_account_id, t.builtin_key, t.copied_from_id, t.parent_id,
  t.name, t.icon, t.colour, t.capabilities, t.default_meter, t.is_field_group, t.field_groups,
  t.default_warranty_months, t.archived_at, t.row_version`;
export const FIELD_COLUMNS = `f.id, f.owner_account_id, f.type_id, f.place_kind_id, f.key, f.label,
  f.kind, f.unit, f.options, f.repeatable, f.required, f.sort, f.secret, f.archived_at,
  f.row_version`;

/** A key a change would define twice along a chain (D92, §7.13). */
export class Redefined extends Error {
  constructor(readonly key: string) {
    super(`field ${key} is defined twice`);
    this.name = 'Redefined';
  }
}

/** A field as the API shows it, from the point of view of the type that resolves it. */
export function fieldOf(
  f: FieldRow,
  via: ResolvedField['source']['via'],
  sourceId: string,
): ResolvedField {
  return {
    id: f.id,
    key: f.key,
    label: f.label,
    labelKey: f.label === null ? f.key : null,
    kind: f.kind,
    unit: f.unit,
    options: f.options,
    repeatable: f.repeatable,
    required: f.required,
    secret: f.secret,
    sort: f.sort,
    archivedAt: f.archived_at ? f.archived_at.toISOString() : null,
    source: { typeId: sourceId, via },
    rowVersion: f.row_version,
  };
}

const byOrder = (a: FieldRow, b: FieldRow) => a.sort - b.sort || a.key.localeCompare(b.key);

/** What a pending change does to one type, for the checks. */
export type TypePatch = { parentId?: string | null; fieldGroups?: string[]; extraOwn?: FieldRow[] };

export class TypeGraph {
  readonly types = new Map<string, TypeRow>();
  readonly own = new Map<string, FieldRow[]>();
  readonly children = new Map<string, string[]>();

  constructor(types: TypeRow[], fields: FieldRow[]) {
    for (const t of types) this.types.set(t.id, t);
    for (const t of types) {
      if (t.parent_id)
        this.children.set(t.parent_id, [...(this.children.get(t.parent_id) ?? []), t.id]);
    }
    for (const f of fields) {
      if (!f.type_id) continue;
      this.own.set(f.type_id, [...(this.own.get(f.type_id) ?? []), f]);
    }
    for (const list of this.own.values()) list.sort(byOrder);
  }

  /** The built-ins and `accountId`'s own types (NULL: the built-ins alone), as the caller sees them. */
  static async load(client: pg.ClientBase, accountId: string | null): Promise<TypeGraph> {
    const { rows: types } = await client.query<TypeRow>(
      `SELECT ${TYPE_COLUMNS} FROM public.types t
        WHERE t.owner_account_id IS NULL OR t.owner_account_id = $1`,
      [accountId],
    );
    const { rows: fields } = await client.query<FieldRow>(
      `SELECT ${FIELD_COLUMNS} FROM public.type_fields f
        WHERE f.type_id IS NOT NULL AND (f.owner_account_id IS NULL OR f.owner_account_id = $1)`,
      [accountId],
    );
    return new TypeGraph(types, fields);
  }

  get(id: string | null | undefined): TypeRow | undefined {
    return id ? this.types.get(id) : undefined;
  }

  /** Set on built-ins and on an account's customised copies of them (Q13b). */
  builtinKeyOf(t: TypeRow): string | null {
    return t.builtin_key ?? this.get(t.copied_from_id)?.builtin_key ?? null;
  }

  /** Everything under `id`, depth first. */
  descendants(id: string): TypeRow[] {
    const out: TypeRow[] = [];
    const walk = (pid: string, depth: number) => {
      if (depth > 64) return;
      for (const c of this.children.get(pid) ?? []) {
        const row = this.types.get(c);
        if (!row) continue;
        out.push(row);
        walk(c, depth + 1);
      }
    };
    walk(id, 0);
    return out;
  }

  /** Whether putting `id` under `parentId` would make a loop (D92). */
  wouldLoop(id: string, parentId: string | null): boolean {
    let cur = this.get(parentId);
    for (let depth = 0; cur && depth < 66; depth++) {
      if (cur.id === id) return true;
      cur = this.get(cur.parent_id);
    }
    return false;
  }

  private parentOf(t: TypeRow, patch: Map<string, TypePatch>): TypeRow | undefined {
    const p = patch.get(t.id);
    return this.get(p && p.parentId !== undefined ? p.parentId : t.parent_id);
  }

  private groupsOf(t: TypeRow, patch: Map<string, TypePatch>): string[] {
    return patch.get(t.id)?.fieldGroups ?? t.field_groups;
  }

  private ownOf(t: TypeRow, patch: Map<string, TypePatch>): FieldRow[] {
    return [...(this.own.get(t.id) ?? []), ...(patch.get(t.id)?.extraOwn ?? [])];
  }

  /** `t`'s chain, root first. */
  chain(t: TypeRow, patch = new Map<string, TypePatch>()): TypeRow[] {
    const out: TypeRow[] = [];
    for (
      let cur: TypeRow | undefined = t;
      cur && out.length < 66;
      cur = this.parentOf(cur, patch)
    ) {
      out.unshift(cur);
    }
    return out;
  }

  /**
   * `t`'s fields in display order: for each type from the root down, its own fields and then its
   * field groups' (a group once). `via` is from `t`'s point of view. Throws Redefined on a key
   * defined twice.
   */
  fields(t: TypeRow, patch = new Map<string, TypePatch>()): ResolvedField[] {
    const out: ResolvedField[] = [];
    const seen = new Set<string>();
    const groups = new Set<string>();
    const add = (f: FieldRow, via: 'own' | 'inherited' | 'group', sourceId: string) => {
      if (seen.has(f.key)) throw new Redefined(f.key);
      seen.add(f.key);
      out.push(fieldOf(f, via, sourceId));
    };
    for (const link of this.chain(t, patch)) {
      for (const f of this.ownOf(link, patch))
        add(f, link.id === t.id ? 'own' : 'inherited', link.id);
      for (const gid of this.groupsOf(link, patch)) {
        if (groups.has(gid)) continue;
        groups.add(gid);
        const g = this.get(gid);
        if (!g) continue;
        for (const f of this.ownOf(g, patch)) add(f, 'group', g.id);
      }
    }
    return out;
  }

  /** Own plus inherited capabilities, through parents and field groups, in library order. */
  capabilities(t: TypeRow): Capability[] {
    const caps = new Set<Capability>();
    for (const link of this.chain(t)) {
      for (const c of link.capabilities) caps.add(c);
      for (const gid of link.field_groups)
        for (const c of this.get(gid)?.capabilities ?? []) caps.add(c);
    }
    return [...caps];
  }

  /**
   * Throws Redefined when `patch` (on `t`) would define a key twice along `t`'s chain or that of
   * anything that resolves through it: its descendants and, for a group, the types carrying it.
   */
  check(t: TypeRow, patch: TypePatch): void {
    const patches = new Map<string, TypePatch>([[t.id, patch]]);
    const affected = new Set<string>([t.id]);
    for (const d of this.descendants(t.id)) affected.add(d.id);
    if (t.is_field_group) {
      for (const x of this.types.values()) {
        if (x.field_groups.includes(t.id)) {
          affected.add(x.id);
          for (const d of this.descendants(x.id)) affected.add(d.id);
        }
      }
    }
    for (const id of affected) {
      const row = this.types.get(id);
      if (row) this.fields(row, patches);
    }
  }
}
