/**
 * Members and roles (screens §5, D46, D47, D48, D180, D190). Grouped Owner · Admins · Members ·
 * Viewers, then pending invites with their expiry and Revoke. Phone: a list whose rows open a
 * sheet of actions. Desktop: the same rows as a table with the actions inline. Promoting,
 * demoting or removing admins is owner only; the owner's row has no actions; an end date can't
 * be later than your own (D180).
 */
import type { Role } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import {
  createManagedAccount,
  newManagedResetCode,
  removeMember,
  revokeInvite,
  updateMember,
} from '@/api/locations';
import { keys, useMe, useMembers } from '@/api/queries';
import type {
  CreateManagedResult,
  LocationDetail,
  ManagedResetCode,
  Member,
  PendingInvite,
} from '@/api/types';
import { PeopleCount } from '@/components/counts';
import { ChevronEndIcon, ClockIcon, KeyIcon, LinkIcon, PlusIcon } from '@/components/icons';
import { LeaveLocation } from '@/components/leave-location';
import { LocationSettingsPage } from '@/components/location-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import {
  Avatar,
  EmptyState,
  ErrorState,
  IconTile,
  LinkButton,
  List,
  LoadingRows,
  Notice,
  Pill,
  Section,
  useErrorText,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { CopyButton } from '@/components/ui/copy-button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { dayOf, endOfDay } from '@/lib/day-end';
import { sep, useFormat } from '@/lib/format';
import { useRoleLabels } from '@/lib/labels';
import { grantableRoles } from '@/lib/roles';

export const Route = createFileRoute('/_app/settings/location/$id/members')({
  component: MembersPage,
  errorComponent: SettingsRouteError,
});

function MembersPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="members" title={() => t`Members`}>
      {(loc) => <MembersBody location={loc} />}
    </LocationSettingsPage>
  );
}

const ORDER: Role[] = ['owner', 'admin', 'member', 'viewer'];

function canManageRow(me: Role, row: Member): boolean {
  if (row.role === 'owner' || row.isYou) return false;
  if (row.role === 'admin') return me === 'owner';
  return me === 'owner' || me === 'admin';
}

/**
 * D197: a managed account's new one-time code is for the owner of its home location, or whoever
 * created it while still an owner or admin there. The member list doesn't say which location is
 * the account's home, so this is the client's best guess: owners here, and the admin who created
 * it (by name). The server decides; its 403 or 404 is explained in the sheet.
 */
function mayIssueCode(location: LocationDetail, row: Member, myName: string | undefined) {
  if (!row.managed) return false;
  if (location.role === 'owner') return true;
  return location.role === 'admin' && !!myName && row.managedByName === myName;
}

