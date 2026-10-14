import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles } from '../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, ok, own } from '../../test/things.js';
import { limiterKey } from '../auth/sign-in-limiter.js';
import type { Keyring, MasterKey } from '../crypto/envelope.js';
import { fixedSecretKeys } from '../crypto/keyring.js';
import type { MailboxConfig } from './config.js';
import { type MailInDeps, runMailIn } from './poll.js';
import { isRtl, readMail } from './read.js';
import {
  imapSource,
  type MailErrorCode,
  type MailSession,
  type MailSource,
  MailSourceError,
} from './source.js';

// Email-in (1.4, D231) through the front door and the job: a location's admins connect a
// mailbox (the password sealed, never answered, never audited); the `mail-in` job reads only mail
// that arrives after, and makes a draft receipt from each message's photos and PDFs, or from its
// body as a PDF; the mailbox turns off when its creator stops administering the location or the
// server refuses the password. The IMAP server is a fake (FakeFolder); nothing leaves the machine.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const master: MasterKey = { key: randomBytes(32), keyVersion: 1 };
const keyring = new Map([[1, master.key]]) as Keyring;
let ibrahim: Person; // owns Home
let bruce: Person; // admin of Home
let louis: Person; // member of Home
let home: Loc;

/** One fake folder: its messages by UID, and what a sign-in should fail with. */
class FakeFolder {
  uidValidity = 7;
  messages = new Map<number, Buffer>();
  next = 1;
  failWith: MailErrorCode | null = null;
  signIns: MailboxConfig[] = [];
  add(raw: Buffer): number {
    const uid = this.next++;
    this.messages.set(uid, raw);
    return uid;
  }
  source: MailSource = async (config) => {
    this.signIns.push(config);
    if (this.failWith) throw new MailSourceError(this.failWith, 'fake');
    const session: MailSession = {
      folder: () => ({ uidValidity: this.uidValidity, uidNext: this.next }),
      list: async (after) =>
        [...this.messages.entries()]
          .filter(([uid]) => uid > after)
          .map(([uid, raw]) => ({ uid, size: raw.length })),
      source: async (uid) => this.messages.get(uid) ?? null,
      close: async () => {},
    };
    return session;
  };
}
let box: FakeFolder;

