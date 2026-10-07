/**
 * "Install on your phone" help (D139, screens §8, frame 01 · Install Kept): the steps for this
 * device's browser, iPhone first on an iPhone. iPhone and iPad have no install prompt, so they
 * get Share → Add to Home Screen; Android and desktop browsers have their own. The checklist
 * step ticks itself the first time Kept opens as the installed app (checklist.tsx).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type Key, type ReactNode, useState } from 'react';
import { BellIcon, ShareIcon } from '@/components/icons';
import { Notice } from '@/components/page';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { useFormat } from '@/lib/format';
import { servedOverHttp } from '@/lib/https';
import { promptInstall, useCanPromptInstall } from '@/pwa/install';

type Platform = 'ios' | 'android' | 'computer';

function detectPlatform(): Platform {
  try {
    const ua = navigator.userAgent;
    // iPadOS reports a Mac; its touch points give it away.
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
      return 'ios';
    if (/Android/.test(ua)) return 'android';
  } catch {
    // No navigator: the computer's steps.
  }
  return 'computer';
}

/** A numbered step; the number follows the digit setting (D143), so no CSS counters. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  const f = useFormat();
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-[3px] bg-amber font-semibold text-[13px] text-amber-ink"
      >
        {f.num(n)}
      </span>
      <span className="min-w-0 pt-0.5 text-ink">{children}</span>
    </li>
  );
}

const steps = 'm-0 grid list-none gap-3 p-0';

export function InstallSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useLingui();
  const [platform, setPlatform] = useState<Platform>(detectPlatform);
  // Android and desktop Chrome: the browser's own prompt, caught at boot (pwa/install.ts).
  const canPrompt = useCanPromptInstall();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t`Install Kept on your phone`}
    >
      {({ close }) => (
        <div className="grid gap-4">
          {servedOverHttp() ? (
            <Notice tone="warn" title={<Trans>Needs HTTPS first</Trans>}>
              <Trans>Over plain HTTP, phones won't install Kept. Put Kept on HTTPS first.</Trans>
            </Notice>
          ) : null}
          {canPrompt ? (
            <Button
              variant="primary"
              className="w-full"
              onPress={() => void promptInstall().then((accepted) => accepted && close())}
            >
              <Trans>Install Kept</Trans>
            </Button>
          ) : null}
          <Tabs selectedKey={platform} onSelectionChange={(k: Key) => setPlatform(k as Platform)}>
            <TabList aria-label={t`Device`}>
              <Tab id="ios">
                <Trans>iPhone, iPad</Trans>
              </Tab>
              <Tab id="android">
                <Trans>Android</Trans>
              </Tab>
              <Tab id="computer">
                <Trans>Computer</Trans>
              </Tab>
            </TabList>
            <TabPanel id="ios">
              <ol className={steps}>
                <Step n={1}>
                  <Trans>
                    Tap <strong>Share</strong>{' '}
                    <ShareIcon aria-hidden="true" className="inline size-4 align-[-3px]" /> in
                    Safari's toolbar.
                  </Trans>
                </Step>
                <Step n={2}>
                  <Trans>
                    Scroll the list and tap <strong>Add to Home Screen</strong>.
                  </Trans>
                </Step>
                <Step n={3}>
                  <Trans>
                    Tap <strong>Add</strong>, then open Kept from its new icon.
                  </Trans>
                </Step>
              </ol>
              <p className="m-0 mt-3 text-small text-ink-2">
                <Trans>
                  iPhone doesn't let web apps appear in the Share sheet. To add a receipt from
                  another app, save it, then use Gallery in Capture.
                </Trans>
              </p>
            </TabPanel>
            <TabPanel id="android">
              <ol className={steps}>
                <Step n={1}>
                  <Trans>Open the browser's menu (the three dots).</Trans>
                </Step>
                <Step n={2}>
                  <Trans>
                    Tap <strong>Install app</strong>, or <strong>Add to Home screen</strong>.
                  </Trans>
                </Step>
                <Step n={3}>
                  <Trans>Open Kept from its new icon.</Trans>
                </Step>
              </ol>
            </TabPanel>
            <TabPanel id="computer">
              <ol className={steps}>
                <Step n={1}>
                  <Trans>
                    In Chrome or Edge, click the install icon at the end of the address bar, or open
                    the menu and choose <strong>Install Kept</strong>.
                  </Trans>
                </Step>
                <Step n={2}>
                  <Trans>
                    In Safari on a Mac, choose <strong>File › Add to Dock</strong>.
                  </Trans>
                </Step>
              </ol>
            </TabPanel>
          </Tabs>
          {platform === 'ios' ? (
            <div className="flex items-start gap-3 rounded-[10px] bg-sunken p-3.5">
              <BellIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ink-2" />
              <div className="grid gap-0.5">
                <div className="font-semibold text-[15px]">
                  <Trans>Reminders need the installed app</Trans>
                </div>
                <div className="text-small text-ink-2">
                  <Trans>
                    On iPhone, notifications only reach Kept once it's on your Home Screen. Until
                    then, reminders can come by email.
                  </Trans>
                </div>
              </div>
            </div>
          ) : null}
          <p className="m-0 text-small text-ink-2">
            <Trans>This step ticks itself the first time you open Kept from its icon.</Trans>
          </p>
          <Button variant="primary" className="w-full" onPress={close}>
            <Trans>Got it</Trans>
          </Button>
        </div>
      )}
    </Sheet>
  );
}
