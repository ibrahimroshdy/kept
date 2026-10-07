import {
  ACTIVE_SOURCE_TYPES,
  type ActiveSourceType,
  AGENDA_STATES,
  type AgendaState,
  OCCURRENCE_KINDS,
  type OccurrenceKind,
} from '@kept/shared';
import { z } from 'zod';
import { type SubjectRef, SubjectRefSchema } from '../paperwork/view.js';

// The agenda's shapes (apps/web/src/api/household/types.ts, "the agenda (T13)"): one row of
// public.agenda_items (0053) as the web reads it.

export const AGENDA_ACTIONS = ['complete', 'snooze', 'mark_returned', 'renew', 'open'] as const;
export type AgendaAction = (typeof AGENDA_ACTIONS)[number];

export type AgendaItem = {
  /** `${sourceType}:${sourceId}:${kind}:${duePeriod}`: the occurrence key (D111), stable. */
  key: string;
  sourceType: ActiveSourceType;
  sourceId: string;
  kind: OccurrenceKind;
  state: AgendaState;
  locationId: string;
  subject: SubjectRef;
  /** The schedule's name, the warranty's provider or kind, the document's title or kind, the
   * thing's name for a loan or a thing's expiry. */
  title: string;
  dueOn: string | null;
  dueValue: string | null;
  unit: string | null;
  actions: AgendaAction[];
};

export type AgendaCounts = { overdue: number; due: number; expiring: number };

export const AgendaItemSchema = z.object({
  key: z.string(),
  sourceType: z.enum(ACTIVE_SOURCE_TYPES),
  sourceId: z.uuid(),
  kind: z.enum(OCCURRENCE_KINDS),
  state: z.enum(AGENDA_STATES),
  locationId: z.uuid(),
  subject: SubjectRefSchema,
  title: z.string(),
  dueOn: z.string().nullable(),
  dueValue: z.string().nullable(),
  unit: z.string().nullable(),
  actions: z.array(z.enum(AGENDA_ACTIONS)),
});

export const AgendaCountsSchema = z.object({
  overdue: z.number().int(),
  due: z.number().int(),
  expiring: z.number().int(),
});

/** What a writer can do from a row, by source (screens §5, Q32); a viewer only opens it. */
export const WRITER_ACTIONS: Readonly<Record<ActiveSourceType, readonly AgendaAction[]>> = {
  schedule: ['complete', 'snooze', 'open'],
  warranty: ['open'],
  registration: ['open'],
  document: ['renew', 'open'],
  loan: ['mark_returned', 'open'],
  thing_expiry: ['open'],
  reading_stale: ['open'],
  stock: ['open'],
};
