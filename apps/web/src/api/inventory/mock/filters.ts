/**
 * The list filters of D205 as the mock reads them: a parameter may repeat (`?typeId=a&typeId=b`,
 * any of them matches) and `not` names the parameters that exclude their values instead, as the
 * server's list endpoints do.
 */

/** The values of `param` (repeated or single). */
export const valuesOf = (query: URLSearchParams, param: string): string[] =>
  query.getAll(param).filter((v) => v !== '');

/** `items` narrowed by `param`: any of its values (`has`), or none of them when `not` names it. */
export function narrow<T>(
  items: T[],
  query: URLSearchParams,
  param: string,
  has: (item: T, value: string) => boolean,
): T[] {
  const values = valuesOf(query, param);
  if (values.length === 0) return items;
  const none = query.getAll('not').includes(param);
  return items.filter((item) => values.some((v) => has(item, v)) !== none);
}
