/**
 * Admin → Settings: the instance settings of GET/PUT /api/v1/admin/settings (admin/routes.ts).
 * Each saves on its own; a value the server's environment sets shows locked, and the server
 * refuses to change it (§7.11: the environment wins).
 *
 * - Sign-up (task 23; KEPT_SIGNUP_OPEN).
 * - Barcode lookup (T17; D104, D126; KEPT_BARCODE_LOOKUP): off by default. When on, a product
 *   barcode Kept doesn't know is looked up in Open Food Facts, Open Products Facts and Open Beauty
 *   Facts; only the barcode is sent. The contact (KEPT_BARCODE_CONTACT) is the email the lookups
 *   name in their User-Agent, as those databases ask.
 * - Former addresses (T16; D120, Q32): an instance's old host names, whose requests are sent to
 *   the public URL, so labels printed under an old address keep working. At most 10; never the
 *   public URL's own host.
 * - Private addresses (Q9, D83; `instance_settings.ssrf_allow_private`): off by default. When on,
 *   an OpenAI-compatible AI provider's base URL may be on the server's own network (a model run
 *   at home). The warning says what that opens: anyone who may add a provider can have the server
 *   call machines on its network. No environment variable sets it, so it is never locked.
 * - Check for new versions (step 8 T11, T21; D65; KEPT_UPDATE_CHECK): off by default. When on, the
 *   server asks GitHub once a day for the newest release of its source repository, sending
 *   nothing but the request; Admin → Status shows the answer. Nothing is downloaded or installed.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { putAdminSettings } from '@/api/admin';
import { keys, useAdminSettings } from '@/api/queries';
import {
  type AdminSetting,
  type AdminSettingsBody,
  HOSTNAME,
  MAX_FORMER_HOSTNAMES,
} from '@/api/types';
import { LockIcon, XIcon } from '@/components/icons';
import {
  ErrorState,
  List,
  LoadingRows,
  Notice,
  Pill,
  Section,
  useErrorText,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/_app/admin/settings')({ component: SettingsPage });

function Locked() {
  return (
    <Pill icon={<LockIcon />}>
      <Trans>Set by the environment</Trans>
    </Pill>
  );
}

/** A plain check before the server's own (`z.email()`); the server has the last word. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useSave() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  return useMutation({
    mutationFn: (body: AdminSettingsBody) => putAdminSettings(body),
    onSuccess: async (next) => {
      qc.setQueryData(keys.admin.settings, next);
      toast({ title: t`Saved`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
}

function SettingsPage() {
  const settings = useAdminSettings();
  const save = useSave();
  if (settings.isPending) return <LoadingRows rows={2} />;
  if (settings.error)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const {
    signupOpen,
    barcodeLookup,
    barcodeContact,
    formerHostnames,
    ssrfAllowPrivate,
    updateCheck,
  } = settings.data;
  return (
    <div className="grid gap-5">
      <Section title={<Trans>Sign-up</Trans>}>
        <List>
          <li className="grid gap-1 px-3.5 py-2">
            <Switch
              isSelected={signupOpen.value}
              isDisabled={signupOpen.locked || save.isPending}
              onChange={(v) => save.mutate({ signupOpen: v })}
              className="w-full flex-row-reverse justify-between"
            >
              <span className="grid gap-0.5 py-1">
                <span className="font-semibold">
                  <Trans>Anyone with the address can create an account</Trans>
                </span>
                <span className="text-small text-ink-3">
                  {signupOpen.value ? (
                    <Trans>Open. New accounts get only their Personal location.</Trans>
                  ) : (
                    <Trans>
                      Closed. People join through an invite, or you add a managed account.
                    </Trans>
                  )}
                </span>
              </span>
            </Switch>
            {signupOpen.locked ? <Locked /> : null}
          </li>
        </List>
      </Section>

      <Section title={<Trans>Barcode lookup</Trans>}>
        <List>
          <li className="grid gap-1 px-3.5 py-2">
            <Switch
              isSelected={barcodeLookup.value}
              isDisabled={barcodeLookup.locked || save.isPending}
              onChange={(v) => save.mutate({ barcodeLookup: v })}
              className="w-full flex-row-reverse justify-between"
            >
              <span className="grid gap-0.5 py-1">
                <span className="font-semibold">
                  <Trans>Look up products Kept doesn't know by their barcode</Trans>
                </span>
                <span className="text-small text-ink-3">
                  {barcodeLookup.value ? (
                    <Trans>
                      On. A scanned product barcode Kept doesn't know is looked up in Open Food
                      Facts, Open Products Facts and Open Beauty Facts. Only the barcode is sent.
                    </Trans>
                  ) : (
                    <Trans>
                      Off. A scanned product barcode finds only what Kept already holds.
                    </Trans>
                  )}
                </span>
              </span>
            </Switch>
            {barcodeLookup.locked ? <Locked /> : null}
          </li>
          <li className="px-3.5 py-3">
            <ContactField setting={barcodeContact} />
          </li>
        </List>
      </Section>

      <Section title={<Trans>Former addresses</Trans>}>
        <FormerHostnames hosts={formerHostnames} />
      </Section>

      {updateCheck ? (
        <Section title={<Trans>New versions</Trans>}>
          <List>
            <li className="grid gap-1 px-3.5 py-2">
              <Switch
                isSelected={updateCheck.value}
                isDisabled={updateCheck.locked || save.isPending}
                onChange={(v) => save.mutate({ updateCheck: v })}
                className="w-full flex-row-reverse justify-between"
              >
                <span className="grid gap-0.5 py-1">
                  <span className="font-semibold">
                    <Trans>Check for new versions</Trans>
                  </span>
                  <span className="text-small text-ink-3">
                    {updateCheck.value ? (
                      <Trans>
                        On. Once a day the server asks GitHub for Kept's newest release, sending
                        nothing but the request. Admin → Status says when one is out.
                      </Trans>
                    ) : (
                      <Trans>Off. Kept never asks; check the releases page yourself.</Trans>
                    )}
                  </span>
                </span>
              </Switch>
              {updateCheck.locked ? <Locked /> : null}
            </li>
          </List>
        </Section>
      ) : null}

      <Section title={<Trans>Private addresses</Trans>}>
        <List>
          <li className="grid gap-2 px-3.5 py-2">
            <Switch
              isSelected={ssrfAllowPrivate}
              isDisabled={save.isPending}
              onChange={(v) => save.mutate({ ssrfAllowPrivate: v })}
              className="w-full flex-row-reverse justify-between"
            >
              <span className="grid gap-0.5 py-1">
                <span className="font-semibold">
                  <Trans>Allow private addresses</Trans>
                </span>
                <span className="text-small text-ink-3">
                  {ssrfAllowPrivate ? (
                    <Trans>
                      On. An OpenAI-compatible AI provider can be on this server's own network, like
                      a model you run at home.
                    </Trans>
                  ) : (
                    <Trans>Off. An AI provider's address must be on the public internet.</Trans>
                  )}
                </span>
              </span>
            </Switch>
            <Notice tone="warn" className="mb-1.5">
              <Trans>
                Only for a server you host yourself. While this is on, anyone who can add an AI
                provider can make this server send requests to machines on its network, such as your
                router or other services.
              </Trans>
            </Notice>
          </li>
        </List>
      </Section>
    </div>
  );
}

/** The contact the lookups name (`User-Agent: Kept/<version> (<contact>)`). */
function ContactField({ setting }: { setting: AdminSetting<string | null> }) {
  const { t } = useLingui();
  const save = useSave();
  const [draft, setDraft] = useState(setting.value ?? '');
  const [error, setError] = useState<string | null>(null);
  const trimmed = draft.trim();
  const changed = trimmed !== (setting.value ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed && (!EMAIL.test(trimmed) || trimmed.length > 254)) {
      setError(t`Enter an email address, or leave it empty.`);
      return;
    }
    setError(null);
    save.mutate({ barcodeContact: trimmed || null });
  };
  return (
    <form noValidate onSubmit={submit} className="grid gap-2">
      <TextField
        label={<Trans>Contact for the lookups</Trans>}
        type="email"
        value={draft}
        onChange={(v) => {
          setDraft(v);
          setError(null);
        }}
        isDisabled={setting.locked}
        inputProps={{ dir: 'ltr', autoComplete: 'email', spellCheck: false }}
        description={
          <Trans>
            The databases ask each app for a contact. Kept sends this email with each lookup, and
            nothing else about you.
          </Trans>
        }
        {...(error ? { errorMessage: error } : {})}
        isInvalid={!!error}
      />
      {setting.locked ? (
        <Locked />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="small" isDisabled={!changed} isPending={save.isPending}>
            <Trans>Save contact</Trans>
          </Button>
        </div>
      )}
    </form>
  );
}