/** A MIME message: text and HTML bodies, and attachments, as a mail client writes them. */
function eml(m: {
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  attach?: { name: string; type: string; bytes: Buffer; inline?: boolean }[];
}): Buffer {
  const b = `b-${randomBytes(6).toString('hex')}`;
  const lines = [
    `From: Shop <${m.from ?? 'orders@shop.example'}>`,
    'To: receipts@home.example',
    `Subject: ${m.subject ?? 'Your order'}`,
    'Date: Tue, 13 Oct 2026 10:00:00 +0000',
    `Message-ID: <${randomBytes(6).toString('hex')}@shop.example>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
  ];
  if (m.text !== undefined) {
    lines.push(`--${b}`, 'Content-Type: text/plain; charset=utf-8', '', m.text);
  }
  if (m.html !== undefined) {
    lines.push(`--${b}`, 'Content-Type: text/html; charset=utf-8', '', m.html);
  }
  for (const a of m.attach ?? []) {
    lines.push(
      `--${b}`,
      `Content-Type: ${a.type}; name="${a.name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${a.name}"`,
      ...(a.inline ? ['Content-ID: <logo@shop>'] : []),
      '',
      a.bytes.toString('base64').replace(/.{76}/g, '$&\r\n'),
    );
  }
  lines.push(`--${b}--`, '');
  return Buffer.from(lines.join('\r\n'));
}

/** A photo big enough not to be taken for a logo. */
const photo = () =>
  sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

const mailbox = (as: Person) => call(t, `/api/v1/locations/${home.id}/mailbox`, { as });
const connect = (as: Person, over: Record<string, unknown> = {}) =>
  call(t, `/api/v1/locations/${home.id}/mailbox`, {
    as,
    method: 'PUT',
    body: {
      host: 'imap.home.example',
      security: 'tls',
      username: 'receipts@home.example',
      password: 'correct horse battery staple',
      folder: 'Kept',
      ...over,
    },
  });

const deps = (): MailInDeps => ({
  pools: db.pools,
  files,
  keyring,
  source: box.source,
  log: { info: () => {}, error: () => {} },
});

/** Every poll is due: the 9-minute gap is the schedule's, not the test's. */
const due = () => own(db, `UPDATE public.mailboxes SET last_polled_at = now() - interval '1 hour'`);
const run = async () => {
  await due();
  return runMailIn(deps());
};

const messages = () =>
  own<{ uid: string; outcome: string; subject: string | null; purchase_id: string | null }>(
    db,
    `SELECT uid::text, outcome, subject, purchase_id FROM public.mailbox_messages
      WHERE location_id = $1 ORDER BY uid`,
    [home.id],
  );
const mailboxRow = async () =>
  (
    await own<{
      active: boolean;
      disabled_reason: string | null;
      last_uid: string | null;
      last_error: string | null;
    }>(
      db,
      'SELECT active, disabled_reason, last_uid::text, last_error FROM public.mailboxes WHERE location_id = $1',
      [home.id],
    )
  )[0];

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  box = new FakeFolder();
  t = await peopleApp(db, {
    files,
    secretKeys: fixedSecretKeys({ current: master, keyring }),
    mailSource: (c, o) => box.source(c, o),
  });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  home = await createLocation(t, db, ibrahim, 'household');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
});

beforeEach(async () => {
  box.failWith = null;
  await own(db, 'DELETE FROM public.mailboxes');
  // Each test signs in a few times; the per-person limit is the routes' own test's.
  await db.pools.auth.query('DELETE FROM auth.sign_in_failures WHERE key = ANY ($1)', [
    [ibrahim, bruce, louis].map((p) => limiterKey('mailbox-check', p.userId)),
  ]);
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('the mailbox settings', () => {
  // catalogue: PUT /api/v1/locations/:id/mailbox
  it('connects after signing in, seals the password, never answers or audits it', async () => {
    expect(ok(await mailbox(bruce))).toEqual({ mailbox: null, recent: [] });
    const res = await connect(bruce, { allowedSenders: ['Orders@Shop.example'] });
    const view = ok(res) as Record<string, unknown>;
    expect(view).toMatchObject({
      host: 'imap.home.example',
      port: 993,
      security: 'tls',
      username: 'receipts@home.example',
      folder: 'Kept',
      allowedSenders: ['orders@shop.example'],
      active: true,
      createdBy: { id: bruce.userId },
    });
    expect(JSON.stringify(view)).not.toContain('battery');
    expect(box.signIns.at(-1)).toMatchObject({ host: 'imap.home.example', port: 993 });
    expect(JSON.stringify(ok(await mailbox(ibrahim)))).not.toContain('battery');
    const [row] = await own<{ config_ciphertext: unknown }>(
      db,
      'SELECT config_ciphertext FROM public.mailboxes WHERE location_id = $1',
      [home.id],
    );
    expect(JSON.stringify(row?.config_ciphertext)).not.toContain('battery');
    const audit = await own<{ action: string; diff: unknown }>(
      db,
      `SELECT action, diff FROM public.audit_events WHERE entity_type = 'mailbox' ORDER BY at, id`,
    );
    expect(audit.map((a) => a.action)).toEqual(['mailbox.create']);
    expect(JSON.stringify(audit)).not.toContain('battery');

    // A second save without the password keeps it; a new port starts the mailbox again.
    ok(await connect(bruce, { password: undefined, security: 'starttls' }));
    expect(box.signIns.at(-1)).toMatchObject({
      port: 143,
      security: 'starttls',
      password: 'correct horse battery staple',
    });
    const after = await own<{ action: string; diff: Record<string, unknown> }>(
      db,
      `SELECT action, diff FROM public.audit_events WHERE entity_type = 'mailbox' ORDER BY at, id`,
    );
    expect(after.at(-1)?.action).toBe('mailbox.update');
  });

  it('refuses a mailbox that fails to sign in, saying why, and saves nothing', async () => {
    box.failWith = 'auth_failed';
    const res = await connect(bruce);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'validation',
      hint: expect.stringContaining('password'),
      mailError: 'auth_failed',
    });
    expect(ok(await mailbox(bruce))).toEqual({ mailbox: null, recent: [] });
  });

  it('is for owners and admins only, and wants a password the first time', async () => {
    expect((await connect(louis)).statusCode).toBe(403);
    expect((await mailbox(louis)).statusCode).toBe(403);
    expect((await connect(bruce, { password: undefined })).statusCode).toBe(400);
    expect((await connect(bruce, { host: 'https://imap.example.com' })).statusCode).toBe(400);
  });

  // catalogue: DELETE /api/v1/locations/:id/mailbox
  it('checks the saved mailbox on request, and removes it, audited', async () => {
    ok(await connect(ibrahim));
    const check = (as: Person) =>
      call(t, `/api/v1/locations/${home.id}/mailbox/check`, { as, method: 'POST' });
    expect(ok(await check(ibrahim))).toEqual({ ok: true, error: null });
    box.failWith = 'no_folder';
    expect(ok(await check(ibrahim))).toEqual({ ok: false, error: 'no_folder' });
    const del = await call(t, `/api/v1/locations/${home.id}/mailbox`, {
      as: ibrahim,
      method: 'DELETE',
    });
    expect(del.statusCode).toBe(204);
    const audit = await own<{ action: string }>(
      db,
      `SELECT action FROM public.audit_events WHERE entity_type = 'mailbox' ORDER BY at, id`,
    );
    expect(audit.map((a) => a.action)).toContain('mailbox.delete');
    expect(ok(await mailbox(ibrahim))).toEqual({ mailbox: null, recent: [] });
  });
});

describe('the mail-in job', () => {
  it('reads only mail that arrives after; photos, PDFs and bodies become draft receipts', async () => {
    box.add(eml({ subject: 'Old mail', text: 'An order from before the mailbox was connected.' }));
    ok(await connect(bruce));
    await run(); // the mark
    expect(await messages()).toEqual([]);

    const jpeg = await photo();
    box.add(
      eml({
        subject: 'Photo receipt',
        text: 'See attached.',
        attach: [{ name: 'r.jpg', type: 'image/jpeg', bytes: jpeg }],
      }),
    );
    box.add(
      eml({
        subject: 'Order 1042 confirmed',
        html: '<p>Thank you for your order.</p><table><tr><td>Drill</td><td>EGP 1,450.00</td></tr></table><p>Total EGP 1,450.00, paid by card ending 4242.</p><img src="cid:logo@shop">',
        attach: [{ name: 'logo.png', type: 'image/png', bytes: jpeg, inline: true }],
      }),
    );
    box.add(eml({ subject: 'Hi', text: 'Thanks!' }));
    const [out] = await run();
    expect(out).toMatchObject({ read: 3, receipts: 2 });
    const rows = await messages();
    expect(rows.map((r) => [r.subject, r.outcome])).toEqual([
      ['Photo receipt', 'receipt'],
      ['Order 1042 confirmed', 'receipt'],
      ['Hi', 'no_receipt'],
    ]);
    for (const r of rows.slice(0, 2)) {
      const pages = await own<{ mime: string; review_state: string; notes: string | null }>(
        db,
        `SELECT f.mime, p.review_state, p.notes FROM public.attachments a
           JOIN public.files f ON f.id = a.file_id
           JOIN public.purchases p ON p.id = a.purchase_id
          WHERE a.purchase_id = $1 AND a.role = 'receipt'`,
        [r.purchase_id],
      );
      expect(pages).toEqual([
        {
          mime: r.subject === 'Photo receipt' ? 'image/jpeg' : 'application/pdf',
          review_state: 'draft',
          notes: r.subject,
        },
      ]);
      const inbox = await own<{ kind: string }>(
        db,
        'SELECT kind FROM public.inbox_items WHERE purchase_id = $1 AND resolved_at IS NULL',
        [r.purchase_id],
      );
      expect(inbox.map((i) => i.kind)).toEqual(['receipt']);
    }
    // As the mailbox's creator, audited as a capture.
    const captures = await own<{ actor_id: string }>(
      db,
      `SELECT actor_id FROM public.audit_events WHERE action = 'purchase.capture'
        AND location_id = $1`,
      [home.id],
    );
    expect(captures.map((c) => c.actor_id)).toEqual([bruce.userId, bruce.userId]);
    expect(await mailboxRow()).toMatchObject({ active: true, last_uid: '4', last_error: null });

    // The page shows them, newest first; a second run reads nothing new.
    const page = ok(await mailbox(bruce)) as unknown as { recent: { subject: string }[] };
    expect(page.recent.map((r) => r.subject)).toEqual([
      'Hi',
      'Order 1042 confirmed',
      'Photo receipt',
    ]);
    const [again] = await run();
    expect(again).toMatchObject({ read: 0 });
  });

  it('skips a sender the mailbox doesn’t allow', async () => {
    ok(await connect(bruce, { allowedSenders: ['orders@shop.example'] }));
    await run();
    box.add(
      eml({ from: 'someone@else.example', subject: 'Not from the shop', text: 'x'.repeat(80) }),
    );
    box.add(
      eml({
        from: 'ORDERS@shop.example',
        subject: 'From the shop',
        text: 'Order 77: total 12.50 EUR, thanks for shopping with us.',
      }),
    );
    await run();
    const rows = await messages();
    expect(rows.slice(-2).map((r) => [r.subject, r.outcome])).toEqual([
      ['Not from the shop', 'sender_not_allowed'],
      ['From the shop', 'receipt'],
    ]);
  });

  it('turns off when its creator stops administering the location; saving turns it back on', async () => {
    ok(await connect(bruce));
    await run();
    await own(
      db,
      `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
      [home.id, bruce.userId],
    );
    try {
      box.add(eml({ subject: 'After', text: 'Total 99.00 EUR for your order, thank you.' }));
      const [out] = await run();
      expect(out?.error).toBe('creator_left');
      expect(await mailboxRow()).toMatchObject({ active: false, disabled_reason: 'creator_left' });
      // Off: not polled at all.
      expect(await run()).toEqual([]);
      ok(await connect(ibrahim, { password: 'another password' }));
      expect(await mailboxRow()).toMatchObject({ active: true, disabled_reason: null });
    } finally {
      await own(
        db,
        `UPDATE public.memberships SET role = 'admin' WHERE location_id = $1 AND user_id = $2`,
        [home.id, bruce.userId],
      );
    }
  });

  it('turns off when the server refuses the password, and records other failures', async () => {
    ok(await connect(bruce));
    box.failWith = 'timeout';
    await run();
    expect(await mailboxRow()).toMatchObject({ active: true, last_error: 'timeout' });
    box.failWith = 'auth_failed';
    await run();
    expect(await mailboxRow()).toMatchObject({
      active: false,
      disabled_reason: 'auth_failed',
      last_error: 'auth_failed',
    });
  });
});

