/**
 * Account settings → Types (screens §5 Type editor, frame 06 · 5): the tree on the left, the
 * selected type on the right (`?type=`). On a phone the tree is the page, and choosing a type
 * shows its editor with a way back to the tree.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import * as z from 'zod/mini';
import { ChevronStartIcon, GearIcon, PlusIcon } from '@/components/icons';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page';
import { useAccountTypes, useRequestedAccountScope } from '@/components/registries/api';
import { NewTypeSheet } from '@/components/registries/new-type-sheet';
import { TypeEditor } from '@/components/registries/type-editor';
import { TypeTree } from '@/components/registries/type-tree';
import { Button } from '@/components/ui/button';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/account/types')({
  validateSearch: listSearch([], { type: z.optional(z.string()) }),
  component: TypesTab,
});

function TypesTab() {
  const { t } = useLingui();
  const scope = useRequestedAccountScope();
  const search = Route.useSearch() as { type?: string; account?: string };
  const navigate = useNavigate();
  const types = useAccountTypes(scope.accountId);
  const [creating, setCreating] = useState(false);
  const selected =
    search.type && types.types.some((x) => x.id === search.type) ? search.type : undefined;
  const select = (id: string | null) =>
    void navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        type: id ?? undefined,
      })) as never,
    });

  if (scope.isPending || types.isPending) return <LoadingRows rows={4} label={t`Loading types`} />;
  if (types.error) return <ErrorState error={types.error} onRetry={() => void types.refetch()} />;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[270px_minmax(0,1fr)]">
      <div className={selected ? 'hidden lg:block' : undefined}>
        <TypeTree
          types={types.types}
          selectedId={selected}
          linkFor={(id) => ({
            to: '.',
            search: ((prev: Record<string, unknown>) => ({ ...prev, type: id })) as never,
          })}
          footer={
            scope.canManage ? (
              <Button
                variant="secondary"
                size="small"
                className="mt-1 justify-self-start"
                onPress={() => setCreating(true)}
              >
                <PlusIcon className="size-4" />
                <Trans>New type</Trans>
              </Button>
            ) : null
          }
        />
      </div>
      {selected ? (
        <div className="grid min-w-0 gap-3 rounded-[10px] border border-line bg-surface p-3.5 md:p-5">
          <Link
            to="."
            search={((prev: Record<string, unknown>) => ({ ...prev, type: undefined })) as never}
            className="inline-flex min-h-11 items-center gap-1 justify-self-start rounded-md pe-2 text-small font-semibold text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info lg:hidden"
          >
            <ChevronStartIcon className="size-4" />
            <Trans>All types</Trans>
          </Link>
          <TypeEditor typeId={selected} scope={scope} types={types.types} onNavigate={select} />
        </div>
      ) : (
        <div className="hidden lg:block">
          <EmptyState icon={<GearIcon />} title={<Trans>Pick a type</Trans>}>
            <Trans>
              A type sets the icon, capabilities and fields of the things that use it, and the types
              inside it inherit them. Built-in types come ready; customise one, or make your own.
            </Trans>
          </EmptyState>
        </div>
      )}
      <NewTypeSheet
        isOpen={creating}
        onClose={() => setCreating(false)}
        accountId={scope.accountId}
        types={types.types}
        parentId={selected ?? null}
        onCreated={(id) => select(id)}
      />
    </div>
  );
}
