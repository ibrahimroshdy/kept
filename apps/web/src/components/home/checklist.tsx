/**
 * The Get-started checklist (D138, screens §5 Home and §8, frame 01 · Home): computed by the
 * server from real state (`GET /home`, task 22), shown by Home outside the first-run state.
 *
 * - Over plain HTTP an instance admin's first step is "Put Kept on HTTPS" (D193). The server
 *   can't see the scheme behind a proxy, so this client adds it.
 * - Finished steps fold into one "Done" row, as in the frame; open steps follow in the server's
 *   order, each with its action where step 2 has one (printing labels and AI arrive later).
 * - The server leaves out "invite" and "connect AI" for invited members, and "connect AI" on
 *   Essentials (D191). A member who joined someone's home has one, so "your first home" counts
 *   as done ("Joined Home") rather than asking her to make another.
 * - Dismissing, and bringing it back, are the `checklist` hint, so every phone agrees (D138).
 *   Step 1 kept "hidden" in this browser's storage; that flag moves to the server once.
 * - "Install on your phone" ticks itself: opened in standalone display mode, Kept posts the
 *   `installed_standalone` hint (§8).
 * - It disappears when every step is done.
 */
import { can } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { getAdminStatus } from '@/api/admin';
import { api } from '@/api/client';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { inventoryKeys } from '@/api/inventory/queries';
import type { ChecklistKey, HomeResponse, UpdateHintBody } from '@/api/inventory/types';
import { keys } from '@/api/queries';
import type { LocationSummary, Me } from '@/api/types';
import { CheckIcon, XIcon } from '@/components/icons';
import { LinkButton, Notice } from '@/components/page';
import { CreateThingSheet } from '@/components/things/create-sheet';
import { Button } from '@/components/ui/button';
import { Dialog, Modal } from '@/components/ui/dialog';
import { sep, useFormat } from '@/lib/format';
import { servedOverHttp } from '@/lib/https';
import { useLocationName } from '@/lib/labels';
import { isStandalone } from '@/lib/media';
import { cn } from '@/lib/utils';
import { InstallSheet } from './install-sheet';

// ----- hints -----------------------------------------------------------------------------------

const updateHint = (key: string, body: UpdateHintBody) => api.put<void>(p.hint(key), body);

/** Step 1's per-browser "hidden" flag (task 28 of step 1), migrated to the `checklist` hint. */
const LEGACY_HIDDEN_KEY = 'kept.getStarted.hidden';

function takeLegacyHidden(): boolean {
  try {
    const hidden = localStorage.getItem(LEGACY_HIDDEN_KEY) === '1';
    localStorage.removeItem(LEGACY_HIDDEN_KEY);
    return hidden;
  } catch {
    return false;
  }
}

/** Dismiss or bring back the checklist, on the server; Home follows at once. */
export function useChecklistDismissed() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (dismissed: boolean) => updateHint('checklist', { dismissed }),
    onMutate: (dismissed) => {
      qc.setQueryData<HomeResponse>(inventoryKeys.home, (old) =>
        old ? { ...old, checklist: { ...old.checklist, dismissed } } : old,
      );
    },
    onError: () => void qc.invalidateQueries({ queryKey: inventoryKeys.home }),
  });
  return m.mutate;
}

/**
 * What Home does once `/home` has answered: move step 1's local flag to the server, and tick
 * "Install on your phone" when Kept runs as the installed app.
 */
export function useChecklistSync(home: HomeResponse | undefined) {
  const qc = useQueryClient();
  const setDismissed = useChecklistDismissed();
  const done = useRef(false);
  useEffect(() => {
    if (!home || done.current) return;
    done.current = true;
    if (takeLegacyHidden() && !home.checklist.dismissed) setDismissed(true);
    const install = home.checklist.items.find((i) => i.key === 'installed');
    if (install && !install.done && isStandalone())
      void updateHint('installed_standalone', { seen: true }).then(
        () => qc.invalidateQueries({ queryKey: inventoryKeys.home }),
        () => undefined,
      );
  }, [home, qc, setDismissed]);
}

// ----- the checklist ---------------------------------------------------------------------------

