/**
 * Where an import comes from (screens §6 "Import stepper", plan T19 step 1): a spreadsheet (step
 * 3's CSV flow, unchanged), a Homebox export, or a Kept export. Homebox's help names its own menu
 * path and the v0.26 floor (plan Q1: older servers update Homebox first). Choosing an archive
 * moves to its upload; the CSV flow keeps its own file step below this.
 */
import type { ArchiveSource } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChoiceCards } from '@/components/ui/segmented';

export type ImportSourceChoice = 'csv' | ArchiveSource;

export function SourceStep({
  value,
  onChange,
}: {
  value: ImportSourceChoice;
  onChange: (source: ImportSourceChoice) => void;
}) {
  const { t } = useLingui();
  return (
    <ChoiceCards<ImportSourceChoice>
      label={t`Import from`}
      value={value}
      onChange={onChange}
      options={[
        {
          id: 'csv',
          title: <Trans>A spreadsheet (CSV)</Trans>,
          body: <Trans>One thing per row, with a header row naming the columns.</Trans>,
        },
        {
          id: 'homebox_zip',
          title: <Trans>A Homebox export</Trans>,
          body: (
            <Trans>
              Homebox v0.26 or newer: Collection settings → Export. Older than v0.26: update Homebox
              first.
            </Trans>
          ),
        },
        {
          id: 'kept_zip',
          title: <Trans>A Kept export</Trans>,
          body: (
            <Trans>
              A location exported from this Kept or another one. It comes in as a new location.
            </Trans>
          ),
        },
      ]}
    />
  );
}
