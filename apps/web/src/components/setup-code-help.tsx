/**
 * "Where to find it" on /setup's code step: one tab per way Kept runs, each with a command that
 * greps the server's logs for the line it prints (`KEPT SETUP CODE: XXX-XXX`, server
 * setup/setup-code.ts), and a last tab that issues a new code with `kept admin setup-code`.
 *
 * The code is made and printed once, by the first boot that stores its hash; later boots print
 * nothing. So a recreated container or a replaced pod has lost it, and the way back is a new code.
 * The Kubernetes command is the one the chart's NOTES.txt prints (its Deployment is named after
 * the release, and the pod's one app container is the default, so no `-c`).
 *
 * React Aria Tabs (arrow keys follow the reading direction), compact: small pills in one row
 * that scrolls sideways if it must, each 28 px tall with a 48 px hit area. The choice is
 * remembered on this device. This page works signed out, so it stays in the PWA precache.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Fragment, type ReactNode, useState } from 'react';
import { CopyButton } from '@/components/ui/copy-button';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export const SETUP_HELP_WAYS = ['compose', 'docker', 'kubernetes', 'cli'] as const;
export type SetupHelpWay = (typeof SETUP_HELP_WAYS)[number];

const KEY = 'kept.setup.codeHelp';
/** Compose is the documented install (docs: install/compose). */
const DEFAULT_WAY: SetupHelpWay = 'compose';

export function storedWay(): SetupHelpWay {
  try {
    const v = localStorage.getItem(KEY);
    return (SETUP_HELP_WAYS as readonly string[]).includes(v ?? '')
      ? (v as SetupHelpWay)
      : DEFAULT_WAY;
  } catch {
    return DEFAULT_WAY;
  }
}

function rememberWay(way: SetupHelpWay): void {
  try {
    localStorage.setItem(KEY, way);
  } catch {
    // No storage: Compose next time.
  }
}

/** The docs site (apps/docs, published at https://ibrahimroshdy.com/kept/). */
const DOCS = 'https://ibrahimroshdy.com/kept';

function docsUrl(page: 'install/compose' | 'install/kubernetes' | 'admin/cli', locale: string) {
  // Only the Compose page has an Arabic translation so far (apps/docs/src/content/docs/ar).
  const ar = locale === 'ar' && page === 'install/compose' ? '/ar' : '';
  return `${DOCS}${ar}/${page}/`;
}

/** A command; `<…>` parts are placeholders for the person's own names. */
const GREP = '| grep "KEPT SETUP CODE"';
const COMMANDS = {
  compose: `docker compose logs kept ${GREP}`,
  docker: `docker logs <container> 2>&1 ${GREP}`,
  kubernetes: `kubectl -n <namespace> logs deploy/<deployment> ${GREP}`,
  cliCompose: 'docker compose run --rm migrate admin setup-code',
  cliKubernetes: 'kubectl -n <namespace> exec deploy/<deployment> -- kept admin setup-code',
} as const;

const PLACEHOLDER = /(<[a-z-]+>)/;

/**
 * A 28 px control with a 48 px hit area: a transparent ::before overhangs it by 10 px. The 16 px
 * gap under the tabs plus the command block's 4 px padding keeps the tabs' and the copy button's
 * hit areas from overlapping.
 */
const HIT = "relative before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']";

function Command({ text, caption }: { text: string; caption?: ReactNode }) {
  const { t } = useLingui();
  const parts = text.split(PLACEHOLDER);
  return (
    <div className="grid gap-1">
      {caption ? <div className="text-[11.5px] text-ink-3 leading-4">{caption}</div> : null}
      <div className="flex items-start gap-1 rounded-md bg-sunken py-1 ps-2.5 pe-1">
        <code
          dir="ltr"
          className="min-w-0 flex-1 select-all whitespace-pre-wrap py-0.5 text-start font-mono text-[12px] text-ink leading-5 [overflow-wrap:anywhere]"
        >
          {parts.map((p, i) =>
            PLACEHOLDER.test(p) ? (
              <var
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of a constant
                key={i}
                data-placeholder=""
                className="font-semibold text-amber-text not-italic underline decoration-dotted underline-offset-2"
              >
                {p}
              </var>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of a constant
              <Fragment key={i}>{p}</Fragment>
            ),
          )}
        </code>
        <CopyButton
          text={text}
          label={t`Copy`}
          iconOnly
          variant="ghost"
          size="icon"
          className={cn(HIT, 'size-7 shrink-0 rounded-md before:-inset-2.5 [&_svg]:size-4')}
        />
      </div>
    </div>
  );
}

