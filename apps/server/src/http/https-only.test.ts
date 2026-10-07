import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { toErrorReply } from './errors.js';
import { assertHttps, isHttps, requireHttps } from './https-only.js';

// D181 (step-8 plan T2): no secret over plain HTTP. The scheme comes from KEPT_PUBLIC_URL only.

async function appFor(publicUrl: string) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorReply(err);
    void reply.code(status).send(body);
  });
  app.post('/kit', { preHandler: requireHttps(publicUrl) }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('requireHttps', () => {
  it('refuses with 403 https_required when the public URL is http', async () => {
    const app = await appFor('http://kept.lan:8080');
    const res = await app.inject({ method: 'POST', url: '/kit' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'https_required' });
    await app.close();
  });

  it('lets the request through when the public URL is https', async () => {
    const app = await appFor('https://kept.example.org');
    const res = await app.inject({ method: 'POST', url: '/kit' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('ignores what the client claims (X-Forwarded-Proto), trusting only the public URL', async () => {
    const app = await appFor('http://kept.lan');
    const res = await app.inject({
      method: 'POST',
      url: '/kit',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('assertHttps and isHttps answer the same way', () => {
    expect(isHttps('https://kept.example.org')).toBe(true);
    expect(isHttps('http://localhost:5173')).toBe(false);
    expect(() => assertHttps('http://localhost:5173')).toThrow(
      expect.objectContaining({ code: 'https_required', status: 403 }),
    );
    expect(() => assertHttps('https://kept.example.org')).not.toThrow();
  });
});
