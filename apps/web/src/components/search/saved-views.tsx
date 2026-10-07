/**
 * The search page's saved searches (screens §5 Search, D183, D205), listed when nothing is being
 * searched: a search and its filters kept under a name, for you only or shared with everyone in
 * one location. Saving, pinning and the default live on the filter strip's Views menu
 * (components/filters/views.tsx), as on every list; this list is the page's way in when idle.
 *
 * Deleting is offered on your own views and, for shared ones, to the location's admins; the
 * server has the last word.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useSavedViews } from '@/api/inventory/queries';
import type { SavedView } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { savedViewApi, useInvalidateViews } from '@/components/filters/views-api';
import { PeopleIcon, PersonIcon, TrashIcon } from '@/components/icons';
import { List, Section, useErrorText } from '@/components/page';
import { rowLink, Tile } from '@/components/places/rows';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useLocationName } from '@/lib/labels';

/** The saved searches list, shown when nothing is being searched. */
export function SavedViews({ onOpen }: { onOpen: (view: SavedView) => void }) {
  const { t } = useLingui();
  const views = useSavedViews('search');
  const locations = useLocations();
  const nameOf = useLocationName();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const invalidate = useInvalidateViews();
  const remove = useMutation({
    mutationFn: (v: SavedView) => savedViewApi.remove(v.id),
    onSuccess: async (_r, v) => {
      await invalidate();
      toast({ title: t`Deleted ${v.name}`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const list = views.data?.views ?? [];
  if (list.length === 0) return null;
  const roleIn = (id: string) => locations.data?.find((l) => l.id === id)?.role;
  const mayDelete = (v: SavedView) =>
    v.mine ||
    (v.sharedLocationId !== null &&
      (roleIn(v.sharedLocationId) === 'owner' || roleIn(v.sharedLocationId) === 'admin'));
  const where = (v: SavedView) => {
    if (!v.sharedLocationId) return t`Only you`;
    const l = locations.data?.find((x) => x.id === v.sharedLocationId);
    const name = l ? nameOf(l) : '';
    const by = v.createdBy.displayName;
    return t`Shared with ${name} · by ${by}`;
  };

  return (
    <Section title={<Trans>Saved searches</Trans>}>
      <List aria-label={t`Saved searches`}>
        {list.map((v) => (
          <li key={v.id} className="flex items-center">
            <button type="button" onClick={() => onOpen(v)} className={`${rowLink} text-start`}>
              <Tile>{v.sharedLocationId ? <PeopleIcon /> : <PersonIcon />}</Tile>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
                  <bdi>{v.name}</bdi>
                </span>
                <span className="text-small text-ink-2">{where(v)}</span>
              </span>
            </button>
            {mayDelete(v) ? (
              <Button
                variant="ghost"
                size="icon"
                className="me-2"
                aria-label={t`Delete ${v.name}`}
                onPress={async () => {
                  const name = v.name;
                  if (
                    await confirm({
                      title: t`Delete the saved search ${name}?`,
                      body: v.sharedLocationId
                        ? t`It goes for everyone it's shared with. The things it finds stay.`
                        : t`The things it finds stay.`,
                      confirmLabel: t`Delete`,
                      destructive: true,
                    })
                  )
                    remove.mutate(v);
                }}
              >
                <TrashIcon />
              </Button>
            ) : null}
          </li>
        ))}
      </List>
    </Section>
  );
}
