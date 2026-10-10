/**
 * The tool set (D22, D63, D124, D172, D213; engineering spec §2.5). One registry serves the
 * assistant and MCP: this file holds each tool's contract, `apps/server/src/tools/` its handler.
 *
 * - `scope`: a `read` tool is offered to every principal; a `write` tool only where the principal
 *   may write (a write token, a member or better, D123).
 * - `module`: the tool is offered in a location only while that module is effective there
 *   (D113); `null` is the core.
 * - `since`: the step whose service backs the tool (step-6 plan Q10). The contract lands now; the
 *   handler lands with that step, and `capabilities` never lists a tool without one.
 * - `input` is what the model or the MCP client sends (snake_case, §2.5). Ids are UUIDs or
 *   6-character short IDs (`idOrCode`), read through `normaliseInputCode`. `location_id` is
 *   optional where the principal has one location (D179).
 * - `output` is the shape of the envelope's `data` (output.ts). Every user-written string sits
 *   under an `untrusted` key (D179).
 * - Descriptions are the question a tool answers, in English only: the model reads them, the UI
 *   never shows them.
 *
 * No tool trashes, deletes, merges, transfers ownership, reveals a secret, uploads a file or runs
 * SQL (D58, D63, D124); `tools.test.ts` walks the names.
 */

import {
  ATTACHMENT_ROLES,
  BUILTIN_PLACE_KINDS,
  CLAIM_STATUSES,
  CONDITIONS,
  DERIVED_STATES,
  isShortCode,
  LIFECYCLES,
  MODULE_IDS,
  type ModuleId,
  normaliseInputCode,
  ROLES,
  WARRANTY_KINDS,
} from '@kept/shared';
import { z } from 'zod';

export const TOOL_SCOPES = ['read', 'write'] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];

/** The steps whose services back a tool (Q10). */
export const TOOL_SINCE = [4, 5, 6, 7] as const;
export type ToolSince = (typeof TOOL_SINCE)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A reference a person or a model typed: a UUID, or a short ID in any spelling a person uses. */
export type ParsedRef = { kind: 'id'; id: string } | { kind: 'code'; code: string };

/** Reads an `idOrCode` value: a UUID as is (lower case), otherwise a normalised short ID. */
export function parseRef(value: string): ParsedRef | null {
  const v = value.trim();
  if (UUID.test(v)) return { kind: 'id', id: v.toLowerCase() };
  const code = normaliseInputCode(v);
  return isShortCode(code) ? { kind: 'code', code } : null;
}

/** A thing, place or container: its UUID or its short ID. */
export const idOrCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((v) => parseRef(v) !== null, { message: 'a UUID or a 6-character short ID' })
  .describe('An id (UUID) or a 6-character short ID such as K7D2QX');

const uuid = z.uuid();
const isoDate = z.iso.date().describe('A date, YYYY-MM-DD, in the location’s time zone');
const isoDateTime = z.iso.datetime({ offset: true });
const locationId = uuid
  .optional()
  .describe('The location. Leave it out when you have access to one location only');
