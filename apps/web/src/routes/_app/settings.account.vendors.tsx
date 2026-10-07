/**
 * Account settings → Vendors (screens §5 Settings → Account; D11): the list standard, the add
 * box with the duplicate hint, and edit, merge and delete for the owner and admins.
 */
import { createFileRoute } from '@tanstack/react-router';
import { LoadingRows } from '@/components/page';
import { useRequestedAccountScope } from '@/components/registries/api';
import { RegistryList } from '@/components/registries/registry-list';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/account/vendors')({
  validateSearch: listSearch([]),
  component: VendorsTab,
});

function VendorsTab() {
  const scope = useRequestedAccountScope();
  if (scope.isPending || !scope.accountId) return <LoadingRows rows={3} />;
  return <RegistryList key={scope.accountId} kind="vendors" scope={scope} />;
}
