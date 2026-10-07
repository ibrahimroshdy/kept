/**
 * Overview (screens §5): the thing's own details, then its type's fields (D154), each only when
 * it has a value; archived values collapsed underneath (D92: re-typing archives, never deletes);
 * then passwords and codes, and the purchase. Edit swaps the details for the form in place.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Disclosure, DisclosurePanel, Heading, Button as RAButton } from 'react-aria-components';
import { OwnCodesSection } from '@/components/codes/own-codes';
import { KeepAtLeastSection } from '@/components/consumables/lazy';
import { ChevronDownIcon, PencilIcon } from '@/components/icons';
import { Pill, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { useThingCtx } from './context';
import { EditForm, type ThingEditor } from './edit-form';
import { editableFields } from './form-model';
import { useConditionLabels } from './labels';
import { useFieldLabel, useTypeName } from './names';
import { PurchaseSection } from './purchase-section';
import { SecretsSection } from './secrets';
import { Bidi, KeyValues, KV, Printed, useFieldValue } from './values';

export function Overview({
  editor,
  onSplit,
  wide = false,
}: {
  editor: ThingEditor;
  onSplit?: () => void;
  /** From `md` up the page header carries Edit, so the section doesn't repeat it. */
  wide?: boolean;
}) {
  const { thing, can } = useThingCtx();
  const { t } = useLingui();
  const editing = editor.session !== null;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="grid min-w-0 gap-5">
        <Section
          title={<Trans>Details</Trans>}
          action={
            can('things.edit') && !editing && !wide ? (
              <Button variant="secondary" size="small" onPress={editor.start}>
                <PencilIcon className="size-4" />
                <Trans>Edit</Trans>
              </Button>
            ) : undefined
          }
        >
          {editing ? <EditForm editor={editor} /> : <Details onSplit={onSplit} />}
        </Section>
        {!editing && Object.keys(thing.archivedCustom).length ? <Archived /> : null}
        {thing.notes && !editing ? (
          <Section title={t`Notes`}>
            <p
              dir="auto"
              className="m-0 whitespace-pre-wrap rounded-[10px] border border-line bg-surface p-3.5 text-[15px] text-ink [overflow-wrap:anywhere]"
            >
              {thing.notes}
            </p>
          </Section>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-5">
        {/* Step 7 (T23): a consumable's minimum, where Consumables is on. */}
        <KeepAtLeastSection />
        <OwnCodesSection
          kind="thing"
          id={thing.id}
          locationId={thing.locationId}
          canEdit={can('things.edit')}
        />
        <SecretsSection />
        <PurchaseSection />
      </div>
    </div>
  );
}

function Details({ onSplit }: { onSplit?: (() => void) | undefined }) {
  const { thing, can } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const typeName = useTypeName();
  const fieldLabel = useFieldLabel();
  const fieldValue = useFieldValue();
  const conditions = useConditionLabels();
  const rows: ReactNode[] = [];
  const add = (key: string, label: string, value: ReactNode | null | undefined) => {
    if (value === null || value === undefined || value === '') return;
    rows.push(
      <KV key={key} label={label}>
        {value}
      </KV>,
    );
  };
  add('type', t`Type`, typeName(thing.type));
  add(
    'quantity',
    t`Quantity`,
    thing.quantity !== 1 ? (
      <span className="inline-flex flex-wrap items-center gap-2">
        {fmt.num(thing.quantity)}
        {onSplit && can('things.edit') && thing.quantity > 1 ? (
          <Button variant="ghost" size="small" onPress={onSplit}>
            <Trans>Split</Trans>
          </Button>
        ) : null}
      </span>
    ) : null,
  );
  add('brand', t`Brand`, thing.brand ? <Bidi>{thing.brand.name}</Bidi> : null);
  add('model', t`Model`, thing.model ? <Bidi>{thing.model}</Bidi> : null);
  add('serial', t`Serial number`, thing.serial ? <Printed>{thing.serial}</Printed> : null);
  add('barcode', t`Barcode`, thing.barcode ? <Printed>{thing.barcode}</Printed> : null);
  add('colour', t`Colour`, thing.colour ? <Bidi>{thing.colour}</Bidi> : null);
  add('condition', t`Condition`, thing.condition ? conditions[thing.condition] : null);
  add(
    'belongsTo',
    t`Belongs to`,
    thing.belongsTo ? (
      <Link to="/people/$id" params={{ id: thing.belongsTo.id }} className="text-info underline">
        <bdi>{thing.belongsTo.displayName}</bdi>
      </Link>
    ) : null,
  );
  add(
    'tags',
    t`Tags`,
    thing.tags.length ? (
      <span className="flex flex-wrap gap-1.5">
        {thing.tags.map((g) => (
          <Pill key={g.id}>
            <bdi>{g.name}</bdi>
          </Pill>
        ))}
      </span>
    ) : null,
  );
  const aliases = Object.values(thing.aliases).flat();
  add('aliases', t`Also called`, aliases.length ? <Bidi>{aliases.join(sep())}</Bidi> : null);
  add('expires', t`Expires`, thing.expiresOn ? fmt.day(thing.expiresOn) : null);
  add(
    'manual',
    t`Manual`,
    thing.manualUrl
      ? fieldValue({ kind: 'url', unit: null, key: 'manual' }, thing.manualUrl)
      : null,
  );
  add('acquiredFrom', t`Came from`, thing.acquiredFrom ? <Bidi>{thing.acquiredFrom}</Bidi> : null);
  for (const f of thing.fields
    .filter((x) => !x.secret && !x.archivedAt)
    .sort((a, b) => a.sort - b.sort)) {
    const value = fieldValue(f, thing.custom[f.key]);
    const suggested = thing.fieldStatus[`custom.${f.key}`]?.state === 'extracted';
    add(
      `custom.${f.key}`,
      fieldLabel(f),
      value === null ? null : (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {value}
          {suggested ? (
            <Pill tone="info">
              <Trans>Suggested</Trans>
            </Pill>
          ) : null}
        </span>
      ),
    );
  }
  add('lastSeen', t`Last seen`, thing.lastSeenAt ? fmt.dateTime(thing.lastSeenAt) : null);
  if (rows.length === 0)
    return (
      <p className="m-0 text-small text-ink-3">
        <Trans>Nothing recorded yet.</Trans>
      </p>
    );
  // Fields the type has but that are still empty, as a gentle prompt for writers.
  const empty = editableFields(thing.fields).filter((f) => thing.custom[f.key] == null).length;
  return (
    <>
      <KeyValues label={t`Details`}>{rows}</KeyValues>
      {empty > 0 && can('things.edit') ? (
        <p className="m-0 text-small text-ink-3">
          <Trans>{fmt.num(empty)} more fields for this type are empty. Edit to fill them in.</Trans>
        </p>
      ) : null}
    </>
  );
}

function Archived() {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const fieldLabel = useFieldLabel();
  const entries = Object.entries(thing.archivedCustom);
  return (
    <Disclosure className="grid gap-2">
      <Heading className="m-0">
        <RAButton
          slot="trigger"
          className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-[10px] border border-line bg-surface px-3.5 text-start text-small font-semibold text-ink-2 outline-none data-focus-visible:outline-2 data-focus-visible:outline-info"
        >
          <Trans>Archived fields · {fmt.num(entries.length)}</Trans>
          <ChevronDownIcon className="size-4 transition-transform group-aria-expanded:rotate-180" />
        </RAButton>
      </Heading>
      <DisclosurePanel>
        <p className="m-0 mb-2 text-small text-ink-3">
          <Trans>
            Kept from an earlier type. They're not lost; re-type back to use them again.
          </Trans>
        </p>
        <KeyValues label={t`Archived fields`}>
          {entries.map(([key, value]) => (
            <KV key={key} label={fieldLabel({ label: null, labelKey: key, key })}>
              <Bidi>{Array.isArray(value) ? value.join(', ') : String(value)}</Bidi>
            </KV>
          ))}
        </KeyValues>
      </DisclosurePanel>
    </Disclosure>
  );
}
