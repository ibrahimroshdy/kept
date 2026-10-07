/**
 * Admin → Backups' settings (plan T21; D64, D66, D181, D186, D193; Q3, Q6; frames 103–106): where
 * backups go (a segmented Directory · S3-compatible · SFTP), the backup password, the night's time
 * and what is kept, then Save, Test and Run now.
 *
 * - Write-only fields (the S3 secret key, the SFTP private key, the password) are never read back:
 *   the server says only whether each is set, shown as "Saved" with Replace. Leaving one alone
 *   sends nothing, which keeps the stored value.
 * - A field the server's environment sets is read-only with "Set by the server's environment"
 *   (D186); the target locks as a whole. It is sent back unchanged.
 * - Over plain HTTP the server refuses the writes (403 `https_required`, D181); the page says so
 *   before anyone tries, and Save and Test are off.
 * - The first save needs the recovery kit (409 `recovery_kit_required`, D193): the page then
 *   offers the kit's download (T22) and Save works again once it's kept.
 * - Test opens the repository with the SAVED settings (T10), so it waits for a save; a missing
 *   repository can be created from its answer.
 */
import {
  BACKUP_KEEP_PRE_UPGRADE,
  BACKUP_PASSWORD_MIN,
  BackupSettingsInput,
  type BackupTargetKind,
  type BackupTestResult,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { TextArea, TextField as TextFieldPrimitive } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { noteRunNow, opsApi } from '@/api/ops/queries';
import type { BackupSettingsView, BackupTargetView, StatusPageData } from '@/api/ops/types';
import { keys } from '@/api/queries';
import { LockIcon } from '@/components/icons';
import { Notice, Pill, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Description, FieldError, inputClass, Label } from '@/components/ui/field';
import { PasswordField } from '@/components/ui/password-field';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { TimeField } from '@/components/ui/time-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useTypedNumber } from '@/lib/units';
import { cn } from '@/lib/utils';
import { KitDownloadButton } from './kit-download';
import { useTestWords } from './ops-words';

type Draft = {
  kind: BackupTargetKind;
  path: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  /** null: keep the saved one (or none). */
  secretAccessKey: string | null;
  host: string;
  port: string;
  user: string;
  sftpPath: string;
  hostKey: string;
  privateKey: string | null;
  password: string | null;
  time: string;
  daily: string;
  weekly: string;
  monthly: string;
};

function draftOf(v: BackupSettingsView): Draft {
  const t = v.target.value;
  return {
    kind: t?.kind ?? 'dir',
    path: t?.kind === 'dir' ? t.path : '',
    endpoint: t?.kind === 's3' ? (t.endpoint ?? '') : '',
    region: t?.kind === 's3' ? t.region : 'us-east-1',
    bucket: t?.kind === 's3' ? t.bucket : '',
    prefix: t?.kind === 's3' ? t.prefix : 'kept-backups/',
    forcePathStyle: t?.kind === 's3' ? t.forcePathStyle : false,
    accessKeyId: t?.kind === 's3' ? t.accessKeyId : '',
    secretAccessKey: null,
    host: t?.kind === 'sftp' ? t.host : '',
    port: t?.kind === 'sftp' ? String(t.port) : '22',
    user: t?.kind === 'sftp' ? t.user : '',
    sftpPath: t?.kind === 'sftp' ? t.path : '',
    hostKey: t?.kind === 'sftp' ? t.hostKey : '',
    privateKey: null,
    password: null,
    time: v.time.value,
    daily: String(v.keep.daily.value),
    weekly: String(v.keep.weekly.value),
    monthly: String(v.keep.monthly.value),
  };
}

/** Eastern Arabic and Persian digits as 0–9: what a phone's Arabic keyboard types (UI review
 * steps 6–8, M7). `\D` alone dropped them, so nothing could be typed. */
export const asciiDigits = (s: string): string =>
  s.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });

/** A locked target, sent back as it is (its write-only fields absent: the stored ones stay). */
function targetInputOf(t: BackupTargetView): Record<string, unknown> {
  if (t.kind === 'dir') return { kind: 'dir', path: t.path };
  if (t.kind === 's3') {
    const { secretAccessKeySet: _s, ...rest } = t;
    return rest;
  }
  const { privateKeySet: _p, ...rest } = t;
  return rest;
}

