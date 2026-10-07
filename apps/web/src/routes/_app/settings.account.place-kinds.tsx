/** Account settings → Place kinds (D160): the kinds of room and spot, and the fields each carries. */
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { LoadingRows } from '@/components/page';
import { useRequestedAccountScope } from '@/components/registries/api';
import { PlaceKinds } from '@/components/registries/place-kinds';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/account/place-kinds')({
  validateSearch: listSearch([], { kind: z.optional(z.string()) }),
  component: PlaceKindsTab,
});

function PlaceKindsTab() {
  const scope = useRequestedAccountScope();
  const search = Route.useSearch() as { kind?: string };
  if (scope.isPending || !scope.accountId) return <LoadingRows rows={3} />;
  return (
    <PlaceKinds
      key={scope.accountId}
      scope={scope}
      {...(search.kind ? { selected: search.kind } : {})}
    />
  );
}
