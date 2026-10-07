/**
 * The primitives gallery: every step-1 primitive in its states, plus step 2's brand, ID chip,
 * status pills, type icons and the list surface, in the current theme and language. Later tasks
 * and screenshots use it as the reference; it is not a product screen.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import type { Key } from 'react-aria-components';
import type { Page } from '@/api/inventory/types';
import { AppMark, BrandLockup } from '@/components/brand';
import { DisplayPrefs } from '@/components/display-prefs';
import { AlertIcon, AssistantIcon, InfoIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { ListSurface } from '@/components/list-surface';
import { StatusPill } from '@/components/status-pill';
import { STATIC_ICONS, TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogFooter, DialogTrigger, Modal } from '@/components/ui/dialog';
import { PasswordField } from '@/components/ui/password-field';
import { Switch } from '@/components/ui/switch';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { firstOf, listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/gallery')({
  validateSearch: listSearch(['kind']),
  component: Gallery,
});

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-t border-line pt-6 first:border-t-0 first:pt-0">
      <h2 className="m-0 font-semibold text-[18px] leading-tight">{title}</h2>
      {children}
    </section>
  );
}

const SWATCHES = [
  'paper',
  'surface',
  'sunken',
  'line',
  'ink',
  'ink-2',
  'ink-3',
  'amber',
  'amber-text',
  'violet',
  'ok',
  'warn',
  'danger',
  'info',
] as const;

function Gallery() {
  const { t } = useLingui();
  const confirm = useConfirm();
  const [currency, setCurrency] = useState<Key | null>('EGP');
  const [notify, setNotify] = useState(true);
  const [lastConfirm, setLastConfirm] = useState<string | null>(null);
  const [printKey, setPrintKey] = useState(0);

  const currencies = [
    { id: 'EGP', label: t`Egyptian pound`, description: 'EGP' },
    { id: 'USD', label: t`US dollar`, description: 'USD' },
    { id: 'EUR', label: t`Euro`, description: 'EUR' },
    { id: 'GBP', label: t`British pound`, description: 'GBP' },
    { id: 'CAD', label: t`Canadian dollar`, description: 'CAD' },
  ];

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-6 sm:px-6">
      <DisplayPrefs />
      <header className="grid gap-1.5">
        <span className="eyebrow">
          <Trans>Design system</Trans>
        </span>
        <h1 className="m-0 font-semibold text-display">
          <Trans>Primitives</Trans>
        </h1>
        <p className="m-0 max-w-[66ch] text-ink-2">
          <Trans>
            Every control Kept's screens are built from, on React Aria. Switch the theme and the
            language above: everything here should mirror cleanly.
          </Trans>
        </p>
      </header>

      <Section title={<Trans>Brand</Trans>}>
        <div className="flex flex-wrap items-center gap-6">
          <BrandLockup width={150} />
          <div className="t-dark flex items-center rounded-lg bg-[var(--surface)] p-3">
            <BrandLockup width={150} />
          </div>
          <div className="flex items-end gap-3">
            {[16, 24, 32, 48, 64, 96].map((size) => (
              <div key={size} className="grid justify-items-center gap-1">
                <AppMark size={size} />
                <span dir="ltr" className="font-mono text-[11px] text-ink-3">
                  {size}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title={<Trans>ID chip and status</Trans>}>
        <div className="flex flex-wrap items-center gap-2">
          <IdChip code="7KQ4MZ" />
          <IdChip code="K7Q3FM" size="large" />
          <IdChip key={printKey} code="2HX9RB" fresh={printKey > 0} />
          <Button size="small" variant="secondary" onPress={() => setPrintKey((k) => k + 1)}>
            <Trans>Print again</Trans>
          </Button>
        </div>
        <p className="m-0 text-ink-2">
          <Trans>
            In a sentence: the drill <IdChip code="2HX9RB" /> is on the tool wall.
          </Trans>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill state="uncertain" />
          <StatusPill state="draft" />
          <StatusPill state="ended" />
          <StatusPill state="ended" label={t`Given away`} />
          <StatusPill state="needs_review" />
        </div>
      </Section>

      <Section title={<Trans>Type icons</Trans>}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {[...Object.keys(STATIC_ICONS), 'lucide:guitar', 'tabler:unknown'].map((ref) => (
            <div
              key={ref}
              className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5"
            >
              <TypeIcon icon={ref} className="text-ink-2" />
              <code dir="ltr" className="font-mono text-[11px] text-ink-3 [overflow-wrap:anywhere]">
                {ref}
              </code>
            </div>
          ))}
        </div>
      </Section>

      <Section title={<Trans>List surface</Trans>}>
        <GalleryList />
      </Section>

      <Section title={<Trans>Colour tokens</Trans>}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2.5">
          {SWATCHES.map((name) => (
            <div key={name} className="grid gap-1.5">
              <div
                className="h-11 rounded-md border border-line"
                style={{ background: `var(--${name})` }}
              />
              <code dir="ltr" className="justify-self-start font-mono text-[11.5px] text-ink-3">
                --{name}
              </code>
            </div>
          ))}
        </div>
      </Section>

      <Section title={<Trans>Buttons</Trans>}>
        <div className="flex flex-wrap items-center gap-2">
          <Button>
            <Trans>Save</Trans>
          </Button>
          <Button variant="secondary">
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="ghost">
            <Trans>Skip for now</Trans>
          </Button>
          <Button variant="danger">
            <Trans>Delete</Trans>
          </Button>
          <Button size="small" variant="secondary">
            <Trans>Small</Trans>
          </Button>
          <Button isDisabled>
            <Trans>Disabled</Trans>
          </Button>
          <Button variant="ghost" size="icon" aria-label={t`Assistant`}>
            <AssistantIcon />
          </Button>
        </div>
      </Section>

      <Section title={<Trans>Text fields</Trans>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={<Trans>Name</Trans>}
            placeholder={t`e.g. Cordless drill`}
            description={<Trans>What you would call it out loud.</Trans>}
          />
          <TextField
            label={<Trans>Email</Trans>}
            type="email"
            defaultValue="not-an-email"
            isInvalid
            errorMessage={t`Enter an email address, like name@example.com.`}
          />
          <PasswordField
            label={<Trans>Password</Trans>}
            autoComplete="new-password"
            description={<Trans>At least 12 characters.</Trans>}
          />
          <Combobox
            label={<Trans>Currency</Trans>}
            items={currencies}
            selectedKey={currency}
            onSelectionChange={setCurrency}
            description={<Trans>Type to search. Never a native select.</Trans>}
          />
        </div>
      </Section>

      <Section title={<Trans>Switch</Trans>}>
        <Switch isSelected={notify} onChange={setNotify}>
          <Trans>Email me when something is due</Trans>
        </Switch>
      </Section>

      <Section title={<Trans>Dialog, confirm and toast</Trans>}>
        <div className="flex flex-wrap items-center gap-2">
          <DialogTrigger>
            <Button variant="secondary">
              <Trans>Rename…</Trans>
            </Button>
            <Modal>
              <Dialog title={<Trans>Rename this thing</Trans>}>
                {({ close }) => (
                  <>
                    <TextField
                      label={<Trans>Name</Trans>}
                      defaultValue={t`Cordless drill`}
                      autoFocus
                    />
                    <DialogFooter>
                      <Button variant="secondary" onPress={close}>
                        <Trans>Cancel</Trans>
                      </Button>
                      <Button
                        onPress={() => {
                          close();
                          toast({ title: t`Renamed`, tone: 'ok' });
                        }}
                      >
                        <Trans>Save</Trans>
                      </Button>
                    </DialogFooter>
                  </>
                )}
              </Dialog>
            </Modal>
          </DialogTrigger>
          <Button
            variant="danger"
            onPress={async () => {
              const ok = await confirm({
                title: t`Remove Selina from this home?`,
                body: t`She will lose access straight away. Things she added stay.`,
                confirmLabel: t`Remove`,
                destructive: true,
              });
              setLastConfirm(ok ? t`Removed` : t`Not removed`);
            }}
          >
            <Trans>Remove member…</Trans>
          </Button>
          <Button
            variant="secondary"
            onPress={() =>
              toast({
                title: t`Moved to Garage`,
                description: t`Cordless drill`,
                action: { label: t`Undo`, onAction: () => toast({ title: t`Move undone` }) },
              })
            }
          >
            <Trans>Show a toast</Trans>
          </Button>
          {lastConfirm ? (
            <output className="text-small text-ink-3">
              <Trans>Last answer: {lastConfirm}</Trans>
            </output>
          ) : null}
        </div>
      </Section>

      <Section title={<Trans>Cards and tabs</Trans>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>
                  <Trans>Cordless drill with two batteries and the long charger</Trans>
                </CardTitle>
                <span className="tape">K7-3QF</span>
              </div>
              <CardDescription>
                <Trans>Garage › Wall shelf › Blue bin</Trans>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-1 text-[12px] text-ok">
                  <InfoIcon width={14} height={14} />
                  <Trans>Warranty until 2027</Trans>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-1 text-[12px] text-warn">
                  <AlertIcon width={14} height={14} />
                  <Trans>Lent to Ibrahim</Trans>
                </span>
              </div>
            </CardContent>
            <CardFooter>
              <Button size="small" variant="secondary">
                <Trans>Open</Trans>
              </Button>
            </CardFooter>
          </Card>
          <Card>
            <Tabs>
              <TabList aria-label={t`Location settings`}>
                <Tab id="members">
                  <Trans>Members</Trans>
                </Tab>
                <Tab id="track">
                  <Trans>What to track</Trans>
                </Tab>
                <Tab id="danger">
                  <Trans>Danger zone</Trans>
                </Tab>
              </TabList>
              <TabPanel id="members" className="text-ink-2">
                <Trans>Three people can see this home.</Trans>
              </TabPanel>
              <TabPanel id="track" className="text-ink-2">
                <Trans>Things, vehicles and paperwork.</Trans>
              </TabPanel>
              <TabPanel id="danger" className="text-ink-2">
                <Trans>Archive or delete this home.</Trans>
              </TabPanel>
            </Tabs>
          </Card>
        </div>
      </Section>
    </div>
  );
}

type Sample = {
  id: string;
  name: string;
  path: string;
  code: string | null;
  kind: string;
  icon: string;
};

const SAMPLES: Sample[] = [
  {
    id: '1',
    name: 'HDMI cable, 2 m',
    path: 'Home › Office › Desk drawer › Cable box',
    code: '7KQ4MZ',
    kind: 'cables',
    icon: 'lucide:cable',
  },
  {
    id: '2',
    name: 'Bosch drill, 18 V',
    path: 'Garage › Tool wall',
    code: '2HX9RB',
    kind: 'tools',
    icon: 'lucide:drill',
  },
  {
    id: '3',
    name: 'Samsung TV, 55″',
    path: 'Home › Living room',
    code: '5MT0QD',
    kind: 'electronics',
    icon: 'lucide:tv',
  },
  {
    id: '4',
    name: 'كابل HDMI',
    path: 'بيت العائلة › غرفة المعيشة',
    code: 'AR7HDM',
    kind: 'cables',
    icon: 'lucide:cable',
  },
  {
    id: '5',
    name: 'Box 3',
    path: 'Home › Hallway closet',
    code: 'B0X3AA',
    kind: 'boxes',
    icon: 'lucide:package',
  },
  {
    id: '6',
    name: 'Wall safe',
    path: 'Home › Bedroom',
    code: '5AFE9K',
    kind: 'boxes',
    icon: 'kept:safe',
  },
  {
    id: '7',
    name: 'مفك براغي',
    path: 'بيت العائلة › المطبخ › صندوق العدة',
    code: null,
    kind: 'tools',
    icon: 'lucide:wrench',
  },
];

/** The list standard on sample rows: search, a chip filter, grouping and "Load more" (3 a page). */
function GalleryList() {
  const { t } = useLingui();
  const [list] = useListState();
  const kind = firstOf(list, 'kind');
  const query = useInfiniteQuery({
    queryKey: ['gallery-list', list.q, kind],
    queryFn: async ({ pageParam }): Promise<Page<Sample>> => {
      const all = SAMPLES.filter(
        (s) =>
          (!list.q || s.name.toLowerCase().includes(list.q.toLowerCase())) &&
          (!kind || s.kind === kind),
      );
      const from = Number(pageParam ?? 0);
      return {
        items: all.slice(from, from + 3),
        next_cursor: from + 3 < all.length ? String(from + 3) : null,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const count = (k: string) => SAMPLES.filter((s) => s.kind === k).length;
  return (
    <ListSurface
      label={t`Sample things`}
      query={query}
      filters={[
        {
          key: 'kind',
          label: t`Kind`,
          kind: 'single',
          hideZero: true,
          values: {
            from: 'static',
            options: [
              { value: 'cables', label: t`Cables`, count: count('cables') },
              { value: 'tools', label: t`Tools`, count: count('tools') },
              { value: 'boxes', label: t`Boxes`, count: count('boxes') },
              { value: 'lent', label: t`Lent`, count: 0 },
            ],
          },
        },
      ]}
      groups={[
        { value: 'none', label: t`None` },
        { value: 'kind', label: t`Kind`, short: t`by kind` },
      ]}
      getKey={(s) => s.id}
      groupOf={(s) => ({ key: s.kind, label: s.kind })}
      renderRow={(s) => (
        <div className="flex min-h-14 items-center gap-3 px-3.5 py-2.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink-2">
            <TypeIcon icon={s.icon} />
          </span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <div dir="auto" className="font-semibold text-[15px] text-ink [overflow-wrap:anywhere]">
              {s.name}
            </div>
            <div dir="auto" className="text-small text-ink-2 [overflow-wrap:anywhere]">
              <bdi>{s.path}</bdi>
            </div>
          </div>
          <IdChip code={s.code} />
        </div>
      )}
      empty={<p>{t`Nothing here yet`}</p>}
    />
  );
}