const cursor = z.string().min(1).max(2400).optional().describe('next_cursor from the last page');
const limit = z.number().int().min(1).max(200).optional().describe('Items per page: 20 unless set');
/** A decimal amount as a string ("450.00") and its ISO 4217 currency. */
const money = z.object({
  amount: z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const shortText = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------------------------
// Output building blocks. Kept's own words (ids, codes, enums, dates, numbers) sit beside
// `untrusted`, which holds only what people wrote (D179).

/** A thing as every output cites it: ids, and its name and place path as untrusted text. */
export const thingRef = z.object({
  id: uuid,
  short_code: z.string().nullable(),
  location_id: uuid,
  untrusted: z.object({
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    /** Place names from the location down to the thing's container. */
    path: z.array(z.string()),
  }),
});
export type ThingRef = z.infer<typeof thingRef>;

export const placeRef = z.object({
  id: uuid,
  short_code: z.string().nullable(),
  location_id: uuid,
  kind: z.string(),
  untrusted: z.object({ name: z.string(), path: z.array(z.string()) }),
});
export type PlaceRef = z.infer<typeof placeRef>;

const locationRef = z.object({
  id: uuid,
  role: z.enum(ROLES),
  time_zone: z.string(),
  untrusted: z.object({ name: z.string() }),
});

const loan = z.object({
  direction: z.enum(['out', 'in']),
  due_on: z.string().nullable(),
  untrusted: z.object({ person: z.string() }),
});

const thingSummary = thingRef.extend({
  quantity: z.number(),
  lifecycle: z.enum(LIFECYCLES),
  states: z.array(z.enum(DERIVED_STATES)),
  last_seen_at: z.string().nullable(),
  loan: loan.optional(),
  matched_by: z.enum(['keyword', 'meaning']).optional(),
});

/** What every write answers: the audit event, and until when it can be undone (7 days, D58). */
const writeResult = z.object({
  audit_event_id: uuid,
  undo_until: z.string().nullable(),
});

const list = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

// ---------------------------------------------------------------------------------------------

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: false;
  idempotentHint: boolean;
  openWorldHint: false;
};

export type ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  description: string;
  scope: ToolScope;
  module: ModuleId | null;
  since: ToolSince;
  input: I;
  output: O;
  annotations: ToolAnnotations;
};

const tool = <I extends z.ZodType, O extends z.ZodType>(
  d: Omit<ToolDef<I, O>, 'annotations'> & { idempotent?: boolean },
): ToolDef<I, O> => {
  const { idempotent, ...rest } = d;
  return Object.freeze({
    ...rest,
    annotations: Object.freeze({
      readOnlyHint: d.scope === 'read',
      destructiveHint: false as const,
      idempotentHint: d.scope === 'read' || idempotent === true,
      openWorldHint: false as const,
    }),
  });
};

/** One item of `add_thing` (D213: a spoken list is one call with several items). */
export const addThingItem = z.object({
  name: shortText(200),
  quantity: z.number().int().min(1).max(100_000).optional(),
  place_id: idOrCode.optional().describe('An existing place or container'),
  new_place: z
    .object({
      name: shortText(120),
      parent_id: idOrCode.optional(),
      kind: z.string().max(40).optional(),
    })
    .optional()
    .describe('A place that does not exist yet; it is proposed with the thing (D213)'),
  type: z.string().max(120).optional().describe('A type name, e.g. "Drill"'),
  brand: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  serial: z.string().max(100).optional().describe('The serial number, as printed on the thing'),
  notes: z.string().max(2000).optional(),
});

