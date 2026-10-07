/**
 * One incident (plan T26; D158): its references, documents, the things it affected and their
 * claims, "Mark these stolen", the insurance report and a claim pack for it. Loads on demand
 * (components/incidents/lazy.tsx).
 */
import { createFileRoute } from '@tanstack/react-router';
import { IncidentScreen } from '@/components/incidents/lazy';
import { IncidentsRouteError } from '@/components/incidents/route-error';

export const Route = createFileRoute('/_app/incidents/$id')({
  component: IncidentPage,
  errorComponent: IncidentsRouteError,
});

function IncidentPage() {
  const { id } = Route.useParams();
  return <IncidentScreen id={id} />;
}
