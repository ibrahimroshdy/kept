/**
 * Where an archive goes (plan T19 step 5; T8, Q8): a new location, made in your account with its
 * own Unplaced area, its name prefilled from the Homebox collection or the exported location; or,
 * for a Homebox export only, a location you own or administer (things already there stay; a
 * re-run adds only what's new). A Kept export always comes in as a new location: it has no safe
 * way to merge into one in use. The new location's timezone and currency come from this browser
 * (like New location, D194), and both can be changed in Location settings.
 */
import type { ArchiveSource } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import type { ImportTargetBody } from '@/api/portability/types';
import type { LocationKind, LocationSummary } from '@/api/types';
import { Notice } from '@/components/page';
import { Combobox } from '@/components/ui/combobox';
import { ChoiceCards } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import {
  browserCurrency,
  browserTimezone,
  CREATABLE_KINDS,
  useKindLabels,
  useLocationName,
} from '@/lib/labels';

type Kind = Exclude<LocationKind, 'personal'>;

export type TargetDraft =
  | { mode: 'new'; name: string; kind: Kind }
  | { mode: 'existing'; locationId: string };

/** The target as first offered: a new location named after the archive. */
export function initialTarget(
  name: string,
  kind: LocationKind | undefined,
): Extract<TargetDraft, { mode: 'new' }> {
  return { mode: 'new', name, kind: kind && kind !== 'personal' ? kind : 'home' };
}

export const NAME_MAX = 120;

/** The body to send, or null while it isn't complete. */
export function targetBody(draft: TargetDraft): ImportTargetBody | null {
  if (draft.mode === 'existing') return draft.locationId ? { locationId: draft.locationId } : null;
  const name = draft.name.trim();
  if (!name || name.length > NAME_MAX) return null;
  return {
    newLocation: {
      name,
      kind: draft.kind,
      timezone: browserTimezone(),
      currency: browserCurrency(),
    },
  };
}

export function TargetStep({
  source,
  draft,
  onChange,
  locations,
  originalName,
}: {
  source: ArchiveSource;
  draft: TargetDraft;
  onChange: (draft: TargetDraft) => void;
  /** Locations the caller owns or administers (a Homebox export may go into one). */
  locations: LocationSummary[];
  /** The collection's or the exported location's name, for a new location. */
  originalName: string;
}) {
  const { t, i18n } = useLingui();
  const f = useFormat();
  const kinds = useKindLabels();
  const locationName = useLocationName();
  const [lastNew, setLastNew] = useState<Extract<TargetDraft, { mode: 'new' }>>(
    draft.mode === 'new' ? draft : { mode: 'new', name: originalName, kind: 'home' },
  );
  const existingAllowed = source === 'homebox_zip' && locations.length > 0;
  const names = new Intl.ListFormat(i18n.locale || 'en', { type: 'conjunction' }).format(
    locations.map((l) => locationName(l)),
  );
  const tooLong = draft.mode === 'new' && draft.name.trim().length > NAME_MAX;
  const max = f.num(NAME_MAX);

  const newFields =
    draft.mode === 'new' ? (
      <div className="grid gap-3">
        <TextField
          label={t`Name`}
          value={draft.name}
          onChange={(name) => {
            const next = { ...draft, name };
            setLastNew(next);
            onChange(next);
          }}
          isRequired
          isInvalid={tooLong || draft.name.trim() === ''}
          errorMessage={tooLong ? t`At most ${max} characters.` : t`Give the new location a name.`}
        />
        <Combobox
          label={t`Kind`}
          items={CREATABLE_KINDS.map((k) => ({ id: k, label: kinds[k] }))}
          selectedKey={draft.kind}
          onSelectionChange={(k) => {
            if (!k) return;
            const next = { ...draft, kind: String(k) as Kind };
            setLastNew(next);
            onChange(next);
          }}
          description={t`Its timezone and currency are this device's; change them later in Location settings.`}
        />
      </div>
    ) : null;

  const existingField =
    draft.mode === 'existing' ? (
      <div>
        <Combobox
          label={t`Location`}
          items={locations.map((l) => ({ id: l.id, label: locationName(l) }))}
          selectedKey={draft.locationId || null}
          onSelectionChange={(k) => {
            if (k) onChange({ mode: 'existing', locationId: String(k) });
          }}
        />
      </div>
    ) : null;

  if (!existingAllowed)
    return (
      <div className="grid gap-4">
        <div className="rounded-[10px] border border-line bg-surface p-3.5">
          <h3 className="m-0 font-semibold text-[16px]">
            <Trans>A new location</Trans>
          </h3>
          <p className="m-0 mt-1 text-small text-ink-2">
            <Trans>Made in your account, with its own Unplaced area.</Trans>
          </p>
          <div className="mt-3">{newFields}</div>
        </div>
        {source === 'kept_zip' ? (
          <Notice tone="info">
            <Trans>A Kept export always comes in as a new location.</Trans>
          </Notice>
        ) : null}
      </div>
    );

  return (
    <div className="grid gap-3">
      <ChoiceCards<'new' | 'existing'>
        aria-label={t`Where it goes`}
        value={draft.mode}
        onChange={(mode) =>
          onChange(
            mode === 'new'
              ? lastNew
              : {
                  mode: 'existing',
                  locationId: locations.length === 1 ? (locations[0]?.id ?? '') : '',
                },
          )
        }
        options={[
          {
            id: 'new',
            title: <Trans>A new location</Trans>,
            body: <Trans>Made in your account, with its own Unplaced area.</Trans>,
          },
          {
            id: 'existing',
            title: <Trans>A location you run</Trans>,
            body: (
              <Trans>
                <bdi>{names}</bdi>. Things already there stay; importing the same export again adds
                only what's new.
              </Trans>
            ),
          },
        ]}
      />
      {newFields}
      {existingField}
    </div>
  );
}
