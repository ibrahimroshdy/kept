/**
 * Step 4's parts of the thing page in one module, loaded on demand (./household-lazy.tsx): the
 * Value, Loans, Claims and Schedules sections, the warranties in Paperwork, and the Lend and Mark
 * returned sheets. vite.config.ts names this module's chunk into assets/household/, which the
 * service worker caches on first use instead of precaching (the 3 MB precache budget, D101): all
 * of it reads the server, so none of it could work offline before its first load anyway.
 */
export { ClaimsSection } from '@/components/claims/claims-section';
export { LendSheet } from '@/components/lending/lend-sheet';
export { ReturnSheet } from '@/components/lending/return-sheet';
export { ThingLoansSection } from '@/components/lending/thing-loans';
export { ValueSection } from '@/components/money/value-section';
export { WarrantiesBlock } from '@/components/warranties/warranties-section';
export { ThingSchedulesSection } from './schedules-section';
