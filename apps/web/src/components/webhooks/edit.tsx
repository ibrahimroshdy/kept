/**
 * Add or change a location's webhook (D63, D110, engineering spec §2.6): the receiving URL and
 * which events to send, as a checkbox list. The server checks the URL against private addresses
 * when it's saved (D83). A new webhook's signing secret, like a rotated one, is shown **once**
 * with Copy and a snippet that checks a delivery's `Kept-Signature` with it; it lives in this
 * sheet's state only and is gone when the sheet closes.
 */
import { SIGNATURE_HEADER, WEBHOOK_EVENTS, type WebhookEvent } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { isApiError } from '@/api/client';
import { connectionsApi, connectionsKeys } from '@/api/connections/queries';
import type { WebhookRow } from '@/api/connections/types';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { DialogFooter } from '@/components/ui/dialog';
import { Description, Label } from '@/components/ui/field';
import { TextField } from '@/components/ui/text-field';
import { TickBox } from '@/components/ui/tick-box';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';
import { useEventWords } from './words';

const URL_MAX = 500;
const DEFAULT_EVENTS: WebhookEvent[] = ['thing.created', 'thing.moved', 'thing.updated'];

export type WebhookSheetState =
  | { kind: 'closed' }
  | { kind: 'add' }
  | { kind: 'edit'; webhook: WebhookRow }
  | { kind: 'secret'; secret: string; rotated: boolean };

export function WebhookSheet({
  locationId,
  state,
  onChange,
}: {
  locationId: string;
  state: WebhookSheetState;
  onChange: (next: WebhookSheetState) => void;
}) {
  const { t } = useLingui();
  const close = () => onChange({ kind: 'closed' });
  return (
    <Sheet
      isOpen={state.kind !== 'closed'}
      onOpenChange={(open) => (open ? undefined : close())}
      title={
        state.kind === 'secret'
          ? t`Signing secret`
          : state.kind === 'edit'
            ? t`Change webhook`
            : t`New webhook`
      }
      wide
    >
      {state.kind === 'secret' ? (
        <SecretView secret={state.secret} rotated={state.rotated} onDone={close} />
      ) : state.kind === 'add' || state.kind === 'edit' ? (
        <WebhookForm
          locationId={locationId}
          {...(state.kind === 'edit' ? { webhook: state.webhook } : {})}
          onCreated={(secret) => onChange({ kind: 'secret', secret, rotated: false })}
          onSaved={close}
          onCancel={close}
        />
      ) : null}
    </Sheet>
  );
}