type Step = {
  key: ChecklistKey | 'https' | 'mail';
  done: boolean;
  title: string;
  /** How a finished step reads inside the Done row. */
  doneLabel: string;
  body: string;
  action?: ReactNode;
};

const manages = (l: LocationSummary) => l.role === 'owner' || l.role === 'admin';

/**
 * How many steps are still open for this person: the server's, less "your first home" once
 * she belongs to a shared one, plus HTTPS for an admin over http. Zero ⇒ no checklist at all.
 */
export function openStepCount(home: HomeResponse, me: Me, locations: LocationSummary[]): number {
  const hasShared = locations.some((l) => l.kind !== 'personal');
  const server = home.checklist.items.filter(
    (i) => !i.done && !(i.key === 'locationCreated' && hasShared),
  ).length;
  return server + (me.user.instanceAdmin && servedOverHttp() ? 1 : 0);
}

export function GetStarted({
  home,
  me,
  locations,
  onHide,
  className,
}: {
  home: HomeResponse;
  me: Me;
  locations: LocationSummary[];
  onHide: () => void;
  className?: string;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const nameOf = useLocationName();
  const [sheet, setSheet] = useState<'add' | 'install' | null>(null);
  const qc = useQueryClient();

  const shared = locations.filter((l) => l.kind !== 'personal');
  const owned = shared.find((l) => l.role === 'owner');
  const invitable = shared.find(manages);
  // Where "Add" puts a thing: a shared location you can add to, else your Personal one (D114).
  const addTo =
    shared.find((l) => can(l.role, 'things.edit'))?.id ??
    locations.find((l) => l.kind === 'personal')?.id;

  // "Print" opens Labels where it's on and the person may print (the list sends every field).
  const labelsOn = locations.some((l) => {
    const d = l as LocationSummary & { modules?: string[]; effectiveModules?: string[] };
    return (d.effectiveModules ?? d.modules ?? []).includes('labels') && can(l.role, 'labels.use');
  });

  // Mail is the instance admin's to set up, like HTTPS: asked only of them, only while it's off.
  const adminStatus = useQuery({
    queryKey: keys.admin.status,
    queryFn: getAdminStatus,
    enabled: me.user.instanceAdmin,
  });

  const steps: Step[] = [];
  if (me.user.instanceAdmin && servedOverHttp()) {
    steps.push({
      key: 'https',
      done: false,
      title: t`Put Kept on HTTPS`,
      doneLabel: '',
      body: t`Over plain HTTP, phones block the camera, installing Kept, push notifications and location.`,
      action: <HttpsHowButton />,
    });
  }
  if (me.user.instanceAdmin && adminStatus.data && !adminStatus.data.mail.configured) {
    steps.push({
      key: 'mail',
      done: false,
      title: t`Set up email`,
      doneLabel: '',
      body: t`Without it, Kept sends no sign-in links, password resets, email invites or reminders.`,
      action: <MailHowButton />,
    });
  }
  for (const item of home.checklist.items) {
    const step = stepFor(item.key, item.done);
    if (step) steps.push(step);
  }

  function stepFor(key: ChecklistKey, serverDone: boolean): Step | null {
    switch (key) {
      case 'locationCreated': {
        const joined = !serverDone && shared.length > 0;
        const created = owned ? nameOf(owned) : undefined;
        const joinedName = shared[0] ? nameOf(shared[0]) : '';
        return {
          key,
          done: serverDone || joined,
          title: t`Create your first home`,
          doneLabel: joined
            ? t`Joined ${joinedName}`
            : created
              ? t`Created ${created}`
              : t`Created a home`,
          body: t`Rooms and spots come from its template; change them any time.`,
          action: (
            <LinkButton to="/locations/new" size="small">
              <Trans>Create</Trans>
            </LinkButton>
          ),
        };
      }
      case 'threeThings':
        return {
          key,
          done: serverDone,
          title: t`Add 3 things`,
          doneLabel: t`Added 3 things`,
          body: t`A few you'd hate to lose track of: a charger, the drill, the passports.`,
          action: addTo ? (
            <Button size="small" variant="secondary" onPress={() => setSheet('add')}>
              <Trans>Add</Trans>
            </Button>
          ) : undefined,
        };
      case 'labelPrinted':
        return {
          key,
          done: serverDone,
          title: t`Print your first label`,
          doneLabel: t`Printed a label`,
          body: t`Stick it on a box, then scan it to see what's inside.`,
          action: labelsOn ? (
            <LinkButton to="/labels" size="small">
              <Trans>Print</Trans>
            </LinkButton>
          ) : undefined,
        };
      case 'invited':
        return {
          key,
          done: serverDone,
          title: t`Invite someone`,
          doneLabel: t`Invited someone`,
          body: t`A link or a QR code; nobody needs email.`,
          action: invitable ? (
            <LinkButton
              to="/settings/location/$id/invite"
              params={{ id: invitable.id }}
              size="small"
            >
              <Trans>Invite</Trans>
            </LinkButton>
          ) : undefined,
        };
      case 'aiConnected':
        return {
          key,
          done: serverDone,
          title: t`Connect an AI provider`,
          doneLabel: t`Connected AI`,
          body: t`Reads receipts and suggests details for you to confirm.`,
        };
      case 'installed':
        return {
          key,
          done: serverDone,
          title: t`Install on your phone`,
          doneLabel: t`Installed on your phone`,
          body: t`On iPhone, reminders only reach the installed app.`,
          action: (
            <Button size="small" variant="secondary" onPress={() => setSheet('install')}>
              <Trans>How</Trans>
            </Button>
          ),
        };
      default:
        return null;
    }
  }

  const finished = steps.filter((s) => s.done);
  const open = steps.filter((s) => !s.done);
  if (openStepCount(home, me, locations) === 0) return null;
  const https = open.filter((s) => s.key === 'https');
  const rest = open.filter((s) => s.key !== 'https');
  // `done` and `total` keep step 1's message, so its Arabic stays.
  const done = f.num(finished.length);
  const total = f.num(steps.length);

  return (
    <section
      aria-labelledby="get-started"
      className={cn(
        'grid content-start gap-3 rounded-[10px] border border-line bg-surface p-3.5',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-0.5">
          <h2 id="get-started" className="m-0 font-semibold text-[16px]">
            <Trans>Get started</Trans>
          </h2>
          <p className="m-0 text-small text-ink-2">
            <Plural
              value={open.length}
              one="One more step and Kept is set up."
              other="# more steps and Kept is set up."
            />
          </p>
        </div>
        <span className="rounded-[3px] bg-amber px-1.5 py-1 font-semibold text-[12px] leading-none text-amber-ink">
          <Trans>
            {done} of {total}
          </Trans>
        </span>
        <Button variant="ghost" size="icon" aria-label={t`Hide Get started`} onPress={onHide}>
          <XIcon />
        </Button>
      </div>
      <div aria-hidden="true" className="flex gap-1">
        {[...finished, ...open].map((s) => (
          <span
            key={s.key}
            className={cn('h-1 flex-1 rounded-full', s.done ? 'bg-ok' : 'bg-sunken')}
          />
        ))}
      </div>
      <ul className="m-0 grid list-none gap-0 p-0 [&>li+li]:border-t [&>li+li]:border-line">
        {https.map((s) => (
          <StepRow key={s.key} title={s.title} body={s.body} action={s.action} />
        ))}
        {finished.length > 0 ? (
          <StepRow done title={t`Done`} body={finished.map((s) => s.doneLabel).join(sep())} />
        ) : null}
        {rest.map((s) => (
          <StepRow key={s.key} title={s.title} body={s.body} action={s.action} />
        ))}
      </ul>
      {sheet === 'add' && addTo ? (
        <CreateThingSheet
          isOpen
          locationId={addTo}
          openAfter={false}
          onClose={() => {
            setSheet(null);
            void qc.invalidateQueries({ queryKey: inventoryKeys.home });
          }}
        />
      ) : null}
      <InstallSheet isOpen={sheet === 'install'} onClose={() => setSheet(null)} />
    </section>
  );
}

function StepRow({
  title,
  body,
  action,
  done = false,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  done?: boolean;
}) {
  const { t } = useLingui();
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md border-2 [&_svg]:size-4',
          done ? 'border-ok bg-ok text-surface' : 'border-line',
        )}
      >
        {done ? <CheckIcon /> : null}
        <span className="sr-only">{done ? t`Done` : t`Not done yet`}</span>
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div data-title className={cn('font-semibold text-[15px]', done && 'text-ink-2')}>
          {title}
        </div>
        <div className="text-small text-ink-2 [overflow-wrap:anywhere]">{body}</div>
      </div>
      {action}
    </li>
  );
}