function MembersBody({ location }: { location: LocationDetail }) {
  const members = useMembers(location.id);
  const roles = useRoleLabels();
  const [editing, setEditing] = useState<Member | null>(null);
  const [addingManaged, setAddingManaged] = useState(false);
  const name = location.name;

  if (members.isPending) return <LoadingRows rows={4} />;
  if (members.error)
    return <ErrorState error={members.error} onRetry={() => void members.refetch()} />;

  const { members: list, invites } = members.data;
  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <div className="text-ink-2">
          {name}
          {sep()}
          <PeopleCount n={list.length} />
          {location.require2fa ? (
            <>
              {sep()}
              <Trans>two-factor required</Trans>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton
            to="/settings/location/$id/invite"
            params={{ id: location.id }}
            variant="primary"
            className="flex-1 sm:flex-none"
          >
            <PlusIcon />
            <Trans>Invite</Trans>
          </LinkButton>
          <Button variant="secondary" onPress={() => setAddingManaged(true)}>
            <KeyIcon />
            <Trans>Add someone without email</Trans>
          </Button>
        </div>
      </div>

      {/* Desktop: the rows are a table; these are its column heads. */}
      <div aria-hidden="true" className="eyebrow -mb-3 hidden items-center gap-3 px-3.5 md:flex">
        <span className="flex-[2]">
          <Trans>Person</Trans>
        </span>
        <span className="w-24">
          <Trans>Role</Trans>
        </span>
        <span className="w-44" />
      </div>
      {ORDER.map((role) => {
        const group = list.filter((m) => m.role === role);
        if (group.length === 0) return null;
        return (
          <Section key={role} title={roles.group[role]}>
            <List>
              {group.map((m) => (
                <li key={m.membershipId}>
                  <MemberRow
                    member={m}
                    location={location}
                    onEdit={canManageRow(location.role, m) ? () => setEditing(m) : undefined}
                  />
                </li>
              ))}
            </List>
          </Section>
        );
      })}

      <Section title={<Trans>Pending invites</Trans>}>
        {invites.length === 0 ? (
          <EmptyState icon={<LinkIcon />} title={<Trans>No pending invites</Trans>}>
            <Trans>An invite link works once, for 7 days. Unused ones show here.</Trans>
          </EmptyState>
        ) : (
          <List>
            {invites.map((inv) => (
              <li key={inv.id}>
                <InviteRow invite={inv} locationId={location.id} />
              </li>
            ))}
          </List>
        )}
      </Section>

      {location.role !== 'owner' ? <LeaveLocation location={location} /> : null}

      {editing ? (
        <EditMember member={editing} location={location} onClose={() => setEditing(null)} />
      ) : null}
      {addingManaged ? (
        <AddManaged location={location} onClose={() => setAddingManaged(false)} />
      ) : null}
    </div>
  );
}

function MemberSubtitle({ member, location }: { member: Member; location: LocationDetail }) {
  const f = useFormat();
  const name = location.name;
  const by = member.managedByName ?? '';
  const until = member.expiresAt ? f.day(member.expiresAt) : null;
  const lines: React.ReactNode[] = [];
  if (member.role === 'owner') lines.push(<Trans key="o">Owns {name}</Trans>);
  else if (member.isYou && member.role === 'admin')
    lines.push(<Trans key="a">Only the owner changes admins</Trans>);
  if (member.managed)
    lines.push(
      by ? (
        <Trans key="m">Managed account · by {by}</Trans>
      ) : (
        <Trans key="m">Managed account</Trans>
      ),
    );
  if (location.require2fa && !member.twoFactorEnabled)
    lines.push(<Trans key="2">No two-factor yet, so {name} is hidden for them</Trans>);
  if (lines.length === 0 && member.lastActiveAt) {
    const when = f.relative(member.lastActiveAt);
    lines.push(<Trans key="l">Active {when}</Trans>);
  }
  return (
    <div className="grid gap-1">
      <div className="text-small text-ink-2">
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list
          <span key={i}>
            {i > 0 ? sep() : null}
            {l}
          </span>
        ))}
      </div>
      {until ? (
        <Pill tone="warn" icon={<ClockIcon />}>
          <Trans>Until {until}</Trans>
        </Pill>
      ) : null}
    </div>
  );
}

