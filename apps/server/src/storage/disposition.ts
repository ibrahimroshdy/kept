// Content-Disposition for served files (D157). Shared by the S3 driver's presigned URLs and the
// local `/f/<token>` route, in a module of its own so the local path never loads the AWS SDK.

const FILENAME_MAX = 255;

/** A Content-Disposition value (RFC 6266): an ASCII `filename` for old clients, and the real
 * name as RFC 5987 `filename*`. Quotes, backslashes, controls and non-ASCII never reach the
 * quoted form, so the value can't break out of the header. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const name = filename.slice(0, FILENAME_MAX);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_').trim() || 'file';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encoded
    ? `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`
    : `${type}; filename="${ascii}"`;
}
