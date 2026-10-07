/**
 * Unicode's first-strong isolate and its end, for a name set inside a translated sentence given
 * as a string (a toast, an aria-label, a line built with `t`): the name keeps its own direction
 * without turning the sentence around it (a Latin name in an Arabic line, an Arabic one in a
 * French line). In JSX, wrap the name in <bdi> instead.
 */
import { createElement, type ReactElement } from 'react';

export const FSI = '⁨';
export const PDI = '⁩';

/** `s` between FSI and PDI; an empty string stays empty. */
export const isolate = (s: string): string => (s ? `${FSI}${s}${PDI}` : s);

/**
 * `s` in a <bdi>, for a name inside a <Trans> sentence: a call keeps the message's positional
 * placeholder ({0}), so the catalogue's messages stay as they are.
 */
export const bdi = (s: string): ReactElement => createElement('bdi', null, s);

/** The sentence without its isolate marks (an accessible name, a comparison). */
export const plainText = (s: string): string => s.replace(/[⁦-⁩]/g, '');
