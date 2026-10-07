/**
 * /people/<id> (screens §2): the person page. Built by task 28 in
 * components/registries/registry-page.tsx, shared with the other registry pages.
 */

import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { createFileRoute } from '@tanstack/react-router';
import { RegistryPage } from '@/components/registries/registry-page';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/people/$id')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.things),
  component: PersonPage,
});

function PersonPage() {
  const { id } = Route.useParams();
  return <RegistryPage key={id} kind="people" id={id} />;
}
