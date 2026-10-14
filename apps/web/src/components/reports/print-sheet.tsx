/**
 * "Print inventory" (D201, task 32; screens §10): a button that opens a sheet of what to put in
 * the report — places, types and tags (all of each unless some are chosen), ended things, things
 * in the Trash, QR codes — then makes the PDF on the server and follows it to Download
 * (./progress.tsx). On the location page it covers that location; on Settings → Account, the
 * account's locations you can see.
 *
 * Anyone who can see a location may make one, viewers too; what money it shows is the server's
 * decision (the same gates as the app). Offline the button is disabled and says why (screens §3).
 *
 * 1.3 (D228): "Email it to me" also mails the PDF when it's done, and for a location "Send it
 * again" keeps a weekly or monthly schedule of the whole location (Settings → Me → Notifications
 * lists and stops them).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { reportKeys, reportsApi } from '@/api/inventory/reports';
import type { InventoryReportBody, ReportScope } from '@/api/inventory/types';
import { FieldEditor } from '@/components/filters/panel';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { useValueLabels } from '@/components/filters/values';
import { ChevronEndIcon, ChevronStartIcon, DocumentIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import type { ListState } from '@/lib/url-state';
import { ReportProgress } from './progress';

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Whether the browser says it's online (a report is made on the server). */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export function PrintInventory({
  scope,
  locationIds,
}: {
  scope: ReportScope;
  /** The locations whose places the sheet offers. */
  locationIds: string[];
}) {
  const { t } = useLingui();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button variant="secondary" size="small" isDisabled={!online} onPress={() => setOpen(true)}>
        <DocumentIcon className="size-4" />
        <Trans>Print inventory</Trans>
      </Button>
      {online ? null : (
        <span className="text-small text-ink-3">
          <Trans>Needs a connection</Trans>
        </span>
      )}
      <Sheet isOpen={open} onOpenChange={setOpen} title={t`Print inventory`}>
        {({ close }) => <PrintForm scope={scope} locationIds={locationIds} onClose={close} />}
      </Sheet>
    </div>
  );
}

const EMPTY: ListState = {
  q: '',
  filters: {},
  not: [],
  savedView: undefined,
  group: undefined,
  sort: undefined,
};

