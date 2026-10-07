/**
 * Consumables (D14; step-7 plan T1, T6, T17): "Keep at least N" on a thing whose type is
 * consumable, and when it counts as low.
 */

/** The largest "keep at least" (`stock_rules.min_quantity`, numeric(12,3), > 0). */
export const STOCK_MIN_MAX = 1_000_000;

/** Low means fewer than the minimum: with "keep at least 4", 4 left is fine and 3 is low (plan
 * Q19). Quantities are decimal strings or numbers; compared as numbers. */
export function isLow(quantity: number | string, min: number | string): boolean {
  return Number(quantity) < Number(min);
}
