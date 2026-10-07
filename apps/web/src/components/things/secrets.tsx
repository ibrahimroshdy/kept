/**
 * Secret fields (D116, D175): kept in their own encrypted store, never in the thing's row.
 * "Reveal" (only when the field's policy lets you) shows the value for 30 seconds with
 * "Revealed · logged", then hides it again, and at once if you leave the page or switch away.
 * Copy is allowed and logged as copied (§8). Setting a value is write-only: "Replace" never shows
 * the old one. The first secret value on an instance needs the recovery kit acknowledged (D193).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useState } from 'react';
import { isApiError } from '@/api/client';
import { thingApi } from '@/api/inventory/thing-api';
import type { SecretSummary } from '@/api/inventory/types';
import { CopyIcon, EyeIcon, EyeOffIcon, LockIcon } from '@/components/icons';
import { Notice, Pill, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/password-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { ModuleOff, useThingCtx } from './context';
import { useFieldLabel } from './names';

type Revealed = { value: string; until: number };

export function SecretsSection() {
  const { thing, moduleOn } = useThingCtx();
  const { t } = useLingui();
  const hasSecretFields = thing.secrets.length > 0 || thing.fields.some((f) => f.secret);
  // Module off: say so only where a value is actually stored; an empty field stays quiet.
  if (!hasSecretFields || (!moduleOn('secrets') && !thing.secrets.some((s) => s.set))) return null;
  return (
    <Section title={<Trans>Passwords and codes</Trans>}>
      {moduleOn('secrets') ? <SecretList /> : <ModuleOff what={t`Passwords and codes`} />}
    </Section>
  );
}

function SecretList() {
  const { thing } = useThingCtx();
  const fieldLabel = useFieldLabel();
  const [revealed, setRevealed] = useState<Record<string, Revealed>>({});
  const [now, setNow] = useState(() => Date.now());
  const hideAll = useCallback(() => setRevealed({}), []);

  // Tick while anything is shown; hide what has run out.
  const showing = Object.keys(revealed).length > 0;
  useEffect(() => {
    if (!showing) return;
    const timer = setInterval(() => {
      const n = Date.now();
      setNow(n);
      setRevealed((r) => {
        const kept = Object.fromEntries(Object.entries(r).filter(([, v]) => v.until > n));
        return Object.keys(kept).length === Object.keys(r).length ? r : kept;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [showing]);

  // Leaving the page (or the tab) hides everything at once.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') hideAll();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', hideAll);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', hideAll);
    };
  }, [hideAll]);

  const summaries: SecretSummary[] = [
    ...thing.secrets,
    // A secret field of the type with nothing stored yet.
    ...thing.fields
      .filter((f) => f.secret && !f.archivedAt && !thing.secrets.some((s) => s.fieldKey === f.key))
      .map((f) => ({ fieldKey: f.key, label: f.label, set: false, canReveal: false })),
  ];

  return (
    <ul className="m-0 grid list-none gap-2.5 p-0">
      {summaries.map((s) => (
        <SecretRow
          key={s.fieldKey}
          summary={s}
          label={s.label ?? fieldLabel({ label: null, labelKey: s.fieldKey, key: s.fieldKey })}
          revealed={revealed[s.fieldKey] ?? null}
          now={now}
          onReveal={(r) => {
            setNow(Date.now());
            setRevealed((x) => ({ ...x, [s.fieldKey]: r }));
          }}
          onHide={() =>
            setRevealed((x) => {
              const { [s.fieldKey]: _gone, ...rest } = x;
              return rest;
            })
          }
        />
      ))}
    </ul>
  );
}

function SecretRow({
  summary,
  label,
  revealed,
  now,
  onReveal,
  onHide,
}: {
  summary: SecretSummary;
  label: string;
  revealed: Revealed | null;
  now: number;
  onReveal: (r: Revealed) => void;
  onHide: () => void;
}) {
  const { thing, can, refresh } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState('');
  const [kitNeeded, setKitNeeded] = useState<string | null>(null);
  const seconds = revealed ? Math.max(0, Math.ceil((revealed.until - now) / 1000)) : 0;

  const reveal = async () => {
    setBusy(true);
    try {
      const r = await thingApi.reveal(thing.id, summary.fieldKey);
      const until = Math.min(Date.parse(r.revealedUntil), Date.now() + 30_000);
      onReveal({ value: r.value, until: Number.isFinite(until) ? until : Date.now() + 30_000 });
    } catch (e) {
      toast({ title: t`Couldn't reveal ${label}`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.value);
      await thingApi.copied(thing.id, summary.fieldKey).catch(() => undefined);
      toast({ title: t`Copied · logged`, tone: 'ok' });
    } catch {
      toast({ title: t`Couldn't copy`, tone: 'danger' });
    }
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setKitNeeded(null);
    try {
      await thingApi.setSecret(thing.id, summary.fieldKey, draft);
      setDraft('');
      setReplacing(false);
      toast({ title: t`${label} saved`, tone: 'ok' });
      await refresh();
    } catch (e) {
      if (
        isApiError(e) &&
        (e.code === 'recovery_kit_required' || e.serverCode === 'recovery_kit_required')
      )
        setKitNeeded(e.hint ?? t`Ask your instance admin to download the recovery kit first.`);
      else toast({ title: t`Couldn't save ${label}`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      aria-label={label}
      className="grid gap-2.5 rounded-[10px] border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-small text-ink-2">
          <LockIcon className="size-4" />
          {label}
        </span>
        {revealed ? (
          <Pill tone="info" icon={<EyeIcon />}>
            <Trans>Revealed · logged</Trans>
          </Pill>
        ) : null}
      </div>
      {revealed ? (
        <div aria-live="polite" className="grid gap-2">
          <bdi dir="ltr" className="font-mono text-[18px] text-ink [overflow-wrap:anywhere]">
            {revealed.value}
          </bdi>
          <p className="m-0 text-small text-ink-2">
            <Trans>Hides in {fmt.num(seconds)} s, and at once if you leave this page.</Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="small" onPress={onHide}>
              <EyeOffIcon className="size-4" />
              <Trans>Hide now</Trans>
            </Button>
            <Button variant="secondary" size="small" onPress={() => void copy()}>
              <CopyIcon className="size-4" />
              <Trans>Copy</Trans>
            </Button>
          </div>
        </div>
      ) : summary.set ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span aria-hidden="true" className="font-mono text-[16px] tracking-[.2em] text-ink-2">
            ••••••••••
          </span>
          {summary.canReveal ? (
            <Button variant="secondary" size="small" isPending={busy} onPress={() => void reveal()}>
              <EyeIcon className="size-4" />
              <Trans>Reveal</Trans>
            </Button>
          ) : (
            <span className="text-small text-ink-3">
              <Trans>Secret · you can't reveal this one</Trans>
            </span>
          )}
        </div>
      ) : (
        <span className="text-small text-ink-3">
          <Trans>Not set</Trans>
        </span>
      )}
      {can('things.edit') ? (
        replacing ? (
          <form
            noValidate
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <PasswordField
              label={summary.set ? t`New ${label}` : label}
              value={draft}
              onChange={setDraft}
              autoComplete="new-password"
              autoFocus
            />
            {kitNeeded ? (
              <Notice tone="warn" title={<Trans>The recovery kit comes first</Trans>}>
                {kitNeeded}
              </Notice>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="small"
                onPress={() => {
                  setReplacing(false);
                  setDraft('');
                  setKitNeeded(null);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button size="small" type="submit" isPending={busy} isDisabled={!draft}>
                <Trans>Save</Trans>
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="ghost"
            size="small"
            className="justify-self-start"
            onPress={() => setReplacing(true)}
          >
            {summary.set ? <Trans>Replace</Trans> : <Trans>Set a value</Trans>}
          </Button>
        )
      ) : null}
    </li>
  );
}
