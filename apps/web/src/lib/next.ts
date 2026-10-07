/** A same-app path to return to after signing in, or undefined. Never another origin. */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  return value;
}

export const nextSearch = (search: Record<string, unknown>): { next?: string } => {
  const next = safeNext(search.next);
  return next ? { next } : {};
};
