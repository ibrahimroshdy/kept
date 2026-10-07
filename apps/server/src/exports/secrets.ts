import type { ExportSecretRecord } from '@kept/shared';
import type pg from 'pg';
import { open, type Sealed } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';
import { aadOf } from '../secrets/service.js';
import { type ReadContext, thingOk } from './data.js';

// The secret values of an export with "Include secrets" (D68; plan T12). Only the owner can ask
// for them (the route, and export_runs' insert policy); the job reads each current value the
// owner may reveal (secret_values' own policy), opens it with the keyring under its row's AAD,
// exactly as the reveal path does (secrets/service.ts), and the caller encrypts the NDJSON with
// the passphrase's key (portability/passphrase.ts). A value never reaches a log, the readable
// copy or any other entry.

type SecretRow = {
  id: string;
  thing_id: string | null;
  place_id: string | null;
  type_field_id: string | null;
  field_key: string;
  ciphertext: Sealed;
  created_at: Date;
};

const PAGE = 500;

/** Every current secret value of the location's kept things and places, opened. */
export async function* readSecrets(
  client: pg.ClientBase,
  keys: SecretKeys,
  ctx: ReadContext,
): AsyncGenerator<ExportSecretRecord> {
  let after: string | null = null;
  let refreshed = false;
  for (;;) {
    const { rows }: { rows: SecretRow[] } = await client.query<SecretRow>(
      `SELECT v.id, v.thing_id, v.place_id, v.type_field_id, v.field_key, v.ciphertext,
              v.created_at
         FROM public.secret_values v
        WHERE v.location_id = $1 AND v.superseded_at IS NULL
          AND ${thingOk('v.thing_id', ctx)}
          AND ($2::uuid IS NULL OR v.id > $2::uuid)
        ORDER BY v.id
        LIMIT ${PAGE}`,
      [ctx.locationId, after],
    );
    for (const r of rows) {
      const read = () =>
        open(keys.get().keyring, r.ciphertext, aadOf(r.id, r.field_key)).toString('utf8');
      let value: string;
      try {
        value = read();
      } catch (err) {
        // A rotation made while the server runs names a version it doesn't hold yet.
        if (refreshed || !(await keys.refresh())) throw err;
        refreshed = true;
        value = read();
      }
      yield {
        subject: r.thing_id
          ? { kind: 'thing', id: r.thing_id }
          : { kind: 'place', id: r.place_id as string },
        fieldKey: r.field_key,
        typeFieldId: r.type_field_id,
        value,
        updatedAt: r.created_at.toISOString(),
      };
    }
    if (rows.length < PAGE) return;
    after = (rows.at(-1) as SecretRow).id;
  }
}