/** Once dismissed and still unfinished: bring it back (Help does this from a later step, §8). */
export function ShowGetStarted({ onShow }: { onShow: () => void }) {
  return (
    <Button variant="ghost" size="small" className="justify-self-start" onPress={onShow}>
      <Trans>Show Get started</Trans>
    </Button>
  );
}

// ----- HTTPS (D193) ----------------------------------------------------------------------------

export function HttpsNotice() {
  return (
    <Notice tone="warn" title={<Trans>Put Kept on HTTPS</Trans>} action={<HttpsHowButton />}>
      <Trans>
        Over plain HTTP, phones block the camera, installing Kept, push notifications and location.
      </Trans>
    </Notice>
  );
}

/** How to turn mail on: two settings and a restart, wherever Kept's other settings live. */
export function MailHowButton() {
  const [open, setOpen] = useState(false);
  const { t } = useLingui();
  return (
    <>
      <Button size="small" variant="secondary" onPress={() => setOpen(true)}>
        <Trans>How</Trans>
      </Button>
      <Modal isOpen={open} onOpenChange={setOpen}>
        <Dialog title={t`Set up email`}>
          <div className="grid gap-3 text-ink-2">
            <p className="m-0">
              <Trans>
                Set these where Kept's other settings live (the .env file with Docker Compose,
                Kept's secret on Kubernetes), then restart Kept:
              </Trans>
            </p>
            <ul className="m-0 grid gap-2 ps-5">
              <li>
                <code className="ltr whitespace-nowrap">KEPT_SMTP_URL</code>{' '}
                <Trans>
                  your mail server, for example{' '}
                  <code className="ltr break-all">smtps://user:password@smtp.example.org:465</code>
                </Trans>
              </li>
              <li>
                <code className="ltr whitespace-nowrap">KEPT_SMTP_FROM</code>{' '}
                <Trans>
                  the sender, for example{' '}
                  <code className="ltr break-all">Kept &lt;kept@example.org&gt;</code>
                </Trans>
              </li>
            </ul>
            <p className="m-0">
              <Trans>
                Any provider that offers SMTP works, such as your email provider's app password or a
                sending service. Admin → Status shows Sending once it's on.
              </Trans>
            </p>
          </div>
        </Dialog>
      </Modal>
    </>
  );
}

