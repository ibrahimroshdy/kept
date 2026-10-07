/**
 * Which agenda sources the Expiring screen reads (plan T23, T27): by default warranties (with
 * their registration deadlines), expiring documents and things that expire (screens §5); Home's
 * overdue and due rows add schedules, loans and stale readings (step 5) when they count them,
 * through `f.source`.
 */
import type { ActiveSourceType } from '@kept/shared';

/** The Expiring screen's sources when none is chosen (screens §5). */
export const EXPIRING_SOURCES: readonly ActiveSourceType[] = [
  'warranty',
  'registration',
  'document',
  'thing_expiry',
];

/** `f.source` values: a warranty's registration deadline goes with the warranty. */
const SOURCE_VALUES: Record<string, readonly ActiveSourceType[]> = {
  warranty: ['warranty', 'registration'],
  document: ['document'],
  thing_expiry: ['thing_expiry'],
  schedule: ['schedule'],
  loan: ['loan'],
  reading: ['reading_stale'],
};

/** What `f.source` asks the agenda for. */
export function sourcesOf(chosen: readonly string[] | undefined): ActiveSourceType[] {
  if (!chosen?.length) return [...EXPIRING_SOURCES];
  return [...new Set(chosen.flatMap((v) => SOURCE_VALUES[v] ?? []))];
}

/** Every `f.source` value: what Home's mixed overdue or due row opens Expiring with. */
export const ALL_SOURCE_VALUES = Object.keys(SOURCE_VALUES);
