/**
 * One inbox item (screens §5 "Inbox", D18, D19, D36): the card for its kind. A draft shows its
 * photo and what AI filled in and accepted, the values that wait as Suggested (confirm `y` or
 * reject `n`), where naming is ("Naming…", "Waiting: AI paused until 1 Oct", "Waiting for Groq",
 * "Couldn't read this photo · Retry · Fill in by hand"), and the AI line. Accept (`a`), Edit
 * (`e`, inline, then Save), Move (`m`), Set type (`t`) and Discard (`d`).
 */
import { AUTO_ACCEPT } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { captureApi } from '@/api/capture/queries';
import { type AiStatus, canAcceptSuggestion, type InboxItem } from '@/api/capture/types';
import type { LocationSummary } from '@/api/types';
import { AiLine, useProviderName } from '@/components/ai/ai-line';
import { useClock, usePausedUntil, usePauseReason } from '@/components/ai/paused-banner';
import { WaitingForProvider } from '@/components/ai/status-line';
import { useHint } from '@/components/hints/use-hint';
import { IdChip } from '@/components/id-chip';
import { useTypeName } from '@/components/places/labels';
import { PathText } from '@/components/places/rows';
import { isChosen, TypePicker, WherePicker, type WhereValue } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { sep } from '@/lib/format';
import { useKeyHints } from '@/lib/key-hints';
import { cn } from '@/lib/utils';
import { undoEventsOf, useInboxRun } from './actions';
import { ClaimItem } from './claim-item';
import { CurrencyItem } from './currency-item';
import { DuplicateReview } from './duplicate-review';
import { useFailureText, useFieldLabels } from './labels';
import { OverflowActions } from './overflow-actions';
import { ReadingReview } from './reading-review';
import { ReceiptReview } from './receipt-review';
import { type Blocked, BlockedReason, ItemShell, useItemKeys } from './shell';
import { type Decision, SuggestedField } from './suggested-field';
import { SyncDropItem } from './sync-drop-item';

export type ItemProps = {
  item: InboxItem;
  location: LocationSummary | undefined;
  /** AI's state in the item's location (paused, waiting for the provider). */
  ai: AiStatus | undefined;
  current: boolean;
  /** Why nothing can be changed now ("Needs a connection"). */
  blocked: Blocked;
};

export function ItemCard(props: ItemProps) {
  switch (props.item.kind) {
    case 'draft':
      return props.item.thing ? <DraftCard {...props} thing={props.item.thing} /> : null;
    case 'receipt':
      return <ReceiptReview {...props} />;
    case 'currency':
      return <CurrencyItem {...props} />;
    case 'reading':
      return <ReadingReview {...props} />;
    case 'duplicate':
      return <DuplicateReview {...props} />;
    case 'label_claim':
      return <ClaimItem {...props} />;
    case 'sync_drop':
      return <SyncDropItem {...props} />;
    default:
      return null;
  }
}

/** "Name, brand and type": the fields AI filled in and that were accepted without asking. */
function useAcceptedText() {
  const { i18n } = useLingui();
  const fieldName = useFieldLabels();
  return (fieldStatus: Record<string, { state: string }>) => {
    const fields = (AUTO_ACCEPT as readonly string[]).filter(
      (f) => fieldStatus[f]?.state === 'extracted',
    );
    if (fields.length === 0) return null;
    const list = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(
      fields.map(fieldName),
    );
    return list;
  };
}

