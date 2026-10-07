import type pg from 'pg';
import type { WarrantyDefaults } from './view.js';

// A new warranty's defaults (step-4 plan T9; D55, D92): the term from the thing's brand, else
// from the nearest type up its chain that has one, and the start from its purchase date. Never an
// AI guess. A default of 0 months ("no warranty") counts as none, as the web's mock reads it.

/** How far up the type tree to look; the tree is shallow, and a loop can't happen (0014). */
const MAX_DEPTH = 32;

type ThingRefs = { brand_id: string | null; type_id: string | null };

/** The thing's purchase date, when its purchase is visible to the caller. */
export async function purchaseDateOf(
  client: pg.ClientBase,
  thingId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ on: string }>(
    `SELECT p.purchased_on::text AS on
       FROM public.things t
       JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
       JOIN public.purchases p ON p.id = pl.purchase_id
      WHERE t.id = $1`,
    [thingId],
  );
  return rows[0]?.on ?? null;
}

export async function warrantyDefaults(
  client: pg.ClientBase,
  thingId: string,
  refs: ThingRefs,
): Promise<WarrantyDefaults> {
  const startsOn = await purchaseDateOf(client, thingId);
  if (refs.brand_id) {
    const { rows } = await client.query<{ id: string; name: string; months: number }>(
      `SELECT id, name, default_warranty_months AS months FROM public.brands
        WHERE id = $1 AND default_warranty_months > 0`,
      [refs.brand_id],
    );
    const brand = rows[0];
    if (brand) {
      return {
        termMonths: brand.months,
        from: { kind: 'brand', id: brand.id, name: brand.name },
        startsOn,
      };
    }
  }
  if (refs.type_id) {
    const { rows } = await client.query<{ id: string; name: string; months: number }>(
      `WITH RECURSIVE chain (id, parent_id, depth) AS (
         SELECT ty.id, ty.parent_id, 0 FROM public.types ty WHERE ty.id = $1
         UNION ALL
         SELECT p.id, p.parent_id, c.depth + 1
           FROM public.types p JOIN chain c ON p.id = c.parent_id
          WHERE c.depth < $2)
       SELECT ty.id, coalesce(ty.name, ty.builtin_key, src.builtin_key, '') AS name,
              ty.default_warranty_months AS months
         FROM chain c
         JOIN public.types ty ON ty.id = c.id
         LEFT JOIN public.types src ON src.id = ty.copied_from_id
        WHERE ty.default_warranty_months > 0
        ORDER BY c.depth LIMIT 1`,
      [refs.type_id, MAX_DEPTH],
    );
    const type = rows[0];
    if (type) {
      return {
        termMonths: type.months,
        from: { kind: 'type', id: type.id, name: type.name },
        startsOn,
      };
    }
  }
  return { termMonths: null, from: null, startsOn };
}
