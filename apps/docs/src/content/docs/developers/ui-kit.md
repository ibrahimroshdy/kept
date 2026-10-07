---
title: UI kit
description: Kept's design tokens, type, brand and component primitives, and the rules every screen follows.
---

The web app's look comes from two design files in the repo, and the code copies them rather than
reinterpreting them:

- [`docs/design/kept-design-board.html`](https://github.com/ibrahimroshdy/kept/blob/main/docs/design/kept-design-board.html):
  tokens, type, the brand and the visual motif;
- [`docs/design/kept-screens.html`](https://github.com/ibrahimroshdy/kept/blob/main/docs/design/kept-screens.html):
  every screen as a frame, with flow maps and the component kit in both themes. It is built from
  the fragments in `docs/design/screens/` by `python3 docs/design/screens/assemble.py`; edit the
  fragments, not the output.

Open either file in a browser. The screens spec
([`docs/specs/2026-09-26-kept-screens.md`](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-26-kept-screens.md))
is the text that goes with them.

## Tokens

`apps/web/src/styles/tokens.css` holds the tokens (D131), copied verbatim from the design board:
names, values and even hex case, so a value can be grepped across both. Biome skips the file for
that reason. Don't change a value here without changing the board. `apps/web/src/styles/index.css`
exposes each one to Tailwind v4 through `@theme inline`, as `bg-surface`, `text-ink-2`,
`border-line`, `bg-amber`, `text-amber-ink` and so on.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--paper` | `#F2F1EC` | `#151412` | The page |
| `--surface` | `#FBFAF7` | `#1E1C19` | Cards, sheets, the tab bar |
| `--sunken` | `#ECEAE4` | `#26231F` | Recessed areas |
| `--line` | `#DEDBD3` | `#34302A` | Borders and rules |
| `--ink` | `#1C1B19` | `#F2EFE9` | Text |
| `--ink-2` | `#55524C` | `#BDB7AC` | Secondary text |
| `--ink-3` | `#6B675F` | `#9A948A` | Tertiary text |
| `--amber` | `#F0B03A` | `#F0B03A` | Label tape, the brand |
| `--amber-ink` | `#2E2100` | `#2E2100` | Text on amber |
| `--amber-text` | `#8A5700` | `#F4C165` | Amber as text |
| `--violet` | `#5B3CC4` | `#A898FA` | AI only (the board reserves it) |
| `--violet-soft` | `#EEEAFD` | `#2A2447` | AI backgrounds |
| `--ok` | `#1E7B3C` | `#5CC27F` | Success |
| `--warn` | `#A6480A` | `#F28A4E` | Warnings |
| `--danger` | `#B42318` | `#F97066` | Errors, destructive actions |
| `--info` | `#2459A8` | `#7FA8EE` | Information, focus rings |
| `--s1`, `--s2`, `--s3` | `#2a78d6`, `#eb6834`, `#1baf7a` | `#3987e5`, `#d95926`, `#199e70` | Chart series |
| `--s-other` | `#A8A399` | `#6E695F` | The "other" series |

Every text token meets 4.5:1 against its background (D131). The "Used for" column is a summary;
the board is the reference.

## Type

IBM Plex Sans, IBM Plex Sans Arabic and IBM Plex Mono (D79, D132), weights 400, 500 and 600. The
fonts **ship with the app** through `@fontsource` packages imported in `index.css`, never from a
CDN; the server's CSP wouldn't allow one. The service worker precaches the Latin and Arabic
subsets only.

The scale (D132), as Tailwind text sizes in `index.css`:

| Utility | Size / line height |
|---|---|
| `text-display` | 28 / 34 px |
| `text-title` | 20 / 26 px |
| `text-body` | 15 / 23 px |
| `text-small` | 13 / 18 px |
| `text-label` | 11.5 px |

Arabic uses Plex Sans Arabic at the same scale with a taller line height (1.75).

## The brand and the tape

The brand is "label tape" (D135). The mark is a square of amber tape with a heavy mono K and the
tape's punched hole at the top start. The hole is there at every size, from the favicon in a
browser tab to the 512 px app icon, and it is cut out of the tape, so it shows whatever the mark
sits on (the opaque app icons fill it with the kit's paper). The lockup is that mark with KEPT
beside it, in the text colour. Both the K and the wordmark are Plex Mono SemiBold outlines drawn as
paths, so the logo needs no font at any size, and the tape keeps its colours in both themes.

`apps/web/src/components/brand.tsx` exports `BrandLockup` (the mark and KEPT: the sidebar and the
sign-in and setup pages) and `AppMark` (the mark alone). Every logo file comes from one script,
[`scripts/render-icons.mjs`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/render-icons.mjs),
which carries the same geometry: the web app's and the docs site's favicons, the docs site's logo,
the app icons (including the maskable one) and the README's light and dark lockups.
[`scripts/render-social-preview.mjs`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/render-social-preview.mjs)
draws the repository's social preview (`docs/assets/social-preview.png`) from the same lockup.
Change `brand.tsx` and `render-icons.mjs` together, run both scripts and commit what they write;
then run [`scripts/capture-screens.mjs`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/capture-screens.mjs)
so the screenshots on this site and the README hero show the new logo.

The tape is also the one visual motif (D134): the `tape` utility in `index.css`, and the short-ID
chip `IdChip` (`components/id-chip.tsx`), the same object as the printed label on a box. A chip
is always left-to-right, even in Arabic; a thing captured offline shows a dashed "ID pending"
chip until it syncs.

## Components

Primitives are [React Aria Components](https://github.com/adobe/react-spectrum) (D95),
wrapped in `apps/web/src/components/ui/`:

| File | Exports |
|---|---|
| `button.tsx` | `Button` (`primary`, `secondary`, `ghost`, `danger`; `default`, `small`, `icon`) |
| `dialog.tsx` | `Modal`, `Dialog`, `DialogFooter`, `DialogTrigger` |
| `confirm.tsx` | `ConfirmProvider`, `useConfirm()` |
| `toast.tsx` | `toast()`, `Toaster` |
| `select.tsx`, `combobox.tsx` | `Select`, `SelectItem`, `Combobox`, `ComboboxItem` |
| `text-field.tsx`, `password-field.tsx`, `field.tsx` | Text inputs, `Label`, `Description`, `FieldError` |
| `date-picker.tsx`, `time-field.tsx` | `DatePicker`, `TimeField` |
| `switch.tsx`, `tick-box.tsx`, `segmented.tsx` | `Switch`, `TickBox`, `Segmented`, `ChoiceCards` |
| `tabs.tsx`, `tooltip.tsx`, `card.tsx` | `Tabs`, `TabList`, `Tab`, `TabPanel`, `Tip`, `Card` |
| `copy-button.tsx`, `qr-code.tsx` | `CopyButton`, `QrCode` |

Screen building blocks are in `components/page.tsx`: `Page`, `Section`, `List`, `Row`, `Pill`,
`Notice`, `EmptyState`, `ErrorState`, `LoadingRows`. Feature components live in folders under
`apps/web/src/components/` named after the area (`things/`, `places/`, `capture/`, `inbox/`,
`vehicles/`, `warranties/`, …). Icons are lucide, plus the inline stroke icons in
`components/icons.tsx`.

## Rules every screen follows

**No native pickers or dialogs.** Never a native `<select>`, never an OS date or time picker, never
`window.confirm`, `alert` or `prompt`. Use `Select`, `Combobox`, `DatePicker`, `TimeField`, and
for a confirmation:

```tsx title="apps/web/src/components/ui/confirm.tsx"
const confirm = useConfirm();
if (await confirm({ title: t`Remove this member?`, confirmLabel: t`Remove`, destructive: true })) {
  // …
}
```

It renders an alert dialog: focus starts on Cancel, Escape cancels, and a click outside doesn't
dismiss it.

**44 px touch targets.** The kit draws some controls at 32 to 40 px. On a touch screen
(`pointer: coarse`), a rule in `index.css` grows every button, link, tab, option, switch and
radio's hit area to at least 44 × 44 px with a transparent `::after`, without redrawing it.

**Nothing truncated on a phone.** No text cut short with "…" at 375 px: wrap it instead. Long
tokens such as model ids use the `model-id` utility, which moves to the next line whole.

**Every list is a list surface.** Search, filters, grouping, sorting and cursor pagination, all
held in the URL (`lib/url-state.ts`), so a list can be linked and Back restores it. Use
`ListSurface` from `apps/web/src/components/list-surface.tsx` with `useListState()`; filters come
from the filter strip (`components/filters/strip.tsx`) and sort, group and layout from its Display
button. Don't argue a list is too short to need it.

**Right-to-left.** Logical CSS only, names in `<bdi>`, separators from `fmt.sep`. See
[Languages and right-to-left](/developers/i18n-rtl/).

**Both widths, both themes.** Check every screen at 375 px and 1280 px, light and dark, and in
Arabic.

## Light, dark and the pre-paint script

The theme follows the OS unless the person picks one; the choice is stored in `localStorage` as
`kept.theme` (`apps/web/src/lib/prefs.ts`). An inline, synchronous script in
`apps/web/index.html` runs before the first paint and sets `data-theme`, the language, the
direction, the content width and the sidebar state on `<html>`, so there is no light flash in dark
mode and no left-to-right flash in Arabic. Every storage read in it is wrapped in `try`/`catch`.
Tailwind's `dark:` variant follows `data-theme`, not only the OS setting. Keep the storage keys in
the script and in `prefs.ts` in step.
