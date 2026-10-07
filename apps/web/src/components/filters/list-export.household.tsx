/**
 * "Export view" and "Print" for the things list you're looking at (D169, D201; screens §5
 * Location / Place / Container; step-7 T16 and T22). Loaded on demand (./list-export.tsx), since
 * both need the server.
 *
 * - **Export view**: `GET /things.csv` with exactly the list's parameters, fetched as a file (no
 *   new page) and saved, or offered to Share where downloads don't work (the installed iPhone
 *   app). Anyone who can see the list may export it; money is in it only where they can see money.
 * - **Print**: the inventory report of exactly that list (`filters.thingIds`), followed to its PDF
 *   in a sheet (../reports/progress.tsx). Its ids are read page by page first; past
 *   PRINT_MAX_THINGS it says to narrow the list instead. The report's scope follows the rows: one
 *   location, or the one account whose locations they're in (a brand's, vendor's or person's
 *   things); a list across two accounts' locations is asked to be narrowed to one.
 *
 * Offline, both are disabled with "Needs a connection" (screens §3).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { ApiError, isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import { reportsApi } from '@/api/inventory/reports';
import type { ReportScope, ThingListParams } from '@/api/inventory/types';
import { portabilityApi } from '@/api/portability/queries';
import { useLocations } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { DocumentIcon, PrinterIcon, ShareIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { ReportProgress } from '@/components/reports/progress';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { canShareFiles, downloadsWork, saveFile, shareFiles } from '@/lib/files';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';

/** The server's report limit (reports/gather.ts MAX_THINGS). */
export const PRINT_MAX_THINGS = 2000;
/** The server's largest page (§7.7). */
const PAGE = 200;

export type ListExportProps = {
  /** The list's GET /things parameters, as its query sends them (paging left out here). */
  params: ThingListParams;
};

/** The list's parameters without paging, for the CSV and for reading its ids. */
function filterOnly(params: ThingListParams): ThingListParams {
  const { cursor: _c, limit: _l, ...rest } = params;
  return rest;
}

/** Fetches the CSV with the list's parameters, as a file. */
export async function fetchThingsCsv(params: ThingListParams): Promise<File> {
  let res: Response;
  try {
    res = await fetch(portabilityApi.thingsCsvUrl(filterOnly(params)), {
      credentials: 'include',
      headers: { accept: 'text/csv' },
    });
  } catch {
    throw new ApiError(0, 'offline', 'Needs a connection');
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_found' : 'internal',
      res.statusText,
    );
  const day = new Date().toISOString().slice(0, 10);
  return new File([await res.blob()], `kept-things-${day}.csv`, { type: 'text/csv' });
}

export type ListedThing = { id: string; locationId: string };