export const TOOL_DEFS = Object.freeze({
  // --- read, core (step 6) -------------------------------------------------------------------
  capabilities: tool({
    name: 'capabilities',
    title: 'What can I do here?',
    description:
      'What can I do in each location? Lists every location you can reach, its modules and the tools you may call there.',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({}),
    output: z.object({
      scope: z.enum(TOOL_SCOPES),
      locations: z.array(
        locationRef.extend({ modules: z.array(z.enum(MODULE_IDS)), tools: z.array(z.string()) }),
      ),
    }),
  }),
  list_locations: tool({
    name: 'list_locations',
    title: 'Locations',
    description: 'Which locations can I see? Lists them with your role and their time zone.',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({}),
    output: list(locationRef),
  }),
  search_things: tool({
    name: 'search_things',
    title: 'Search things',
    description:
      'Which things match these words? Searches names, aliases, types, brands and notes, with filters.',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({
      location_id: locationId,
      query: z.string().trim().max(200),
      filters: z
        .object({
          type: z.string().max(120).optional(),
          place_id: idOrCode.optional(),
          status: z.enum([...LIFECYCLES, ...DERIVED_STATES]).optional(),
          tag: z.string().max(80).optional(),
        })
        .optional(),
      cursor,
      limit,
    }),
    output: list(thingSummary),
  }),
  where_is: tool({
    name: 'where_is',
    title: 'Where is it?',
    description:
      'Where is a thing? Give a name or words from it; answers the best matches with their full place path.',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({ location_id: locationId, query: shortText(200) }),
    output: list(thingSummary.extend({ uncertain: z.boolean() })),
  }),
  get_thing: tool({
    name: 'get_thing',
    title: 'A thing',
    description: 'What do we know about this thing? Give its id or short ID.',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({ location_id: locationId, thing_id: idOrCode }),
    output: z.object({
      thing: thingSummary.extend({
        type_id: uuid.nullable(),
        condition: z.enum(CONDITIONS).nullable(),
        container: z.boolean(),
        untrusted: thingRef.shape.untrusted.extend({
          type: z.string().nullable(),
          brand: z.string().nullable(),
          model: z.string().nullable(),
          notes: z.string().nullable(),
          fields: z.record(z.string(), z.unknown()).optional(),
        }),
        purchase: z
          .object({ purchased_on: z.string().nullable(), price: money.optional() })
          .optional(),
        meters: z
          .array(
            z.object({
              id: uuid,
              unit: z.string(),
              last_value: z.number().nullable(),
              last_taken_at: z.string().nullable(),
              untrusted: z.object({ name: z.string() }),
            }),
          )
          .optional(),
        url: z.string().describe('The thing’s page in Kept'),
      }),
    }),
  }),
  list_contents: tool({
    name: 'list_contents',
    title: 'What is in it?',
    description:
      'What is in this place or container? Lists places and things below it, 1 to 3 levels deep.',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({
      location_id: locationId,
      place_id: idOrCode.optional(),
      container_id: idOrCode.optional(),
      depth: z.number().int().min(1).max(3).optional(),
      cursor,
      limit,
    }),
    output: z.object({
      parent: z.union([placeRef, thingRef]),
      items: z.array(
        z.object({
          depth: z.number().int().min(1).max(3),
          place: placeRef.optional(),
          thing: thingSummary.optional(),
        }),
      ),
    }),
  }),
  thing_history: tool({
    name: 'thing_history',
    title: 'History',
    description:
      'What happened to this thing? Its history, newest first: who did what and when (values hidden where your role hides them).',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({ location_id: locationId, thing_id: idOrCode, cursor, limit }),
    output: list(
      z.object({
        id: uuid,
        at: z.string(),
        action: z.string(),
        actor_type: z.enum(['user', 'token', 'system']),
        untrusted: z.object({ actor: z.string().nullable(), summary: z.string() }),
      }),
    ),
  }),
  find_documents: tool({
    name: 'find_documents',
    title: 'Documents',
    description:
      'Where is the receipt, manual or warranty for something? Lists attachments with what they belong to; open them in Kept.',
    scope: 'read',
    module: null,
    since: 6,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode.optional(),
      query: z.string().trim().max(200).optional(),
      roles: z.array(z.enum(ATTACHMENT_ROLES)).max(ATTACHMENT_ROLES.length).optional(),
      cursor,
      limit,
    }),
    output: list(
      z.object({
        attachment_id: uuid,
        role: z.enum(ATTACHMENT_ROLES),
        subject: z.object({
          type: z.enum(['thing', 'place', 'purchase', 'location', 'meter_reading', 'incident']),
          id: uuid,
        }),
        mime: z.string(),
        bytes: z.number().int(),
        added_at: z.string(),
        url: z.string().describe('The subject’s page in Kept; no file bytes over MCP'),
        untrusted: z.object({ title: z.string().nullable(), subject: z.string() }),
      }),
    ),
  }),

  // --- read, modules (step 4) ----------------------------------------------------------------
  upcoming: tool({
    name: 'upcoming',
    title: 'What is coming up?',
    description:
      'What is due, overdue or expiring soon? Schedules, warranties, loans and low stock within some days.',
    scope: 'read',
    module: 'schedules',
    since: 4,
    input: z.object({
      location_id: locationId,
      within_days: z.number().int().min(1).max(366).optional(),
      kinds: z
        .array(z.enum(['due', 'overdue', 'expiring', 'low_stock', 'loans']))
        .max(5)
        .optional(),
      cursor,
      limit,
    }),
    output: list(
      z.object({
        kind: z.enum(['due', 'overdue', 'expiring', 'low_stock', 'loans']),
        source_type: z.string(),
        source_id: uuid,
        due_on: z.string().nullable(),
        thing: thingRef.optional(),
        untrusted: z.object({ title: z.string() }),
      }),
    ),
  }),

  // --- write, core (step 6) ------------------------------------------------------------------
  add_thing: tool({
    name: 'add_thing',
    title: 'Add things',
    description:
      'Add one or more things. Put every thing the person listed in `items`, in one call; name a new place in `new_place` when it does not exist.',
    scope: 'write',
    module: null,
    since: 6,
    input: z.object({ location_id: locationId, items: z.array(addThingItem).min(1).max(20) }),
    output: writeResult.extend({
      /** One undoable event per thing and per new place, in write order (one Undo undoes all). */
      audit_event_ids: z.array(uuid),
      things: z.array(thingRef),
      places: z.array(placeRef),
      /** Per item, where it landed: `status` says whether its place already existed, was
       * just made, or is the default Unplaced bucket; `place` is its index in `places`
       * (null for Unplaced). `item` is the index in `items`. */
      placed: z.array(
        z.object({
          item: z.number().int().min(0),
          status: z.enum(['found', 'created', 'unplaced']),
          place: z.number().int().min(0).nullable(),
        }),
      ),
      attach_link: z.string().optional(),
      /** A type or brand named for an item that Kept doesn't know; the thing was added without
       * it. `item` is the index in `items`. */
      not_set: z
        .array(
          z.object({
            item: z.number().int().min(0),
            field: z.enum(['type', 'brand']),
            untrusted: z.object({ value: z.string() }),
          }),
        )
        .optional(),
    }),
  }),
  update_thing: tool({
    name: 'update_thing',
    title: 'Change a thing',
    description:
      'Change a thing’s name, aliases, notes, brand, model, serial number, condition or fields. Secret fields and prices only where allowed.',
    scope: 'write',
    module: null,
    since: 6,
    idempotent: true,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      fields: z
        .object({
          name: shortText(200).optional(),
          aliases: z.array(shortText(200)).max(20).optional(),
          notes: z.string().max(2000).nullable().optional(),
          brand: z.string().max(120).nullable().optional(),
          model: z.string().max(120).nullable().optional(),
          serial: z.string().max(100).nullable().optional(),
          condition: z.enum(CONDITIONS).nullable().optional(),
          custom: z.record(z.string(), z.unknown()).optional(),
        })
        .refine((f) => Object.keys(f).length > 0, { message: 'at least one field' }),
    }),
    output: writeResult.extend({ thing: thingRef, changed_fields: z.array(z.string()) }),
  }),
  move_thing: tool({
    name: 'move_thing',
    title: 'Move a thing',
    description:
      'Move a thing to another place or container. Give a quantity to move only some of them (the rest stay).',
    scope: 'write',
    module: null,
    since: 6,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      to_place_id: idOrCode.optional(),
      to_container_id: idOrCode.optional(),
      quantity: z.number().int().min(1).optional(),
    }),
    output: writeResult.extend({ thing: thingRef, split_from: uuid.optional() }),
  }),
  mark_seen: tool({
    name: 'mark_seen',
    title: 'Seen it',
    description: 'I just saw this thing where Kept says it is. Give its id or short ID.',
    scope: 'write',
    module: null,
    since: 6,
    idempotent: true,
    input: z.object({ location_id: locationId, thing_id: idOrCode }),
    output: writeResult.extend({ thing: thingRef, last_seen_at: z.string() }),
  }),
  create_place: tool({
    name: 'create_place',
    title: 'Add a place',
    description:
      'Add a place (a room, a shelf, a zone) under another place, or at the top of the location.',
    scope: 'write',
    module: null,
    since: 6,
    input: z.object({
      location_id: locationId,
      parent_id: idOrCode.optional(),
      name: shortText(120),
      kind: z
        .string()
        .max(40)
        .optional()
        .describe(`A place kind: ${BUILTIN_PLACE_KINDS.join(', ')} or the account’s own`),
    }),
    output: writeResult.extend({ place: placeRef }),
  }),
  attach_link: tool({
    name: 'attach_link',
    title: 'Add a photo or document',
    description:
      'A link that opens Kept’s capture sheet for this thing or place, so the person can add a photo, receipt or document.',
    scope: 'write',
    module: null,
    since: 6,
    idempotent: true,
    input: z.object({
      location_id: locationId,
      subject_type: z.enum(['thing', 'place']),
      subject_id: idOrCode,
      role: z.enum(ATTACHMENT_ROLES).optional(),
    }),
    output: z.object({ url: z.string() }),
  }),
  log_reading: tool({
    name: 'log_reading',
    title: 'Log a reading',
    description:
      'Record a meter reading (odometer, hours, electricity). Give the thing or the meter, the value and when.',
    scope: 'write',
    module: null,
    since: 6,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode.optional(),
      meter_id: uuid.optional(),
      value: z.number().finite().nonnegative(),
      taken_at: isoDateTime.optional(),
    }),
    output: writeResult.extend({
      reading: z.object({
        id: uuid,
        meter_id: uuid,
        value: z.number(),
        unit: z.string(),
        taken_at: z.string(),
      }),
      to_inbox: z.boolean().describe('True when the reading needs a look and went to the Inbox'),
    }),
  }),

  // --- write, lending (step 4) ---------------------------------------------------------------
  lend_thing: tool({
    name: 'lend_thing',
    title: 'Lend',
    description: 'Lend a thing to someone, with an optional due date.',
    scope: 'write',
    module: 'lending',
    since: 4,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      person: shortText(120).describe('A person’s name or id'),
      due_on: isoDate.optional(),
      quantity: z.number().int().min(1).optional(),
    }),
    output: writeResult.extend({ thing: thingRef, loan_id: uuid }),
  }),
  return_thing: tool({
    name: 'return_thing',
    title: 'Returned',
    description: 'A lent or borrowed thing came back (all of it, or a quantity).',
    scope: 'write',
    module: 'lending',
    since: 4,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      quantity: z.number().int().min(1).optional(),
    }),
    output: writeResult.extend({ thing: thingRef, loan_id: uuid }),
  }),
  borrow_thing: tool({
    name: 'borrow_thing',
    title: 'Borrow',
    description:
      'Record a thing borrowed from someone: it is added as theirs, where you put it, with an optional due date.',
    scope: 'write',
    module: 'lending',
    since: 4,
    // A borrowed thing is added as the lender's (step 4's borrow, D56), so it takes a name and a
    // place, not an existing thing.
    input: z.object({
      location_id: locationId,
      name: shortText(200),
      place_id: idOrCode.optional().describe('Where you put it; the Unplaced area when left out'),
      person: shortText(120).describe('A person’s name or id'),
      due_on: isoDate.optional(),
    }),
    output: writeResult.extend({ thing: thingRef, loan_id: uuid }),
  }),

  // --- write, schedules (step 4) -------------------------------------------------------------
  complete_schedule: tool({
    name: 'complete_schedule',
    title: 'Done',
    description: 'A scheduled task was done (on a date, or at a meter value).',
    scope: 'write',
    module: 'schedules',
    since: 4,
    input: z.object({
      location_id: locationId,
      schedule_id: uuid,
      done_on: isoDate.optional(),
      value: z.number().finite().nonnegative().optional(),
    }),
    output: writeResult.extend({ schedule_id: uuid, next_due_on: z.string().nullable() }),
  }),
  snooze_schedule: tool({
    name: 'snooze_schedule',
    title: 'Snooze',
    description: 'Put off a scheduled task until a date or a meter value.',
    scope: 'write',
    module: 'schedules',
    since: 4,
    input: z.object({
      location_id: locationId,
      schedule_id: uuid,
      until_date: isoDate.optional(),
      until_value: z.number().finite().nonnegative().optional(),
    }),
    output: writeResult.extend({ schedule_id: uuid }),
  }),

  // --- write, warranties (step 4) ------------------------------------------------------------
  add_warranty: tool({
    name: 'add_warranty',
    title: 'Add a warranty',
    description: 'Record a warranty on a thing: its kind, and when it ends or how many months.',
    scope: 'write',
    module: 'warranties',
    since: 4,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      kind: z.enum(WARRANTY_KINDS),
      ends_on: isoDate.optional(),
      term_months: z.number().int().min(1).max(600).optional(),
      provider: z.string().max(120).optional(),
    }),
    output: writeResult.extend({ warranty_id: uuid, ends_on: z.string().nullable() }),
  }),
  open_claim: tool({
    name: 'open_claim',
    title: 'Open a claim',
    description: 'Open a warranty claim for a thing.',
    scope: 'write',
    module: 'warranties',
    since: 4,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      warranty_id: uuid.optional(),
      reference: z.string().max(120).optional(),
    }),
    output: writeResult.extend({ claim_id: uuid, status: z.enum(CLAIM_STATUSES) }),
  }),
  update_claim: tool({
    name: 'update_claim',
    title: 'Update a claim',
    description: 'Change a warranty claim’s status or reference.',
    scope: 'write',
    module: 'warranties',
    since: 4,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      warranty_id: uuid.optional(),
      reference: z.string().max(120).optional(),
      status: z.enum(CLAIM_STATUSES).optional(),
    }),
    output: writeResult.extend({ claim_id: uuid, status: z.enum(CLAIM_STATUSES) }),
  }),

  // --- write, services and fuel (step 5) -----------------------------------------------------
  log_service: tool({
    name: 'log_service',
    title: 'Log a service',
    description:
      'Record a service done on a thing or a place: the date, who did it, the total, the lines, and which schedules it completes.',
    scope: 'write',
    module: null,
    since: 5,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode.optional(),
      place_id: idOrCode.optional(),
      serviced_on: isoDate,
      vendor: z.string().max(120).optional(),
      total: money.optional(),
      lines: z
        .array(z.object({ description: shortText(200), amount: money.optional() }))
        .max(50)
        .optional(),
      completes: z.array(uuid).max(20).optional(),
    }),
    output: writeResult.extend({ service_id: uuid }),
  }),
  log_fuel: tool({
    name: 'log_fuel',
    title: 'Log fuel',
    description:
      'Record a fill-up: the amount, its unit, the cost, whether it was full, and the odometer.',
    scope: 'write',
    module: 'fuel',
    since: 5,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      amount: z.number().finite().positive(),
      unit: z.string().max(10),
      cost: money.optional(),
      full: z.boolean().optional(),
      reading: z.number().finite().nonnegative().optional(),
    }),
    output: writeResult.extend({ fill_id: uuid }),
  }),

  // --- write, consumables (step 7) -----------------------------------------------------------
  adjust_stock: tool({
    name: 'adjust_stock',
    title: 'Adjust stock',
    description: 'Add to or take from a consumable’s stock (a positive or negative delta).',
    scope: 'write',
    module: 'consumables',
    since: 7,
    input: z.object({
      location_id: locationId,
      thing_id: idOrCode,
      delta: z
        .number()
        .int()
        .refine((n) => n !== 0, { message: 'not zero' }),
    }),
    output: writeResult.extend({ thing: thingRef, quantity: z.number() }),
  }),
});

export type ToolName = keyof typeof TOOL_DEFS;
export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_DEFS) as ToolName[]);

export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_DEFS)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOL_DEFS)[N]['output']>;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_DEFS, name);
}

/** Names no tool may carry (D58, D63, D124): nothing destructive, no secrets, files or SQL. */
export const FORBIDDEN_TOOL_NAME = /trash|delete|merge|transfer|reveal|upload|sql/;