/** One small muted paragraph; its sentences are separate messages, joined by a space. */
function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[12px] text-ink-3 leading-[17px]">{children}</p>;
}

function GuideLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-ink-2 underline underline-offset-2"
    >
      {children}
    </a>
  );
}

export function SetupCodeHelp() {
  const { t, i18n } = useLingui();
  const [way, setWay] = useState<SetupHelpWay>(storedWay);
  const locale = i18n.locale;
  const replace = <Trans>Replace the highlighted parts with your own names.</Trans>;
  const printedOnce = (
    <Trans>
      The code is printed once, on the first start. If the container has been recreated since, issue
      a new code.
    </Trans>
  );
  const installGuide = (page: 'install/compose' | 'install/kubernetes') => (
    <GuideLink href={docsUrl(page, locale)}>
      <Trans>Install guide</Trans>
    </GuideLink>
  );

  return (
    <section
      aria-labelledby="setup-code-help"
      className="grid min-w-0 gap-2 rounded-[10px] border border-line bg-paper px-3 py-2.5"
    >
      <h2 id="setup-code-help" className="m-0 font-semibold text-[13px] leading-5">
        <Trans>Where to find it</Trans>
      </h2>
      <Tabs
        className="gap-4"
        selectedKey={way}
        onSelectionChange={(k) => {
          const next = String(k) as SetupHelpWay;
          setWay(next);
          rememberWay(next);
        }}
      >
        {/* One row; it scrolls sideways when it doesn't fit. The vertical padding (cancelled by
            the negative margin) leaves room for the tabs' 48 px hit areas inside the scroller; the
            sideways bleed lets a phone's row scroll from the panel's edge. */}
        <TabList
          aria-label={t`How this server runs`}
          className="-mx-3 -my-2.5 gap-0.5 px-3 py-2.5 shadow-none"
        >
          {SETUP_HELP_WAYS.map((id) => (
            <Tab
              key={id}
              id={id}
              className={cn(
                HIT,
                'min-h-7 rounded-full border border-transparent px-2 py-0 font-medium text-[12px] text-ink-3 data-selected:border-line data-selected:bg-surface data-selected:text-ink',
              )}
            >
              {
                {
                  compose: t`Docker Compose`,
                  docker: t`Docker`,
                  kubernetes: t`Kubernetes`,
                  cli: t`New code`,
                }[id]
              }
            </Tab>
          ))}
        </TabList>
        <TabPanel id="compose" className="grid gap-1.5">
          <Command text={COMMANDS.compose} />
          <Note>
            {printedOnce} {installGuide('install/compose')}
          </Note>
        </TabPanel>
        <TabPanel id="docker" className="grid gap-1.5">
          <Command text={COMMANDS.docker} />
          <Note>
            {replace} {printedOnce}{' '}
            <Trans>
              On a NAS or an app store, search its logs page for{' '}
              <code className="ltr whitespace-nowrap">KEPT SETUP CODE</code>.
            </Trans>
          </Note>
        </TabPanel>
        <TabPanel id="kubernetes" className="grid gap-1.5">
          <Command text={COMMANDS.kubernetes} />
          <Note>
            {replace}{' '}
            <Trans>
              helm install printed this command with your names. The code is printed once: after a
              container restart add <code className="ltr whitespace-nowrap">--previous</code>; if
              the pod has been replaced, issue a new code.
            </Trans>{' '}
            {installGuide('install/kubernetes')}
          </Note>
        </TabPanel>
        <TabPanel id="cli" className="grid gap-1.5">
          <Command text={COMMANDS.cliCompose} caption={t`Docker Compose`} />
          <Command text={COMMANDS.cliKubernetes} caption={t`Kubernetes`} />
          <Note>
            <Trans>
              Works only until setup is finished. It replaces the old code and lifts the lockout on
              wrong codes. It needs the database owner's login: Compose's migrate service has it,
              and under Helm the pod that runs backups.
            </Trans>{' '}
            <GuideLink href={docsUrl('admin/cli', locale)}>
              <Trans>CLI guide</Trans>
            </GuideLink>
          </Note>
        </TabPanel>
      </Tabs>
    </section>
  );
}
