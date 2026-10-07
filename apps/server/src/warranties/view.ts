import {
  addDays,
  CLAIM_STATUSES,
  type ClaimStatus,
  canonicalAmount,
  HOUSEHOLD_LIMITS as L,
  VENDOR_KINDS,
  type VendorKind,
  WARRANTY_KINDS,
  type WarrantyKind,
  warrantyEnds,
} from '@kept/shared';
import { z } from 'zod';
import type { AttachmentView } from '../files/views.js';
import { DocumentSchema, type GatedMoney, GatedMoneySchema } from '../money/view.js';
import type { Gate } from '../serialize/gates.js';

// Warranties and claims on the wire (step-4 plan T9; D53–D55, D158, D195; Q18, Q26, Q27): the web
// contract's shapes (apps/web/src/api/household/types.ts, "warranties and claims"), the request
// bodies, and the rows they are made from.
//
// A claim's cost and covered amount leave only through the caller's gate (serialize/gates.ts):
// `{moneyHidden: true}` where money is hidden there, whether or not there is an amount (so its
// absence tells a viewer nothing), `savedYou` null, and receipts and invoices left out of its
// documents (files/views.ts MONEY_ROLES).

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const IsoDate = z.iso.date();
const AmountIn = z.string().trim().min(1).max(40);
const CurrencyIn = z.string().trim().min(1).max(8);
const Provider = z.string().trim().min(1).max(L.providerLength);
const ClaimContact = z.string().trim().min(1).max(L.claimContactLength);
const LeadDays = z.number().int().min(L.warrantyLeadDays.min).max(L.warrantyLeadDays.max);
const TermMonths = z.number().int().min(L.warrantyTermMonths.min).max(L.warrantyTermMonths.max);
const Reference = z.string().trim().min(1).max(L.referenceLength);
const Notes = z.string().max(5000);
/** An existing vendor of the account, or a new one by name (D11). */
const VendorIn = z.union([
  z.strictObject({ id: z.uuid() }),
  z.strictObject({ name: z.string().trim().min(1).max(120) }),
]);

export const CreateWarrantyBody = z
  .strictObject({
    id: z.uuid().optional(),
    kind: z.enum(WARRANTY_KINDS),
    provider: Provider.optional(),
    startsOn: IsoDate,
    endsOn: IsoDate.optional(),
    termMonths: TermMonths.optional(),
    lifetime: z.literal(true).optional(),
    leadDays: LeadDays.optional(),
    claimContact: ClaimContact.optional(),
    registered: z.boolean().optional(),
    registrationDeadline: IsoDate.optional(),
  })
  .refine((b) => [b.endsOn, b.termMonths, b.lifetime].filter((x) => x !== undefined).length === 1, {
    message: 'one of endsOn, termMonths or lifetime',
    path: ['endsOn'],
  });
export type CreateWarrantyBody = z.infer<typeof CreateWarrantyBody>;

/** The create's fields, each optional; null clears one that may be empty. Setting one of
 * `endsOn`, `termMonths` or `lifetime: true` clears the other two (a warranty has exactly one). */
