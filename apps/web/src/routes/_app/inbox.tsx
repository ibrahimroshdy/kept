/**
 * The inbox (screens §5 "Inbox"; D18, D36, D175, D191): where captured drafts, receipts, readings
 * that don't fit, duplicates, lost label claims and dropped offline changes wait for a person.
 * The list, its keys and its states are components/inbox/inbox-list.tsx; the URL holds the
 * search and the filters (`f.kind`, `f.location`, `f.mine=everyone`), as every list does (L88).
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { InboxList } from '@/components/inbox/inbox-list';
import { Page } from '@/components/page';
import { listSearch } from '@/lib/url-state';
import { useOffline } from '@/offline/provider';

export const Route = createFileRoute('/_app/inbox')({
  validateSearch: listSearch(['kind', 'location', 'mine']),
  component: InboxPage,
});

function InboxPage() {
  const { t } = useLingui();
  const offline = useOffline();
  return (
    <Page title={t`Inbox`} wide>
      <InboxList local={offline?.store ?? null} />
    </Page>
  );
}
