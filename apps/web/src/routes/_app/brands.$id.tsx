/**
 * /brands/<id> (screens §2): the brand page. Built by task 28 in
 * components/registries/registry-page.tsx, shared with the other registry pages.
 */

import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { createFileRoute } from '@tanstack/react-router';
import { RegistryPage } from '@/components/registries/registry-page';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/brands/$id')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.things),
  component: BrandPage,
});

function BrandPage() {
  const { id } = Route.useParams();
  return <RegistryPage key={id} kind="brands" id={id} />;
}
