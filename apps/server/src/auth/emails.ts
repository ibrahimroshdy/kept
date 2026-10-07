import { randomUUID } from 'node:crypto';

/** Managed accounts (D47, D93) get a synthetic address under the reserved `.invalid` TLD
 * (RFC 2606): Better Auth requires an email on every user, and `.invalid` can never be
 * delivered or registered. */
export const MANAGED_EMAIL_DOMAIN = 'managed.invalid';

export function managedEmail(): string {
  return `${randomUUID()}@${MANAGED_EMAIL_DOMAIN}`;
}

/** Any `.invalid` address: never mailed, never accepted from a person (D176). */
export function isUndeliverableEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('.invalid');
}
