/**
 * New token (screens §5 "Connections", D15, D60, D63, D179, D180): a name, what it may do (read,
 * or read and change; never delete), its locations (one pre-selected, D179), and an optional
 * expiry on Kept's calendar. A write token over locations whose member lists differ is a second
 * step: the server answers D179's warning and the sheet asks again before sending
 * `confirmCrossLocation`.
 *
 * The token is then shown **once**, with Copy and Share and the ready-made client configs (T10).
 * It lives in this sheet's state only, never in the query cache, and is gone from the page the
 * moment the sheet closes (`onOpenChange(false)` drops it; the sheet's content unmounts).
 *
 * Scope follows the role (roles.ts `tokens.manage-own`): a viewer's token reads only, a member's
 * is up to their own role, so "Read and change" is off while any picked location is one where
 * you're a viewer.
 */
import type { TokenScope } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { connectionsApi, connectionsKeys } from '@/api/connections/queries';
import {
  type CreatedToken,
  type CreateTokenBody,
  isCrossLocationWarning,
} from '@/api/connections/types';
import { useLocations } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { ShareIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Description, Label } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { TickBox } from '@/components/ui/tick-box';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { ClientConfigs } from './client-configs';
import { useNameList, useScopeMeaning, useScopeWords } from './words';

const NAME_MAX = 80;

type Step = { kind: 'form' } | { kind: 'warning' } | { kind: 'created'; created: CreatedToken };

export function TokenCreateSheet({
  isOpen,
  onOpenChange,
  defaultLocationId,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The location to start with (one pre-selected, D179). Default: the first one you manage. */
  defaultLocationId?: string;
}) {
  const { t } = useLingui();
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const close = (open: boolean) => {
    if (!open) setStep({ kind: 'form' });
    onOpenChange(open);
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={close}
      title={step.kind === 'created' ? t`Your new token` : t`New token`}
      wide
    >
      {step.kind === 'created' ? (
        <CreatedView created={step.created} onDone={() => close(false)} />
      ) : (
        <CreateForm
          {...(defaultLocationId ? { defaultLocationId } : {})}
          warning={step.kind === 'warning'}
          onWarning={() => setStep({ kind: 'warning' })}
          onBack={() => setStep({ kind: 'form' })}
          onCreated={(created) => setStep({ kind: 'created', created })}
          onCancel={() => close(false)}
        />
      )}
    </Sheet>
  );
}

/** The location a new token starts with: the given one, else the first that isn't Personal. */
function firstChoice(locations: LocationDetail[], wanted?: string): string[] {
  if (wanted && locations.some((l) => l.id === wanted)) return [wanted];
  const pick = locations.find((l) => l.kind !== 'personal') ?? locations[0];
  return pick ? [pick.id] : [];
}

/** End of the chosen day in the reader's time zone, as the server's ISO instant. */
const endOfDay = (day: string) => new Date(`${day}T23:59:59`).toISOString();