function WebhookForm({
  locationId,
  webhook,
  onCreated,
  onSaved,
  onCancel,
}: {
  locationId: string;
  webhook?: WebhookRow;
  onCreated: (secret: string) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const errorText = useErrorText();
  const eventWords = useEventWords();
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [events, setEvents] = useState<WebhookEvent[]>(webhook?.events ?? DEFAULT_EVENTS);
  const [errors, setErrors] = useState<{ url?: string; events?: string }>({});
  const [failed, setFailed] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const body = { url: url.trim(), events };
      if (webhook) {
        await connectionsApi.updateWebhook(webhook.id, body, webhook.rowVersion);
        return null;
      }
      return (await connectionsApi.createWebhook(locationId, body)).secret;
    },
    onSuccess: async (secret) => {
      await qc.invalidateQueries({ queryKey: connectionsKeys.webhooks(locationId) });
      if (secret) onCreated(secret);
      else {
        toast({ title: t`Webhook saved`, tone: 'ok' });
        onSaved();
      }
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'private_address')
        setErrors({
          url: t`That address is on a private network, which this server doesn't allow.`,
        });
      // The server's check of the address itself (a name that doesn't resolve, say): said on the
      // field, not as "some of that isn't valid" (UI review steps 6–8, M5).
      else if (isApiError(e) && e.code === 'validation' && e.hint?.startsWith('url:'))
        setErrors({ url: t`Kept can't reach that address. Check it for typos.` });
      else setFailed(errorText(e));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFailed(null);
    const u = url.trim();
    let valid = false;
    try {
      const parsed = new URL(u);
      valid = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      valid = false;
    }
    const next = {
      ...(valid && u.length <= URL_MAX
        ? {}
        : { url: t`Enter the full address, starting with https://` }),
      ...(events.length ? {} : { events: t`Pick at least one event.` }),
    };
    setErrors(next);
    if (next.url || next.events) return;
    save.mutate();
  };
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <TextField
        label={t`Send to`}
        description={t`Your server's address. Kept sends a signed POST there.`}
        value={url}
        onChange={(v) => {
          setUrl(v);
          setErrors((x) => ({ ...x, url: undefined }));
        }}
        isInvalid={!!errors.url}
        errorMessage={errors.url}
        autoFocus
        inputProps={{ dir: 'ltr', inputMode: 'url', autoCapitalize: 'none', spellCheck: false }}
      />
      <div className="grid gap-1">
        <Label id="webhook-events">
          <Trans>When</Trans>
        </Label>
        <Description>
          <Trans>
            Each message carries ids and the names of the fields that changed, never names, places
            or values. Your server fetches what it needs with its own token.
          </Trans>
        </Description>
        <fieldset aria-labelledby="webhook-events" className="m-0 grid border-0 p-0">
          {WEBHOOK_EVENTS.map((ev) => (
            <TickBox
              key={ev}
              isSelected={events.includes(ev)}
              onChange={(on) => {
                setErrors((x) => ({ ...x, events: undefined }));
                setEvents(on ? [...events, ev] : events.filter((x) => x !== ev));
              }}
              description={
                <code dir="ltr" className="font-mono text-[12.5px]">
                  {ev}
                </code>
              }
            >
              {eventWords(ev)}
            </TickBox>
          ))}
        </fieldset>
        {errors.events ? (
          <p role="alert" className="m-0 text-danger text-small">
            {errors.events}
          </p>
        ) : null}
      </div>
      {failed ? <Notice tone="danger">{failed}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending} isDisabled={!online}>
          {webhook ? <Trans>Save</Trans> : <Trans>Add webhook</Trans>}
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

/**
 * How a receiver checks a delivery (the `Kept-Signature` format in @kept/shared webhooks.ts:
 * `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`), in Node, over the raw body.
 */
function verifySnippet(secret: string): string {
  return [
    "import { createHmac, timingSafeEqual } from 'node:crypto';",
    '',
    `const SECRET = '${secret}';`,
    '',
    `// header: the request's ${SIGNATURE_HEADER} header; body: the raw body, as received`,
    'export function fromKept(header, body) {',
    '  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");',
    '  if (!m) return false;',
    '  const mac = createHmac("sha256", SECRET).update(m[1] + "." + body).digest("hex");',
    '  const fresh = Math.abs(Date.now() / 1000 - Number(m[1])) < 300;',
    '  return fresh && timingSafeEqual(Buffer.from(mac), Buffer.from(m[2]));',
    '}',
  ].join('\n');
}

function SecretView({
  secret,
  rotated,
  onDone,
}: {
  secret: string;
  rotated: boolean;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const snippet = verifySnippet(secret);
  return (
    <div className="grid gap-4">
      <p className="m-0 text-ink-2">
        {rotated ? (
          <Trans>
            The old secret stopped working. Put this one on your server; every delivery from now on
            is signed with it.
          </Trans>
        ) : (
          <Trans>
            Kept signs every delivery with this secret, so your server can tell it came from Kept.
          </Trans>
        )}
      </p>
      <code
        data-webhook-secret=""
        dir="ltr"
        className="block select-all break-all rounded-lg border border-line bg-sunken px-3 py-2.5 font-mono text-[14px] text-ink"
      >
        {secret}
      </code>
      <CopyButton
        text={secret}
        label={t`Copy secret`}
        size="small"
        className="justify-self-start"
      />
      <p className="m-0 font-semibold text-[14px] text-ink">
        <Trans>Copy it now. You won't see it again; rotate it if it's lost.</Trans>
      </p>
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-[14px] text-ink">
            <Trans>Check a delivery (Node.js)</Trans>
          </span>
          <CopyButton text={snippet} label={t`Copy code`} size="small" />
        </div>
        <pre
          dir="ltr"
          className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-sunken p-2.5 font-mono text-[12.5px] text-ink"
        >
          {snippet}
        </pre>
      </div>
      <DialogFooter>
        <Button onPress={onDone}>
          <Trans>Done</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
