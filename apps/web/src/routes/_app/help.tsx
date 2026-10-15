/**
 * Help (plan T31; D138, D139, screens §1 and §8): "Show me around" (the guided tour, replayable,
 * resumable where it stopped (D242), never started on launch), bringing back the Get-started
 * checklist, installing Kept on a phone, sharing into Kept from other apps per platform (iPhone
 * has no share target, V9), logging the odometer from an iPhone Shortcut with a token (step 6 T21,
 * D63), and the diagnostics page.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useRef, useState } from 'react';
import { useHome } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { ShortcutRecipeSheet } from '@/components/connections/shortcut-recipe';
import { useGuidedTourCopy } from '@/components/hints/hint-copy';
import {
  availableSections,
  passedSections,
  tourProgress,
  useGuidedTour,
} from '@/components/hints/tour';
import { useHints } from '@/components/hints/use-hint';
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
import { useMediaQuery, WIDE } from '@/lib/media';

export const Route = createFileRoute('/_app/help')({ component: HelpPage });

function HelpPage() {
  const { t } = useLingui();
  const [install, setInstall] = useState(false);
  const [recipe, setRecipe] = useState(false);
  return (
    <Page title={t`Help`}>
      <Section title={<Trans>Find your way around</Trans>}>
        <List>
          <TourRow />
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
 * "Show me around" (D242): Start the first time and after a finished tour; Resume and Start over
 * once a tour stopped part-way, naming the section it stopped at. Where it stopped is the
 * server's (`help.tour.<section>` hints), so every device agrees.
 */
function TourRow() {
  const tour = useGuidedTour();
  const copy = useGuidedTourCopy();
  const hints = useHints(false);
  const locations = useLocations();
  const wide = useMediaQuery(WIDE);
  const startRef = useRef<HTMLButtonElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const progress = tourProgress(
    availableSections(locations.data ?? []),
    passedSections(hints.data?.hints),
  );
  const stoppedAt =
    progress.state === 'stopped'
      ? copy[progress.sectionId === 'more' && wide ? 'more-wide' : progress.sectionId]?.title
      : undefined;
  return (
    <li data-tour="help-tour">
      <Row
        leading={
          <IconTile>
            <QuestionIcon />
          </IconTile>
        }
        title={<Trans>Show me around</Trans>}
        subtitle={
          progress.state === 'stopped' && stoppedAt ? (
            <Trans>Stopped at {stoppedAt}.</Trans>
          ) : progress.state === 'finished' ? (
            <Trans>Seen it all. Replay it any time.</Trans>
          ) : (
            <Trans>
              A short walk from Home to Help. Close it any time; it picks up where you stopped.
            </Trans>
          )
        }
        trailing={
          progress.state === 'stopped' ? null : (
            <Button
              ref={startRef}
              size="small"
              variant="primary"
              onPress={() => void tour.start({ returnFocus: startRef.current })}
            >
              <Trans>Start</Trans>
            </Button>
          )
        }
      >
        {progress.state === 'stopped' ? (
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button
              ref={resumeRef}
              size="small"
              variant="primary"
              onPress={() => void tour.start({ from: 'resume', returnFocus: resumeRef.current })}
            >
              <Trans>Resume</Trans>
            </Button>
            <Button
              size="small"
              variant="secondary"
              onPress={() => void tour.start({ returnFocus: resumeRef.current })}
            >
              <Trans>Start over</Trans>
            </Button>
          </div>
        ) : null}
      </Row>
    </li>
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