function bodyOf(d: Draft, v: BackupSettingsView): unknown {
  const locked = v.target.locked && v.target.value;
  const target = locked
    ? targetInputOf(v.target.value as BackupTargetView)
    : d.kind === 'dir'
      ? { kind: 'dir', path: d.path.trim() }
      : d.kind === 's3'
        ? {
            kind: 's3',
            endpoint: d.endpoint.trim() || null,
            region: d.region.trim(),
            bucket: d.bucket.trim(),
            prefix: d.prefix.trim(),
            forcePathStyle: d.forcePathStyle,
            accessKeyId: d.accessKeyId.trim(),
            ...(d.secretAccessKey ? { secretAccessKey: d.secretAccessKey } : {}),
          }
        : {
            kind: 'sftp',
            host: d.host.trim(),
            port: Number(asciiDigits(d.port)),
            user: d.user.trim(),
            path: d.sftpPath.trim(),
            hostKey: d.hostKey.trim(),
            ...(d.privateKey ? { privateKey: d.privateKey } : {}),
          };
  return {
    target,
    ...(d.password && !v.passwordSet.locked ? { password: d.password } : {}),
    time: d.time,
    keep: {
      daily: Number(asciiDigits(d.daily)),
      weekly: Number(asciiDigits(d.weekly)),
      monthly: Number(asciiDigits(d.monthly)),
    },
  };
}

/** The field each zod issue is about, as the form names them. */
function fieldOf(path: readonly PropertyKey[]): string {
  const [a, b] = path.map(String);
  if (a === 'target') return b === 'path' ? 'path' : (b ?? 'target');
  if (a === 'keep') return b ?? 'keep';
  return a ?? 'form';
}

/** Words for the backup routes' refusals (T10), else the app's usual ones. */
export function useBackupErrorText() {
  const { t } = useLingui();
  const base = useErrorText();
  return (e: unknown): string => {
    if (!isApiError(e)) return base(e);
    switch (e.code) {
      case 'backup_running':
        return t`A backup is already running. Wait for it to finish.`;
      case 'backup_not_configured':
        return t`Choose where backups go and set their password first.`;
      case 'setting_locked':
        return t`The server's environment sets that, so it can't be changed here.`;
      case 'backup_password_weak':
        return t`Use a backup password of at least 12 characters. A few words are easiest.`;
      case 'https_required':
        return t`This needs a secure (HTTPS) connection to Kept.`;
      case 'recovery_kit_required':
        return t`Download the recovery kit first.`;
      case 'restic_failed':
        return t`The backup tool couldn't open the repository. Test says why.`;
      default:
        return base(e);
    }
  };
}

function LockedPill() {
  return (
    <Pill icon={<LockIcon />}>
      <Trans>Set by the server's environment</Trans>
    </Pill>
  );
}