/** Where naming is, in words (D206: paused is a banner and a line; waiting is only a line). */
export function ExtractionLine({
  item,
  ai,
  onRetry,
  onFillIn,
  blocked,
}: {
  item: InboxItem;
  ai: AiStatus | undefined;
  onRetry: () => void;
  onFillIn: () => void;
  blocked: Blocked;
}) {
  const { t } = useLingui();
  const provider = useProviderName()(ai?.providerKind ?? null);
  const clock = useClock();
  const pausedUntil = usePausedUntil();
  const reason = usePauseReason();
  const failure = useFailureText();
  const x = item.extraction;
  if (!x) return null;
  const line = (text: string, tone: 'plain' | 'warn' = 'plain') => (
    <p
      className={cn(
        'm-0 text-small [overflow-wrap:anywhere]',
        tone === 'warn' ? 'text-warn' : 'text-ink-2',
      )}
    >
      {text}
    </p>
  );
  switch (x.status) {
    case 'queued':
    case 'running':
      return line(t`Naming…`);
    case 'paused_budget': {
      const until = x.pausedUntil ?? ai?.pausedUntil;
      const text = until ? t`Waiting: ${pausedUntil(until)}` : t`Waiting: AI is paused`;
      return (
        <div className="grid gap-0.5">
          {line(text, 'warn')}
          {ai ? line(reason(ai)) : null}
        </div>
      );
    }
    case 'waiting_provider': {
      const wait = ai?.waitingProvider;
      const why = x.statusReason ?? wait?.reason;
      // Captured while no provider resolved (the server's `no_provider`): it waits in a queue for
      // one, and connecting a key sends it.
      if (why === 'no_provider') return <WaitingForProvider canManage={ai?.canManage ?? false} />;
      if (why === 'auth')
        return ai?.canManage
          ? line(t`${provider} rejected the key · Replace it in AI settings`, 'warn')
          : line(
              ai?.manager
                ? t`AI isn't working here · ask ${ai.manager.displayName}`
                : t`AI isn't working here · ask an admin`,
              'warn',
            );
      if (why === 'provider_down' && wait)
        return line(t`${provider} isn't answering · retrying at ${clock(wait.until)}`);
      const seconds = wait ? Math.round((Date.parse(wait.until) - Date.now()) / 1000) : 0;
      return line(
        seconds > 0
          ? t`Waiting for ${provider} · about ${seconds} s`
          : t`Waiting for ${provider} · next in line`,
      );
    }
    case 'failed':
      return (
        <div className="grid gap-2">
          {line(failure(x.statusReason), 'warn')}
          <div className="flex flex-wrap gap-2">
            <Button size="small" variant="secondary" isDisabled={!!blocked} onPress={onRetry}>
              <Trans>Retry</Trans>
            </Button>
            <Button size="small" variant="secondary" isDisabled={!!blocked} onPress={onFillIn}>
              <Trans>Fill in by hand</Trans>
            </Button>
          </div>
        </div>
      );
    default:
      return null;
  }
}

