# Spike L1: the app lock (WebAuthn user verification, PRF, the PIN)

Date: 2026-10-06. Step-8 plan, Task 0b (it feeds T1's `APP_LOCK` and T21's app lock; D181, D210,
Q22). Result: **PASS** in Chromium; the phone rows are **maintainer check pending**.
- **User verification works:** in headless Chromium 153.0.8010.12 with a CDP virtual platform
  authenticator, a credential is created and asserted with `userVerification: 'required'`
  (`authenticatorAttachment: 'platform'`, UV flag set in both). With verification failing, or an
  authenticator that can't verify, both calls are refused (`NotAllowedError`).
- **Q22, PRF in Chromium: yes.** An authenticator with PRF returns a 32-byte secret **at creation and
  at every assertion**; the same salt gives the same secret, a second salt a different one. An
  authenticator with only CTAP2 `hmac-secret` reports `prf.enabled: true` at creation **without** a
  secret, and gives one at assertion. One with neither reports `enabled: false`. The secret,
  through HKDF, wrapped and unwrapped an AES-GCM data key.
- **The PIN: 2,850,000 PBKDF2-SHA-256 iterations take 288 ms** in Chromium on this laptop (median of
  7). CDP's `Emulation.setCPUThrottlingRate` at 4× slows page JavaScript 3.9× but **leaves WebCrypto's
  PBKDF2 at 288 ms**, so it isn't a slower-core proxy for this. On the efficiency cores
  (`taskpolicy -b`), the same count took 1.9 s (contended; an upper bound).
- **The phones:** published sources say PRF ships in Safari 18 (iOS 18) for iCloud Keychain passkeys
  and in Chrome for Android 116+ with Google Password Manager; the installed PWA cases have no
  published statement. All four device rows are pending.

Code: `docs/spikes/code/step8/app-lock/`:
- `app-lock.spike.mjs`: serves `page.html` on `localhost` (a random port), launches headless Chromium,
  runs five virtual-authenticator cases and the PIN timings, then node's for comparison.
- `page.html`: the probe (WebAuthn create/get with PRF, the PRF and PIN wrapping, PBKDF2 timing).
- `pin-only.spike.mjs`: the PIN timing alone, for a run under `taskpolicy -b`.
- `node-pbkdf2.mjs`: PBKDF2 in node (`webcrypto.subtle` and `pbkdf2Sync`).
- `results-2026-10-06.json`, `results-pin-only-2026-10-06.jsonl`: the full runs. PRF outputs are
  recorded only as lengths and equalities.
- `package.json` + `package-lock.json` (npm, outside the workspace).

## Versions and sources