/** A read-only value with its label. */
function Fixed({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="font-semibold text-[12px] leading-none tracking-[.02em] text-ink-3">
        {label}
      </span>
      <span className="[overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** A write-only value: "Saved" with Replace, or the field to type a new one. */
function WriteOnly({
  label,
  saved,
  savedText,
  value,
  onChange,
  children,
}: {
  label: ReactNode;
  saved: boolean;
  savedText: ReactNode;
  value: string | null;
  onChange: (v: string | null) => void;
  children: (props: { value: string; onChange: (v: string) => void }) => ReactNode;
}) {
  if (saved && value === null) {
    return (
      <div className="grid gap-1">
        <span className="font-semibold text-[12px] leading-none tracking-[.02em] text-ink-3">
          {label}
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-ink-2">{savedText}</span>
          <Button size="small" variant="secondary" onPress={() => onChange('')}>
            <Trans>Replace</Trans>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      {children({ value: value ?? '', onChange: (v) => onChange(v) })}
      {saved ? (
        <Button
          size="small"
          variant="ghost"
          className="justify-self-start"
          onPress={() => onChange(null)}
        >
          <Trans>Keep the saved one</Trans>
        </Button>
      ) : null}
    </div>
  );
}

/** The variable that locks each kind of target (config/env.ts). */
const TARGET_VARS: Record<BackupTargetKind, string> = {
  dir: 'KEPT_BACKUP_DIR',
  s3: 'KEPT_BACKUP_S3_BUCKET',
  sftp: 'KEPT_BACKUP_SFTP',
};

const ltr = { dir: 'ltr' as const, spellCheck: false, autoCapitalize: 'none' as const };

function TargetFields({
  d,
  set,
  view,
  errors,
}: {
  d: Draft;
  set: (patch: Partial<Draft>) => void;
  view: BackupSettingsView;
  errors: Record<string, string>;
}) {
  const { t } = useLingui();
  const saved = view.target.value;
  const field = (key: keyof Draft, label: string, more: { description?: string } = {}) => (
    <TextField
      label={label}
      value={String(d[key] ?? '')}
      onChange={(v) => set({ [key]: v } as Partial<Draft>)}
      inputProps={ltr}
      isInvalid={!!errors[key === 'sftpPath' ? 'path' : key]}
      errorMessage={errors[key === 'sftpPath' ? 'path' : key]}
      {...more}
    />
  );
  if (d.kind === 'dir') {
    return field('path', t`Folder`, {
      description: t`An absolute path as the server sees it: another disk, or a NAS mount. Not the disk Kept's data is on.`,
    });
  }
  if (d.kind === 's3') {
    return (
      <>
        {field('endpoint', t`Endpoint`, {
          description: t`Empty for AWS. B2 and R2 through their S3 endpoints.`,
        })}
        <div className="grid gap-3 sm:grid-cols-2">
          {field('bucket', t`Bucket`)}
          {field('region', t`Region`)}
        </div>
        {field('prefix', t`Prefix`, {
          description: t`A folder inside the bucket, ending in a slash.`,
        })}
        <Switch isSelected={d.forcePathStyle} onChange={(on) => set({ forcePathStyle: on })}>
          <Trans>Path-style addresses (most self-hosted stores need this)</Trans>
        </Switch>
        {field('accessKeyId', t`Access key ID`)}
        <WriteOnly
          label={<Trans>Secret access key</Trans>}
          saved={saved?.kind === 's3' && saved.secretAccessKeySet}
          savedText={<Trans>Saved, never shown again</Trans>}
          value={d.secretAccessKey}
          onChange={(v) => set({ secretAccessKey: v })}
        >
          {(p) => (
            <PasswordField
              label={t`Secret access key`}
              autoComplete="new-password"
              value={p.value}
              onChange={p.onChange}
              isInvalid={!!errors.secretAccessKey}
              errorMessage={errors.secretAccessKey}
            />
          )}
        </WriteOnly>
      </>
    );
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        {field('host', t`Server`)}
        {field('port', t`Port`)}
      </div>
      {field('user', t`User`)}
      {field('sftpPath', t`Folder on the server`, {
        description: t`Absolute, or relative to the user's home folder.`,
      })}
      {field('hostKey', t`Host key`, {
        description: t`The server's own key, as ssh-keyscan prints it without the host name. Kept connects to no other.`,
      })}
      <WriteOnly
        label={<Trans>Private key</Trans>}
        saved={saved?.kind === 'sftp' && saved.privateKeySet}
        savedText={<Trans>Saved, never shown again</Trans>}
        value={d.privateKey}
        onChange={(v) => set({ privateKey: v })}
      >
        {(p) => (
          <TextFieldPrimitive
            className="grid gap-1"
            value={p.value}
            onChange={p.onChange}
            isInvalid={!!errors.privateKey}
          >
            <Label>{t`Private key`}</Label>
            <TextArea
              rows={4}
              dir="ltr"
              spellCheck={false}
              autoCapitalize="none"
              className={cn(inputClass, 'font-mono text-[13px]')}
            />
            <Description>
              <Trans>An OpenSSH private key. It replaces the saved key when you save.</Trans>
            </Description>
            <FieldError>{errors.privateKey}</FieldError>
          </TextFieldPrimitive>
        )}
      </WriteOnly>
    </>
  );
}

/** The saved target in words: "S3-compatible, kept-backups". */
export function useTargetWords() {
  const { t } = useLingui();
  return {
    kind: (k: BackupTargetKind) => ({ dir: t`Directory`, s3: t`S3-compatible`, sftp: t`SFTP` })[k],
    where: (v: BackupTargetView): string =>
      v.kind === 'dir'
        ? v.path
        : v.kind === 's3'
          ? `${v.bucket}${v.endpoint ? ` (${v.endpoint.replace(/^https?:\/\//, '')})` : ''}`
          : `${v.user}@${v.host}:${v.path}`,
  };
}

export function BackupForm({
  view,
  status,
  onDone,
}: {
  view: BackupSettingsView;
  status: StatusPageData | undefined;
  /** Called after a save (the page shows the summary again). */
  onDone?: () => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const typed = useTypedNumber();
  const qc = useQueryClient();
  const errorText = useBackupErrorText();
  const words = useTargetWords();
  const [d, setDraft] = useState<Draft>(() => draftOf(view));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [kitNeeded, setKitNeeded] = useState(false);
  const set = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrors({});
  };
  const https = status?.https !== false;
  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(view));

  const save = useMutation({
    mutationFn: (body: unknown) =>
      opsApi.putBackup(body as Parameters<typeof opsApi.putBackup>[0], view.version),
    onSuccess: async (next) => {
      qc.setQueryData(['admin', 'backup', 'settings'], next);
      setDraft(draftOf(next));
      setKitNeeded(false);
      await qc.invalidateQueries({ queryKey: keys.admin.all });
      toast({ title: t`Backup settings saved`, tone: 'ok' });
      onDone?.();
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'recovery_kit_required') {
        setKitNeeded(true);
        return;
      }
      toast({ title: errorText(e), tone: 'danger' });
    },
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (d.password !== null && d.password !== '' && [...d.password].length < BACKUP_PASSWORD_MIN) {
      next.password = t`At least 12 characters.`;
    }
    if (!view.passwordSet.value && !view.passwordSet.locked && !d.password) {
      next.password = t`Backups need a password: no password, no backup.`;
    }
    const body = bodyOf(d, view);
    const parsed = BackupSettingsInput.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = fieldOf(issue.path);
        next[key] ??= t`Check this.`;
      }
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    save.mutate(body);
  };

  const targetLocked = view.target.locked && view.target.value !== null;
  const keepLocked = (['daily', 'weekly', 'monthly'] as const).some((k) => view.keep[k].locked);
  const preUpgrade = f.num(BACKUP_KEEP_PRE_UPGRADE);
  const lockedVars = [
    targetLocked ? TARGET_VARS[view.target.value?.kind ?? 'dir'] : null,
    view.passwordSet.locked ? 'KEPT_BACKUP_PASSWORD' : null,
    view.time.locked ? 'KEPT_BACKUP_TIME' : null,
    keepLocked ? 'KEPT_BACKUP_KEEP_DAILY' : null,
  ].filter((x): x is string => x !== null);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!https ? (
        <Notice tone="warn" title={<Trans>This page is on plain HTTP</Trans>}>
          <Trans>Backup settings and the recovery kit can only be changed over HTTPS.</Trans>
        </Notice>
      ) : null}
      {kitNeeded ? (
        <Notice
          tone="warn"
          title={<Trans>Download the recovery kit first</Trans>}
          action={<KitDownloadButton size="small" variant="secondary" />}
        >
          <Trans>
            A backup is only as good as the keys that open it. Download the recovery kit and keep it
            off this server, then save again.
          </Trans>
        </Notice>
      ) : null}

      <section className="grid gap-3">
        <h2 className="eyebrow m-0">
          <Trans>Where backups go</Trans>
        </h2>
        {targetLocked && view.target.value ? (
          <div className="grid gap-2">
            <Fixed label={words.kind(view.target.value.kind)}>
              <span className="ltr">{words.where(view.target.value)}</span>
            </Fixed>
            <LockedPill />
          </div>
        ) : (
          <>
            <Segmented<BackupTargetKind>
              label={t`Target`}
              value={d.kind}
              onChange={(kind) => set({ kind })}
              options={[
                { id: 'dir', label: t`Directory` },
                { id: 's3', label: t`S3-compatible` },
                { id: 'sftp', label: t`SFTP` },
              ]}
            />
            <TargetFields d={d} set={set} view={view} errors={errors} />
          </>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="eyebrow m-0">
          <Trans>Backup password</Trans>
        </h2>
        {view.passwordSet.locked ? (
          <div className="grid gap-2">
            <span className="text-ink-2">
              {view.passwordSet.value ? <Trans>Set</Trans> : <Trans>Not set</Trans>}
            </span>
            <LockedPill />
          </div>
        ) : (
          <WriteOnly
            label={<Trans>Backup password</Trans>}
            saved={view.passwordSet.value}
            savedText={<Trans>Set, and in the recovery kit</Trans>}
            value={d.password}
            onChange={(v) => set({ password: v })}
          >
            {(p) => (
              <PasswordField
                label={t`Backup password`}
                autoComplete="new-password"
                value={p.value}
                onChange={p.onChange}
                description={t`At least 12 characters. Without it nobody can read the backups, Kept included.`}
                isInvalid={!!errors.password}
                errorMessage={errors.password}
              />
            )}
          </WriteOnly>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="eyebrow m-0">
          <Trans>When, and what is kept</Trans>
        </h2>
        {view.time.locked ? (
          <Fixed label={<Trans>Every night at (UTC)</Trans>}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{d.time}</span>
              <LockedPill />
            </span>
          </Fixed>
        ) : (
          <TimeField
            label={t`Every night at (UTC)`}
            value={d.time}
            onChange={(time) => set({ time })}
          />
        )}
        <div className="grid grid-cols-3 gap-3">
          {(['daily', 'weekly', 'monthly'] as const).map((k) => {
            const label = { daily: t`Daily`, weekly: t`Weekly`, monthly: t`Monthly` }[k];
            return view.keep[k].locked ? (
              <Fixed key={k} label={label}>
                {f.num(view.keep[k].value)}
              </Fixed>
            ) : (
              <TextField
                key={k}
                label={label}
                value={typed(d[k])}
                onChange={(v) => set({ [k]: asciiDigits(v).replace(/\D/g, '') } as Partial<Draft>)}
                inputProps={{ inputMode: 'numeric' }}
                isInvalid={!!errors[k]}
                errorMessage={errors[k]}
              />
            );
          })}
        </div>
        {keepLocked ? <LockedPill /> : null}
        <p className="m-0 text-small text-ink-3">
          <Trans>Snapshots taken before an upgrade: the last {preUpgrade} are kept.</Trans>
        </p>
        {lockedVars.length > 0 ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>
              Change the locked settings in the server's configuration (
              <code className="ltr whitespace-nowrap">{lockedVars.join(', ')}</code>) and restart
              Kept.
            </Trans>
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" isPending={save.isPending} isDisabled={!https || !dirty}>
          <Trans>Save</Trans>
        </Button>
        {onDone ? (
          <Button
            variant="ghost"
            onPress={() => {
              setDraft(draftOf(view));
              setErrors({});
              onDone();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Test: opens the repository with the saved settings and says what happened, inline. */
export function TestButton({ disabled }: { disabled: boolean }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useBackupErrorText();
  const testWords = useTestWords();
  const [result, setResult] = useState<BackupTestResult | null>(null);
  const test = useMutation({
    mutationFn: (init: boolean) => opsApi.testBackup(init ? { init: true } : {}),
    onSuccess: async (r) => {
      setResult(r);
      if (r.ok) await qc.invalidateQueries({ queryKey: ['admin', 'backup', 'snapshots'] });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const failed = result && !result.ok ? testWords(result.error) : null;
  return (
    <>
      <Button
        variant="secondary"
        isPending={test.isPending && !test.variables}
        isDisabled={disabled}
        onPress={() => test.mutate(false)}
      >
        <Trans>Test</Trans>
      </Button>
      {result ? (
        <div className="basis-full" aria-live="polite">
          {result.ok ? (
            <Notice tone="ok" title={<Trans>Reached</Trans>}>
              <Trans>Opened the repository with the saved password just now.</Trans>
            </Notice>
          ) : (
            <Notice
              tone="warn"
              title={failed?.title}
              action={
                result.error === 'no_repository' ? (
                  <Button
                    size="small"
                    variant="secondary"
                    isPending={test.isPending && test.variables === true}
                    onPress={() => test.mutate(true)}
                  >
                    {t`Create the repository`}
                  </Button>
                ) : null
              }
            >
              {failed?.body}
            </Notice>
          )}
        </div>
      ) : null}
    </>
  );
}

/** Run now: a manual backup, queued (202); the runs list shows it. */
export function RunNowButton({ disabled }: { disabled: boolean }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useBackupErrorText();
  const run = useMutation({
    mutationFn: opsApi.runBackup,
    onSuccess: async () => {
      noteRunNow();
      await qc.invalidateQueries({ queryKey: keys.admin.all });
      toast({ title: t`Backup started. It shows in the runs below.`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <Button
      variant="secondary"
      isPending={run.isPending}
      isDisabled={disabled}
      onPress={() => run.mutate()}
    >
      <Trans>Run now</Trans>
    </Button>
  );
}
