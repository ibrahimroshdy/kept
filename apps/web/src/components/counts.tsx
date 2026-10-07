import { Plural } from '@lingui/react/macro';

/** Counts follow the digit setting through Lingui's `locales` (D143). */
export function ThingCount({ n }: { n: number }) {
  return <Plural value={n} one="# thing" other="# things" />;
}

export function PeopleCount({ n }: { n: number }) {
  return <Plural value={n} one="# person" other="# people" />;
}
