/**
 * Settings → Account → Templates (plan T30; D76, D177, Q17): the account's templates, list-standard
 * (search in the URL), each with its type and the locations it's shared with. Owners and admins
 * add, edit and delete them; a template shared with a location you don't administer is left out
 * of this list, because editing needs admin of every location that uses it.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { captureApi, captureKeys } from '@/api/capture/queries';
import type { AccountTemplate } from '@/api/capture/types';
import { CopyIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, useErrorText } from '@/components/page';
import { Tile } from '@/components/places/rows';
import { type AccountScope, useWholeList } from '@/components/registries/api';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useListState } from '@/lib/url-state';
import { TemplateSheet } from './template-sheet';

export function TemplateList({ scope }: { scope: AccountScope }) {
  const { t } = useLingui();
  const [list] = useListState();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const [editing, setEditing] = useState<AccountTemplate | null | undefined>(undefined);
  const query = useWholeList(
    captureKeys.templates.account(scope.accountId),
    () => captureApi.accountTemplates(scope.accountId).then((r) => r.items),
    list.q,
    (x: AccountTemplate) => x.name,
    !!scope.accountId,
  );
  const remove = useMutation({
    mutationFn: (x: AccountTemplate) => captureApi.deleteTemplate(x.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: captureKeys.templates.all }),
    onError: (e) =>
      toast({ title: t`Couldn't delete it`, description: errorText(e), tone: 'danger' }),
  });
  const askRemove = async (x: AccountTemplate) => {
    const name = x.name;
    const ok = await confirm({
      title: t`Delete ${name}?`,
      body: t`Things already started from it keep their details.`,
      confirmLabel: t`Delete`,
      destructive: true,
    });
    if (ok) remove.mutate(x);
  };

  // With none yet (and nothing searched), "New template" is the empty card's own action, as the
  // Inbox's and Paperwork's are; under a list it follows the rows (UI audit L4).
  const none = !list.q && query.isSuccess && (query.data?.pages[0]?.items.length ?? 0) === 0;
  const newButton = (
    <Button variant="secondary" className="justify-self-start" onPress={() => setEditing(null)}>
      <PlusIcon className="size-4" />
      <Trans>New template</Trans>
    </Button>
  );

  return (
    <div className="grid gap-3">
      <ListSurface<AccountTemplate>
        label={t`Templates`}
        search={{ label: t`Search templates`, placeholder: t`Search templates` }}
        query={query}
        getKey={(x) => x.id}
        empty={
          <EmptyState
            icon={<CopyIcon />}
            title={<Trans>No templates yet</Trans>}
            action={scope.canManage ? newButton : undefined}
          >
            <Trans>
              Save the details you type again and again, and share them with your locations. Start
              one here, or use Save as template on a thing.
            </Trans>
          </EmptyState>
        }
        renderRow={(x) => {
          const where = x.locations.map((l) => l.name).join(', ');
          return (
            <div className="flex min-h-14 items-center gap-3 px-3.5 py-2.5">
              <Tile>
                <TypeIcon icon={x.typeIcon} />
              </Tile>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-semibold text-[15px] [overflow-wrap:anywhere]">
                  <bdi>{x.name}</bdi>
                </span>
                <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
                  <Plural
                    value={x.locations.length}
                    one="Shared with 1 location"
                    other="Shared with # locations"
                  />
                  {': '}
                  <bdi>{where}</bdi>
                </span>
              </span>
              {scope.canManage ? (
                <span className="flex shrink-0 gap-1">
                  <Button variant="secondary" size="small" onPress={() => setEditing(x)}>
                    <Trans>Edit</Trans>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t`Delete ${x.name}`}
                    onPress={() => void askRemove(x)}
                  >
                    <TrashIcon />
                  </Button>
                </span>
              ) : null}
            </div>
          );
        }}
      />
      {scope.canManage && !none ? newButton : null}
      <TemplateSheet
        isOpen={editing !== undefined}
        onClose={() => setEditing(undefined)}
        accountId={scope.accountId}
        template={editing ?? null}
      />
    </div>
  );
}