function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function CreateForm({
  defaultLocationId,
  warning,
  onWarning,
  onBack,
  onCreated,
  onCancel,
}: {
  defaultLocationId?: string;
  warning: boolean;
  onWarning: () => void;
  onBack: () => void;
  onCreated: (created: CreatedToken) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const errorText = useErrorText();
  const scopeWords = useScopeWords();
  const scopeMeaning = useScopeMeaning();
  const nameOf = useLocationName();
  const names = useNameList();
  const locations = useLocations();
  const all = locations.data ?? [];
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? firstChoice(all, defaultLocationId);
  const [scope, setScope] = useState<TokenScope>('read');
  const [expiresOn, setExpiresOn] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string; locations?: string }>({});
  const [failed, setFailed] = useState<string | null>(null);

  const viewerIn = useMemo(
    () => all.filter((l) => chosen.includes(l.id) && l.role === 'viewer'),
    [all, chosen],
  );
  const writeAllowed = viewerIn.length === 0;
  const effectiveScope: TokenScope = writeAllowed ? scope : 'read';

  const body = (confirmCrossLocation: boolean): CreateTokenBody => ({
    name: name.trim(),
    scope: effectiveScope,
    locationIds: chosen,
    ...(expiresOn ? { expiresAt: endOfDay(expiresOn) } : {}),
    ...(confirmCrossLocation ? { confirmCrossLocation: true } : {}),
  });

  const create = useMutation({
    mutationFn: (confirm: boolean) => connectionsApi.createToken(body(confirm)),
    onSuccess: async (r) => {
      if (isCrossLocationWarning(r)) {
        onWarning();
        return;
      }
      await qc.invalidateQueries({ queryKey: connectionsKeys.tokens });
      onCreated(r);
    },
    onError: (e) => setFailed(errorText(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFailed(null);
    const next = {
      ...(name.trim() ? {} : { name: t`Name it after where you'll use it.` }),
      ...(name.trim().length > NAME_MAX ? { name: t`At most 80 characters.` } : {}),
      ...(chosen.length ? {} : { locations: t`Pick at least one location.` }),
    };
    setErrors(next);
    if (next.name || next.locations) return;
    create.mutate(false);
  };

  if (warning) {
    const picks = names(all.filter((l) => chosen.includes(l.id)).map((l) => nameOf(l)));
    return (
      <div className="grid gap-4">
        <Notice tone="warn" title={<Trans>Different people use these locations</Trans>}>
          <Trans>
            A token that can change things in <bdi>{picks}</bdi> lets an app move things between
            them, so people in one could see what came from the other. Make one token per location
            unless you mean that.
          </Trans>
        </Notice>
        {failed ? <Notice tone="danger">{failed}</Notice> : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onBack}>
            <Trans>Back</Trans>
          </Button>
          <Button
            isPending={create.isPending}
            isDisabled={!online}
            onPress={() => {
              setFailed(null);
              create.mutate(true);
            }}
          >
            <Trans>Make it for all of them</Trans>
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <TextField
        label={t`Name`}
        description={t`Where you'll use it: "Claude Desktop, my laptop", "Shortcuts on my iPhone".`}
        value={name}
        onChange={(v) => {
          setName(v);
          setErrors((x) => ({ ...x, name: undefined }));
        }}
        isInvalid={!!errors.name}
        errorMessage={errors.name}
        autoFocus
      />
      <div className="grid gap-1">
        <Label id="token-locations">
          <Trans>Locations</Trans>
        </Label>
        <Description>
          <Trans>A token starts with one location. Add another only if the app needs both.</Trans>
        </Description>
        <fieldset aria-labelledby="token-locations" className="m-0 grid border-0 p-0">
          {all.map((l) => (
            <TickBox
              key={l.id}
              isSelected={chosen.includes(l.id)}
              onChange={(on) => {
                setErrors((x) => ({ ...x, locations: undefined }));
                setPicked(on ? [...chosen, l.id] : chosen.filter((id) => id !== l.id));
              }}
              description={l.role === 'viewer' ? <Trans>You're a viewer here</Trans> : undefined}
            >
              <bdi>{nameOf(l)}</bdi>
            </TickBox>
          ))}
        </fieldset>
        {errors.locations ? (
          <p role="alert" className="m-0 text-danger text-small">
            {errors.locations}
          </p>
        ) : null}
      </div>
      <Segmented<TokenScope>
        label={t`What it can do`}
        value={effectiveScope}
        onChange={setScope}
        options={[
          { id: 'read', label: scopeWords('read') },
          { id: 'write', label: scopeWords('write'), isDisabled: !writeAllowed },
        ]}
        description={
          writeAllowed ? (
            scopeMeaning(effectiveScope)
          ) : (
            <Trans>
              Read only: you're a viewer in <bdi>{names(viewerIn.map((l) => nameOf(l)))}</bdi>, and
              a token can't do more than you can.
            </Trans>
          )
        }
      />
      <DatePicker
        label={t`Expires`}
        description={t`Leave empty to keep it until you revoke it.`}
        value={expiresOn}
        onChange={setExpiresOn}
        minValue={tomorrow()}
      />
      {failed ? <Notice tone="danger">{failed}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={create.isPending} isDisabled={!online}>
          <Trans>Make token</Trans>
        </Button>
      </DialogFooter>
      {!online ? (
        <p className="m-0 text-end text-ink-2 text-small">
          <Trans>Needs a connection</Trans>
        </p>
      ) : null}
    </form>
  );
}

const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/** The token, once: Copy, Share, what it can do, and the client configs. */
function CreatedView({ created, onDone }: { created: CreatedToken; onDone: () => void }) {
  const { t } = useLingui();
  const f = useFormat();
  const scopeWords = useScopeWords();
  const names = useNameList();
  const locationName = useLocationName();
  const { token, secret } = created;
  const where = names(token.locations.map(locationName));
  const scope = scopeWords(token.scope);
  const expires = token.expiresAt ? f.day(token.expiresAt) : null;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2 rounded-[10px] border border-line bg-sunken p-3.5">
        <div className="font-semibold text-[15px] text-ink [overflow-wrap:anywhere]">
          <bdi>{token.name}</bdi>
        </div>
        <code
          data-token-secret=""
          dir="ltr"
          className="block select-all break-all rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-[14px] text-ink"
        >
          {secret}
        </code>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={secret} label={t`Copy`} size="small" />
          {canShare() ? (
            <Button
              variant="secondary"
              size="small"
              onPress={async () => {
                try {
                  await navigator.share({ text: secret });
                } catch (e) {
                  // The person closed the share sheet: nothing to say.
                  if ((e as Error)?.name !== 'AbortError')
                    toast({ title: t`Couldn't share`, tone: 'danger' });
                }
              }}
            >
              <ShareIcon />
              <Trans>Share</Trans>
            </Button>
          ) : null}
        </div>
        <p className="m-0 font-semibold text-[14px] text-ink">
          <Trans>Copy it now. You won't see this again: Kept keeps only a fingerprint of it.</Trans>
        </p>
        <p className="m-0 text-small text-ink-2">
          {expires ? (
            <Trans>
              {scope} · <bdi>{where}</bdi> · expires {expires}
            </Trans>
          ) : (
            <Trans>
              {scope} · <bdi>{where}</bdi> · no expiry
            </Trans>
          )}
        </p>
      </div>
      <ClientConfigs configs={created.clientConfigs} />
      <DialogFooter>
        <Button onPress={onDone}>
          <Trans>Done</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
