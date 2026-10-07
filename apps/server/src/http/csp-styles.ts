// Inline <style> elements that React Aria injects at runtime, allowed by hash (never by
// 'unsafe-inline'). Both are static text, so their hashes are fixed per React Aria version;
// csp-styles.test.ts recomputes them from the installed react-aria and fails on an upgrade that
// changes them.
//
// - usePress (every pressable, every page): `touch-action: pan-x pan-y pinch-zoom` on
//   `[data-react-aria-pressable]`, so Safari still fires pointercancel on scroll.
// - usePreventScroll on mobile WebKit (a modal or sheet open on an iPhone): `overscroll-behavior:
//   contain`, so a nested list doesn't scroll the page behind the sheet.
//
// Hashes only cover <style> elements: `style` attributes stay blocked (that needs
// 'unsafe-hashes'), and styles set through the CSSOM (element.style.x = …) are not affected by
// CSP at all.

/** The exact text of each injected <style>, as React Aria 3.52 writes it (after `.trim()`). */
export const REACT_ARIA_STYLES = {
  pressable:
    '@layer {\n  [data-react-aria-pressable] {\n    touch-action: pan-x pan-y pinch-zoom;\n  }\n}',
  preventScroll: '@layer {\n  * {\n    overscroll-behavior: contain;\n  }\n}',
} as const;

/** CSP source expressions for REACT_ARIA_STYLES (sha256, base64). */
export const LIBRARY_STYLE_HASHES = [
  "'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='",
  "'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='",
] as const;
