/**
 * A shared page (1.5, D233; screens §2 `/s/<token>`, D39 item 7, D116): what a household shared
 * as a read-only link, opened with no account. The things A to Z with only their name, photo,
 * type, where they are, quantity, condition and notes, under the list standard. A link that is
 * revoked, expired, unknown or no longer backed by its maker says "This link has expired", the
 * same for each (engineering spec §5), and never asks anyone to sign in. The page's language is
 * the browser's (the app's own default). Kept for search engines: `noindex`.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, type ErrorComponentProps } from '@tanstack/react-router';
import { isApiError } from '@/api/client';
import { useSharedPage } from '@/api/sharelinks/queries';
import { Logo } from '@/components/app-shell';
import { ErrorState, LoadingRows } from '@/components/page';
import { SHARED_FILTERS, SharedHeader, SharedList } from '@/components/sharelinks/shared-view';
import { useTypeName } from '@/components/things/names';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/s/$token')({
  validateSearch: listSearch(SHARED_FILTERS),
  component: SharedPageRoute,
  errorComponent: SharedRouteError,
});

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useLingui();
  return (
    // <main>: the page stands alone, outside the app shell.
    <main className="min-h-dvh bg-paper">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <div className="mx-auto grid w-full max-w-3xl content-start gap-5 px-4 pt-4 pb-10 md:px-8 md:pt-8">
        <div className="flex items-center justify-between gap-3">
          <Logo />
          <span className="text-small text-ink-3">{t`Shared from Kept · read-only`}</span>
        </div>
        <h1 className="m-0 break-words font-semibold text-[26px] text-ink leading-tight">
          {title}
        </h1>
        {children}
      </div>
    </main>
  );
}

function SharedPageRoute() {
  const { token } = Route.useParams();
  const { t } = useLingui();
  const query = useSharedPage({ token });
  const typeName = useTypeName();
  if (query.isPending)
    return (
      <Frame title={t`Shared with you`}>
        <LoadingRows rows={4} label={t`Loading`} />
      </Frame>
    );
  if (query.isError) {
    const gone = isApiError(query.error) && query.error.status === 404;
    return gone ? (
      <Frame title={t`This link has expired`}>
        <p className="m-0 text-ink-2">
          <Trans>Ask the person who shared it for a new one.</Trans>
        </p>
      </Frame>
    ) : (
      <Frame title={t`Couldn't open this link`}>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Frame>
    );
  }
  const first = query.data.pages[0];
  if (!first) return null;
  const title =
    first.thing?.name ??
    (first.place ? (first.place.isUnplaced ? t`Unplaced` : first.place.name) : null) ??
    first.title ??
    (first.thing ? typeName(first.thing.type) : t`Shared with you`);
  return (
    <Frame title={title}>
      <SharedHeader page={first} />
      <SharedList query={query} />
    </Frame>
  );
}

/** The page's code didn't load (offline, or an old build): say so, in the same frame. */
function SharedRouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useLingui();
  return (
    <Frame title={t`Couldn't open this link`}>
      <ErrorState error={error} onRetry={reset} />
    </Frame>
  );
}
