/**
 * Tokens and connected apps (screens §5 "Connections", D58, D63, D179, D180): the only place
 * tokens live. One list on the list standard (L88): search by name, filters for the location
 * (screens §5: "filtered by location"), the kind and whether it still works, grouped by kind so
 * the connected apps (OAuth) sit apart from your personal tokens, and "Load more". Everything is
 * in the URL. `GET /tokens` takes only a cursor, so the narrowing is done here over the loaded
 * pages.
 *
 * A personal token's row: its name, what it may do, where, when it was last used and when it
 * expires, with Revoke. Never its secret: that was shown once, when it was made.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTokens } from '@/api/connections/queries';
import type { TokenRow as Row, TokensPage } from '@/api/connections/types';
import { useLocations } from '@/api/queries';
import { KeyIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, IconTile, Pill } from '@/components/page';
import { isolate } from '@/lib/bidi';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { firstOf, useListState } from '@/lib/url-state';
import { OAuthAppRow } from './oauth-apps';
import { RevokeButton } from './revoke';
import { useNameList, useRevokedWords, useScopeWords } from './words';

/** The URL filter keys this list owns (the route's `listSearch`). */
export const CONNECTION_FILTERS = ['location', 'kind', 'state'] as const;

export function ConnectionsList({ action }: { action?: ReactNode }) {
  const { t } = useLingui();
  const [list] = useListState();
  const query = useTokens();
  const locations = useLocations();
  const nameOf = useLocationName();
  const all = query.data?.pages.flatMap((p) => p.items) ?? [];

  const wanted = list.filters.location ?? [];
  const notLocation = list.not.includes('location');
  const kind = firstOf(list, 'kind');
  const state = firstOf(list, 'state');
  const q = list.q.trim().toLocaleLowerCase();
  const shown = all
    .filter((r) => !q || (r.clientName ?? r.name).toLocaleLowerCase().includes(q))
    .filter((r) => !wanted.length || r.locations.some((l) => wanted.includes(l.id)) !== notLocation)
    .filter((r) => !kind || r.kind === kind)
    .filter((r) => !state || (state === 'active') === (r.revokedAt === null));
  const by = list.group ?? 'kind';
  // Grouped by kind: personal tokens first, then the connected apps, as the board draws them.
  const ordered =
    by === 'kind'
      ? [...shown.filter((r) => r.kind === 'personal'), ...shown.filter((r) => r.kind === 'oauth')]
      : shown;
  const narrowed = {
    ...query,
    data: query.data
      ? {
          pages: [{ items: ordered, next_cursor: query.data.pages.at(-1)?.next_cursor ?? null }],
          pageParams: [undefined],
        }
      : undefined,
  } as unknown as UseInfiniteQueryResult<InfiniteData<TokensPage>>;

  return (
    <ListSurface<Row>
      label={t`Tokens and connected apps`}
      search={{
        label: t`Search tokens and apps`,
        placeholder: t`Search by name`,
        ...(action ? { end: action } : {}),
      }}
      filters={[
        {
          key: 'location',
          label: t`Location`,
          kind: 'multi',
          values: {
            from: 'static',
            options: (locations.data ?? []).map((l) => ({ value: l.id, label: nameOf(l) })),
          },
        },
        {
          key: 'kind',
          label: t`Kind`,
          kind: 'single',
          values: {
            from: 'static',
            options: [
              { value: 'personal', label: t`Personal tokens` },
              { value: 'oauth', label: t`Connected apps` },
            ],
          },
        },
        {
          key: 'state',
          label: t`State`,
          kind: 'single',
          values: {
            from: 'static',
            options: [
              { value: 'active', label: t`Working` },
              { value: 'ended', label: t`Revoked or expired` },
            ],
          },
        },
      ]}
      groups={[
        { value: 'kind', label: t`Kind`, short: t`by kind` },
        { value: 'none', label: t`None` },
      ]}
      defaultGroup="kind"
      groupOf={(r, g) =>
        g === 'kind'
          ? r.kind === 'oauth'
            ? { key: 'oauth', label: <Trans>Connected apps (OAuth)</Trans> }
            : { key: 'personal', label: <Trans>Personal tokens</Trans> }
          : null
      }
      query={narrowed}
      getKey={(r) => r.id}
      renderRow={(r) => (r.kind === 'oauth' ? <OAuthAppRow app={r} /> : <TokenRowView token={r} />)}
      empty={
        <EmptyState icon={<KeyIcon />} title={<Trans>No tokens yet</Trans>}>
          <Trans>
            A token lets an app such as Claude Desktop, or a Shortcut on your phone, find and add
            your things. Make one for each app, limited to the locations it needs.
          </Trans>
        </EmptyState>
      }
    />
  );
}

export function TokenRowView({ token }: { token: Row }) {
  const { t } = useLingui();
  const f = useFormat();
  const scopeWords = useScopeWords();
  const revoked = useRevokedWords();
  const names = useNameList();
  const locationName = useLocationName();
  const scope = scopeWords(token.scope);
  const where = names(token.locations.map(locationName));
  const used = token.lastUsedAt ? f.relative(token.lastUsedAt) : null;
  const expires = token.expiresAt ? f.day(token.expiresAt) : null;
  const ended = token.revokedAt !== null;
  const name = isolate(token.name);
  return (
    <div className="flex min-h-14 items-start gap-3 px-3.5 py-2.5">
      <IconTile>
        <KeyIcon />
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
          <bdi>{token.name}</bdi>
        </div>
        <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
          {used ? (
            <Trans>
              {scope} · <bdi>{where}</bdi> · used {used}
            </Trans>
          ) : (
            <Trans>
              {scope} · <bdi>{where}</bdi> · not used yet
            </Trans>
          )}
        </div>
        {ended ? (
          <Pill className="mt-1">{revoked(token.revokedReason)}</Pill>
        ) : expires ? (
          <div className="text-small text-ink-3">
            <Trans>Expires {expires}</Trans>
          </div>
        ) : null}
      </div>
      {ended ? null : (
        <RevokeButton
          token={token}
          label={t`Revoke`}
          title={t`Revoke ${name}?`}
          body={t`Apps using it stop working at once. Changes it made stay, and can still be undone for 7 days.`}
        />
      )}
    </div>
  );
}
