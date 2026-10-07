// Text a client names itself with (an OAuth app's metadata document): shown as is, but never
// allowed to reorder the page around it.

/**
 * Bidi controls (embeddings, overrides, isolates and marks) taken out of the text an app gives
 * itself: inside the page's isolate an override still reorders it, so "Claude \u202eevil\u202c
 * Desktop" read as "Claude live Desktop" (D179; UI review steps 6–8, M6).
 */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export const withoutBidiControls = (s: string): string => s.replace(BIDI_CONTROLS, '');
