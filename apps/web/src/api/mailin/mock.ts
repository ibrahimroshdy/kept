/**
 * Mock handlers for email-in (1.4, D231): a location's mailbox, for its owners and admins. A
 * host named `fail.example` refuses the password, as a server would; the password is never
 * answered.
 */
import type { MockState } from '../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../mock/kit';
import { mailinPaths as p } from './paths';
import type { Mailbox, MailboxBody, RecentMail } from './types';

type Stored = { mailbox: Mailbox; password: string; recent: RecentMail[] };
const stores = new WeakMap<MockState, Map<string, Stored>>();
const storeOf = (state: MockState) => {
  let s = stores.get(state);
  if (!s) {
    s = new Map();
    stores.set(state, s);
  }
  return s;
};

/** For tests: a location's mailbox with some recent mail. */
export function seedMailbox(state: MockState, locationId: string, stored: Stored): void {
  storeOf(state).set(locationId, stored);
}

const PORTS = { tls: 993, starttls: 143 } as const;

export function mailinMockRoutes(state: MockState): MockRoute[] {
  const roleIn = (id: string) => state.locations.find((l) => l.id === id)?.role;
  const gate = (id: string) => {
    const role = roleIn(id);
    if (!role) return notFound();
    if (role !== 'owner' && role !== 'admin') return forbidden();
    return null;
  };
  return [
    route('GET', p.mailbox(':id'), ({ params }) => {
      const id = params.id as string;
      const refused = gate(id);
      if (refused) return refused;
      const s = storeOf(state).get(id);
      return { mailbox: s?.mailbox ?? null, recent: s?.recent ?? [] };
    }),
    route('PUT', p.mailbox(':id'), ({ params, body }) => {
      const id = params.id as string;
      const refused = gate(id);
      if (refused) return refused;
      const b = body as MailboxBody;
      const saved = storeOf(state).get(id);
      const password = b?.password ?? saved?.password;
      if (!b?.host || !b.username || !b.folder || !password)
        return err(400, 'validation', 'The request is not valid.');
      if (b.host === 'fail.example')
        return reply(400, {
          error: 'The request is not valid.',
          code: 'validation',
          hint: 'The mailbox refused the user name or password.',
          mailError: 'auth_failed',
        });
      const mailbox: Mailbox = {
        id:
          saved?.mailbox.id ??
          `01926f00-0000-7000-8000-00000ma1${String(storeOf(state).size).padStart(4, '0')}`,
        host: b.host,
        port: b.port ?? PORTS[b.security],
        security: b.security,
        username: b.username,
        folder: b.folder,
        allowedSenders: (b.allowedSenders ?? []).map((a) => a.toLowerCase()),
        active: true,
        disabledReason: null,
        lastPolledAt: saved?.mailbox.lastPolledAt ?? null,
        lastError: null,
        createdBy: saved?.mailbox.createdBy ?? {
          id: state.me.user.id,
          displayName: state.me.user.displayName,
        },
      };
      storeOf(state).set(id, { mailbox, password, recent: saved?.recent ?? [] });
      return mailbox;
    }),
    route('POST', p.mailboxCheck(':id'), ({ params }) => {
      const id = params.id as string;
      const refused = gate(id);
      if (refused) return refused;
      return storeOf(state).get(id) ? { ok: true, error: null } : notFound();
    }),
    route('DELETE', p.mailbox(':id'), ({ params }) => {
      const id = params.id as string;
      const refused = gate(id);
      if (refused) return refused;
      if (!storeOf(state).delete(id)) return notFound();
      return reply(204);
    }),
  ];
}
