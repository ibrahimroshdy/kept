import { locationModuleSet } from '../../http/modules.js';
import { claimableCode, claimLabel, openLabelClaimItem } from '../../labels/claim.js';
import { type Handler, requireLive, targetRef } from './common.js';

// `claim_label` → the label claim (T16, labels/claim.ts), which kept.claim_blank_code() decides.
// Claims are server-authoritative (D112): the first to arrive wins, whatever the phones' clocks.
// - claimed: `applied`, the code on the thing or place it went to (`entity.shortCode`);
// - claimed first on another phone: `needs_review` / `already_claimed` with an inbox
//   `label_claim` item ("This label was claimed on another phone for 'Camping box'", screens §5).
//   A new box made for the claim stays, with its own (pending, unprinted) code: the phone clears
//   the claimed code from it;
// - a code that can't be claimed here (missing, retired, another location's or household's, or
//   labels off in the location): `target_missing`, exactly as for a random code (§2.4);
// - the thing, place or parent of a new box trashed meanwhile: dropped with who trashed it (D35).

export const claimLabelOp: Handler<'claim_label'> = async (ctx, { locationId, payload }) => {
  const { client, tx } = ctx;
  if (!(await locationModuleSet(tx, locationId))?.has('labels')) {
    return { outcome: 'dropped', reason: 'target_missing' };
  }
  const target = payload.target;
  const ref =
    'thingId' in target
      ? { type: 'thing' as const, id: target.thingId }
      : 'placeId' in target
        ? { type: 'place' as const, id: target.placeId }
        : targetRef(target.newContainer);
  const gone = ref ? await requireLive(client, [ref]) : null;
  if (gone) return gone;

  const code = claimableCode(payload.code);
  const out = await claimLabel(ctx, code, target, { via: 'op' });
  if (out.outcome === 'claimed') {
    return {
      outcome: 'applied',
      entity: { type: out.target.kind, id: out.target.id, shortCode: code },
    };
  }
  // The loser: the thing it wanted to label (a new box keeps its own code), or the place.
  const thingId =
    'thingId' in target
      ? target.thingId.toLowerCase()
      : 'newContainer' in target
        ? target.newContainer.id.toLowerCase()
        : null;
  const placeId = 'placeId' in target ? target.placeId.toLowerCase() : null;
  const { rows } = await client.query<{ location_id: string; short_code: string | null }>(
    thingId
      ? `SELECT t.location_id,
                (SELECT s.code FROM public.short_ids s
                  WHERE s.thing_id = t.id AND s.state = 'assigned' AND s.is_primary) AS short_code
           FROM public.things t WHERE t.id = $1`
      : 'SELECT p.location_id, NULL::text AS short_code FROM public.places p WHERE p.id = $1',
    [thingId ?? placeId],
  );
  const at = rows[0];
  const inboxItemId = at
    ? await openLabelClaimItem(client, {
        locationId: at.location_id,
        thingId,
        code,
        claimedFor: out.claimedFor,
      })
    : null;
  return {
    outcome: 'needs_review',
    reason: 'already_claimed',
    ...(thingId
      ? { entity: { type: 'thing', id: thingId, shortCode: at?.short_code ?? null } }
      : placeId
        ? { entity: { type: 'place', id: placeId } }
        : {}),
    ...(inboxItemId ? { inboxItemId } : {}),
  };
};
