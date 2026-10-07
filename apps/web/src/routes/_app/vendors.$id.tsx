/**
 * /vendors/<id> (screens §2): the vendor page. Built by task 28 in
 * components/registries/registry-page.tsx, shared with the other registry pages.
 */

import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { createFileRoute } from '@tanstack/react-router';
import { RegistryPage } from '@/components/registries/registry-page';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/vendors/$id')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.things),
  component: VendorPage,
});

function VendorPage() {
  const { id } = Route.useParams();
  return <RegistryPage key={id} kind="vendors" id={id} />;
}