function PrintForm({
  scope,
  locationIds,
  onClose,
}: {
  scope: ReportScope;
  locationIds: string[];
  onClose: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const registry = useFilterRegistry();
  // The server takes lists of ids to include; "is none of" has no meaning here.
  const defs: FilterDef[] = [
    { ...registry.place(locationIds), label: t`Places`, negatable: false },
    { ...registry.type(), label: t`Types`, negatable: false },
    { ...registry.tag(), label: t`Tags`, negatable: false },
  ];
  const [list, setList] = useState<ListState>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [includeTrashed, setIncludeTrashed] = useState(false);
  const [qr, setQr] = useState(false);
  const [email, setEmail] = useState(false);
  const [repeat, setRepeat] = useState<'never' | 'weekly' | 'monthly'>('never');
  const [runId, setRunId] = useState<string | null>(null);
  const qc = useQueryClient();
  const locationId = 'locationId' in scope ? scope.locationId : null;

  const chosen = (key: string) => list.filters[key] ?? [];
  const body = (): InventoryReportBody => {
    const ids = (key: string) => (chosen(key).length ? chosen(key) : undefined);
    const placeIds = ids('place');
    const typeIds = ids('type');
    const tagIds = ids('tag');
    return {
      scope,
      filters: {
        ...(placeIds ? { placeIds } : {}),
        ...(typeIds ? { typeIds } : {}),
        ...(tagIds ? { tagIds } : {}),
        includeEnded,
        includeTrashed,
      },
      include: { qr },
      ...(email ? { email: true } : {}),
    };
  };
  const start = useMutation({
    mutationFn: async (b: InventoryReportBody) => {
      if (locationId && repeat !== 'never') {
        await reportsApi.schedule({ locationId, kind: 'inventory', cadence: repeat });
        await qc.invalidateQueries({ queryKey: reportKeys.schedules });
      }
      return reportsApi.start(b);
    },
    onSuccess: ({ id }) => setRunId(id),
  });
  const startError = (e: unknown) =>
    isApiError(e) && e.code === 'rate_limited'
      ? t`Kept makes at most five reports an hour. Try again later.`
      : errorText(e);

  if (runId)
    return (
      <div className="grid gap-4">
        <ReportProgress
          key={runId}
          runId={runId}
          onRetry={() => {
            setRunId(null);
            start.mutate(body());
          }}
        />
        {start.error ? <Notice tone="danger">{startError(start.error)}</Notice> : null}
        {email ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>It's also on its way to your email.</Trans>
          </p>
        ) : null}
        {repeat !== 'never' ? (
          <p className="m-0 text-small text-ink-2">
            {repeat === 'weekly' ? (
              <Trans>Kept emails this location's inventory every Monday morning.</Trans>
            ) : (
              <Trans>Kept emails this location's inventory on the 1st of every month.</Trans>
            )}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </div>
    );

  const field = defs.find((d) => d.key === editing);
  if (field)
    return (
      <div className="grid gap-3">
        <div className="flex items-center gap-1.5">
          <AriaButton
            aria-label={t`Back`}
            onPress={() => setEditing(null)}
            className="grid size-9 cursor-pointer place-items-center rounded-md text-ink-2 outline-none data-hovered:bg-sunken data-hovered:text-ink data-focus-visible:outline-2 data-focus-visible:outline-info"
          >
            <ChevronStartIcon aria-hidden="true" className="size-[18px]" />
          </AriaButton>
          <span className="font-semibold text-[15px]">{field.label}</span>
        </div>
        <FieldEditor
          def={field}
          list={list}
          commit={(patch) =>
            setList((l) => ({ ...l, filters: { ...l.filters, ...patch.filters }, not: [] }))
          }
          onDone={() => setEditing(null)}
        />
        <DialogFooter>
          <Button onPress={() => setEditing(null)}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </div>
    );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate(body());
      }}
    >
      <p className="m-0 text-small text-ink-2">
        <Trans>
          A PDF of the things here, grouped by place, with their photos and short IDs. Prices are in
          it only where you can see them.
        </Trans>
      </p>
      <ul aria-label={t`What to include`} className="m-0 grid list-none gap-px p-0">
        {defs.map((def) => (
          <li key={def.key}>
            <FieldRow def={def} chosen={chosen(def.key)} onOpen={() => setEditing(def.key)} />
          </li>
        ))}
      </ul>
      <div className="grid">
        <Switch isSelected={includeEnded} onChange={setIncludeEnded}>
          <Trans>Include ended things</Trans>
        </Switch>
        <Switch isSelected={includeTrashed} onChange={setIncludeTrashed}>
          <Trans>Include things in the Trash</Trans>
        </Switch>
        <Switch isSelected={qr} onChange={setQr}>
          <Trans>QR codes</Trans>
        </Switch>
        <Switch isSelected={email} onChange={setEmail}>
          <Trans>Email it to me</Trans>
        </Switch>
      </div>
      {locationId ? (
        <div className="grid gap-1.5">
          <Segmented<'never' | 'weekly' | 'monthly'>
            label={t`Send it again`}
            value={repeat}
            onChange={setRepeat}
            options={[
              { id: 'never', label: t`Never` },
              { id: 'weekly', label: t`Every week` },
              { id: 'monthly', label: t`Every month` },
            ]}
          />
          {repeat !== 'never' ? (
            <p className="m-0 text-small text-ink-3">
              <Trans>
                Emailed to you: the whole location, with photos, as it is that day. Stop it in
                Settings → Me → Notifications.
              </Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {start.error ? <Notice tone="danger">{startError(start.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={start.isPending}>
          <Trans>Make the PDF</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

/** One of places, types and tags: what's chosen ("All" until something is), opening its list. */
function FieldRow({
  def,
  chosen,
  onOpen,
}: {
  def: FilterDef;
  chosen: string[];
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const named = useValueLabels(def, chosen);
  const summary = chosen.length === 0 ? t`All` : named.map((o) => o.label).join(t`, `);
  return (
    <AriaButton
      onPress={onOpen}
      className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-start text-[15px] text-ink outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:bg-sunken"
    >
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-medium">{def.label}</span>
        <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
          <bdi>{summary}</bdi>
        </span>
      </span>
      <ChevronEndIcon aria-hidden="true" className="size-5 shrink-0 text-ink-3" />
    </AriaButton>
  );
}
