import { MODULE_IDS } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FORBIDDEN_TOOL_NAME,
  idOrCode,
  isToolName,
  parseRef,
  TOOL_DEFS,
  TOOL_NAMES,
  type ToolDef,
} from './tools.js';

const defs = Object.entries(TOOL_DEFS) as [string, ToolDef][];

/** The table in the step-6 plan, task 1 step 1. */
const TABLE: Record<string, [scope: 'read' | 'write', module: string | null, since: number]> = {
  capabilities: ['read', null, 6],
  list_locations: ['read', null, 6],
  search_things: ['read', null, 6],
  where_is: ['read', null, 6],
  get_thing: ['read', null, 6],
  list_contents: ['read', null, 6],
  thing_history: ['read', null, 6],
  find_documents: ['read', null, 6],
  upcoming: ['read', 'schedules', 4],
  add_thing: ['write', null, 6],
  update_thing: ['write', null, 6],
  move_thing: ['write', null, 6],
  mark_seen: ['write', null, 6],
  create_place: ['write', null, 6],
  attach_link: ['write', null, 6],
  log_reading: ['write', null, 6],
  lend_thing: ['write', 'lending', 4],
  return_thing: ['write', 'lending', 4],
  borrow_thing: ['write', 'lending', 4],
  complete_schedule: ['write', 'schedules', 4],
  snooze_schedule: ['write', 'schedules', 4],
  add_warranty: ['write', 'warranties', 4],
  open_claim: ['write', 'warranties', 4],
  update_claim: ['write', 'warranties', 4],
  log_service: ['write', null, 5],
  log_fuel: ['write', 'fuel', 5],
  adjust_stock: ['write', 'consumables', 7],
};

describe('TOOL_DEFS', () => {
  it('is exactly the plan’s table: scope, module and step', () => {
    expect(Object.keys(TOOL_DEFS).sort()).toEqual(Object.keys(TABLE).sort());
    for (const [name, d] of defs) expect([d.scope, d.module, d.since]).toEqual(TABLE[name]);
    expect(TOOL_NAMES).toHaveLength(27);
  });

  it('has no tool that trashes, deletes, merges, transfers, reveals, uploads or runs SQL', () => {
    for (const name of TOOL_NAMES) expect(name).not.toMatch(FORBIDDEN_TOOL_NAME);
    expect('trash_thing').toMatch(FORBIDDEN_TOOL_NAME);
    expect('reveal_secret').toMatch(FORBIDDEN_TOOL_NAME);
  });

  it('keys each entry by its own name, snake_case, frozen', () => {
    expect(Object.isFrozen(TOOL_DEFS)).toBe(true);
    for (const [key, d] of defs) {
      expect(d.name).toBe(key);
      expect(key).toMatch(/^[a-z][a-z_]{2,40}$/);
      expect(Object.isFrozen(d)).toBe(true);
      expect(isToolName(key)).toBe(true);
    }
    expect(isToolName('toString')).toBe(false);
  });

  it('names a real module or none', () => {
    for (const [, d] of defs) if (d.module) expect(MODULE_IDS).toContain(d.module);
  });

  it('annotates reads read-only and nothing destructive or open-world', () => {
    for (const [, d] of defs) {
      expect(d.annotations.readOnlyHint).toBe(d.scope === 'read');
      expect(d.annotations.destructiveHint).toBe(false);
      expect(d.annotations.openWorldHint).toBe(false);
      if (d.scope === 'read') expect(d.annotations.idempotentHint).toBe(true);
    }
    expect(TOOL_DEFS.mark_seen.annotations.idempotentHint).toBe(true);
    expect(TOOL_DEFS.move_thing.annotations.idempotentHint).toBe(false);
  });

  it('describes each tool in English, as the question it answers', () => {
    for (const [, d] of defs) {
      expect(d.title.length).toBeGreaterThan(2);
      expect(d.description).toMatch(/^[A-Z].{15,200}[.?]$/);
    }
  });

  it('takes an optional location_id on every tool but the location-free ones', () => {
    for (const [name, d] of defs) {
      const shape = (d.input as z.ZodObject).shape;
      if (name === 'capabilities' || name === 'list_locations') expect(shape).toEqual({});
      else expect(shape.location_id?.safeParse(undefined).success).toBe(true);
    }
  });

  it('turns every input and output into JSON Schema (what MCP and the model are sent)', () => {
    for (const [, d] of defs) {
      expect(() => z.toJSONSchema(d.input, { io: 'input' })).not.toThrow();
      expect(() => z.toJSONSchema(d.output)).not.toThrow();
    }
  });

  it('keeps user-written names under untrusted in outputs', () => {
    const json = JSON.stringify(z.toJSONSchema(TOOL_DEFS.where_is.output));
    expect(json).toContain('"untrusted"');
    const thing = TOOL_DEFS.get_thing.output.shape.thing.shape;
    expect(Object.keys(thing)).not.toContain('name');
    expect(Object.keys(thing.untrusted.shape)).toEqual(
      expect.arrayContaining(['name', 'path', 'notes']),
    );
  });

  it('adds a spoken list in one call (D213): 1 to 20 items, a new place allowed', () => {
    const input = TOOL_DEFS.add_thing.input;
    const three = {
      items: [
        { name: 'Drill', new_place: { name: 'Garage' } },
        { name: 'Ladder' },
        { name: 'Paint can', quantity: 2 },
      ],
    };
    expect(input.safeParse(three).success).toBe(true);
    expect(input.safeParse({ items: [] }).success).toBe(false);
    expect(input.safeParse({ items: Array(21).fill({ name: 'x' }) }).success).toBe(false);
  });

  it('refuses an empty update and a zero stock delta', () => {
    expect(TOOL_DEFS.update_thing.input.safeParse({ thing_id: 'K7D2QX', fields: {} }).success).toBe(
      false,
    );
    expect(TOOL_DEFS.adjust_stock.input.safeParse({ thing_id: 'K7D2QX', delta: 0 }).success).toBe(
      false,
    );
  });
});

describe('idOrCode and parseRef', () => {
  it.each([
    [
      '0192a1b2-0000-7000-8000-000000000001',
      { kind: 'id', id: '0192a1b2-0000-7000-8000-000000000001' },
    ],
    [
      '0192A1B2-0000-7000-8000-00000000000A',
      { kind: 'id', id: '0192a1b2-0000-7000-8000-00000000000a' },
    ],
    ['K7D2QX', { kind: 'code', code: 'K7D2QX' }],
    ['k7d-2qx', { kind: 'code', code: 'K7D2QX' }],
    ['k7d‑2qx', { kind: 'code', code: 'K7D2QX' }],
    ['ko1l2q', { kind: 'code', code: 'K0112Q' }],
    ['drill', null],
    ['K7D2Q', null],
    ['', null],
  ])('%s', (input, expected) => {
    expect(parseRef(input)).toEqual(expected);
    expect(idOrCode.safeParse(input).success).toBe(expected !== null);
  });
});
