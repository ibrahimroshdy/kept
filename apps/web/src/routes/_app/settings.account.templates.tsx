/** Account → Templates (plan T30; D76, D177): list-standard, with the template sheet. */
import { createFileRoute } from '@tanstack/react-router';
import { LoadingRows } from '@/components/page';
import { useRequestedAccountScope } from '@/components/registries/api';
import { TemplateList } from '@/components/templates/template-list';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/account/templates')({
  validateSearch: listSearch([]),
  component: TemplatesTab,
});

function TemplatesTab() {
  const scope = useRequestedAccountScope();
  if (scope.isPending || !scope.accountId) return <LoadingRows rows={3} />;
  return <TemplateList key={scope.accountId} scope={scope} />;
}
