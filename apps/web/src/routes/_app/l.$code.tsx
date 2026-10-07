/**
 * `/l/<code>`: a label read by the phone's own camera (plan T26; D120, D137; V6, V7). Signed out,
 * the app frame's gate sends the person to sign in and back here with the code in the URL. The
 * code is all it carries, never data. The page is components/scan/label-link.tsx.
 */
import { createFileRoute } from '@tanstack/react-router';
import { LabelLink } from '@/components/scan/label-link';

export const Route = createFileRoute('/_app/l/$code')({ component: LabelPage });

function LabelPage() {
  const { code } = Route.useParams();
  return <LabelLink key={code} code={code} />;
}
