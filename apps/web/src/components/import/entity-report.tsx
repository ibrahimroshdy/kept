/**
 * An archive import's report (plan T19 step 7; Q27): the counts the import would make first, then
 * only the entries with an issue, grouped by reason, each translated from its code and params
 * (labels.ts). A list-standard list: search (a name or a reason), a Status filter, pages, in the
 * URL; grouped by reason, fixed. People to invite follow (the connection's members with their
 * emails, or the Kept export's names and roles), each with Invite once the location exists.
 */
import { IMPORT_ISSUE_CODES, type ImportIssue } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type {
  ArchiveDryRunReport,
  ArchiveReportRow,
  ArchiveRowStatus,
} from '@/api/portability/types';
import type { FilterDef } from '@/components/filters/types';
import { ListSurface } from '@/components/list-surface';
import { Pill, type PillTone } from '@/components/page';
import { useFormat } from '@/lib/format';
import { isNot, useListState } from '@/lib/url-state';
import { useIssueText } from './labels';
import { useMemoryPages } from './memory-list';
import { CountTiles } from './step-chrome';

const TONE: Record<ArchiveRowStatus, PillTone> = { ok: 'ok', text: 'warn', skipped: 'danger' };
const STATUSES: ArchiveRowStatus[] = ['text', 'skipped'];
const ORDER = new Map<string, number>(IMPORT_ISSUE_CODES.map((c, i) => [c, i]));

/** One reason on one entry: the list's row. */
type Line = { key: string; status: ArchiveRowStatus; row: ArchiveReportRow; issue: ImportIssue };

function useArchiveStatusLabel() {
  const { t } = useLingui();
  const labels: Record<ArchiveRowStatus, string> = {
    ok: t`Imported`,
    text: t`Changed`,
    skipped: t`Skipped`,
  };
  return (s: ArchiveRowStatus) => labels[s];
}

export function ArchiveReportSummary({ report }: { report: ArchiveDryRunReport }) {
  const f = useFormat();
  const tile = (n: number, label: ReactNode) => ({ n, value: f.num(n), label });
  if (report.source === 'homebox_zip') {
    const s = report.summary;
    return (
      <CountTiles
        tiles={[
          tile(s.things, <Plural value={s.things} one="thing to add" other="things to add" />),
          tile(s.places, <Plural value={s.places} one="place to make" other="places to make" />),
          tile(
            s.attachments,
            <Plural value={s.attachments} one="photo or file" other="photos and files" />,
          ),
          tile(
            s.legacyCodes,
            <Plural value={s.legacyCodes} one="old label kept" other="old labels kept" />,
          ),
          tile(
            s.purchases,
            <Plural value={s.purchases} one="purchase to record" other="purchases to record" />,
          ),
          tile(
            s.warranties,
            <Plural value={s.warranties} one="warranty to add" other="warranties to add" />,
          ),
          tile(
            s.services,
            <Plural value={s.services} one="service to add" other="services to add" />,
          ),
          tile(s.types, <Plural value={s.types} one="type to add" other="types to add" />),
        ]}
      />
    );
  }
  const s = report.summary;
  return (
    <CountTiles
      tiles={[
        tile(s.things, <Plural value={s.things} one="thing to add" other="things to add" />),
        tile(s.places, <Plural value={s.places} one="place to make" other="places to make" />),
        tile(s.files, <Plural value={s.files} one="photo or file" other="photos and files" />),
        tile(
          s.codesAdopted,
          <Plural
            value={s.codesAdopted}
            one="label kept as printed"
            other="labels kept as printed"
          />,
        ),
        tile(
          s.codesReissued,
          <Plural
            value={s.codesReissued}
            one="label with a new code (the old one still opens it)"
            other="labels with a new code (the old ones still open them)"
          />,
        ),
        tile(s.history, <Plural value={s.history} one="history event" other="history events" />),
        tile(
          s.secrets,
          <Plural value={s.secrets} one="secret to bring over" other="secrets to bring over" />,
        ),
      ]}
    />
  );
}

export function EntityReport({
  report,
  reportKey,
}: {
  report: ArchiveDryRunReport;
  reportKey: string;
}) {
  const { t } = useLingui();
  const [list] = useListState();
  const issueText = useIssueText();
  const statusLabel = useArchiveStatusLabel();

  const lines: Line[] = report.rows
    .flatMap((row, r) =>
      row.issues.map((issue, i) => ({ key: `${r}:${i}`, status: row.status, row, issue })),
    )
    .sort((a, b) => (ORDER.get(a.issue.code) ?? 999) - (ORDER.get(b.issue.code) ?? 999));
  const counts: Record<ArchiveRowStatus, number> = { ok: 0, text: 0, skipped: 0 };
  for (const l of lines) counts[l.status] += 1;

  const statuses = list.filters.status ?? [];
  const not = isNot(list, 'status');
  const q = list.q.trim().toLocaleLowerCase();
  const shown = lines.filter((l) => {
    if (statuses.length && statuses.includes(l.status) === not) return false;
    if (!q) return true;
    return [l.row.ref.name ?? '', issueText(l.issue)].join('\n').toLocaleLowerCase().includes(q);
  });
  const query = useMemoryPages(['archive-report', reportKey, q, statuses, not], shown);

  const filters: FilterDef[] = [
    {
      key: 'status',
      label: t`Status`,
      kind: 'multi',
      hideZero: true,
      values: {
        from: 'static',
        options: STATUSES.map((s) => ({ value: s, label: statusLabel(s), count: counts[s] })),
      },
    },
  ];
  const total = report.rows.length;

  if (total === 0)
    return (
      <p className="m-0 text-ink-2">
        <Trans>Everything maps as it is: nothing needs a look.</Trans>
      </p>
    );

  return (
    <section className="grid gap-2" aria-labelledby="import-needs-look">
      <h3 id="import-needs-look" className="m-0 font-semibold text-[17px]">
        <Trans>Needs a look</Trans>
        <span className="font-normal text-ink-2">
          {' '}
          <Plural value={total} one="(# entry)" other="(# entries)" />
        </span>
      </h3>
      <ListSurface<Line>
        label={t`Needs a look`}
        search={{ label: t`Search the report`, placeholder: t`A name or a reason` }}
        filters={filters}
        query={query}
        getKey={(l) => l.key}
        defaultGroup="reason"
        groupOf={(l) => ({ key: l.issue.code, label: issueText(l.issue) })}
        empty={null}
        renderRow={(l) => (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2.5">
            <span className="grid min-w-0 flex-1 gap-0.5">
              <bdi className="font-medium [overflow-wrap:anywhere]">
                {l.row.ref.name ?? l.row.ref.id}
              </bdi>
              <span className="text-small text-ink-2">
                <RefKind kind={l.row.ref.kind} kept={report.source === 'kept_zip'} />
              </span>
            </span>
            <Pill tone={TONE[l.status]}>{statusLabel(l.status)}</Pill>
          </div>
        )}
      />
    </section>
  );
}

function RefKind({ kind, kept }: { kind: ArchiveReportRow['ref']['kind']; kept: boolean }) {
  switch (kind) {
    case 'attachment':
      return <Trans>An attachment</Trans>;
    case 'file':
      return <Trans>A file</Trans>;
    case 'maintenance':
      return <Trans>A maintenance entry</Trans>;
    case 'template':
      return <Trans>A template</Trans>;
    default:
      return kept ? <Trans>A thing or place</Trans> : <Trans>An item or location</Trans>;
  }
}
