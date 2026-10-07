/**
 * Reads the signed-in frame's last-known state (shell.ts) from a person's database, for the gate
 * on a cold start offline (lib/signed-in-gate.ts through open.ts). Loaded lazily with Dexie: it
 * runs only when the network has already failed.
 */
import type { DexieOptions } from 'dexie';
import { KeptDb } from './db';
import { type OfflineShell, readShell } from './shell';

export async function shellFromDb(
  userId: string,
  options?: DexieOptions,
): Promise<OfflineShell | null> {
  const db = new KeptDb(userId, options);
  try {
    const [shell, locked] = await Promise.all([db.meta.get('shell'), db.meta.get('lockedAt')]);
    return readShell(shell?.value, userId, locked?.value);
  } finally {
    db.close();
  }
}
