/**
 * "Link from Paperless" (1.x, D248): searches the location's Paperless-ngx through Kept's server
 * (Paperless's own full-text search: title, content, correspondent, type and tags), shows each
 * document's thumbnail, and links the ones ticked. A sheet on a phone, a dialog from `md` up.
 * Documents already linked here are shown ticked and can't be ticked again. Pages are Paperless's
 * own, 24 a page.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { isApiError } from '@/api/client';
import { paperlessPaths } from '@/api/paperless/paths';
import { paperlessApi, paperlessKeys, usePaperlessSearch } from '@/api/paperless/queries';
import type { PaperlessHit, PaperlessSubject } from '@/api/paperless/types';
import { SearchIcon } from '@/components/icons';
import { EmptyState, LoadingRows, Notice, Pill, useErrorText } from '@/components/page';
import { useRoleLabels } from '@/components/things/labels';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { TickBox } from '@/components/ui/tick-box';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { PaperlessThumb } from './documents';
import { usePaperlessErrorWords } from './words';

/** The most documents one Link sends (the server's batch). */
const MAX_PICK = 20;

export function PaperlessPicker({
  locationId,
  subject,
  name,
  onClose,
}: {
  locationId: string;
  subject: PaperlessSubject;
  name: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const words = usePaperlessErrorWords();
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [saving, setSaving] = useState(false);
  // Search as the person types, once they pause.
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(id);
  }, [typed]);
  const search = usePaperlessSearch(locationId, q, page, subject, true);
  const pages = search.data ? Math.max(1, Math.ceil(search.data.count / search.data.pageSize)) : 1;
  const toggle = (id: number, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const link = async (close: () => void) => {
    setSaving(true);
    try {
      const { items } = await paperlessApi.link({ ...subject, documentIds: [...picked] });
      await qc.invalidateQueries({ queryKey: paperlessKeys.links(subject) });
      const n = items.length;
      toast({ title: t`Linked ${n} from Paperless`, tone: 'ok' });
      close();
    } catch (e) {
      const code = isApiError(e) ? (e.details.paperlessError as string | undefined) : undefined;
      toast({
        title: t`Couldn't link them`,
        description: code ? (words(code) ?? errorText(e)) : errorText(e),
        tone: 'danger',
      });
    } finally {
      setSaving(false);
    }
  };
  const problem =
    search.error && isApiError(search.error)
      ? (words(search.error.details.paperlessError as string | undefined) ??
        errorText(search.error))
      : search.error
        ? errorText(search.error)
        : null;
  return (
    <Sheet
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t`Link from Paperless to ${name}`}
    >
      {({ close }) => (
        <div className="grid gap-3">
          <TextField
            label={t`Search Paperless`}
            description={t`Words from the title or the text, a correspondent, a type or a tag.`}
            value={typed}
            onChange={setTyped}
            type="search"
            autoComplete="off"
          />
          {problem ? (
            <Notice tone="danger" title={<Trans>Paperless can't be reached</Trans>}>
              {problem}
            </Notice>
          ) : search.isPending ? (
            <LoadingRows rows={4} label={t`Searching Paperless`} />
          ) : (search.data?.items.length ?? 0) === 0 ? (
            <EmptyState icon={<SearchIcon />} title={<Trans>No documents found</Trans>}>
              {q ? (
                <Trans>Try other words.</Trans>
              ) : (
                <Trans>This Paperless has no documents yet.</Trans>
              )}
            </EmptyState>
          ) : (
            <ul
              aria-label={t`Paperless documents`}
              className="m-0 grid list-none gap-0 divide-y divide-line rounded-[10px] border border-line p-0"
            >
              {search.data?.items.map((d) => (
                <li key={d.documentId} className="px-3">
                  <Hit
                    hit={d}
                    locationId={locationId}
                    picked={d.linked || picked.has(d.documentId)}
                    full={!picked.has(d.documentId) && picked.size >= MAX_PICK}
                    onChange={(on) => toggle(d.documentId, on)}
                  />
                </li>
              ))}
            </ul>
          )}
          {pages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-small text-ink-2">
              <Button
                variant="ghost"
                size="small"
                isDisabled={page <= 1 || search.isFetching}
                onPress={() => setPage((p) => p - 1)}
              >
                <Trans>Previous</Trans>
              </Button>
              <span>
                <Trans>
                  Page {page} of {pages}
                </Trans>
              </span>
              <Button
                variant="ghost"
                size="small"
                isDisabled={page >= pages || search.isFetching}
                onPress={() => setPage((p) => p + 1)}
              >
                <Trans>Next</Trans>
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onPress={close}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              isDisabled={picked.size === 0}
              isPending={saving}
              onPress={() => void link(close)}
            >
              <Plural
                value={picked.size}
                _0="Link"
                one="Link # document"
                other="Link # documents"
              />
            </Button>
          </DialogFooter>
        </div>
      )}
    </Sheet>
  );
}

function Hit({
  hit: d,
  locationId,
  picked,
  full,
  onChange,
}: {
  hit: PaperlessHit;
  locationId: string;
  picked: boolean;
  full: boolean;
  onChange: (on: boolean) => void;
}) {
  const fmt = useFormat();
  const roles = useRoleLabels();
  const details = [roles[d.kind], d.correspondent, d.createdOn ? fmt.day(d.createdOn) : null]
    .filter(Boolean)
    .join(fmt.sep);
  return (
    <div className="flex items-center gap-3 py-1">
      <PaperlessThumb src={paperlessPaths.documentThumb(locationId, d.documentId)} />
      <TickBox
        isSelected={picked}
        isDisabled={d.linked || full}
        onChange={onChange}
        className="min-w-0 flex-1"
        description={
          <>
            <bdi>{details}</bdi>
            {d.tags.length > 0 ? (
              <span className="mt-1 flex flex-wrap gap-1">
                {d.tags.map((tag) => (
                  <Pill key={tag}>
                    <bdi>{tag}</bdi>
                  </Pill>
                ))}
              </span>
            ) : null}
          </>
        }
      >
        <span className="font-semibold">
          <bdi>{d.title}</bdi>
        </span>
        {d.linked ? (
          <>
            {' '}
            <Pill tone="ok">
              <Trans>Linked</Trans>
            </Pill>
          </>
        ) : null}
      </TickBox>
    </div>
  );
}
