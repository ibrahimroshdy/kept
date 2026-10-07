/**
 * Caps and budgets (D19, D167, D206; screens §5 AI settings "Caps"): monthly money and/or tokens
 * for the account, per location ("Home: USD 3.00 · inside the account's USD 5.00"), per person in
 * the account, a personal key's own cap, the instance's (overall and per account), and the
 * per-task budgets (tokens a minute, a day and a month). Money fields are plain inputs with Kept's
 * currency picker, never a native select. A location cap above the account's shows "can't be above
 * the account's cap" inline (400 `cap_above_account`). "Pause AI" pauses the scope by hand.
 *
 * Readers who can't edit (a location's admins, a member for their own row) see the same rows
 * without the buttons (screens §3: hidden for the role).
 */
import { AI_TASKS, type AiTask, DEFAULT_BUDGETS } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { listAdminAccounts } from '@/api/admin';
import { captureApi, captureKeys, useAiCaps } from '@/api/capture/queries';
import type { AiCap, AiCapScope, AiScope, PutAiCapBody } from '@/api/capture/types';
import { isApiError } from '@/api/client';
import { getMembers } from '@/api/locations';
import { keys, useMe } from '@/api/queries';
import type { AdminAccount } from '@/api/types';
import { ErrorState, List, LoadingRows, Section, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { CurrencyPicker } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { CapBar, useCapName } from './cap-bars';
import { useMoney } from './labels';

/** Where a new cap goes: its scope and the ids that name it. */
export type CapTarget = {
  scope: AiCapScope;
  label: string;
  accountId?: string;
  locationId?: string;
  userId?: string;
  task?: AiTask;
};

function useTaskName(): (task: AiTask) => string {
  const { t } = useLingui();
  return (task) =>
    task === 'extraction'
      ? t`Photos and receipts`
      : task === 'assistant'
        ? t`Assistant`
        : t`Search`;
}

const digits = (s: string) => s.replace(/[\s,_]/g, '');
const positive = (s: string) => s.trim() !== '' && Number(digits(s)) > 0;

/** The cap editor: money (amount + currency) and/or tokens a month; for a budget, per minute/day. */
function CapSheet({
  target,
  cap,
  budget,
  onClose,
  accountCap,
}: {
  target: CapTarget;
  cap: AiCap | undefined;
  /** A per-task budget: tokens a minute, a day and a month, no money. */
  budget: boolean;
  onClose: () => void;
  /** The account's money cap, for the inline check on a location cap. */
  accountCap?: AiCap;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const online = useOnline();
  const money = useMoney();
  const [amount, setAmount] = useState(cap?.monthlyCap?.amount ?? '');
  const [currency, setCurrency] = useState<string | null>(
    cap?.monthlyCap?.currency ?? accountCap?.monthlyCap?.currency ?? 'USD',
  );
  const [month, setMonth] = useState(cap?.tokensPerMonth ? String(cap.tokensPerMonth) : '');
  const [day, setDay] = useState(cap?.tokensPerDay ? String(cap.tokensPerDay) : '');
  const [minute, setMinute] = useState(cap?.tokensPerMinute ? String(cap.tokensPerMinute) : '');
  const [serverError, setServerError] = useState<string | null>(null);
  const above =
    target.scope === 'location' &&
    !!accountCap?.monthlyCap &&
    accountCap.monthlyCap.currency === currency &&
    positive(amount) &&
    Number(amount) > Number(accountCap.monthlyCap.amount);
  const aboveText = t`Can't be above the account's cap`;
  const save = useMutation({
    mutationFn: () => {
      const body: PutAiCapBody = {
        scope: target.scope,
        ...(target.accountId ? { accountId: target.accountId } : {}),
        ...(target.locationId ? { locationId: target.locationId } : {}),
        ...(target.userId ? { userId: target.userId } : {}),
        ...(target.task ? { task: target.task } : {}),
        ...(budget
          ? {}
          : {
              monthlyCap:
                positive(amount) && currency
                  ? { amount: Number(digits(amount)).toFixed(2), currency }
                  : null,
            }),
        ...(positive(month) ? { tokensPerMonth: Number(digits(month)) } : {}),
        ...(budget && positive(day) ? { tokensPerDay: Number(digits(day)) } : {}),
        ...(budget && positive(minute) ? { tokensPerMinute: Number(digits(minute)) } : {}),
      };
      return captureApi.putAiCap(body, cap?.rowVersion);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({ tone: 'ok', title: t`Limit saved` });
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && e.serverCode === 'cap_above_account') setServerError(aboveText);
      else if (isApiError(e) && e.serverCode === 'currency_not_enabled')
        setServerError(t`That currency isn't turned on. An instance admin can add it.`);
      else setServerError(errorText(e));
    },
  });
  const nothing = budget
    ? !positive(month) && !positive(day) && !positive(minute)
    : !positive(amount) && !positive(month);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {budget ? null : (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
          <TextField
            label={<Trans>Money a month</Trans>}
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setServerError(null);
            }}
            inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
            isInvalid={above}
            {...(above ? { errorMessage: aboveText } : {})}
            description={
              target.scope === 'location' && accountCap?.monthlyCap ? (
                <Trans>
                  Inside the account's{' '}
                  {money(accountCap.monthlyCap.amount, accountCap.monthlyCap.currency)}
                </Trans>
              ) : undefined
            }
          />
          <CurrencyPicker label={<Trans>Currency</Trans>} value={currency} onChange={setCurrency} />
        </div>
      )}
      <TextField
        label={<Trans>Tokens a month</Trans>}
        value={month}
        onChange={setMonth}
        inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
        description={
          budget ? undefined : (
            <Trans>Optional. A token cap also counts calls whose cost is unknown.</Trans>
          )
        }
      />
      {budget ? (
        <>
          <TextField
            label={<Trans>Tokens a day</Trans>}
            value={day}
            onChange={setDay}
            inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
          />
          <TextField
            label={<Trans>Tokens a minute</Trans>}
            value={minute}
            onChange={setMinute}
            inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
          />
        </>
      ) : null}
      {serverError ? (
        <p role="alert" className="m-0 font-medium text-danger text-small">
          {serverError}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isDisabled={!online || nothing || above} isPending={save.isPending}>
          <Trans>Save limit</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

function CapRow({
  cap,
  target,
  title,
  budget = false,
  accountCap,
  placeholder,
}: {
  cap: AiCap | undefined;
  target: CapTarget;
  title: ReactNode;
  budget?: boolean;
  accountCap?: AiCap;
  /** What applies with no row ("No limit", or a budget's default). */
  placeholder: ReactNode;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const canEdit = cap ? cap.canEdit : true;
  const remove = useMutation({
    mutationFn: (id: string) => captureApi.deleteAiCap(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({ tone: 'ok', title: t`Limit removed` });
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  return (
    <li className="grid gap-2 px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-semibold text-[15px] text-ink">{title}</span>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button size="small" variant="secondary" onPress={() => setEditing(true)}>
              {cap ? <Trans>Change</Trans> : <Trans>Set a limit</Trans>}
            </Button>
            {cap ? (
              <Button
                size="small"
                variant="ghost"
                isPending={remove.isPending}
                onPress={async () => {
                  const ok = await confirm({
                    title: t`Remove this limit?`,
                    body: t`AI here is then limited only by the other caps that apply.`,
                    confirmLabel: t`Remove`,
                  });
                  if (ok) remove.mutate(cap.id);
                }}
              >
                <Trans>Remove</Trans>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {cap && !budget ? <CapBar cap={cap} /> : null}
      {budget ? <BudgetLine cap={cap} task={target.task} /> : null}
      {!cap && !budget ? <span className="text-small text-ink-2">{placeholder}</span> : null}
      <Sheet
        isOpen={editing}
        onOpenChange={setEditing}
        title={cap ? t`Change the limit` : t`Set a limit`}
      >
        {({ close }) => (
          <CapSheet
            target={target}
            cap={cap}
            budget={budget}
            onClose={close}
            {...(accountCap ? { accountCap } : {})}
          />
        )}
      </Sheet>
    </li>
  );
}

/** "60,000 a minute · 2,000,000 a day · 20,000,000 a month (the default)". */
function BudgetLine({ cap, task }: { cap: AiCap | undefined; task: AiTask | undefined }) {
  const fmt = useFormat();
  const d = task === 'extraction' ? DEFAULT_BUDGETS.extraction : null;
  const minute = cap?.tokensPerMinute ?? d?.tokensPerMinute;
  const day = cap?.tokensPerDay ?? d?.tokensPerDay;
  const month = cap?.tokensPerMonth ?? d?.tokensPerMonth;
  if (!minute && !day && !month)
    return (
      <span className="text-small text-ink-2">
        <Trans>No budget: the monthly caps above apply.</Trans>
      </span>
    );
  return (
    <span className="text-small text-ink-2 tabular-nums">
      {minute ? <Trans>{fmt.num(minute)} tokens a minute</Trans> : null}
      {day ? (
        <>
          {minute ? sep() : null}
          <Trans>{fmt.num(day)} a day</Trans>
        </>
      ) : null}
      {month ? (
        <>
          {sep()}
          <Trans>{fmt.num(month)} a month</Trans>
        </>
      ) : null}
      {!cap ? (
        <>
          {' '}
          <Trans>(the default)</Trans>
        </>
      ) : null}
    </span>
  );
}

function PauseButton({ target }: { target: CapTarget }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const online = useOnline();
  const pause = useMutation({
    mutationFn: () =>
      captureApi.pauseAi({
        scope: target.scope,
        ...(target.accountId ? { accountId: target.accountId } : {}),
        ...(target.locationId ? { locationId: target.locationId } : {}),
        ...(target.userId ? { userId: target.userId } : {}),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({
        tone: 'ok',
        title: t`AI paused`,
        description: t`Captures still save; naming waits.`,
      });
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  return (
    <Button
      variant="secondary"
      isDisabled={!online}
      isPending={pause.isPending}
      onPress={async () => {
        const ok = await confirm({
          title: t`Pause AI?`,
          body: t`Nothing is sent to the provider until you resume. Captures still save, and their naming waits.`,
          confirmLabel: t`Pause AI`,
        });
        if (ok) pause.mutate();
      }}
      className="justify-self-start"
    >
      <Trans>Pause AI</Trans>
    </Button>
  );
}

/**
 * "Limit an account" (Admin → AI; step-3 carry-over, T19): the accounts on this server by their
 * owner's name, found on the server as you type, each with how many locations it owns; nothing
 * about what's in them (D33). Picking one sets its own cap on the server's key.
 */
function AddAccountCap({ taken }: { taken: string[] }) {
  const { t } = useLingui();
  const [q, setQ] = useState('');
  const [account, setAccount] = useState<AdminAccount | null>(null);
  const accounts = useQuery({
    queryKey: ['admin', 'accounts', q.trim()],
    queryFn: () => listAdminAccounts(q.trim() || undefined),
    placeholderData: (prev) => prev,
  });
  const items = (accounts.data?.items ?? [])
    .filter((a) => !taken.includes(a.id))
    .map((a) => ({
      id: a.id,
      label: a.ownerName,
      description: plural(a.locations, { one: '# location', other: '# locations' }),
    }));
  return (
    <div className="grid gap-2">
      <Combobox
        label={<Trans>Limit an account</Trans>}
        items={items}
        inputValue={q}
        onInputChange={setQ}
        selectedKey={account?.id ?? null}
        onSelectionChange={(k) => {
          const found = accounts.data?.items.find((a) => a.id === k);
          setAccount(found ?? null);
        }}
        placeholder={t`Find an account by its owner`}
      />
      <Sheet
        isOpen={account !== null}
        onOpenChange={(open) => (open ? undefined : setAccount(null))}
        title={t`Set a limit for ${account?.ownerName ?? ''}`}
      >
        {({ close }) =>
          account ? (
            <CapSheet
              target={{
                scope: 'instance_account',
                label: account.ownerName,
                accountId: account.id,
              }}
              cap={undefined}
              budget={false}
              onClose={() => {
                close();
                setAccount(null);
                setQ('');
              }}
            />
          ) : null
        }
      </Sheet>
    </div>
  );
}

/** "Limit a person": anyone with a role in the account's locations, except you. */
function AddPersonCap({
  locations,
  account,
  taken,
}: {
  locations: { id: string; name: string }[];
  account?: { id: string; ownerName: string };
  /** People who already have a row. */
  taken: string[];
}) {
  const { t } = useLingui();
  const me = useMe();
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const lists = useQueries({
    queries: locations.map((l) => ({
      queryKey: keys.members(l.id),
      queryFn: () => getMembers(l.id),
    })),
  });
  const people = [
    ...new Map(
      lists
        .flatMap((q) => q.data?.members ?? [])
        .filter((m) => m.userId !== me.data?.user.id && !taken.includes(m.userId))
        .map((m) => [m.userId, { id: m.userId, label: m.displayName }] as const),
    ).values(),
  ];
  if (people.length === 0) return null;
  return (
    <div className="grid gap-2">
      <Combobox
        label={<Trans>Limit a person</Trans>}
        items={people}
        selectedKey={person?.id ?? null}
        onSelectionChange={(k) => {
          const found = people.find((p) => p.id === k);
          setPerson(found ? { id: found.id, name: found.label } : null);
        }}
        placeholder={t`Find a person`}
      />
      <Sheet
        isOpen={person !== null}
        onOpenChange={(open) => (open ? undefined : setPerson(null))}
        title={t`Set a limit for ${person?.name ?? ''}`}
      >
        {({ close }) =>
          person ? (
            <CapSheet
              target={{
                scope: 'member',
                label: person.name,
                userId: person.id,
                ...(account ? { accountId: account.id } : {}),
              }}
              cap={undefined}
              budget={false}
              onClose={() => {
                close();
                setPerson(null);
              }}
            />
          ) : null
        }
      </Sheet>
    </div>
  );
}

/**
 * Caps for a settings page: `account` (the account, its locations, its people, and the per-task
 * budgets), `me` (the personal key's cap), `instance` (overall and per account), or `location`
 * (one location's cap, from Location settings → AI here).
 */
export function Caps({
  scope,
  locationId,
  account,
  locations = [],
  canPause = true,
}: {
  scope: AiScope;
  locationId?: string;
  /** The caller's account: id and owner name, for the account row. */
  account?: { id: string; ownerName: string };
  /** The account's locations (for a row each). */
  locations?: { id: string; name: string }[];
  canPause?: boolean;
}) {
  const { t } = useLingui();
  const taskName = useTaskName();
  const capName = useCapName();
  const q = useAiCaps({ scope, ...(locationId ? { locationId } : {}) });
  if (q.isPending) return <LoadingRows rows={2} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const caps = q.data.caps;
  const find = (pred: (c: AiCap) => boolean) => caps.find(pred);
  const accountCap = find((c) => c.scope === 'account' && !c.task);
  const none = <Trans>No limit</Trans>;

  if (scope === 'location' && locationId) {
    const loc = locations.find((l) => l.id === locationId);
    const cap = find((c) => c.scope === 'location' && c.target.id === locationId);
    return (
      <List aria-label={t`Limits`}>
        <CapRow
          cap={cap}
          target={{ scope: 'location', label: loc?.name ?? '', locationId }}
          title={<bdi>{loc?.name ?? cap?.target.label}</bdi>}
          placeholder={none}
          {...(accountCap ? { accountCap } : {})}
        />
      </List>
    );
  }
  if (scope === 'me') {
    const cap = find((c) => c.scope === 'user');
    const members = caps.filter((c) => c.scope === 'member');
    return (
      <div className="grid gap-3">
        <List aria-label={t`Limits`}>
          <CapRow
            cap={cap}
            target={{ scope: 'user', label: '' }}
            title={<Trans>Your personal key</Trans>}
            placeholder={none}
          />
          {members.map((c) => (
            <CapRow
              key={c.id}
              cap={c}
              target={{ scope: 'member', label: c.target.label }}
              title={
                <Trans>
                  Your limit in <bdi>{c.target.label}</bdi>'s account
                </Trans>
              }
              placeholder={none}
            />
          ))}
        </List>
        {canPause ? <PauseButton target={{ scope: 'user', label: '' }} /> : null}
      </div>
    );
  }
  if (scope === 'instance') {
    const overall = find((c) => c.scope === 'instance' && !c.task);
    const perAccount = caps.filter((c) => c.scope === 'instance_account');
    const fallback = perAccount.find((c) => !c.target.id);
    return (
      <div className="grid gap-3">
        <List aria-label={t`Limits`}>
          <CapRow
            cap={overall}
            target={{ scope: 'instance', label: '' }}
            title={<Trans>This server, overall</Trans>}
            placeholder={none}
          />
          <CapRow
            cap={fallback}
            target={{ scope: 'instance_account', label: '' }}
            title={<Trans>Each account on this server's key</Trans>}
            placeholder={none}
          />
          {perAccount
            .filter((c) => c.target.id)
            .map((c) => (
              <CapRow
                key={c.id}
                cap={c}
                target={{
                  scope: 'instance_account',
                  label: c.target.label,
                  accountId: c.target.id ?? '',
                }}
                title={<bdi>{capName(c)}</bdi>}
                placeholder={none}
              />
            ))}
          {AI_TASKS.map((task) => (
            <CapRow
              key={task}
              budget
              cap={find((c) => c.scope === 'instance' && c.task === task)}
              target={{ scope: 'instance', label: '', task }}
              title={<Trans>Budget · {taskName(task)}</Trans>}
              placeholder={none}
            />
          ))}
        </List>
        <AddAccountCap taken={perAccount.flatMap((c) => (c.target.id ? [c.target.id] : []))} />
        {canPause ? <PauseButton target={{ scope: 'instance', label: '' }} /> : null}
      </div>
    );
  }
  // The account: its cap, a row per location, its people, and the per-task budgets.
  const people = caps.filter((c) => c.scope === 'member');
  const accountTarget: CapTarget = {
    scope: 'account',
    label: account?.ownerName ?? '',
    ...(account ? { accountId: account.id } : {}),
  };
  return (
    <div className="grid gap-4">
      <Section title={<Trans>Monthly caps</Trans>}>
        <List aria-label={t`Monthly caps`}>
          <CapRow
            cap={accountCap}
            target={accountTarget}
            title={<Trans>The whole account</Trans>}
            placeholder={none}
          />
          {locations.map((l) => (
            <CapRow
              key={l.id}
              cap={find((c) => c.scope === 'location' && c.target.id === l.id)}
              target={{ scope: 'location', label: l.name, locationId: l.id }}
              title={<bdi>{l.name}</bdi>}
              placeholder={none}
              {...(accountCap ? { accountCap } : {})}
            />
          ))}
          {people.map((c) => (
            <CapRow
              key={c.id}
              cap={c}
              target={{
                scope: 'member',
                label: c.target.label,
                userId: c.target.id ?? '',
                ...(account ? { accountId: account.id } : {}),
              }}
              title={<bdi>{capName(c)}</bdi>}
              placeholder={none}
            />
          ))}
        </List>
        <AddPersonCap
          locations={locations}
          taken={people.map((c) => c.target.id ?? '')}
          {...(account ? { account } : {})}
        />
      </Section>
      <Section title={<Trans>Budgets per task</Trans>}>
        <List aria-label={t`Budgets per task`}>
          {AI_TASKS.map((task) => (
            <CapRow
              key={task}
              budget
              cap={find((c) => c.scope === 'account' && c.task === task)}
              target={{ ...accountTarget, task }}
              title={taskName(task)}
              placeholder={none}
            />
          ))}
        </List>
      </Section>
      {canPause ? <PauseButton target={accountTarget} /> : null}
    </div>
  );
}