/** The instance's former host names: listed, removed, added (saved as the whole list). */
function FormerHostnames({ hosts }: { hosts: string[] }) {
  const { t } = useLingui();
  const save = useSave();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const max = MAX_FORMER_HOSTNAMES;
  const full = hosts.length >= max;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const host = draft.trim().toLowerCase();
    if (!HOSTNAME.test(host)) {
      setError(t`Enter a host name only, like kept.home.example: no https:// and no port.`);
      return;
    }
    // The page's own host stands in for the public URL's (inferred: Kept is served from it).
    if (host === window.location.hostname.toLowerCase()) {
      setError(t`That is this server's own address.`);
      return;
    }
    if (hosts.includes(host)) {
      setError(t`That name is already listed.`);
      return;
    }
    setError(null);
    save.mutate({ formerHostnames: [...hosts, host] }, { onSuccess: () => setDraft('') });
  };
  return (
    <div className="grid gap-3">
      <p className="m-0 text-small text-ink-2">
        <Trans>
          When Kept moves to a new address, list the old names here and point them at this server. A
          label printed under an old address still opens: the request is sent to this one.
        </Trans>
      </p>
      {hosts.length ? (
        <List aria-label={t`Former addresses`}>
          {hosts.map((host) => (
            <li key={host} className="flex items-center justify-between gap-2 px-3.5 py-2">
              <bdi dir="ltr" className="min-w-0 font-mono text-[13.5px] [overflow-wrap:anywhere]">
                {host}
              </bdi>
              <Button
                size="small"
                variant="ghost"
                aria-label={t`Remove ${host}`}
                isDisabled={save.isPending}
                onPress={() => save.mutate({ formerHostnames: hosts.filter((h) => h !== host) })}
                className="[&_svg]:size-4"
              >
                <XIcon aria-hidden="true" />
                <Trans>Remove</Trans>
              </Button>
            </li>
          ))}
        </List>
      ) : (
        <p className="m-0 text-small text-ink-3">
          <Trans>None. Kept answers only at its own address.</Trans>
        </p>
      )}
      <form noValidate onSubmit={add} className="grid gap-2">
        <TextField
          label={<Trans>Old host name</Trans>}
          value={draft}
          onChange={(v) => {
            setDraft(v);
            setError(null);
          }}
          isDisabled={full}
          inputProps={{ dir: 'ltr', spellCheck: false, autoCapitalize: 'none' }}
          description={
            full ? (
              <Plural
                value={max}
                one="At most # name. Remove one to add another."
                other="At most # names. Remove one to add another."
              />
            ) : (
              <Trans>Only the name, like kept.home.example.</Trans>
            )
          }
          {...(error ? { errorMessage: error } : {})}
          isInvalid={!!error}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            size="small"
            variant="secondary"
            isDisabled={full || !draft.trim()}
            isPending={save.isPending}
          >
            <Trans>Add</Trans>
          </Button>
        </div>
      </form>
    </div>
  );
}
