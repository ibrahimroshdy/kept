/**
 * Invite (screens §5, D33, D180, D181, D193). Role (admin only for the owner), an end date
 * capped at your own, then the link with Copy link and a QR code beside it, so the other phone
 * scans it with no SMTP. The link works once, for 7 days. Its token travels in the #fragment.
 * Send by email is disabled with its reason until SMTP is set up (§3).
 */
import type { Role } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { createInvite } from '@/api/locations';
import { keys, useMe } from '@/api/queries';
import type { CreateInviteResult, LocationDetail } from '@/api/types';
import { LinkIcon, MailIcon, ShareIcon } from '@/components/icons';
import { LocationSettingsPage } from '@/components/location-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import { IconTile, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { DatePicker } from '@/components/ui/date-picker';
import { QrCode } from '@/components/ui/qr-code';
import { Segmented } from '@/components/ui/segmented';
import { toast } from '@/components/ui/toast';
import { dayOf, endOfDay } from '@/lib/day-end';
import { useFormat } from '@/lib/format';
import { useRoleLabels } from '@/lib/labels';
import { grantableRoles } from '@/lib/roles';

export const Route = createFileRoute('/_app/settings/location/$id/invite')({
  component: InvitePage,
  errorComponent: SettingsRouteError,
});

function InvitePage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage
      id={id}
      section="members"
      title={(loc) => {
        const name = loc.name;
        return t`Invite to ${name}`;
      }}
    >
      {(loc) => <InviteForm location={loc} />}
    </LocationSettingsPage>
  );
}

function InviteForm({ location }: { location: LocationDetail }) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  const f = useFormat();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const me = useMe();
  const [role, setRole] = useState<Role>('member');
  const [limited, setLimited] = useState(false);
  const [until, setUntil] = useState<string | null>(null);
  const [invite, setInvite] = useState<CreateInviteResult | null>(null);
  const cap = location.membershipExpiresAt
    ? dayOf(location.membershipExpiresAt, location.timezone)
    : null;
  const capText = cap ? f.day(cap) : null;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const missingDate = limited && !until;
  // An admin whose own access ends can only invite until then (D180).
  const mustLimit = !!cap;

  const create = useMutation({
    mutationFn: () =>
      createInvite(location.id, {
        role,
        membershipExpiresAt:
          limited || mustLimit ? endOfDay(until ?? cap ?? '', location.timezone) : null,
      }),
    onSuccess: async (r) => {
      setInvite(r);
      await qc.invalidateQueries({ queryKey: keys.members(location.id) });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const changed = () => setInvite(null);
  const expires = invite?.expiresAt
    ? f.day(invite.expiresAt)
    : f.day(new Date(Date.now() + 7 * 86_400_000).toISOString());
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const place = location.name;

  return (
    <div className="grid gap-5">
      <Segmented<Role>
        label={t`Role`}
        value={role}
        onChange={(r) => {
          setRole(r);
          changed();
        }}
        description={roles.what[role]}
        options={grantableRoles(location.role).map((r) => ({ id: r, label: roles.one[r] }))}
      />
      <div className="grid gap-2">
        <Segmented<'none' | 'date'>
          label={t`Access`}
          value={limited || mustLimit ? 'date' : 'none'}
          onChange={(v) => {
            setLimited(v === 'date');
            changed();
          }}
          options={[
            { id: 'none', label: t`No end date`, isDisabled: mustLimit },
            { id: 'date', label: t`Until a date` },
          ]}
        />
        {limited || mustLimit ? (
          <DatePicker
            label={t`Last day`}
            value={until ?? cap}
            onChange={(v) => {
              setUntil(v);
              changed();
            }}
            minValue={tomorrow}
            maxValue={cap}
            errorMessage={missingDate ? t`Choose the last day.` : undefined}
            description={
              capText ? (
                <Trans>
                  Their access, and any tokens they make, stop on this date. It can't be later than
                  your own, {capText}.
                </Trans>
              ) : (
                <Trans>Their access, and any tokens they make, stop on this date.</Trans>
              )
            }
          />
        ) : null}
      </div>

      {invite?.url ? (
        <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
          <div className="flex flex-wrap items-start gap-4">
            <div className="rounded-lg border border-line bg-white p-1.5">
              <QrCode value={invite.url} label={t`QR code for the invite link`} size={148} />
            </div>
            <div className="grid min-w-0 flex-1 basis-40 gap-1.5">
              <div className="eyebrow">
                <Trans>Scan with their phone</Trans>
              </div>
              <div className="ltr font-mono text-[13.5px] leading-snug text-ink [overflow-wrap:anywhere]">
                {invite.url}
              </div>
              <div className="text-small text-ink-2">
                <Trans>One use. Works for 7 days, until {expires}.</Trans>
              </div>
            </div>
          </div>
          <CopyButton text={invite.url} label={t`Copy link`} variant="primary" className="w-full" />
          {canShare ? (
            <Button
              variant="secondary"
              className="w-full"
              onPress={() =>
                void navigator
                  .share({ title: t`Join ${place} on Kept`, url: invite.url ?? '' })
                  .catch(() => {})
              }
            >
              <ShareIcon />
              <Trans>Share…</Trans>
            </Button>
          ) : null}
          <p className="m-0 text-small text-ink-3">
            <Trans>
              It shows under Members as a pending invite until it's used, where you can revoke it.
            </Trans>
          </p>
        </div>
      ) : (
        <Button
          className="w-full"
          isDisabled={missingDate}
          isPending={create.isPending}
          onPress={() => create.mutate()}
        >
          <LinkIcon />
          <Trans>Create invite link</Trans>
        </Button>
      )}

      <div className="flex items-center gap-3 rounded-[10px] border border-line bg-surface p-3.5">
        <IconTile>
          <MailIcon />
        </IconTile>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="font-semibold text-[15px] text-ink-2">
            <Trans>Send by email</Trans>
          </div>
          <div className="text-small text-ink-3">
            <Trans>Needs email set up on this server</Trans>
          </div>
        </div>
        {me.data?.user.instanceAdmin ? (
          <Link
            to="/admin/settings"
            className="inline-flex min-h-10 items-center rounded-[7px] border border-line px-3 text-[13px] font-semibold text-ink outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info"
          >
            <Trans>Set up</Trans>
          </Link>
        ) : null}
      </div>
      {location.require2fa ? (
        <Notice tone="info">
          <Trans>
            {place} asks everyone for two-factor. They can join now; {place} stays hidden for them
            until they add a passkey or an authenticator.
          </Trans>
        </Notice>
      ) : null}
    </div>
  );
}