/** The list's things (id and location), at most `max + 1` (one more says "too many"). */
export async function listThingIds(params: ThingListParams, max: number): Promise<ListedThing[]> {
  const rows: ListedThing[] = [];
  let cursor: string | null = null;
  do {
    const page = await inventoryApi.things({
      ...filterOnly(params),
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items.map((r) => ({ id: r.id, locationId: r.locationId })));
    cursor = page.next_cursor;
  } while (cursor && rows.length <= max);
  return rows.slice(0, max + 1);
}

/**
 * The report's scope for these things: their one location, else the one account owning all
 * their locations, else null (two accounts: a report covers one).
 */
export function scopeOf(
  rows: readonly ListedThing[],
  locations: readonly Pick<LocationDetail, 'id' | 'ownerAccountId'>[],
): ReportScope | null {
  const ids = new Set(rows.map((r) => r.locationId));
  const [first] = ids;
  if (first === undefined) return null;
  if (ids.size === 1) return { locationId: first };
  const accounts = new Set(
    [...ids].map((id) => locations.find((l) => l.id === id)?.ownerAccountId ?? `?${id}`),
  );
  const [account] = accounts;
  return accounts.size === 1 && account && !account.startsWith('?') ? { accountId: account } : null;
}

const itemClass =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[15px] text-ink outline-none data-focused:bg-sunken data-disabled:cursor-default data-disabled:text-ink-3 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-ink-2';

export function ListExport({ params }: ListExportProps) {
  const { t } = useLingui();
  const fmt = useFormat();
  const online = useOnline();
  const errorText = useErrorText();
  const [exporting, setExporting] = useState(false);
  // Fetched but not handed over: where downloads don't work, it waits for Share.
  const [ready, setReady] = useState<File | null>(null);
  const [printing, setPrinting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await fetchThingsCsv(params);
      if (downloadsWork()) saveFile(file);
      else setReady(file);
    } catch (e) {
      toast({
        tone: 'danger',
        title:
          isApiError(e) && e.code === 'rate_limited'
            ? t`Kept exports at most five lists an hour. Try again later.`
            : errorText(e),
      });
    } finally {
      setExporting(false);
    }
  };
  const shareCsv = async (file: File) => {
    const how = await shareFiles([file]);
    if (how === 'shared') setReady(null);
    if (how === 'refused') toast({ tone: 'danger', title: t`Couldn't share the CSV. Try again.` });
  };

  return (
    <>
      <MenuTrigger>
        <Button
          size="small"
          variant="secondary"
          isDisabled={!online}
          isPending={exporting}
          aria-label={online ? t`Export or print this list` : t`Needs a connection`}
          className="[&_svg]:size-4"
        >
          <DocumentIcon aria-hidden="true" />
          <span className="max-sm:sr-only">
            <Trans>Export</Trans>
          </span>
        </Button>
        <Popover
          placement="bottom end"
          offset={6}
          className="z-50 min-w-60 rounded-[10px] border border-line bg-surface shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
        >
          <Menu
            aria-label={t`Export or print this list`}
            onAction={(key) => {
              if (key === 'csv') void exportCsv();
              if (key === 'print') setPrinting(true);
            }}
            className="grid gap-px p-1 outline-none"
          >
            <MenuItem id="csv" textValue={t`Export view (CSV)`} className={itemClass}>
              <DocumentIcon aria-hidden="true" />
              <span className="grid min-w-0 flex-1">
                <span>
                  <Trans>Export view (CSV)</Trans>
                </span>
                <span className="text-small text-ink-3">
                  <Trans>The things in this list, as a spreadsheet</Trans>
                </span>
              </span>
            </MenuItem>
            <MenuItem id="print" textValue={t`Print`} className={itemClass}>
              <PrinterIcon aria-hidden="true" />
              <span className="grid min-w-0 flex-1">
                <span>
                  <Trans>Print</Trans>
                </span>
                <span className="text-small text-ink-3">
                  <Trans>A PDF of this list, up to {fmt.num(PRINT_MAX_THINGS)} things</Trans>
                </span>
              </span>
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>

      {ready ? (
        <Sheet isOpen onOpenChange={(open) => !open && setReady(null)} title={t`Your CSV is ready`}>
          {({ close }) => (
            <div className="grid gap-4">
              <p className="m-0 text-ink-2">
                {canShareFiles([ready]) ? (
                  <Trans>Share it to save it to Files or send it on.</Trans>
                ) : (
                  <Trans>
                    This browser can't save files here. Open Kept in Safari to export it.
                  </Trans>
                )}
              </p>
              <DialogFooter>
                <Button variant="secondary" onPress={close}>
                  <Trans>Close</Trans>
                </Button>
                {canShareFiles([ready]) ? (
                  <Button onPress={() => void shareCsv(ready)}>
                    <ShareIcon className="size-4" />
                    <Trans>Share</Trans>
                  </Button>
                ) : null}
              </DialogFooter>
            </div>
          )}
        </Sheet>
      ) : null}

      <Sheet isOpen={printing} onOpenChange={setPrinting} title={t`Print this list`}>
        {({ close }) => <PrintList params={params} onClose={close} />}
      </Sheet>
    </>
  );
}

type PrintState =
  | { step: 'reading' }
  | { step: 'too_many' }
  | { step: 'empty' }
  | { step: 'two_accounts' }
  | { step: 'running'; runId: string; rows: ListedThing[] }
  | { step: 'failed'; error: unknown; rows: ListedThing[] | null };

function PrintList({ params, onClose }: ListExportProps & { onClose: () => void }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const locations = useLocations();
  const [state, setState] = useState<PrintState>({ step: 'reading' });

  const start = async (known: ListedThing[] | null) => {
    setState({ step: 'reading' });
    let rows = known;
    try {
      rows ??= await listThingIds(params, PRINT_MAX_THINGS);
      if (rows.length > PRINT_MAX_THINGS) return setState({ step: 'too_many' });
      if (rows.length === 0) return setState({ step: 'empty' });
      const scope = scopeOf(rows, locations.data ?? []);
      if (!scope) return setState({ step: 'two_accounts' });
      const { id } = await reportsApi.start({
        scope,
        // The list's own things, ended ones included when the list shows them.
        filters: { thingIds: rows.map((r) => r.id), includeEnded: true },
      });
      setState({ step: 'running', runId: id, rows });
    } catch (error) {
      setState({ step: 'failed', error, rows });
    }
  };
  // Once, when the sheet opens (a second effect run in development must not start two runs).
  const began = useRef(false);
  useEffect(() => {
    if (began.current) return;
    began.current = true;
    void start(null);
  });

  const failure = (e: unknown) =>
    isApiError(e) && e.code === 'rate_limited'
      ? t`Kept makes at most five reports an hour. Try again later.`
      : errorText(e);

  return (
    <div className="grid gap-4">
      {state.step === 'reading' ? (
        <p className="m-0 text-ink-2" role="status">
          <Trans>Reading the list…</Trans>
        </p>
      ) : state.step === 'too_many' ? (
        <Notice tone="warn">
          <Trans>Narrow the list to {fmt.num(PRINT_MAX_THINGS)} things to print it.</Trans>
        </Notice>
      ) : state.step === 'two_accounts' ? (
        <Notice tone="warn">
          <Trans>
            This list holds things from more than one account. Filter it to one location to print
            it.
          </Trans>
        </Notice>
      ) : state.step === 'empty' ? (
        <Notice>
          <Trans>There's nothing in this list to print.</Trans>
        </Notice>
      ) : state.step === 'failed' ? (
        <Notice tone="danger">{failure(state.error)}</Notice>
      ) : (
        <ReportProgress
          key={state.runId}
          runId={state.runId}
          onRetry={() => void start(state.rows)}
        />
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Close</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