| | Version |
|---|---|
| `playwright` | 1.63.0 (Apache-2.0; the same version as `apps/web`'s `@playwright/test`) |
| Chromium | 153.0.8010.12 (`browser.version()`; Playwright's `chromium-headless-shell` revision 1243) |
| Node | 24.21.0 |
| Machine | Apple M1 Pro (8 performance + 2 efficiency cores), 16 GB, macOS 26.5.1; load average 26–46 from other agents during the runs |

Read on 2026-10-06:
- The CDP WebAuthn and Emulation domains, from the protocol definition the docs site is built from
  (`json/browser_protocol.json` in github.com/ChromeDevTools/devtools-protocol, master) and from
  `playwright-core/types/protocol.d.ts` 1.63.0. `VirtualAuthenticatorOptions` has `hasPrf` ("the
  authenticator will support the prf extension", default false), `hasHmacSecret`,
  `hasUserVerification`, `isUserVerified`, `hasResidentKey`, `automaticPresenceSimulation`,
  `transport` (`internal` among others), `ctap2Version`. `WebAuthn.setUserVerified` exists.
  `Emulation.setCPUThrottlingRate({rate})`: "Enables CPU throttling to emulate slow CPUs."
- The WebAuthn Level 3 editor's draft, §10.1.4 "Pseudo-random function extension (prf)",
  <https://w3c.github.io/webauthn/#prf-extension>: inputs `eval {first, second?}` and
  `evalByCredential` (assertions only, needs `allowCredentials`); "Not all authenticators support
  evaluating the PRFs during credential creation so outputs may, or may not, be provided"; salts are
  `SHA-256("WebAuthn PRF" || 0x00 || input)`; outputs are 32 bytes.
- The phone sources are in the table under "The phones".

## WebAuthn in Chromium

Every case: `protocol: 'ctap2'`, `ctap2Version: 'ctap2_1'`, `transport: 'internal'`,
`hasResidentKey: true`, `automaticPresenceSimulation: true`. The page asks for `rp.id: 'localhost'`,
a platform authenticator, `residentKey: 'required'`, `userVerification: 'required'`, ES256/RS256,
and `extensions.prf.eval.first` at creation.

| Case (options) | create | `prf` at create | get, UV | `prf` at get | same salt → same secret | 2nd salt differs |
|---|---|---|---|---|---|---|
| `hasPrf` | ok, UV ✓ | `enabled: true`, `results.first` 32 B | ok, UV ✓ | 32 B | yes | yes |
| `hasHmacSecret` only | ok, UV ✓ | `enabled: true`, **no results** | ok, UV ✓ | 32 B | yes | yes |
| neither | ok, UV ✓ | `enabled: false` | ok, UV ✓ | no results | | |
| `hasPrf`, `isUserVerified: false` | `NotAllowedError` | | | | | |
| `hasUserVerification: false` | `NotAllowedError` | | | | | |

After a `hasPrf` credential was created, `WebAuthn.setUserVerified(false)` made the next assertion
fail with `NotAllowedError`: user verification is enforced per call, not remembered.

**Detecting support:** `PublicKeyCredential.getClientCapabilities()` answered `extension:prf: true`
for every case, including the authenticator with no PRF: it describes the browser, not the
authenticator. Only `getClientExtensionResults().prf.enabled` after `create()` tells. By contrast,
`isUserVerifyingPlatformAuthenticatorAvailable()` (and the capability
`userVerifyingPlatformAuthenticator`) was `false` only for the authenticator without user
verification, so it decides whether to offer "Use Face ID or fingerprint".

**The PRF secret as a key:** `HKDF-SHA-256(secret, info "kept app lock v1")` → an AES-KW key wrapped a
random AES-GCM-256 data key (40 bytes) and unwrapped it; a text encrypted with the data key
decrypted with the unwrapped one.

## The PIN

`PBKDF2-SHA-256(PIN, 16-byte random salt, n)` → an AES-KW key (`deriveKey`, not extractable) that
wraps the AES-GCM data key (`wrapKey('raw', …, 'AES-KW')`, 40 bytes). A wrong PIN's key fails
`unwrapKey` (AES-KW's integrity check): the app learns "wrong PIN" without a stored hash.

| Where | n | Median |
|---|---|---|
| Chromium (5 runs each) | 100,000 / 300,000 / 600,000 | 10.6 / 29.7 / 62.2 ms |
| Chromium, **the target** (7 runs; again in `pin-only`) | **2,850,000** | **287.8 ms** (288.5 ms) |
| Chromium, the whole wrap path at the target | 2,850,000 | 288.6 ms |
| Chromium, CDP CPU throttling 4× | 2,850,000 | 288.0 ms (page JS: 93 → 366 ms) |
| Chromium on the efficiency cores (`taskpolicy -b`) | 2,850,000 / 600,000 | 1,896 / 718 ms (page JS: 87 → 2,153 ms) |
| node `webcrypto.subtle` / `pbkdf2Sync` | 2,850,000 | 1,302 / 1,238 ms |
| node on the efficiency cores | 2,850,000 | 4,346 / 3,027 ms |

The target is the 600,000 point scaled to 300 ms and rounded down to 50,000. Chromium's PBKDF2 is
~4.5× faster than node's here, so node's numbers don't stand in for the browser. The efficiency-core
runs share two cores with 25+ runnable processes from other agents (page JavaScript slowed 25×, far
more than the cores' speed difference), so read them as an upper bound, not a phone estimate. **No
measurement here predicts a phone;** the device rows do.

OWASP's Password Storage Cheat Sheet recommends 600,000 iterations for PBKDF2-HMAC-SHA256
(<https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>, read
2026-10-06). The target is 4.75× that.

**What the PIN protects against** (computed from the measured rate): a six-digit PIN has 10⁶ values.
At 2.85 M iterations one guess costs ~0.29 s on one core, so all of them cost ~80 core-hours (~10 h
on this laptop's eight performance cores); at 600,000, ~17 core-hours. GPUs are faster (inferred, not
measured). Ten wrong PINs wipe the device's copy in the app (D181), but someone who copies the
browser profile's IndexedDB can try PINs offline. The PRF path has no such gap: its secret is 32
random bytes held by the authenticator.

## The phones

From published documentation (read 2026-10-06):

| Platform | What the sources say | Sources |
|---|---|---|
| iOS Safari (tab) | Safari 18 adds the `prf` extension, on iOS 18, iPadOS 18, macOS and visionOS 2. Yubico: works with iCloud Keychain passkeys (Face ID/Touch ID); iOS passes no extension data to roaming security keys. Corbado reports data-loss bugs in 18.0–18.3 when the iPhone is the cross-device source, fixed in 18.4. MDN's compatibility data (BCD 8.1.4) lists `prf` in `create()` for Safari iOS 18 but **not** in `get()` (pointing at WebKit bug 259934, which is RESOLVED); this contradicts WebKit's own statement and is unresolved here. | [WebKit: Safari 18.0](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/); [Yubico developer guide to PRF](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html); [Corbado, modified 2026-09-29](https://www.corbado.com/blog/passkeys-prf-webauthn); `@mdn/browser-compat-data` 8.1.4, `api.CredentialsContainer.{create,get}.publicKey_option.extensions.prf`; [WebKit bug 259934](https://bugs.webkit.org/show_bug.cgi?id=259934) |
| iOS installed PWA | No source found that addresses PRF in a home-screen web app. BCD lists `webview_ios` as Safari's (create 18, get no). Inferred: the same WebKit WebAuthn as Safari. | as above |
| Android Chrome (tab) | BCD: `prf` in `create()` and `get()` since Chrome for Android 116 (and Samsung Internet 24). The Chromium intent to ship: "Some passkey providers on Android 14 may not support it." Corbado: all Google Password Manager passkeys support PRF; third-party providers vary (Bitwarden ~29% in their tests). | [Intent to Ship: WebAuthn PRF extension](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI) (2023-04-29); BCD 8.1.4; Corbado |
| Android installed PWA | No source found. BCD lists Android WebView with no support, but an installed PWA runs in Chrome, not WebView (inferred). | |

Google's "Passkey support on Android and Chrome" page (last updated 2025-05-19) and passkeys.dev's
device-support matrix (last updated 2026-09-21) don't mention PRF.

**Device rows** (for `docs/spikes/2026-xx-step8-devices.md`; Kept's L1 probe on the device, over
HTTPS, never on a real authenticator from an agent):

| Device | UV create + get (`required`) | `prf.enabled` at create | PRF secret at create / get | PIN unlock time at the chosen count | Result |
|---|---|---|---|---|---|
| iPhone, Safari tab | | | | | maintainer check pending |
| iPhone, installed PWA | | | | | maintainer check pending |
| Android, Chrome tab (Google Password Manager) | | | | | maintainer check pending |
| Android, installed PWA | | | | | maintainer check pending |

## Findings for the plan

1. **Detect PRF from `create()`'s `prf.enabled`, never from `getClientCapabilities()`.**
2. **A secret may not come back at creation** (`hmac-secret` authenticators, and the spec allows it
   generally). Setup then runs one `get()` with the credential's id in `allowCredentials` and the
   same salt to obtain it: a second Face ID/fingerprint prompt during setup.
3. **Store per device:** the credential id (needed in `allowCredentials`), the PRF salt, and for the
   PIN its salt **and iteration count** next to each wrapped key, so the count can change later
   without breaking devices already set up.
4. **Offer the biometric option only when `isUserVerifyingPlatformAuthenticatorAvailable()` is true.**
5. **Wrong PIN = failed `unwrapKey`:** no PIN hash to store or compare.
6. **CDP CPU throttling doesn't slow WebCrypto,** so T25/perf can't use it to approximate a slow
   phone's unlock. The device rows are the measure.
7. The PIN path slows, but doesn't stop, an offline attack on a copied profile (above).

## Changes to the plan

- **T1:** `APP_LOCK.pbkdf2Iterations = 2_850_000` (≈ 288 ms in Chromium on the laptop, the plan's
  definition). T21 stores the count with each PIN-wrapped key (finding 3). If the device rows show
  an unlock over about 1 s on the slower phone, lower the constant for new wraps; OWASP's 600,000 is
  the floor.
- **T21:** PRF setup per findings 1, 2 and 4; Q22's answer for Chromium is "PRF available" when
  `prf.enabled` is true, and the PIN-only path otherwise, as planned.
- **T19/T21 wording (proposal):** the "keep offline" warning and the docs say the PIN keeps out
  someone holding the phone, not someone who has copied the browser's storage; the passkey (PRF)
  protects against both. Behaviour stays as planned (the PIN still opens the extras, Q22).
- **The device checklist** gets the four rows above.

## Rerun

```sh
cd docs/spikes/code/step8/app-lock && npm ci
npx playwright install chromium-headless-shell   # only if revision 1243 isn't cached
node app-lock.spike.mjs                           # writes results-2026-10-06.json
taskpolicy -b node pin-only.spike.mjs 2850000     # the efficiency-core run
```
