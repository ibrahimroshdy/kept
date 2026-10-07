import { VALUATION_SOURCES } from '@kept/shared';
import { z } from 'zod';
import { AttachmentSubjectSchema, type AttachmentView } from '../files/views.js';

// Money on the wire (step-4 plan T8; D76, D136, D158): the web contract's exchange rates and
// valuations (apps/web/src/api/household/types.ts, "money: exchange rates and valuations").
// A valuation's value leaves only through the caller's gate (serialize/gates.ts): `{moneyHidden:
// true}` where money is hidden there, with its documents left out too (an appraisal shows the
// value). Amounts are canonical decimal strings ("1200.5"), as purchases' are.

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** An amount or a rate as typed: any digits parseAmount() reads (D172). */
const AmountIn = z.string().trim().min(1).max(40);
/** A currency as sent. "$" is refused with its own hint (D189). */
const CurrencyIn = z.string().trim().min(1).max(8);
const IsoDate = z.iso.date();
const Notes = z.string().max(2000);
const Ccy = z.string().regex(/^[A-Za-z]{3}$/, 'a three-letter currency code');

export const FxAccountParams = z.object({ accountId: z.uuid() });
export const FxKeyParams = z.object({
  accountId: z.uuid(),
  from: Ccy,
  to: Ccy,
  validFrom: IsoDate,
});
export const FxListQuery = z.object({ from: Ccy.optional(), to: Ccy.optional() });

export const PutFxRateBody = z.strictObject({
  fromCcy: CurrencyIn,
  toCcy: CurrencyIn,
  /** A decimal above 0, at most 10 integer digits and 8 decimals (numeric(18,8)). */
  rate: AmountIn,
  validFrom: IsoDate,
});
export type PutFxRateBody = z.infer<typeof PutFxRateBody>;

export const CreateValuationBody = z.strictObject({
  id: z.uuid().optional(),
  value: AmountIn,
  currency: CurrencyIn,
  valuedOn: IsoDate,
  source: z.enum(VALUATION_SOURCES),
  notes: Notes.optional(),
});
export type CreateValuationBody = z.infer<typeof CreateValuationBody>;

/** The create's fields, each optional; `notes: null` clears the notes. */
export const UpdateValuationBody = z
  .strictObject({
    value: AmountIn.optional(),
    currency: CurrencyIn.optional(),
    valuedOn: IsoDate.optional(),
    source: z.enum(VALUATION_SOURCES).optional(),
    notes: Notes.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change.');
export type UpdateValuationBody = z.infer<typeof UpdateValuationBody>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

const ActorRef = z.object({ displayName: z.string() });

const FileViewSchema = z.object({
  id: z.uuid(),
  sha256: z.string(),
  bytes: z.number(),
  mime: z.string(),
  class: z.string(),
  hasGps: z.boolean(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  derivativeState: z.string(),
  thumbUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
  deduplicatedFrom: z.string().optional(),
});

/** A record's document: step 2's AttachmentView (files/views.ts). */
export const DocumentSchema = z.object({
  id: z.uuid(),
  role: z.string(),
  sort: z.number(),
  file: FileViewSchema.nullable(),
  url: z.string().nullable(),
  subject: AttachmentSubjectSchema,
  createdBy: ActorRef,
  rowVersion: z.number(),
});

export const FxRateSchema = z.object({
  fromCcy: z.string(),
  toCcy: z.string(),
  rate: z.string(),
  validFrom: z.string(),
  rowVersion: z.number(),
  updatedBy: ActorRef,
  updatedAt: z.string(),
});
export type FxRateView = z.infer<typeof FxRateSchema>;
export const FxRatesSchema = z.object({ items: z.array(FxRateSchema) });

/** An amount, or only the fact that it's hidden from this reader. */
export const GatedMoneySchema = z.union([
  z.object({ amount: z.string(), currency: z.string() }),
  z.object({ moneyHidden: z.literal(true) }),
]);
export type GatedMoney = { amount: string; currency: string } | { moneyHidden: true };

export const ValuationSchema = z.object({
  id: z.uuid(),
  value: GatedMoneySchema,
  valuedOn: z.string(),
  source: z.enum(VALUATION_SOURCES),
  notes: z.string().nullable(),
  documents: z.array(DocumentSchema),
  rowVersion: z.number(),
  createdBy: ActorRef,
});
export type ValuationView = {
  id: string;
  value: GatedMoney;
  valuedOn: string;
  source: (typeof VALUATION_SOURCES)[number];
  notes: string | null;
  documents: AttachmentView[];
  rowVersion: number;
  createdBy: { displayName: string };
};
export const ValuationsSchema = z.object({
  items: z.array(ValuationSchema),
  current: ValuationSchema.nullable(),
});

/** The thing view's `currentValue` (things/view.ts). */
export const CurrentValueSchema = z.union([
  z.object({
    amount: z.string(),
    currency: z.string(),
    valuedOn: z.string(),
    source: z.enum(VALUATION_SOURCES),
  }),
  z.object({ moneyHidden: z.literal(true) }),
]);
export type CurrentValue =
  | {
      amount: string;
      currency: string;
      valuedOn: string;
      source: (typeof VALUATION_SOURCES)[number];
    }
  | { moneyHidden: true };