describe('reading a message', () => {
  it('takes attached photos and PDFs, never an inline logo; the body only without them', async () => {
    const jpeg = await photo();
    const mail = await readMail(
      eml({
        text: 'Receipt attached.',
        html: '<p>Receipt attached.</p><img src="cid:logo@shop">',
        attach: [
          { name: 'logo.png', type: 'image/png', bytes: jpeg, inline: true },
          { name: 'receipt.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%fake\n') },
          { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('hello') },
        ],
      }),
    );
    expect(mail.files.map((f) => f.contentType)).toEqual(['application/pdf']);
    expect(mail.body).toBeNull();
    expect(mail.from).toBe('orders@shop.example');
  });

  it('turns an HTML body into paragraphs, Arabic ones right to left', async () => {
    const mail = await readMail(
      eml({ html: '<p>شكراً لطلبك من المتجر.</p><p>Total: 250 EGP for two items.</p>' }),
    );
    expect(mail.body).toEqual([
      { text: 'شكراً لطلبك من المتجر.', rtl: true },
      { text: 'Total: 250 EGP for two items.', rtl: false },
    ]);
    expect(isRtl('123 شارع')).toBe(true);
    expect(isRtl('Order #12 — شكراً')).toBe(false);
  });
});

describe('the IMAP source refuses private addresses (D128)', () => {
  const config: MailboxConfig = {
    host: '10.0.0.5',
    port: 993,
    security: 'tls',
    username: 'u',
    password: 'p',
    folder: 'INBOX',
  };
  it('an IP literal', async () => {
    await expect(imapSource()(config, { allowPrivate: false })).rejects.toMatchObject({
      code: 'private_address',
    });
  });
  it('a name that resolves to one, at connect time', async () => {
    const resolve = (
      _host: string,
      cb: (e: Error | null, a: { address: string; family: number }[]) => void,
    ) => cb(null, [{ address: '192.168.1.20', family: 4 }]);
    await expect(
      imapSource(resolve)({ ...config, host: 'imap.lan.example' }, { allowPrivate: false }),
    ).rejects.toMatchObject({ code: 'private_address' });
  });
});
