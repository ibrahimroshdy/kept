/**
 * /types/<id> (screens §2): one type's editor on its own page, for a link from anywhere (a
 * thing's type, a search result). The same editor as Account settings → Types; `?account=` says
 * which account's copy of the tree it sits in (yours by default).
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { useType } from '@/api/inventory/queries';
import { ErrorState, LoadingRows, Page } from '@/components/page';
import { useAccountTypes, useRequestedAccountScope } from '@/components/registries/api';
import { TypeEditor } from '@/components/registries/type-editor';
import { useTypeName } from '@/components/things/names';

export const Route = createFileRoute('/_app/types/$id')({
  validateSearch: z.catch(z.object({ account: z.optional(z.string()) }), {}),
  component: TypePage,
});

function TypePage() {
  const { t } = useLingui();
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const scope = useRequestedAccountScope();
  const types = useAccountTypes(scope.accountId);
  const detail = useType(id);
  const typeName = useTypeName();
  const title = detail.data ? typeName(detail.data) : t`Type`;
  return (
    <Page
      title={<bdi>{title}</bdi>}
      back="/settings/account/types"
      eyebrow={t`Account settings · Types`}
    >
      {scope.isPending || types.isPending ? (
        <LoadingRows rows={4} />
      ) : types.error ? (
        <ErrorState error={types.error} onRetry={() => void types.refetch()} />
      ) : (
        <TypeEditor
          typeId={id}
          scope={scope}
          types={types.types}
          onNavigate={(next) =>
            void navigate(
              next
                ? {
                    to: '/types/$id',
                    params: { id: next },
                    search: search.account ? { account: search.account } : {},
                  }
                : { to: '/settings/account/types' },
            )
          }
        />
      )}
    </Page>
  );
}