export const UpdateWarrantyBody = z
  .strictObject({
    kind: z.enum(WARRANTY_KINDS).optional(),
    provider: Provider.nullable().optional(),
    startsOn: IsoDate.optional(),
    endsOn: IsoDate.nullable().optional(),
    termMonths: TermMonths.nullable().optional(),
    lifetime: z.boolean().optional(),
    leadDays: LeadDays.optional(),
    claimContact: ClaimContact.nullable().optional(),
    registered: z.boolean().optional(),
    registrationDeadline: IsoDate.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change.');
export type UpdateWarrantyBody = z.infer<typeof UpdateWarrantyBody>;

export const CreateClaimBody = z.strictObject({
  id: z.uuid().optional(),
  warrantyId: z.uuid().optional(),
  incidentId: z.uuid().optional(),
  openedOn: IsoDate,
  reference: Reference.optional(),
  vendor: VendorIn.optional(),
  status: z.enum(['open', 'in_repair']).optional(),
  notes: Notes.optional(),
});
export type CreateClaimBody = z.infer<typeof CreateClaimBody>;

export const UpdateClaimBody = z
  .strictObject({
    status: z.enum(CLAIM_STATUSES).optional(),
    reference: Reference.nullable().optional(),
    vendor: VendorIn.nullable().optional(),
    cost: AmountIn.nullable().optional(),
    currency: CurrencyIn.optional(),
    coveredAmount: AmountIn.nullable().optional(),
    closedOn: IsoDate.nullable().optional(),
    notes: Notes.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change.');
export type UpdateClaimBody = z.infer<typeof UpdateClaimBody>;

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export type WarrantyRow = {
  id: string;
  location_id: string;
  thing_id: string;
  kind: WarrantyKind;
  provider: string | null;
  starts_on: string;
  ends_on: string | null;
  term_months: number | null;
  lifetime: boolean;
  effective_ends_on: string | null;
  lead_days: number;
  claim_contact: string | null;
  registered: boolean;
  registration_deadline: string | null;
  row_version: number;
  created_by: string;
  display_name: string | null;
};

export const WARRANTY_SELECT = `SELECT w.id, w.location_id, w.thing_id, w.kind, w.provider,
       w.starts_on::text AS starts_on, w.ends_on::text AS ends_on, w.term_months, w.lifetime,
       w.effective_ends_on::text AS effective_ends_on, w.lead_days, w.claim_contact, w.registered,
       w.registration_deadline::text AS registration_deadline, w.row_version, w.created_by,
       up.display_name
  FROM public.warranties w
  LEFT JOIN public.user_profiles up ON up.user_id = w.created_by`;

/** The warranty's audit image (snake_case, as audited() stores it). */
export function warrantyImage(w: WarrantyRow): Record<string, unknown> {
  return {
    thing_id: w.thing_id,
    kind: w.kind,
    provider: w.provider,
    starts_on: w.starts_on,
    ends_on: w.ends_on,
    term_months: w.term_months,
    lifetime: w.lifetime,
    lead_days: w.lead_days,
    claim_contact: w.claim_contact,
    registered: w.registered,
    registration_deadline: w.registration_deadline,
  };
}

export type ClaimRow = {
  id: string;
  location_id: string;
  thing_id: string;
  warranty_id: string | null;
  warranty_kind: WarrantyKind | null;
  warranty_provider: string | null;
  incident_id: string | null;
  incident_kind: string | null;
  incident_occurred_on: string | null;
  opened_on: string;
  reference: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_kind: VendorKind | null;
  status: ClaimStatus;
  cost: string | null;
  currency: string | null;
  covered_amount: string | null;
  notes: string | null;
  closed_on: string | null;
  row_version: number;
  created_by: string;
};

export const CLAIM_SELECT = `SELECT c.id, c.location_id, c.thing_id, c.warranty_id,
       w.kind AS warranty_kind, w.provider AS warranty_provider,
       c.incident_id, i.kind AS incident_kind, i.occurred_on::text AS incident_occurred_on,
       c.opened_on::text AS opened_on, c.reference, c.vendor_id, v.name AS vendor_name,
       v.kind AS vendor_kind, c.status, c.cost::text AS cost, c.currency::text AS currency,
       c.covered_amount::text AS covered_amount, c.notes, c.closed_on::text AS closed_on,
       c.row_version, c.created_by
  FROM public.claims c
  LEFT JOIN public.warranties w ON w.id = c.warranty_id
  LEFT JOIN public.incidents i ON i.id = c.incident_id
  LEFT JOIN public.vendors v ON v.id = c.vendor_id`;

/** The fields of a claim's audit image, in order. */
export const CLAIM_FIELDS = [
  'warranty_id',
  'incident_id',
  'opened_on',
  'reference',
  'vendor_id',
  'status',
  'cost',
  'currency',
  'covered_amount',
  'notes',
  'closed_on',
] as const;
export const CLAIM_MONEY_FIELDS: readonly string[] = ['cost', 'currency', 'covered_amount'];

/** The claim's audit image (snake_case); `cost` and `covered_amount` are money (classes.ts). */
export function claimImage(c: ClaimRow): Record<string, unknown> {
  return {
    thing_id: c.thing_id,
    warranty_id: c.warranty_id,
    incident_id: c.incident_id,
    opened_on: c.opened_on,
    reference: c.reference,
    vendor_id: c.vendor_id,
    status: c.status,
    cost: canonicalAmount(c.cost),
    currency: c.currency,
    covered_amount: canonicalAmount(c.covered_amount),
    notes: c.notes,
    closed_on: c.closed_on,
  };
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

const ActorRef = z.object({ displayName: z.string() });

export const WarrantySchema = z.object({
  id: z.uuid(),
  thingId: z.uuid(),
  kind: z.enum(WARRANTY_KINDS),
  provider: z.string().nullable(),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  termMonths: z.number().nullable(),
  lifetime: z.boolean(),
  effectiveEndsOn: z.string().nullable(),
  leadDays: z.number(),
  claimContact: z.string().nullable(),
  registered: z.boolean(),
  registrationDeadline: z.string().nullable(),
  state: z.enum(['active', 'expiring', 'ended']),
  documents: z.array(DocumentSchema),
  rowVersion: z.number(),
  createdBy: ActorRef,
});
export type WarrantyView = z.infer<typeof WarrantySchema> & { documents: AttachmentView[] };

export const CoverageSchema = z.object({
  longestId: z.uuid().nullable(),
  boughtOn: z.string().nullable(),
  coveredUntil: z.string().nullable(),
});
export const WarrantiesSchema = z.object({
  items: z.array(WarrantySchema),
  coverage: CoverageSchema,
});

export const WarrantyDefaultsSchema = z.object({
  termMonths: z.number().nullable(),
  from: z.object({ kind: z.enum(['brand', 'type']), id: z.uuid(), name: z.string() }).nullable(),
  startsOn: z.string().nullable(),
});
export type WarrantyDefaults = z.infer<typeof WarrantyDefaultsSchema>;

export const ClaimSchema = z.object({
  id: z.uuid(),
  thingId: z.uuid(),
  warranty: z
    .object({ id: z.uuid(), kind: z.enum(WARRANTY_KINDS), provider: z.string().nullable() })
    .nullable(),
  incident: z.object({ id: z.uuid(), kind: z.string(), occurredOn: z.string() }).nullable(),
  openedOn: z.string(),
  reference: z.string().nullable(),
  vendor: z.object({ id: z.uuid(), name: z.string(), kind: z.enum(VENDOR_KINDS) }).nullable(),
  status: z.enum(CLAIM_STATUSES),
  cost: GatedMoneySchema.nullable(),
  coveredAmount: GatedMoneySchema.nullable(),
  notes: z.string().nullable(),
  closedOn: z.string().nullable(),
  savedYou: GatedMoneySchema.nullable(),
  documents: z.array(DocumentSchema),
  rowVersion: z.number(),
});
export type ClaimView = z.infer<typeof ClaimSchema> & { documents: AttachmentView[] };
export const ClaimsSchema = z.object({ items: z.array(ClaimSchema) });

export const ClaimPrefillSchema = z.object({
  warrantyId: z.uuid().nullable(),
  claimUrl: z.string().nullable(),
  supportPhone: z.string().nullable(),
  claimContact: z.string().nullable(),
});
export type ClaimPrefill = z.infer<typeof ClaimPrefillSchema>;

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export type WarrantyState = 'active' | 'expiring' | 'ended';

/** Ended after its last day; expiring from `lead_days` before it (L2: end dates inclusive). */
export function warrantyState(w: WarrantyRow, today: string): WarrantyState {
  const ends = warrantyEnds({
    startsOn: w.starts_on,
    endsOn: w.ends_on,
    termMonths: w.term_months,
    lifetime: w.lifetime,
  });
  if (ends === null || ends === 'lifetime') return 'active';
  if (ends < today) return 'ended';
  return today >= addDays(ends, -w.lead_days) ? 'expiring' : 'active';
}

/** The longest cover first (D53): lifetime, then the latest last day, then the oldest made. */
export function byCover(a: WarrantyRow, b: WarrantyRow): number {
  const end = (w: WarrantyRow) => (w.lifetime ? '9999-12-31' : (w.effective_ends_on ?? ''));
  return end(b).localeCompare(end(a)) || a.id.localeCompare(b.id);
}

export function warrantyView(
  w: WarrantyRow,
  today: string,
  documents: AttachmentView[],
): WarrantyView {
  return {
    id: w.id,
    thingId: w.thing_id,
    kind: w.kind,
    provider: w.provider,
    startsOn: w.starts_on,
    endsOn: w.ends_on,
    termMonths: w.term_months,
    lifetime: w.lifetime,
    effectiveEndsOn: w.lifetime ? null : w.effective_ends_on,
    leadDays: w.lead_days,
    claimContact: w.claim_contact,
    registered: w.registered,
    registrationDeadline: w.registration_deadline,
    state: warrantyState(w, today),
    documents,
    rowVersion: w.row_version,
    createdBy: { displayName: w.display_name ?? '' },
  };
}

const HIDDEN = Object.freeze({ moneyHidden: true as const });

/** An amount through the gate: hidden where money is (with or without one), else the pair or
 * null. */
function gated(gate: Gate, amount: string | null, currency: string | null): GatedMoney | null {
  if (!gate.showMoney) return HIDDEN;
  if (amount === null || currency === null) return null;
  return { amount: canonicalAmount(amount) as string, currency };
}

/** D195, Q18: "Warranty saved you <amount>": what it would have cost, when the claim resolved at
 * no cost. */
function savedYouOf(c: ClaimRow, gate: Gate): GatedMoney | null {
  if (!gate.showMoney || c.status !== 'resolved' || c.covered_amount === null) return null;
  if (c.cost !== null && Number(c.cost) !== 0) return null;
  return gated(gate, c.covered_amount, c.currency);
}

export function claimView(c: ClaimRow, gate: Gate, documents: AttachmentView[]): ClaimView {
  return {
    id: c.id,
    thingId: c.thing_id,
    warranty:
      c.warranty_id && c.warranty_kind
        ? { id: c.warranty_id, kind: c.warranty_kind, provider: c.warranty_provider }
        : null,
    incident:
      c.incident_id && c.incident_kind && c.incident_occurred_on
        ? { id: c.incident_id, kind: c.incident_kind, occurredOn: c.incident_occurred_on }
        : null,
    openedOn: c.opened_on,
    reference: c.reference,
    vendor:
      c.vendor_id && c.vendor_name && c.vendor_kind
        ? { id: c.vendor_id, name: c.vendor_name, kind: c.vendor_kind }
        : null,
    status: c.status,
    cost: gated(gate, c.cost, c.currency),
    coveredAmount: gated(gate, c.covered_amount, c.currency),
    notes: c.notes,
    closedOn: c.closed_on,
    savedYou: savedYouOf(c, gate),
    documents,
    rowVersion: c.row_version,
  };
}
