/**
 * The Kept instances the e2e run starts (e2e/serve.mjs), one per purpose so no test sees
 * another's data: each project gets a fresh, never-set-up instance of its own for the flow
 * (first-run setup happens once per instance) and a seeded one for the sign-in tests.
 *
 * Ports sit away from 8080, the port `node dist/main.js` and the dev server use, so a running dev
 * server doesn't collide with an e2e run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Instance = { name: string; port: number; seed: boolean };

export const INSTANCES = {
  phone: { name: 'flow-phone', port: 8181, seed: false },
  desktop: { name: 'flow-desktop', port: 8182, seed: false },
  seedPhone: { name: 'seed-phone', port: 8183, seed: true },
  seedDesktop: { name: 'seed-desktop', port: 8184, seed: true },
  // Step 2's flows (e2e/step2.spec.ts) write to the inventory: a seeded instance of their own.
  step2Phone: { name: 'inventory-phone', port: 8185, seed: true },
  step2Desktop: { name: 'inventory-desktop', port: 8186, seed: true },
  // The UI audit's axe pass and keyboard walk (e2e/audit.spec.ts): a capture and a label print.
  auditPhone: { name: 'audit-phone', port: 8193, seed: true },
  auditDesktop: { name: 'audit-desktop', port: 8194, seed: true },
  // Step 4's household journeys (e2e/step4.spec.ts): lending, schedules, documents, incidents
  // and the notification centre, on a seeded instance of their own.
  household: { name: 'household', port: 8188, seed: true },
} as const satisfies Record<string, Instance>;

/**
 * Step 5's vehicle journeys (e2e/step5.spec.ts): seeded with `households`, every AI call answered
 * by the mock (the service invoice's lines, e2e/fixtures/mock-answers.json), as the capture
 * instance is. Its key for KEPT_E2E_INSTANCES is `vehicles`.
 */
export const VEHICLES_INSTANCE: Instance & { aiMock: true } = {
  name: 'vehicles',
  port: 8189,
  seed: true,
  aiMock: true,
};

/**
 * Steps 6–8's journeys run behind HTTPS (serve.mjs `--https`: a TLS proxy with a self-signed
 * certificate made for the run), because token creation, an export with secrets, revealing a
 * secret and the backup settings are refused over plain http (D181). Their contexts take
 * `ignoreHTTPSErrors`. Keys for KEPT_E2E_INSTANCES: `assistant`, `portability`, `operations`.
 */
export type TlsInstance = Instance & { https: true; aiMock?: boolean; owner?: boolean };

/** Step 6 (e2e/step6.spec.ts): the assistant on the mock's scripted cases, tokens and /mcp. */
export const ASSISTANT_INSTANCE: TlsInstance = {
  name: 'assistant',
  port: 8195,
  seed: true,
  aiMock: true,
  https: true,
};

/** Step 7 (e2e/step7.spec.ts): the Homebox and Kept imports, the export, consumables. */
export const PORTABILITY_INSTANCE: TlsInstance = {
  name: 'portability',
  port: 8196,
  seed: true,
  https: true,
};

/** Step 8 (e2e/step8.spec.ts): Admin → Backups (with the owner login a run needs), the app lock. */
export const OPERATIONS_INSTANCE: TlsInstance = {
  name: 'operations',
  port: 8197,
  seed: true,
  https: true,
  owner: true,
};

export const urlOf = (i: Instance & { https?: boolean }) =>
  `${i.https ? 'https' : 'http'}://localhost:${i.port}`;

/** Where serve.mjs keeps an instance's config, data and log: the repo's gitignored .tmp/. */
export const stateDirOf = (i: Instance) =>
  fileURLToPath(new URL(`../../../.tmp/e2e/${i.name}/`, import.meta.url));

/** The setup code the instance printed on first boot (`KEPT SETUP CODE: XXX-XXX`). */
export function printedSetupCode(i: Instance): string {
  const log = readFileSync(`${stateDirOf(i)}server.log`, 'utf8');
  const codes = [...log.matchAll(/^KEPT SETUP CODE: (\S+)$/gm)].map((m) => m[1]);
  if (codes.length !== 1 || !codes[0]) {
    throw new Error(`${i.name}: expected one setup code line in its log, found ${codes.length}`);
  }
  return codes[0];
}
