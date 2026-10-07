# Spike V18: driver.js hints with RTL, keyboard and screen readers

Date: 2026-09-26. Step-3 plan, Task 0. Result: **passes, with two things T31's wrapper must do:**
1. flip the alignment in RTL, because driver.js positions with physical sides;
2. put focus back after "Got it", because the beacon is removed and focus drops to `<body>`.

react-joyride (the fallback) was **not** installed.

Code: `docs/spikes/code/step3/web/` (`spike-hints.html`, `src/spike-hints.ts`,
`spike-e2e/hints.spec.ts`). The page is `dir="rtl" lang="ar"` with Arabic copy, and it runs under
Kept's CSP (`default-src 'self'`). Checked in Chromium through Playwright 1.63.0, with
`@axe-core/playwright` 4.13.0 (MPL-2.0, a dev-only spike tool).

## Versions (checked with `npm view` on 2026-09-26)

| Package | Version | Licence | Notes |
|---|---|---|---|
| `driver.js` | 1.8.0 | MIT | Exports `.` (the `driver()` tour), `./hints`, `./dist/driver.css` and `./dist/hints.css`. `hints.mjs` is 15.4 KB raw, and `hints.css` holds the popover styles as well |
| `react-joyride` | 3.2.0 | MIT | the fallback. Not needed |

API from `dist/hints.d.mts`:
- `hints(config)` takes `{hints, beacon, buttonText, popoverClass, popoverOffset, overlay, overlayColor, overlayOpacity, onOpen, onDismiss, onButtonClick}`.
- It returns `{show, hide, open, close, dismiss, restore, setHints, getHints, getActive, isVisible, refresh}`.
- A `DriverHint` is `{element, id, beacon: {side, align, animate, className}, popover: {title, description, side, align, popoverClass, showButton, buttonText, onButtonClick, onPopoverRender}, onOpen, onDismiss, data}`.

## What was proven

- **The popover has a role and a name.**
  - It is `role="dialog"`, with `aria-labelledby` pointing at the title and `aria-describedby`
    at the description.
  - Playwright finds it with `getByRole('dialog', {name: 'اختر الوضع'})`.
  - With the popover open, **axe found 0 violations**.
  - The popover is **not** `aria-modal` and doesn't trap focus. That suits a hint that never
    blocks (D138).
- **The beacon is a real button.**
  - It is a `<button>` with `aria-label` = the popover title, `aria-haspopup="dialog"`, and an
    `aria-expanded` that toggles.
  - It is appended to `<body>`, so it comes **last in tab order**. Measured order:
    `before → mode-strip → after → beacon`.
- **A keyboard user can reach "Got it".**
  1. Enter on the beacon opens the popover.
  2. Focus moves straight to the "Got it" button (`فهمت`). The close button isn't shown in
     hints mode.
  3. Enter on it dismisses the hint: `onDismiss` fires, and the beacon is removed.
- **Escape closes it and focus returns** to the beacon, on a `keyup` listener. This works in
  overlay mode too: the SVG overlay is removed as well.
- **Focus after "Got it" is lost.** The beacon is gone, so `document.activeElement` is `<body>`.
- **The text mirrors.** The popover inherits `dir`: computed `direction: rtl`, right-aligned
  text, and "Got it" at the inline end. driver.js's `.driver-popover` rule uses `all: unset`, which doesn't
  reset `direction`.
- **The position does not mirror by itself.**
  - `align: 'start' | 'end'` and `side: 'left' | 'right'` are physical: `end` is always the
    right edge.
  - Left alone in RTL, the beacon sits on the target's **right** corner, which is inline-start.
  - Flipping `start ↔ end` in RTL gives an exact mirror of LTR. With a 900 px viewport:

    | | Beacon centre | Popover |
    |---|---|---|
    | LTR | the target's right edge (204 = 204) | left edge 22 px before the beacon |
    | RTL, flipped | the target's left edge (696 = 696) | right edge 22 px after the beacon |

  - In hints mode (no overlay) the popover is anchored to the **beacon**, not the target.
- **It works under Kept's CSP**, with no console errors. driver.js positions through CSSOM
  (`element.style.left = …`), which `style-src 'self'` doesn't block. The SVG overlay does the
  same.
- **Reduced motion is handled.** `hints.css` turns the beacon pulse and the overlay fade off
  under `prefers-reduced-motion: reduce`. `beacon.animate: false` also stops the pulse.

## What T31's `use-hint.ts` must do

- **Map logical to physical positions.** If `document.dir === 'rtl'`, swap `start ↔ end` for
  `align`, and `left ↔ right` for `side`, on both `beacon` and `popover`. Default to the beacon
  at `{side: 'top', align: <logical end>}` and the popover at
  `{side: 'bottom', align: <logical start>}`.
- **Put focus back after "Got it".** In `onDismiss`, move focus to the hinted element, or the
  element that had it before. Otherwise a keyboard or screen-reader user lands on `<body>`.
- **Use constant strings only.** The title and description are written with `innerHTML`, so pass
  only the i18n constants from `@kept/shared` `hints.ts`, never user data.
- **Restyle with logical CSS.** Use `popoverClass` plus Kept's own logical CSS, keeping
  `check-logical-css` clean. `hints.css` uses physical properties (`right: 0` on the close
  button, `text-align: right` in the footer, `margin-left` between the nav buttons). These don't
  show in hints mode, but they do in the `driver()` tour.
- **Tour arrow keys are physical.** Read from `driver.js.mjs`, not tested: ArrowRight means
  "next" and ArrowLeft means "previous", whatever the `dir`. In RTL that runs against the reading
  direction. "Show me around" should either live with it, or set `allowKeyboardControl: false`
  and handle Escape and the arrows in the wrapper. `allowKeyboardControl` controls Escape too.
- **Screen readers on real devices aren't covered.** VoiceOver (iOS/macOS) and NVDA weren't run.
  The role, name and focus were checked through the accessibility tree and axe. This goes in the
  device checklist.

## Fallback

Not taken. `react-joyride` stays uninstalled.
