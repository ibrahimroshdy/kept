/**
 * Help (plan T31; D138, D139, screens §1 and §8): "Show me around" (the guided tour, replayable,
 * never started on launch), bringing back the Get-started checklist, installing Kept on a phone,
 * sharing into Kept from other apps per platform (iPhone has no share target, V9), logging the
 * odometer from an iPhone Shortcut with a token (step 6 T21, D63), and the diagnostics page.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useRef, useState } from 'react';
import { useHome } from '@/api/inventory/queries';
import { ShortcutRecipeSheet } from '@/components/connections/shortcut-recipe';
import { useShowMeAround } from '@/components/hints/tour';
import { useChecklistDismissed } from '@/components/home/checklist';
import { InstallSheet } from '@/components/home/install-sheet';
import {
  CarIcon,
  CheckCircleIcon,
  GalleryIcon,
  PhoneIcon,
  QuestionIcon,
  ShareIcon,
  WrenchIcon,
} from '@/components/icons';
import { IconTile, LinkButton, List, Page, Row, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/_app/help')({ component: HelpPage });

function HelpPage() {
  const { t } = useLingui();
  const tour = useShowMeAround();
  const startRef = useRef<HTMLButtonElement>(null);
  const [install, setInstall] = useState(false);
  const [recipe, setRecipe] = useState(false);
  return (
    <Page title={t`Help`}>
      <Section title={<Trans>Find your way around</Trans>}>
        <List>
          <li>
            <Row
              leading={
                <IconTile>
                  <QuestionIcon />
                </IconTile>
              }
              title={<Trans>Show me around</Trans>}
              subtitle={
                <Trans>A short look at Home, Capture, Inbox and Search. Replay it any time.</Trans>
              }
              trailing={
                <Button
                  ref={startRef}
                  size="small"
                  variant="primary"
                  onPress={() => void tour.start(startRef.current)}
                >
                  <Trans>Start</Trans>
                </Button>
              }
            />
          </li>
          <ChecklistRow />
        </List>
      </Section>

      <Section title={<Trans>On your phone</Trans>}>
        <List>
          <li>
            <Row
              leading={
                <IconTile>
                  <PhoneIcon />
                </IconTile>
              }
              title={<Trans>Install on your phone</Trans>}
              subtitle={
                <Trans>Kept opens from its own icon, full screen, and works offline.</Trans>
              }
              trailing={
                <Button size="small" variant="secondary" onPress={() => setInstall(true)}>
                  <Trans>Show steps</Trans>
                </Button>
              }
            />
          </li>
        </List>
        <InstallSheet isOpen={install} onClose={() => setInstall(false)} />
      </Section>

      <Section title={<Trans>Share into Kept</Trans>}>
        <List>
          <ShareNote icon={<ShareIcon />} title={<Trans>Android</Trans>}>
            <Trans>
              Once Kept is installed it's in the Share sheet. Share photos or PDFs to it from any
              app, and they open in Capture.
            </Trans>
          </ShareNote>
          <ShareNote icon={<GalleryIcon />} title={<Trans>iPhone, iPad</Trans>}>
            <Trans>
              iPhone doesn't let web apps appear in the Share sheet. Save the photo first, then add
              it in Capture with Gallery.
            </Trans>
          </ShareNote>
          <ShareNote icon={<GalleryIcon />} title={<Trans>Computer</Trans>}>
            <Trans>Add photos from your files with Gallery in Capture.</Trans>
          </ShareNote>
        </List>
      </Section>

      <Section title={<Trans>Connect other apps</Trans>}>
        <List>
          <li>
            <Row
              leading={
                <IconTile>
                  <CarIcon />
                </IconTile>
              }
              title={<Trans>Log your odometer from an iPhone Shortcut</Trans>}
              subtitle={
                <Trans>
                  A Shortcut that asks for the reading and sends it to Kept with a token.
                </Trans>
              }
              trailing={
                <Button size="small" variant="secondary" onPress={() => setRecipe(true)}>
                  <Trans>Show the recipe</Trans>
                </Button>
              }
            />
          </li>
        </List>
        <ShortcutRecipeSheet isOpen={recipe} onOpenChange={setRecipe} />
      </Section>

      <Section title={<Trans>Something not working?</Trans>}>
        <List>
          <li>
            <Row
              leading={
                <IconTile>
                  <WrenchIcon />
                </IconTile>
              }
              title={<Trans>Diagnostics</Trans>}
              subtitle={
                <Trans>Check the camera, offline support and storage, and copy a report.</Trans>
              }
              trailing={
                <LinkButton to="/settings/diagnostics" size="small">
                  <Trans>Open</Trans>
                </LinkButton>
              }
            />
          </li>
        </List>
      </Section>
    </Page>
  );
}

/**
 * The Get-started checklist: bring it back to Home when it was hidden (the `checklist` hint, so
 * every device agrees, D138). While it shows, or once every step is done, there is nothing to do.
 */
function ChecklistRow() {
  const { t } = useLingui();
  const home = useHome();
  const setDismissed = useChecklistDismissed();
  const checklist = home.data?.checklist;
  const finished = !!checklist && checklist.items.every((i) => i.done);
  return (
    <li>
      <Row
        leading={
          <IconTile>
            <CheckCircleIcon />
          </IconTile>
        }
        title={<Trans>Get-started checklist</Trans>}
        subtitle={
          !checklist ? null : finished ? (
            <Trans>Every step is done.</Trans>
          ) : checklist.dismissed ? (
            <Trans>Hidden from Home.</Trans>
          ) : (
            <Trans>On Home until every step is done.</Trans>
          )
        }
        trailing={
          checklist?.dismissed && !finished ? (
            <Button
              size="small"
              variant="secondary"
              onPress={() => {
                setDismissed(false);
                toast({ title: t`The checklist is back on Home`, tone: 'ok' });
              }}
            >
              <Trans>Bring it back</Trans>
            </Button>
          ) : null
        }
      />
    </li>
  );
}

function ShareNote({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <li>
      <Row leading={<IconTile>{icon}</IconTile>} title={title} subtitle={children} />
    </li>
  );
}
