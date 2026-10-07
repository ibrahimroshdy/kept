/** The base32 secret from an otpauth:// URI, grouped in fours for typing by hand. */
export function secretOf(uri: string): string {
  try {
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    return secret.replace(/(.{4})/g, '$1 ').trim();
  } catch {
    return '';
  }
}