function MemberRow({
  member,
  location,
  onEdit,
}: {
  member: Member;
  location: LocationDetail;
  onEdit: (() => void) | undefined;
}) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const who = member.displayName;
  const place = location.name;
  const remove = useMutation({
    mutationFn: () => removeMember(location.id, member.membershipId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.members(location.id) });
      toast({ title: t`${who} removed from ${place}`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const askRemove = async () => {
    const ok = await confirm({
      title: t`Remove ${who} from ${place}?`,
      body: t`${who} loses access straight away. What ${who} added stays. Their webhooks, share links and exports for ${place} stop working.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (ok) remove.mutate();
  };

  const nameLine = (
    <span className="font-semibold text-[15px] [overflow-wrap:anywhere]">
      {member.isYou ? <Trans>{who} (you)</Trans> : who}
    </span>
  );
  const body = (
    <>
      <Avatar name={member.displayName} you={member.isYou} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        {nameLine}
        <MemberSubtitle member={member} location={location} />
      </div>
    </>
  );
  return (
    <>
      {/* Phone: the row opens its sheet. */}
      <div className="md:hidden">
        {onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            aria-label={t`Manage ${who}`}
            className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-3 text-start outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
          >
            {body}
            <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3.5 py-3">{body}</div>
        )}
      </div>
      {/* Desktop: the actions inline. */}
      <div className="hidden items-center gap-3 px-3.5 py-2.5 md:flex">
        <div className="flex min-w-0 flex-[2] items-center gap-3">{body}</div>
        <div className="w-24 text-small text-ink-2">{roles.one[member.role]}</div>
        <div className="flex w-44 justify-end gap-2">
          {onEdit ? (
            <>
              <Button size="small" variant="secondary" onPress={onEdit}>
                <Trans>Change</Trans>
              </Button>
              <Button
                size="small"
                variant="ghost"
                className="text-danger"
                isPending={remove.isPending}
                onPress={askRemove}
              >
                <Trans>Remove</Trans>
              </Button>
            </>
          ) : member.role === 'owner' ? (
            <span className="text-end text-small text-ink-3">
              <Trans>Transfer is in Location settings</Trans>
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}

function EditMember({
  member,
  location,
  onClose,
}: {
  member: Member;
  location: LocationDetail;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  const f = useFormat();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const me = useMe();
  const [code, setCode] = useState<ManagedResetCode | null>(null);
  const [role, setRole] = useState<Role>(member.role);
  const [limited, setLimited] = useState(!!member.expiresAt);
  const [until, setUntil] = useState<string | null>(
    member.expiresAt ? dayOf(member.expiresAt, location.timezone) : null,
  );
  const who = member.displayName;
  const place = location.name;
  const cap = location.membershipExpiresAt
    ? dayOf(location.membershipExpiresAt, location.timezone)
    : null;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const capText = cap ? f.day(cap) : null;

  const save = useMutation({
    mutationFn: () =>
      updateMember(
        location.id,
        member.membershipId,
        { role, expiresAt: limited && until ? endOfDay(until, location.timezone) : null },
        member.rowVersion,
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.members(location.id) });
      toast({ title: t`Saved`, tone: 'ok' });
      onClose();
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => removeMember(location.id, member.membershipId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.members(location.id) });
      toast({ title: t`${who} removed from ${place}`, tone: 'ok' });
      onClose();
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const missingDate = limited && !until;
  const issue = useMutation({
    mutationFn: () => newManagedResetCode(member.userId),
    onSuccess: setCode,
  });
  const refused =
    issue.error &&
    isApiError(issue.error) &&
    (issue.error.code === 'not_found' || issue.error.code === 'forbidden');
  const askCode = async () => {
    const ok = await confirm({
      title: t`Give ${who} a new one-time code?`,
      body: t`${who} is signed out on every device and sets a new password with the code. Any earlier code stops working.`,
      confirmLabel: t`New code`,
    });
    if (ok) issue.mutate();
  };

  if (code) {
    const validUntil = f.dateTime(code.expiresAt);
    return (
      <Modal isOpen onOpenChange={(open) => (open ? null : onClose())}>
        <Dialog title={t`Give ${who} this code`}>
          <div className="grid gap-4">
            <p className="m-0 text-ink-2">
              <Trans>
                {who} signs in with their username and this code, then chooses a new password. It is
                shown only now. Works once, until {validUntil}.
              </Trans>
            </p>
            <div className="grid gap-2 rounded-[10px] border border-line bg-sunken p-3">
              <div className="text-small text-ink-3">
                <Trans>Username</Trans>
              </div>
              <div className="ltr font-mono text-[16px]">{member.username}</div>
              <div className="text-small text-ink-3">
                <Trans>One-time code</Trans>
              </div>
              <div className="ltr font-mono text-[22px] font-semibold tracking-[.15em]">
                {code.code}
              </div>
            </div>
            <DialogFooter>
              <CopyButton text={code.code} label={t`Copy code`} />
              <Button onPress={onClose}>
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      </Modal>
    );
  }

  return (
    <Modal isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <Dialog title={who}>
        <div className="grid gap-4">
          {mayIssueCode(location, member, me.data?.user.displayName) ? (
            <div className="grid gap-2 rounded-[10px] border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-small text-ink-2">
                  <Trans>Forgot their password? A new code lets them set another.</Trans>
                </span>
                <Button
                  size="small"
                  variant="secondary"
                  isPending={issue.isPending}
                  onPress={() => void askCode()}
                >
                  <KeyIcon />
                  <Trans>New one-time code</Trans>
                </Button>
              </div>
              {issue.error ? (
                <Notice tone="danger">
                  {refused ? (
                    <Trans>
                      Only the owner of {who}’s home location, or whoever created the account while
                      still an admin there, can give {who} a new code.
                    </Trans>
                  ) : (
                    errorText(issue.error)
                  )}
                </Notice>
              ) : null}
            </div>
          ) : null}
          <Segmented<Role>
            label={t`Role`}
            value={role}
            onChange={setRole}
            description={roles.what[role]}
            options={grantableRoles(location.role).map((r) => ({ id: r, label: roles.one[r] }))}
          />
          <Segmented<'none' | 'date'>
            label={t`Access`}
            value={limited ? 'date' : 'none'}
            onChange={(v) => setLimited(v === 'date')}
            options={[
              { id: 'none', label: t`No end date` },
              { id: 'date', label: t`Until a date` },
            ]}
          />
          {limited ? (
            <DatePicker
              label={t`Last day`}
              value={until}
              onChange={setUntil}
              minValue={tomorrow}
              maxValue={cap}
              errorMessage={missingDate ? t`Choose the last day.` : undefined}
              description={
                capText ? (
                  <Trans>
                    Their access, and any tokens they make, stop on this date. It can't be later
                    than your own, {capText}.
                  </Trans>
                ) : (
                  <Trans>Their access, and any tokens they make, stop on this date.</Trans>
                )
              }
            />
          ) : null}
          <DialogFooter className="justify-between">
            <Button
              variant="ghost"
              className="text-danger"
              isPending={remove.isPending}
              onPress={async () => {
                const ok = await confirm({
                  title: t`Remove ${who} from ${place}?`,
                  body: t`${who} loses access straight away. What ${who} added stays. Their webhooks, share links and exports for ${place} stop working.`,
                  confirmLabel: t`Remove`,
                  destructive: true,
                });
                if (ok) remove.mutate();
              }}
            >
              <Trans>Remove</Trans>
            </Button>
            <Button
              isDisabled={missingDate}
              isPending={save.isPending}
              onPress={() => save.mutate()}
            >
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </div>
      </Dialog>
    </Modal>
  );
}

function InviteRow({ invite, locationId }: { invite: PendingInvite; locationId: string }) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  const f = useFormat();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const role = roles.one[invite.role];
  const by = invite.createdByName ?? '';
  const expires = f.day(invite.expiresAt);
  const revoke = useMutation({
    mutationFn: () => revokeInvite(locationId, invite.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.members(locationId) });
      toast({ title: t`Invite revoked`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <IconTile>
        <LinkIcon />
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="font-semibold text-[15px]">
          <Trans>{role} invite</Trans>
        </div>
        <div className="text-small text-ink-2">
          {by ? (
            <Trans>
              By {by} · link expires {expires}
            </Trans>
          ) : (
            <Trans>Link expires {expires}</Trans>
          )}
        </div>
      </div>
      <Button
        size="small"
        variant="secondary"
        isPending={revoke.isPending}
        onPress={async () => {
          const ok = await confirm({
            title: t`Revoke this invite?`,
            body: t`The link stops working. Anyone who hasn't opened it yet will need a new one.`,
            confirmLabel: t`Revoke`,
            destructive: true,
          });
          if (ok) revoke.mutate();
        }}
      >
        <Trans>Revoke</Trans>
      </Button>
    </div>
  );
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function AddManaged({ location, onClose }: { location: LocationDetail; onClose: () => void }) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [tried, setTried] = useState(false);
  const [result, setResult] = useState<CreateManagedResult | null>(null);
  const nameError = tried && !displayName.trim() ? t`Enter their name.` : undefined;
  const userError =
    tried && !USERNAME.test(username)
      ? t`3 to 32 characters: lowercase letters, digits, dot, dash or underscore.`
      : undefined;
  const create = useMutation({
    mutationFn: () =>
      createManagedAccount(location.id, {
        displayName: displayName.trim(),
        username: username.trim(),
        role,
      }),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: keys.members(location.id) });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const person = displayName.trim();
  return (
    <Modal isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <Dialog title={result ? t`Give ${person} this code` : t`Add someone without email`}>
        {result ? (
          <div className="grid gap-4">
            <p className="m-0 text-ink-2">
              <Trans>
                {person} signs in with the username below and this one-time code, then chooses their
                own password. You never see it. The code works once, for 30 minutes.
              </Trans>
            </p>
            <div className="grid gap-2 rounded-[10px] border border-line bg-sunken p-3">
              <div className="text-small text-ink-3">
                <Trans>Username</Trans>
              </div>
              <div className="ltr font-mono text-[16px]">{result.username}</div>
              <div className="text-small text-ink-3">
                <Trans>One-time code</Trans>
              </div>
              <div className="ltr font-mono text-[22px] font-semibold tracking-[.15em]">
                {result.code}
              </div>
            </div>
            <DialogFooter>
              {result.code ? <CopyButton text={result.code} label={t`Copy code`} /> : null}
              <Button onPress={onClose}>
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (!displayName.trim() || !USERNAME.test(username)) return;
              create.mutate();
            }}
          >
            <p className="m-0 text-ink-2">
              <Trans>
                For a child or a parent with no email: they sign in with a username. You can reset
                their password later; they can add an email to take it over.
              </Trans>
            </p>
            <TextField
              label={t`Name`}
              value={displayName}
              onChange={setDisplayName}
              isInvalid={!!nameError}
              errorMessage={nameError}
              autoFocus
            />
            <TextField
              label={t`Username`}
              value={username}
              onChange={(v) => setUsername(v.toLowerCase())}
              isInvalid={!!userError}
              errorMessage={userError}
              inputProps={{ dir: 'ltr', autoCapitalize: 'none', spellCheck: false }}
            />
            <Segmented<Role>
              label={t`Role`}
              value={role}
              onChange={setRole}
              description={roles.what[role]}
              options={grantableRoles(location.role)
                .filter((r) => r !== 'admin')
                .map((r) => ({ id: r, label: roles.one[r] }))}
            />
            <Notice tone="info">
              <Trans>The owner is told about every new managed account.</Trans>
            </Notice>
            <DialogFooter>
              <Button variant="secondary" onPress={onClose}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" isPending={create.isPending}>
                <Trans>Create account</Trans>
              </Button>
            </DialogFooter>
          </form>
        )}
      </Dialog>
    </Modal>
  );
}
