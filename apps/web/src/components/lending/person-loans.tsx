/**
 * Loans on the person page (plan T22; D57, screens §5 "Person page: what they have, and what
 * belongs to them"): "Has from us" (open loans out to them) and "Lent to us" (open loans in from
 * them), then the returned ones, before the page's "Belongs to" list. Only locations with Lending
 * on count (the server's rule); with nothing either way, the sections stay away.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { usePersonLoans } from '@/api/household/queries';
import type { LoanRow } from '@/api/household/types';
import { List, LoadingRows, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { LoanRowView } from './loan-row';

export function PersonLoans({ personId, name }: { personId: string; name: string }) {
  const { t } = useLingui();
  const q = usePersonLoans(personId);
  if (q.isPending) return <LoadingRows rows={1} label={t`Loading loans`} />;
  if (q.isError) return null;
  const first = q.data.pages[0];
  const has = first?.has ?? [];
  const lentUs = first?.lentUs ?? [];
  const history = q.data.pages.flatMap((p) => p.history);
  return (
    <>
      {has.length ? (
        <Section title={<Trans>Has from us</Trans>}>
          <Loans label={t`What ${name} has from us`} rows={has} />
        </Section>
      ) : null}
      {lentUs.length ? (
        <Section title={<Trans>Lent to us</Trans>}>
          <Loans label={t`What ${name} lent us`} rows={lentUs} />
        </Section>
      ) : null}
      {history.length ? (
        <Section title={<Trans>Returned</Trans>}>
          <Loans label={t`Loans with ${name} that ended`} rows={history} />
          {q.hasNextPage ? (
            <Button
              variant="secondary"
              className="justify-self-center"
              isPending={q.isFetchingNextPage}
              onPress={() => void q.fetchNextPage()}
            >
              <Trans>Load more</Trans>
            </Button>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

function Loans({ label, rows }: { label: string; rows: LoanRow[] }) {
  return (
    <List aria-label={label}>
      {rows.map((l) => (
        <li key={l.id}>
          <LoanRowView loan={l} hidePerson />
        </li>
      ))}
    </List>
  );
}
