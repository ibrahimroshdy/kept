import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type pg from 'pg';

// A software WebAuthn authenticator (ES256), enough to drive Better Auth's passkey
// verify-authentication endpoint from Node without a browser. Registration is skipped: the
// credential row is written straight into auth.passkey, in the shape the passkey plugin stores
// (COSE public key, standard base64).

function cborBytes(bytes: Buffer): Buffer {
  if (bytes.length !== 32) throw new Error('only 32-byte coordinates are supported');
  return Buffer.concat([Buffer.from([0x58, 0x20]), bytes]);
}

/** COSE_Key for an EC2 P-256 ES256 key: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
function coseKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
    cborBytes(x),
    Buffer.from([0x22]),
    cborBytes(y),
  ]);
}

export type SoftPasskey = {
  credentialId: string;
  /** Builds the AuthenticationResponseJSON a browser would send for this challenge. */
  assert: (opts: { challenge: string; userVerified: boolean }) => AuthenticationResponseJSON;
};

export async function registerSoftPasskey(
  authPool: pg.Pool,
  userId: string,
  rp: { id: string; origin: string },
): Promise<SoftPasskey> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = randomBytes(16).toString('base64url');
  await authPool.query(
    `INSERT INTO auth.passkey (name, public_key, user_id, credential_id, counter, device_type,
                               backed_up, transports, created_at)
     VALUES ('test key', $1, $2, $3, 0, 'singleDevice', false, 'internal', now())`,
    [coseKey(publicKey).toString('base64'), userId, credentialId],
  );

  let counter = 0;
  return {
    credentialId,
    assert: ({ challenge, userVerified }) => {
      counter += 1;
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge, origin: rp.origin, crossOrigin: false }),
      );
      const flags = 0x01 | (userVerified ? 0x04 : 0); // UP, optionally UV
      const signCount = Buffer.alloc(4);
      signCount.writeUInt32BE(counter);
      const authenticatorData = Buffer.concat([
        createHash('sha256').update(rp.id).digest(),
        Buffer.from([flags]),
        signCount,
      ]);
      const signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
        privateKey,
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
  };
}

/** CBOR text string (short: under 24 bytes). */
function cborText(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length >= 24) throw new Error('only short CBOR strings are supported');
  return Buffer.concat([Buffer.from([0x60 + bytes.length]), bytes]);
}

/** CBOR byte string of up to 65535 bytes. */
function cborByteString(bytes: Buffer): Buffer {
  const head =
    bytes.length < 24
      ? Buffer.from([0x40 + bytes.length])
      : bytes.length < 256
        ? Buffer.from([0x58, bytes.length])
        : Buffer.from([0x59, bytes.length >> 8, bytes.length & 0xff]);
  return Buffer.concat([head, bytes]);
}

/**
 * The browser's answer to a registration ceremony, from a fresh software key: attestation
 * `none` (what the passkey plugin asks for), user present and verified.
 */
export function softRegistration(
  challenge: string,
  rp: { id: string; origin: string },
): RegistrationResponseJSON {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = randomBytes(16);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash('sha256').update(rp.id).digest(),
    Buffer.from([0x01 | 0x04 | 0x40]), // UP, UV, attested credential data
    Buffer.alloc(4), // sign count
    Buffer.alloc(16), // AAGUID
    idLength,
    credentialId,
    coseKey(publicKey),
  ]);
  const attestationObject = Buffer.concat([
    Buffer.from([0xa3]),
    cborText('fmt'),
    cborText('none'),
    cborText('attStmt'),
    Buffer.from([0xa0]),
    cborText('authData'),
    cborByteString(authData),
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.create', challenge, origin: rp.origin, crossOrigin: false }),
  );
  const id = credentialId.toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      attestationObject: attestationObject.toString('base64url'),
      transports: ['internal'],
    },
    clientExtensionResults: {},
  };
}
