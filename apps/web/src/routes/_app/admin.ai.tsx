/**
 * Admin → AI (plan T29; D206): the instance key, the instance caps (overall and per account), the
 * versioned price table in edit mode, and a link to instance usage. Inside the admin frame
 * (admin.tsx), and the parent of /admin/ai/usage (admin.ai.usage.tsx): when a child matches, this
 * renders only the child.
 */
import { createFileRoute, Outlet, useChildMatches } from '@tanstack/react-router';
import { AiSettings } from '@/components/ai/settings-page';

export const Route = createFileRoute('/_app/admin/ai')({ component: AdminAiRoute });

function AdminAiRoute() {
  if (useChildMatches().length > 0) return <Outlet />;
  return <AiSettings scope="instance" />;
}