export function HttpsHowButton() {
  const [open, setOpen] = useState(false);
  const { t } = useLingui();
  return (
    <>
      <Button size="small" variant="secondary" onPress={() => setOpen(true)}>
        <Trans>How</Trans>
      </Button>
      <Modal isOpen={open} onOpenChange={setOpen}>
        <Dialog title={t`Put Kept on HTTPS`}>
          <div className="grid gap-3 text-ink-2">
            <p className="m-0">
              <Trans>
                Browsers only allow the camera, installing the app, push notifications and location
                on a secure address. Two ways to get one:
              </Trans>
            </p>
            <ol className="m-0 grid gap-2 ps-5">
              <li>
                <Trans>
                  Start Kept's Compose file with the{' '}
                  <code className="ltr whitespace-nowrap">https</code> profile. It adds a reverse
                  proxy that gets a certificate for your domain.
                </Trans>
              </li>
              <li>
                <Trans>
                  Or reach Kept through Tailscale and turn on HTTPS for your tailnet; the address
                  ends in <code className="ltr whitespace-nowrap">.ts.net</code>.
                </Trans>
              </li>
            </ol>
            <p className="m-0">
              <Trans>Then set KEPT_PUBLIC_URL to the https address and restart Kept.</Trans>
            </p>
          </div>
        </Dialog>
      </Modal>
    </>
  );
}
