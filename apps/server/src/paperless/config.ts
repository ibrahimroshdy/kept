import {
  type Aad,
  type Keyring,
  type MasterKey,
  open,
  type Sealed,
  seal,
} from '../crypto/envelope.js';
import { invalid } from '../http/errors.js';

// A location's Paperless-ngx connection (1.x, D248): its address and API token, sealed together
// as `paperless_connections|<id>|config` (§7.3), so the token never sits in the clear and
// kept_app never reads it (0135). The address is also kept in the clear (`base_url`) for the
// settings page and the "Open in Paperless" links. The token is never answered, logged or
// audited.

export type PaperlessConfig = { baseUrl: string; token: string };

/** The longest token accepted. Paperless's are 40 hex characters; room for a proxy's own. */
export const MAX_TOKEN_CHARS = 512;

export const paperlessAad = (connectionId: string): Aad => ({
  table: 'paperless_connections',
  rowId: connectionId,
  fieldKey: 'config',
});

export function sealPaperlessConfig(
  master: MasterKey,
  id: string,
  config: PaperlessConfig,
): Sealed {
  return seal(master, JSON.stringify(config), paperlessAad(id));
}

export function openPaperlessConfig(keyring: Keyring, id: string, sealed: Sealed): PaperlessConfig {
  const parsed = JSON.parse(open(keyring, sealed, paperlessAad(id)).toString('utf8'));
  return { baseUrl: String(parsed.baseUrl), token: String(parsed.token) };
}

/**
 * The server's root from what a person typed: http or https, no user name or password, no query
 * or fragment; a trailing `/api` (or `/`) is dropped, so both the web address and the API's work.
 * A path prefix (Paperless behind a proxy at `/paperless`, PAPERLESS_FORCE_SCRIPT_NAME) is kept.
 * Answers the root without a trailing slash, e.g. `https://docs.example.com/paperless`.
 */
export function paperlessRoot(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid('url: an address like https://paperless.example.com.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('url: it starts with https:// (or http:// on your own network).');
  }
  if (url.username || url.password) throw invalid('url: no user name or password in it.');
  if (url.search || url.hash) throw invalid('url: no query or fragment.');
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '')
    .replace(/\/+$/, '');
  const root = url.href.replace(/\/+$/, '');
  if (root.length > 500) throw invalid('url: at most 500 characters.');
  return root;
}

/** A token as pasted: `Token abc…` or just `abc…`; printable ASCII, no spaces. */
export function paperlessToken(raw: string): string {
  const token = raw.trim().replace(/^token\s+/i, '');
  if (!token || token.length > MAX_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) {
    throw invalid('token: the API token from your Paperless profile.');
  }
  return token;
}
