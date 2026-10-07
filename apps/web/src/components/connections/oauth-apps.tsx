/**
 * A connected app (OAuth, D93, D125, D179): an app you allowed on Kept's consent page. Its name is
 * as the app calls itself, untrusted text (D179), so it is isolated and never a link. It shows what
 * it may do, where, when you allowed it and when it last called, with Revoke: Kept checks the
 * grant on every call, so the next call fails at once (step-6 plan Q7).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { TokenRow } from '@/api/connections/types';
import { ShieldIcon } from '@/components/icons';
import { IconTile, Pill } from '@/components/page';
import { isolate } from '@/lib/bidi';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { RevokeButton } from './revoke';
import { useNameList, useRevokedWords, useScopeWords } from './words';

export function OAuthAppRow({ app }: { app: TokenRow }) {
  const { t } = useLingui();
  const f = useFormat();
  const scopeWords = useScopeWords();
  const revoked = useRevokedWords();
  const names = useNameList();
  const locationName = useLocationName();
  const name = app.clientName ?? app.name;
  const appName = isolate(name);
  const scope = scopeWords(app.scope);
  const where = names(app.locations.map(locationName));
  const granted = f.day(app.createdAt);
  const used = app.lastUsedAt ? f.relative(app.lastUsedAt) : null;
  const ended = app.revokedAt !== null;
  return (
    <div className="flex min-h-14 items-start gap-3 px-3.5 py-2.5">
      <IconTile>
        <ShieldIcon />
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
          <bdi>{name}</bdi>
        </div>
        <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
          {used ? (
            <Trans>
              {scope} · <bdi>{where}</bdi> · allowed {granted} · used {used}
            </Trans>
          ) : (
            <Trans>
              {scope} · <bdi>{where}</bdi> · allowed {granted} · not used yet
            </Trans>
          )}
        </div>
        {ended ? <Pill className="mt-1">{revoked(app.revokedReason)}</Pill> : null}
      </div>
      {ended ? null : (
        <RevokeButton
          token={app}
          label={t`Revoke`}
          title={t`Disconnect ${appName}?`}
          body={t`It stops reaching your Kept at once. To use it again, connect it again from the app.`}
        />
      )}
    </div>
  );
}
