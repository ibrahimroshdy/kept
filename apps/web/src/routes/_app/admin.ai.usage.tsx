/**
 * Admin → AI usage (plan T29a; D206): per-account totals and the calls the instance key paid, with
 * the account and person but no location, thing or thread (D33). Inside the admin frame.
 */
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { AI_CALL_FILTERS } from '@/components/ai/call-filters';
import { InstanceUsagePage } from '@/components/ai/usage-page';
import { listSearch } from '@/lib/url-state';

const text = z.optional(z.string());

export const Route = createFileRoute('/_app/admin/ai/usage')({
  validateSearch: listSearch(AI_CALL_FILTERS, { period: text, from: text, to: text }),
  component: InstanceUsagePage,
});
