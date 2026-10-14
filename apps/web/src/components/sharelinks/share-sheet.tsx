/**
 * Share a read-only link (1.5, D233; D39 item 7, D116): a box, a place or a search's list, for
 * someone with no account. Pick how long it works (30 days by default, a year at most, §3.3); a
 * list also takes the name its page shows. The link is shown **once**, with Copy; only its hash
 * is kept, so it is gone when the sheet closes. Owners and admins only, never in Personal (the
 * callers hide it otherwise).
 */
import { SHARE_LINK_DEFAULT_DAYS, SHARE_LINK_EXPIRY_DAYS, type ShareView } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { sharelinkApi, sharelinkKeys } from '@/api/sharelinks/queries';
import type { CreatedShareLink } from '@/api/sharelinks/types';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useExpiryWords, WhatTheySee } from './words';

export type ShareTarget =
  | { kind: 'thing'; id: string; name: string }
  | { kind: 'place'; id: string; name: string }
  | { kind: 'view'; view: ShareView; title: string; locationName: string };

export function ShareLinkSheet({
  isOpen,
  onClose,
  locationId,
  target,
}: {
  isOpen: boolean;
  onClose: () => void;
  locationId: string;
  target: ShareTarget;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t`Share a read-only link`}
    >
      {isOpen ? <ShareForm locationId={locationId} target={target} onDone={onClose} /> : null}
    </Sheet>
  );
}

function ShareForm({
  locationId,
  target,
  onDone,
}: {
  locationId: string;
  target: ShareTarget;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const errorText = useErrorText();
  const expiry = useExpiryWords();
  const [days, setDays] = useState(String(SHARE_LINK_DEFAULT_DAYS));
  const [title, setTitle] = useState(target.kind === 'view' ? target.title : '');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [made, setMade] = useState<CreatedShareLink | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => {
      const expiresInDays = Number(days);
      if (target.kind === 'thing')
        return sharelinkApi.create(locationId, { thingId: target.id, expiresInDays });
      if (target.kind === 'place')
        return sharelinkApi.create(locationId, { placeId: target.id, expiresInDays });
      return sharelinkApi.create(locationId, {
        view: target.view,
        title: title.trim(),
        expiresInDays,
      });
    },
    onSuccess: async (out) => {
      setMade(out);
      await qc.invalidateQueries({ queryKey: sharelinkKeys.links(locationId) });
    },
    onError: (e) => setFailed(errorText(e)),
  });

  if (made) return <MadeView made={made} locationId={locationId} onDone={onDone} />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFailed(null);
    if (target.kind === 'view' && !title.trim()) {
      setTitleError(t`Give the list a name.`);
      return;
    }
    create.mutate();
  };
  const name = target.kind === 'view' ? '' : target.name;
  const locationName = target.kind === 'view' ? target.locationName : '';
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <p className="m-0 text-ink-2">
        {target.kind === 'view' ? (
          <Trans>
            Anyone with the link sees what this search finds in <bdi>{locationName}</bdi> when they
            open it. No account needed.
          </Trans>
        ) : (
          <Trans>
            Anyone with the link sees <bdi>{name}</bdi> and everything in it. No account needed.
          </Trans>
        )}
      </p>
      <p className="m-0 text-ink-2 text-small">
        <WhatTheySee />
      </p>
      {target.kind === 'view' ? (
        <TextField
          label={t`Name on the page`}
          value={title}
          maxLength={120}
          onChange={(v) => {
            setTitle(v);
            setTitleError(null);
          }}
          isInvalid={!!titleError}
          errorMessage={titleError ?? undefined}
        />
      ) : null}
      <Segmented
        label={t`Works for`}
        value={days}
        onChange={setDays}
        options={SHARE_LINK_EXPIRY_DAYS.map((d) => ({ id: String(d), label: expiry[d] }))}
      />
      {failed ? <Notice tone="danger">{failed}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={create.isPending} isDisabled={!online}>
          <Trans>Make link</Trans>
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

function MadeView({
  made,
  locationId,
  onDone,
}: {
  made: CreatedShareLink;
  locationId: string;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const until = f.day(made.link.expiresAt);
  return (
    <div className="grid gap-4">
      <p className="m-0 text-ink-2">
        <Trans>Anyone with this link can open it until {until}.</Trans>
      </p>
      <code
        data-share-link=""
        dir="ltr"
        className="block select-all break-all rounded-lg border border-line bg-sunken px-3 py-2.5 font-mono text-[14px] text-ink"
      >
        {made.url}
      </code>
      <CopyButton
        text={made.url}
        label={t`Copy link`}
        size="small"
        className="justify-self-start"
      />
      <p className="m-0 font-semibold text-[14px] text-ink">
        <Trans>Copy it now. Kept shows this link once; make a new one if it's lost.</Trans>
      </p>
      <Link
        to="/settings/location/$id/share-links"
        params={{ id: locationId }}
        className="justify-self-start text-small font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
      >
        <Trans>See this location's share links</Trans>
      </Link>
      <DialogFooter>
        <Button onPress={onDone}>
          <Trans>Done</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
