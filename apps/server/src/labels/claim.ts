import { isShortCode, newId, normaliseInputCode } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { AppError, notFound, pgErrorOf } from '../http/errors.js';
import { type Ctx, insertThing, requireRole } from '../things/service.js';

// Claiming a pre-printed blank label (plan T16; D43, D112, D137; engineering spec §2.4; Q24).
//
// The decision is the database's: kept.claim_blank_code() (0042) claims the code for a thing or a
// place of the location it was printed for, or answers `already_claimed` with who has it when it
// was claimed first in a location the caller sees. Anything else (missing, retired, another
// location, invisible, a viewer) is its 42501, which the error handler answers as the same 404 a
// random code gets (§7.7), so a claim can't be used to learn that a code exists somewhere.
//
// Three callers share claimLabel():
// - `POST /api/v1/codes/:code/claim` (labels/routes.ts): `already_claimed` becomes 409
//   `label_claimed {claimedFor}`, and the transaction rolls back (a new container with it);
// - the capture service's `claimCode` (capture/service.ts, T13): the new thing is made, then the
//   code it was captured into is claimed for it;
// - the `claim_label` sync op (T14): `already_claimed` is its `needs_review` plus an inbox
//   `label_claim` item; the loser's new container stays, with its own (pending) code.
//
// A claimed label is a physical label: its `printed_at` is set, so the thing it went to no longer
// counts as unprinted (Q28). On a thing made for the claim (a new container, a capture into a
// scanned blank), the claimed code becomes the primary one and the code insertThing() allocated
// is demoted: that one was never printed, and the one on the box is what the thing's page shows.

export const ClaimTarget = z.union([
  z.strictObject({ thingId: z.uuid() }),
  z.strictObject({ placeId: z.uuid() }),
  z.strictObject({
    newContainer: z.union([
      z.strictObject({
        id: z.uuid(),
        name: z.string().trim().min(1).max(200),
        typeId: z.uuid().optional(),
        placeId: z.uuid(),
      }),
      z.strictObject({
        id: z.uuid(),
        name: z.string().trim().min(1).max(200),
        typeId: z.uuid().optional(),
        containerId: z.uuid(),
      }),
    ]),
  }),
]);
export type ClaimTarget = z.infer<typeof ClaimTarget>;

export type ClaimedFor = { kind: 'thing' | 'place'; id: string; name: string };

export type ClaimOutcome =
  | { outcome: 'claimed'; target: { kind: 'thing' | 'place'; id: string } }
  | { outcome: 'already_claimed'; claimedFor: ClaimedFor };

export type ClaimOptions = {
  /** `op` (T14): the op checked the new container's client id against its own window. */
  via?: 'online' | 'op';
  /** The `thingId` target was made for this claim (a capture into a scanned blank): the claimed
   * code becomes its primary one. */
  newThing?: boolean;
};

type Row = {
  outcome: string;
  thing_id: string | null;
  place_id: string | null;
  name: string | null;
};

/** The code as stored, or a 404 for anything that can't be one (the same 404 as a random code). */
export function claimableCode(input: string): string {
  const code = normaliseInputCode(input);
  if (!isShortCode(code)) throw notFound();
  return code;
}

