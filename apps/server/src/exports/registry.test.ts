import { EXPORT_ENTITIES } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx } from '../../test/tenancy.js';
import { entitySchema } from './format.js';
import {
  EXPORTED_ENTITIES,
  type FieldKind,
  fieldsOf,
  HISTORY_ENTITY,
  NOT_EXPORTED,
  OMIT_REASONS,
  omittedOf,
  REGISTRY,
} from './registry.js';

// D69, plan Q24: the export registry names every location-scoped table (and every account
// registry beside them), exported or left out with a reason, and every column of an exported
// table is a field of the right kind or omitted with a reason. A table or column a later step
// adds fails here until it is decided.

const db = await testDb();

type Column = { table: string; column: string; type: string };

const KIND_OF_TYPE: Record<string, FieldKind> = {
  uuid: 'uuid',
  'uuid[]': 'uuids',
  text: 'text',
  'text[]': 'texts',
  integer: 'int',
  smallint: 'int',
  bigint: 'int',
  boolean: 'bool',
  date: 'date',
  'timestamp with time zone': 'ts',
  jsonb: 'json',
  'double precision': 'float',
  'time without time zone': 'time',
};
const kindOf = (type: string): FieldKind | undefined =>
  KIND_OF_TYPE[type] ??
  (type.startsWith('numeric') ? 'dec' : type.startsWith('character') ? 'text' : undefined);

async function catalogue(): Promise<{ scoped: Set<string>; columns: Column[] }> {
  return ownerTx(db, async (c) => {
    const { rows } = await c.query<{ table: string; column: string; type: string }>(
      `SELECT cl.relname AS table, a.attname AS column,
              format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_class cl
         JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE cl.relkind IN ('r', 'p') AND NOT cl.relispartition
        ORDER BY cl.relname, a.attnum`,
    );
    const byTable = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = byTable.get(r.table) ?? new Set();
      set.add(r.column);
      byTable.set(r.table, set);
    }
    const scoped = new Set(
      [...byTable]
        .filter(([, cols]) => cols.has('location_id') || cols.has('owner_account_id'))
        .map(([t]) => t),
    );
    scoped.delete('locations');
    return { scoped, columns: rows };
  });
}

describe('the export registry', () => {
  it('decides every location-scoped and account table', async () => {
    const { scoped } = await catalogue();
    const exported = new Set(REGISTRY.map((d) => d.table));
    const undecided = [...scoped].filter((t) => !exported.has(t) && !(t in NOT_EXPORTED));
    expect(undecided).toEqual([]);
    const both = [...exported].filter((t) => t in NOT_EXPORTED);
    expect(both).toEqual([]);
  });

  it('names every column of an exported table, each field with its kind', async () => {
    const { columns } = await catalogue();
    const problems: string[] = [];
    for (const def of REGISTRY) {
      const cols = columns.filter((c) => c.table === def.table);
      expect(cols.length, def.table).toBeGreaterThan(0);
      const fields = new Map(fieldsOf(def).map((f) => [f.column, f]));
      const omitted = new Set(omittedOf(def));
      for (const c of cols) {
        const field = fields.get(c.column);
        if (field) {
          if (kindOf(c.type) !== field.kind) {
            problems.push(`${def.entity}.${c.column}: ${c.type} is not ${field.kind}`);
          }
        } else if (!omitted.has(c.column)) {
          problems.push(`${def.entity}.${c.column}: neither a field nor omitted`);
        } else if (!OMIT_REASONS[c.column]) {
          problems.push(`${def.entity}.${c.column}: omitted with no reason`);
        }
      }
      for (const f of fields.keys()) {
        if (!cols.some((c) => c.column === f)) problems.push(`${def.entity}.${f}: no such column`);
      }
      for (const k of def.key) {
        if (!cols.some((c) => c.column === k)) problems.push(`${def.entity}: key ${k} missing`);
      }
      for (const m of def.money ?? []) {
        if (!fields.has(m)) problems.push(`${def.entity}: money ${m} is not a field`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('writes every shared entity, in the shared order, history last', () => {
    expect(EXPORTED_ENTITIES).toEqual([...EXPORT_ENTITIES]);
    expect(EXPORTED_ENTITIES.at(-1)).toBe(HISTORY_ENTITY);
    expect(new Set(REGISTRY.map((d) => d.entity)).size).toBe(REGISTRY.length);
  });

  it('gives each entity a row schema', () => {
    for (const def of REGISTRY) {
      const schema = entitySchema(def.entity);
      const row = Object.fromEntries(fieldsOf(def).map((f) => [f.name, null]));
      expect(schema.safeParse(row).success, def.entity).toBe(
        def.entity !== 'location' && def.entity !== 'types',
      );
    }
  });
});
