/**
 * Tokens in the URL fragment (D181): `#token=abc` (magic links) or a bare `#abc` (invites,
 * screens §2 `/invite#<token>`). The fragment is never sent to the server.
 */
export function tokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  if (raw.includes('=')) {
    const value = new URLSearchParams(raw).get('token');
    return value?.trim() ? value.trim() : null;
  }
  const bare = decodeURIComponent(raw).trim();
  return /^[A-Za-z0-9_-]{6,}$/.test(bare) ? bare : null;
}