/** Runs kept.claim_blank_code() for one target; 42501 (the same 404 as a random code) otherwise. */
async function claimFor(
  client: pg.ClientBase,
  code: string,
  target: { thingId: string } | { placeId: string },
): Promise<ClaimOutcome> {
  const thingId = 'thingId' in target ? target.thingId.toLowerCase() : null;
  const placeId = 'placeId' in target ? target.placeId.toLowerCase() : null;
  const { rows } = await client.query<Row>(
    'SELECT outcome, thing_id, place_id, name FROM kept.claim_blank_code($1, $2, $3)',
    [code, thingId, placeId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (row.outcome === 'claimed') {
    await client.query(
      'UPDATE public.short_ids SET printed_at = coalesce(printed_at, now()) WHERE code = $1',
      [code],
    );
    return {
      outcome: 'claimed',
      target: thingId ? { kind: 'thing', id: thingId } : { kind: 'place', id: placeId as string },
    };
  }
  return {
    outcome: 'already_claimed',
    claimedFor: row.thing_id
      ? { kind: 'thing', id: row.thing_id, name: row.name ?? '' }
      : { kind: 'place', id: row.place_id as string, name: row.name ?? '' },
  };
}

/** Makes the claimed code the primary one of a thing made for it (see the header). */
export async function promoteClaimed(
  client: pg.ClientBase,
  code: string,
  thingId: string,
): Promise<void> {
  await client.query(
    `UPDATE public.short_ids SET is_primary = false
      WHERE thing_id = $1 AND state = 'assigned' AND is_primary AND code <> $2`,
    [thingId, code],
  );
  await client.query('UPDATE public.short_ids SET is_primary = true WHERE code = $1', [code]);
}

/**
 * Claims `rawCode` for the target, auditing a `label.claim` on success. `already_claimed` is
 * answered, not thrown: the route and the sync op each decide what it means.
 */
export async function claimLabel(
  ctx: Ctx,
  rawCode: string,
  target: ClaimTarget,
  opts: ClaimOptions = {},
): Promise<ClaimOutcome> {
  const { client, tx, scope } = ctx;
  const code = claimableCode(rawCode);
  let result: ClaimOutcome;
  let made: string | null = null;
  if ('newContainer' in target) {
    const nc = target.newContainer;
    // The location is the parent's; one the caller can't see is a 404, a viewer's a 403.
    const parent =
      'placeId' in nc
        ? await client.query<{ location_id: string }>(
            'SELECT location_id FROM public.places WHERE id = $1 AND deleted_at IS NULL',
            [nc.placeId],
          )
        : await client.query<{ location_id: string }>(
            'SELECT location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
            [nc.containerId],
          );
    const locationId = parent.rows[0]?.location_id;
    if (!locationId) throw notFound();
    await requireRole(client, locationId, 'labels.use');
    // D43 "New box here": a box, unless the phone chose a type.
    let typeId = nc.typeId?.toLowerCase();
    if (!typeId) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'box_bin'`,
      );
      typeId = rows[0]?.id;
    }
    made = await insertThing(
      ctx,
      {
        id: nc.id,
        locationId,
        ...('placeId' in nc ? { placeId: nc.placeId } : { containerId: nc.containerId }),
        name: nc.name,
        ...(typeId ? { typeId } : {}),
      },
      { idChecked: opts.via === 'op' },
    );
    result = await claimFor(client, code, { thingId: made });
    if (result.outcome === 'claimed') await promoteClaimed(client, code, made);
  } else {
    result = await claimFor(client, code, target);
    if (result.outcome === 'claimed' && opts.newThing && 'thingId' in target) {
      await promoteClaimed(client, code, result.target.id);
    }
  }
  if (result.outcome === 'claimed') {
    const { rows } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.short_ids WHERE code = $1',
      [code],
    );
    const locationId = rows[0]?.location_id as string;
    const isThing = result.target.kind === 'thing';
    await audited(tx, {
      locationId,
      actor: { type: 'user', id: scope.userId },
      action: 'label.claim',
      entity: { type: result.target.kind, id: result.target.id },
      after: { code, ...(made ? { new_container: true } : {}) },
      ...(isThing ? { rootThingId: result.target.id, subjects: [result.target.id] } : {}),
      requestId: ctx.requestId,
    });
  }
  return result;
}

/** The route's refusal for a label claimed first elsewhere (§5 "Label already claimed"). */
export function labelClaimed(claimedFor: ClaimedFor): AppError {
  return new AppError('label_claimed', 409, `This label is on "${claimedFor.name}".`, {
    claimedFor,
  });
}

/**
 * The loser of a claim race gets an inbox `label_claim` item on the thing it wanted to label
 * ("This label was claimed on another phone for 'Camping box'", screens §5): payload
 * `{claimedFor}`, the code in `code`. A claim meant for a place has no thing: the item carries
 * the code alone. Answers its id, or null when one is open already.
 */
export async function openLabelClaimItem(
  client: pg.ClientBase,
  item: {
    locationId: string;
    thingId: string | null;
    code: string;
    claimedFor: ClaimedFor;
    batchId?: string;
  },
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.inbox_items (id, location_id, kind, thing_id, code, batch_id, created_by,
                                     payload)
     VALUES ($1, $2, 'label_claim', $3, $4, $5, kept.current_user_id(), $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      newId(),
      item.locationId,
      item.thingId,
      item.code,
      item.batchId ?? null,
      JSON.stringify({ claimedFor: item.claimedFor }),
    ],
  );
  return rows[0]?.id ?? null;
}

/**
 * A capture into a scanned blank (`claimCode`, T13): claims the code for the thing just made,
 * under a savepoint, so the capture stands whatever the claim answers:
 * - `claimed`: the label is the thing's primary code;
 * - `already_claimed`: an inbox `label_claim` item (the thing keeps its own code);
 * - `not_claimable`: a code the caller can't claim (missing, another household's, retired);
 *   nothing more is said, exactly as for a random code.
 */
export async function claimForCapture(
  ctx: Ctx,
  rawCode: string,
  thing: { id: string; locationId: string; batchId?: string },
): Promise<{ outcome: 'claimed' | 'already_claimed' | 'not_claimable'; inboxItemId?: string }> {
  const { client } = ctx;
  await client.query('SAVEPOINT kept_claim');
  let out: ClaimOutcome;
  try {
    out = await claimLabel(ctx, rawCode, { thingId: thing.id }, { newThing: true });
  } catch (err) {
    const known =
      pgErrorOf(err)?.code === '42501' || (err instanceof AppError && err.status === 404);
    if (!known) throw err;
    await client.query('ROLLBACK TO SAVEPOINT kept_claim');
    return { outcome: 'not_claimable' };
  }
  await client.query('RELEASE SAVEPOINT kept_claim');
  if (out.outcome === 'claimed') return { outcome: 'claimed' };
  const inboxItemId = await openLabelClaimItem(client, {
    locationId: thing.locationId,
    thingId: thing.id,
    code: claimableCode(rawCode),
    claimedFor: out.claimedFor,
    ...(thing.batchId ? { batchId: thing.batchId } : {}),
  });
  return { outcome: 'already_claimed', ...(inboxItemId ? { inboxItemId } : {}) };
}