function DraftCard({
  item,
  thing,
  location,
  ai,
  current,
  blocked,
}: ItemProps & { thing: NonNullable<InboxItem['thing']> }) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const accepted = useAcceptedText();
  const confirm = useConfirm();
  const { run, busy } = useInboxRun();
  const suggestions = item.suggestions ?? [];
  // First inbox review with Suggested values: one hint on them, once per person (D138).
  const suggestedRef = useRef<HTMLDivElement>(null);
  useHint('inbox.suggested', suggestedRef, { when: suggestions.length > 0 });
  const [decisions, setDecisions] = useState<Record<string, Decision | undefined>>({});
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(thing?.name ?? '');
  const [typeId, setTypeId] = useState<string | null>(thing?.type?.id ?? null);
  const [sheet, setSheet] = useState<'move' | 'type' | null>(null);

  const display = thing.name ?? t`Unnamed thing`;
  const undecided = suggestions.filter((s) => !decisions[s.field]);
  const focusField = undecided[0]?.field;
  const decide = (field: string, d: Decision | undefined) =>
    setDecisions((prev) => ({ ...prev, [field]: d }));
  const decisionBody = () => ({
    accept: suggestions
      .filter((s) => decisions[s.field] === 'confirm' && canAcceptSuggestion(s.field))
      .map((s) => s.field),
    reject: suggestions.filter((s) => decisions[s.field] === 'reject').map((s) => s.field),
  });
  // Keys only where there are keys to press (lib/key-hints.ts); a phone says "tap".
  const keys = useKeyHints();
  const acceptBlocked: Blocked =
    blocked ??
    (!thing.name
      ? keys
        ? t`Needs a name: press E, or Edit, to type one.`
        : t`Needs a name: tap Edit to type one.`
      : undecided.length > 0
        ? keys
          ? t`Confirm or reject each suggested value first (Y or N).`
          : t`Confirm or reject each suggested value first.`
        : undefined);

  const accept = () => {
    if (acceptBlocked) return;
    void run(() => captureApi.inboxAccept(item.id, decisionBody(), item.rowVersion), {
      done: t`Accepted ${display}`,
    });
  };
  const saveEdit = () => {
    const trimmed = name.trim();
    if (!trimmed || blocked) return;
    void run(
      () =>
        captureApi.inboxAccept(
          item.id,
          {
            ...decisionBody(),
            set: {
              name: trimmed,
              ...(typeId !== (thing.type?.id ?? null) ? { typeId } : {}),
            },
          },
          item.rowVersion,
        ),
      { done: t`Saved ${trimmed}` },
    ).then((r) => {
      if (r) setEditing(false);
    });
  };
  const discard = async () => {
    if (blocked) return;
    const ok = await confirm({
      title: t`Discard ${display}?`,
      body: t`It goes to the trash with its photos. You can restore it for 30 days.`,
      confirmLabel: t`Discard`,
      destructive: true,
    });
    if (ok)
      void run(() => captureApi.inboxDiscard(item.id, item.rowVersion), {
        done: t`Discarded ${display}`,
        undo: undoEventsOf,
      });
  };
  const retry = () =>
    void run(() => captureApi.extract(thing.id), { done: t`Reading the photo again` });
  const startEdit = () => {
    if (blocked) return;
    setName(thing.name ?? '');
    setTypeId(thing.type?.id ?? null);
    setEditing(true);
  };

  useItemKeys(item.id, {
    accept,
    edit: startEdit,
    move: () => !blocked && setSheet('move'),
    set_type: () => !blocked && setSheet('type'),
    // `y` on a field accept can't write does nothing: it offers Reject alone.
    confirm_field: () =>
      focusField && !blocked && canAcceptSuggestion(focusField) && decide(focusField, 'confirm'),
    reject_field: () => focusField && !blocked && decide(focusField, 'reject'),
    drop: () => void discard(),
  });

  const acceptedList = accepted(thing.fieldStatus);
  const typeLabel = typeName(thing.type);
  const facts = [thing.brand?.name, thing.model, typeLabel].filter((x): x is string => !!x);
  return (
    <ItemShell
      item={item}
      label={display}
      current={current}
      photo={thing.photos[0]}
      title={thing.name ? <bdi>{thing.name}</bdi> : <Trans>Unnamed thing</Trans>}
      titleExtra={<IdChip code={thing.shortCode} pending />}
      meta={
        <>
          {facts.length ? (
            <span className="[overflow-wrap:anywhere]">
              {facts.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed short list
                <span key={i}>
                  {i > 0 ? sep() : null}
                  <bdi>{f}</bdi>
                </span>
              ))}
            </span>
          ) : null}
          {thing.path.length ? <PathText path={thing.path} /> : null}
        </>
      }
      actions={
        editing ? null : (
          <>
            <Button
              size="small"
              isDisabled={!!acceptBlocked}
              isPending={busy}
              aria-keyshortcuts="A"
              onPress={accept}
            >
              <Trans>Accept</Trans>
            </Button>
            <Button
              size="small"
              variant="secondary"
              isDisabled={!!blocked}
              aria-keyshortcuts="E"
              onPress={startEdit}
            >
              <Trans>Edit</Trans>
            </Button>
            <OverflowActions
              title={display}
              isDisabled={!!blocked}
              actions={[
                { id: 'move', label: t`Move`, keys: 'M', onAction: () => setSheet('move') },
                { id: 'type', label: t`Set type`, keys: 'T', onAction: () => setSheet('type') },
                {
                  id: 'discard',
                  label: t`Discard`,
                  keys: 'D',
                  danger: true,
                  onAction: () => void discard(),
                },
              ]}
            />
            <BlockedReason reason={acceptBlocked} />
          </>
        )
      }
    >
      <ExtractionLine item={item} ai={ai} blocked={blocked} onRetry={retry} onFillIn={startEdit} />
      {suggestions.length ? (
        <div ref={suggestedRef} className="grid gap-2">
          {suggestions.map((s) => (
            <SuggestedField
              key={s.field}
              suggestion={s}
              decision={decisions[s.field]}
              onDecide={(d) => decide(s.field, d)}
              current={current && s.field === focusField}
              {...(blocked ? { disabledReason: blocked } : {})}
            />
          ))}
        </div>
      ) : null}
      {acceptedList ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Filled in by AI and accepted: {acceptedList}.</Trans>
        </p>
      ) : null}
      {item.extraction?.call ? <AiLine call={item.extraction.call} /> : null}
      {editing ? (
        <form
          className="grid gap-3 rounded-[10px] border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveEdit();
          }}
        >
          <TextField
            label={t`Name`}
            value={name}
            onChange={setName}
            isRequired
            autoFocus
            {...(name.trim() ? {} : { errorMessage: t`A thing needs a name.` })}
          />
          {location ? (
            <TypePicker
              accountId={location.ownerAccountId}
              value={typeId}
              onChange={(id) => setTypeId(id)}
              label={t`Type`}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="small" isPending={busy} isDisabled={!name.trim()}>
              <Trans>Save</Trans>
            </Button>
            <Button size="small" variant="secondary" onPress={() => setEditing(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : null}
      <MoveSheet
        isOpen={sheet === 'move'}
        onClose={() => setSheet(null)}
        ids={[item.id]}
        locationId={item.locationId}
        names={display}
        exclude={thing.id}
      />
      <TypeSheet
        isOpen={sheet === 'type'}
        onClose={() => setSheet(null)}
        ids={[item.id]}
        accountId={location?.ownerAccountId ?? ''}
        names={display}
        current={thing.type?.id ?? null}
      />
    </ItemShell>
  );
}

/** Move drafts (`set_place`, one undoable bulk event, D150). */
export function MoveSheet({
  isOpen,
  onClose,
  ids,
  locationId,
  names,
  exclude,
}: {
  isOpen: boolean;
  onClose: () => void;
  ids: string[];
  locationId: string;
  /** What moves, in words: a name, or "3 drafts". */
  names: string;
  exclude?: string;
}) {
  const { t } = useLingui();
  const { run, busy } = useInboxRun();
  const [where, setWhere] = useState<WhereValue>({ locationId, target: { placeId: '' } });
  const save = () =>
    void run(
      () =>
        captureApi.inboxBulk({
          ids,
          action: 'set_place',
          to: where.target as { placeId: string } | { containerId: string },
        }),
      { done: t`Moved ${names}`, undo: undoEventsOf },
    ).then((r) => {
      if (r) onClose();
    });
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Move ${names}`}>
      <div className="grid gap-4">
        <WherePicker
          value={where}
          onChange={setWhere}
          allowOtherLocations={false}
          {...(exclude ? { exclude } : {})}
        />
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isDisabled={!isChosen(where.target)} isPending={busy} onPress={save}>
            <Trans>Move</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}

/** Set the type of drafts (`set_type`, one undoable bulk event). */
export function TypeSheet({
  isOpen,
  onClose,
  ids,
  accountId,
  names,
  current = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  ids: string[];
  accountId: string;
  names: string;
  current?: string | null;
}) {
  const { t } = useLingui();
  const { run, busy } = useInboxRun();
  const [typeId, setTypeId] = useState<string | null>(current);
  const save = () => {
    if (!typeId) return;
    void run(() => captureApi.inboxBulk({ ids, action: 'set_type', typeId }), {
      done: t`Set the type of ${names}`,
      undo: undoEventsOf,
    }).then((r) => {
      if (r) onClose();
    });
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => !o && onClose()}
      title={t`Set the type of ${names}`}
    >
      <div className="grid gap-4">
        <TypePicker
          accountId={accountId}
          value={typeId}
          onChange={(id) => setTypeId(id)}
          label={t`Type`}
        />
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isDisabled={!typeId} isPending={busy} onPress={save}>
            <Trans>Set type</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}
