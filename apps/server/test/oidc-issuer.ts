import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

// A fake OpenID provider on 127.0.0.1 for the OIDC tests (step-6 T16; spike S6.7 recommended an
// in-process stub over its 416 MB container). It serves discovery, a JWKS, an authorize endpoint
// that logs in whoever the test named last (`login(sub, claims)`) and redirects back with a code,
// and a token endpoint that checks the client and PKCE (S256) and answers an RS256 id_token with
// those claims. Nothing it serves leaves the machine.

export type FakeIssuer = {
  /** The issuer, exactly as discovery states it: `http://127.0.0.1:<port>/kept`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next authorize request logs in as, and the id_token's extra claims. */
  login: (sub: string, claims: Record<string, unknown>) => void;
  /** Discovery's `issuer`, to test a mismatch. */
  advertise: (issuer: string) => void;
  /** Every request, `METHOD /path`, in order. */
  seen: string[];
  close: () => Promise<void>;
};

type Grant = { sub: string; claims: Record<string, unknown>; challenge: string; redirect: string };

async function body(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const clientId = 'kept-test';
  const clientSecret = randomBytes(24).toString('base64url');
  const grants = new Map<string, Grant>();
  const seen: string[] = [];
  let next: { sub: string; claims: Record<string, unknown> } = { sub: 'nobody', claims: {} };
  let issuer = '';
  let advertised: string | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(`${req.method} ${url.pathname}`);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/kept/.well-known/openid-configuration') {
      return json(200, {
        issuer: advertised ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
      });
    }
    if (url.pathname === '/kept/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/kept/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256') {
        return json(400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('hex');
      const redirect = q.get('redirect_uri') ?? '';
      grants.set(code, { ...next, challenge: q.get('code_challenge') ?? '', redirect });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/kept/token' && req.method === 'POST') {
      void body(req).then(async (form) => {
        const grant = grants.get(form.get('code') ?? '');
        grants.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          !grant ||
          form.get('client_id') !== clientId ||
          form.get('client_secret') !== clientSecret ||
          form.get('redirect_uri') !== grant.redirect ||
          challenge !== grant.challenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        const idToken = await new SignJWT({ ...grant.claims })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject(grant.sub)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return json(200, {
          access_token: randomBytes(16).toString('hex'),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}/kept`;
  return {
    issuer,
    clientId,
    clientSecret,
    login: (sub, claims) => {
      next = { sub, claims };
    },
    advertise: (value) => {
      advertised = value;
    },
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
