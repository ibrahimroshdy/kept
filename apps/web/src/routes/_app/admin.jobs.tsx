/** Admin → Failed jobs (task 24, D166): each with its last error, Retry and Discard. */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { failedJobAction } from '@/api/admin';
import { keys, useFailedJobs } from '@/api/queries';
import type { FailedJob } from '@/api/types';
import { CheckCircleIcon, RetryIcon } from '@/components/icons';
import { EmptyState, ErrorState, List, LoadingRows, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';

export const Route = createFileRoute('/_app/admin/jobs')({ component: JobsPage });

function JobsPage() {
  const jobs = useFailedJobs();
  if (jobs.isPending) return <LoadingRows rows={2} />;
  if (jobs.error) return <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />;
  if (jobs.data.length === 0)
    return (
      <EmptyState icon={<CheckCircleIcon />} title={<Trans>No failed jobs</Trans>}>
        <Trans>Background work is keeping up. A job that fails every retry shows up here.</Trans>
      </EmptyState>
    );
  return (
    <List>
      {jobs.data.map((j) => (
        <li key={j.id}>
          <JobRow job={j} />
        </li>
      ))}
    </List>
  );
}

function JobRow({ job }: { job: FailedJob }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const act = useMutation({
    mutationFn: (action: 'retry' | 'discard') => failedJobAction(job.id, action),
    onSuccess: async (_r, action) => {
      await qc.invalidateQueries({ queryKey: keys.admin.jobs });
      toast({ title: action === 'retry' ? t`Queued again` : t`Discarded`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const when = f.dateTime(job.failedAt);
  const attempts = f.num(job.attempts);
  // A job's data (and so its location) is never shown to an instance admin (D164).
  return (
    <div className="grid gap-2 px-3.5 py-3">
      <div className="ltr text-start font-mono text-[14px] font-semibold">{job.name}</div>
      <div className="text-small text-ink-2">
        <Trans>
          Failed {when} after {attempts} attempts
        </Trans>
      </div>
      {job.error ? (
        <code className="ltr block rounded-md bg-sunken px-2.5 py-2 text-start font-mono text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">
          {job.error}
        </code>
      ) : (
        <div className="text-small text-ink-3">
          <Trans>It left no error message.</Trans>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          variant="secondary"
          isPending={act.isPending && act.variables === 'retry'}
          onPress={() => act.mutate('retry')}
        >
          <RetryIcon />
          <Trans>Retry</Trans>
        </Button>
        <Button
          size="small"
          variant="ghost"
          isPending={act.isPending && act.variables === 'discard'}
          onPress={async () => {
            const ok = await confirm({
              title: t`Discard this job?`,
              body: t`It won't run again. Whatever it was doing stays undone.`,
              confirmLabel: t`Discard`,
              destructive: true,
            });
            if (ok) act.mutate('discard');
          }}
        >
          <Trans>Discard</Trans>
        </Button>
      </div>
    </div>
  );
}
