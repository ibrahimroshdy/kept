/**
 * The OAuth consent page (step-6 plan T22; D93, D125, D179, D180): an app asks to use your Kept,
 * and you choose what it may do (read, or read and change; never delete) and in which locations
 * (one pre-selected; more shows D179's warning), then Allow or Deny. Kept's answer goes back to
 * the app through the redirect the server returns.
 *
 * The app's name and address are as the app calls itself: untrusted text (D179), isolated and
 * never a link; its logo is never fetched. Outside the app shell, in the auth frame like the
 * sign-in pages, and precached like them (vite.config.ts), so it opens on a cold start. Signed
 * out, the gate sends you to /signin and back here with the app's query intact.
 */
import type { TokenScope } from '@kept/shared';
import { OAUTH_SCOPES } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, type ErrorComponentProps, useRouterState } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { isApiError } from '@/api/client';
import { connectionsApi, useOAuthConsent } from '@/api/connections/queries';
import type { OAuthConsent } from '@/api/connections/types';
import { AuthFrame } from '@/components/auth-frame';
import { useNameList, useScopeMeaning, useScopeWords } from '@/components/connections/words';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Description, Label } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { TickBox } from '@/components/ui/tick-box';
import { useLocationName } from '@/lib/labels';
import { leave } from '@/lib/leave';
import { useOnline } from '@/lib/online';
import { signedInGate } from '@/lib/signed-in-gate';

export const Route = createFileRoute('/oauth/consent')({
  beforeLoad: signedInGate,
  component: ConsentPage,
  errorComponent: RouteError,
});

/**
 * The plugin's query string exactly as the browser has it (it may be signed, so it is passed
 * through untouched); the router's copy where there is no real address bar (tests).
 */
function useRawQuery(): string {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  if (typeof window !== 'undefined' && window.location.pathname === '/oauth/consent')
    return window.location.search;
  return searchStr;
}

function ConsentPage() {
  const { t } = useLingui();
  const query = useRawQuery();
  const consent = useOAuthConsent(query);
  if (consent.isPending)
    return (
      <AuthFrame title={t`Connect an app`}>
        <LoadingRows rows={3} />
      </AuthFrame>
    );
  if (consent.isError) {
    const stale =
      isApiError(consent.error) && (consent.error.status === 400 || consent.error.status === 404);
    return (
      <AuthFrame title={t`Connect an app`}>
        {stale ? (
          <Notice tone="warn" title={<Trans>This request isn't valid any more</Trans>}>
            <Trans>Start connecting again from the app.</Trans>
          </Notice>
        ) : (
          <ErrorState error={consent.error} onRetry={() => void consent.refetch()} />
        )}
      </AuthFrame>
    );
  }
  return <ConsentForm query={query} consent={consent.data} />;
}

function ConsentForm({ query, consent }: { query: string; consent: OAuthConsent }) {
  const { t } = useLingui();
  const online = useOnline();
  const errorText = useErrorText();
  const scopeWords = useScopeWords();
  const scopeMeaning = useScopeMeaning();
  const names = useNameList();
  const { client, locations } = consent;
  const wantsWrite = consent.requestedScopes.includes(OAUTH_SCOPES.write);
  const [chosen, setChosen] = useState<string[]>(() => {
    const first = locations.find((l) => l.canWrite) ?? locations[0];
    return first ? [first.id] : [];
  });
  const [scope, setScope] = useState<TokenScope>('read');
  const [failed, setFailed] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const readOnlyIn = useMemo(
    () => locations.filter((l) => chosen.includes(l.id) && !l.canWrite),
    [locations, chosen],
  );
  const writeAllowed = wantsWrite && readOnlyIn.length === 0;
  const effective: TokenScope = writeAllowed ? scope : 'read';
  const label = useLocationName();

  const answer = useMutation({
    mutationFn: (accept: boolean) =>
      connectionsApi.answerConsent(query, { accept, scope: effective, locationIds: chosen }),
    onSuccess: ({ redirectTo }) => leave.to(redirectTo),
    onError: (e) => setFailed(errorText(e)),
  });

  const name = client.name;
  return (
    <AuthFrame
      title={
        <Trans>
          <bdi>{name}</bdi> wants to use your Kept
        </Trans>
      }
      intro={
        <span className="grid gap-1">
          <span>
            <Trans>That's the name the app gives itself. Kept can't confirm who made it.</Trans>
          </span>
          {client.uri ? (
            <span dir="ltr" className="break-all text-start font-mono text-[13px] text-ink-2">
              {client.uri}
            </span>
          ) : null}
        </span>
      }
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            isDisabled={!online || answer.isPending}
            onPress={() => {
              setFailed(null);
              answer.mutate(false);
            }}
          >
            <Trans>Deny</Trans>
          </Button>
          <Button
            isDisabled={!online}
            isPending={answer.isPending}
            onPress={() => {
              setFailed(null);
              if (!chosen.length) {
                setMissing(true);
                return;
              }
              answer.mutate(true);
            }}
          >
            <Trans>Allow</Trans>
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Segmented<TokenScope>
          label={t`What it can do`}
          value={effective}
          onChange={setScope}
          options={[
            { id: 'read', label: scopeWords('read') },
            ...(wantsWrite
              ? [{ id: 'write' as const, label: scopeWords('write'), isDisabled: !writeAllowed }]
              : []),
          ]}
          description={
            wantsWrite && !writeAllowed ? (
              <Trans>
                Read only: you can't change things in <bdi>{names(readOnlyIn.map(label))}</bdi>, so
                neither can the app.
              </Trans>
            ) : (
              scopeMeaning(effective)
            )
          }
        />
        <div className="grid gap-1">
          <Label id="consent-locations">
            <Trans>Where</Trans>
          </Label>
          <Description>
            <Trans>Pick only what it needs. You can disconnect it in Settings → Connections.</Trans>
          </Description>
          <fieldset aria-labelledby="consent-locations" className="m-0 grid border-0 p-0">
            {locations.map((l) => (
              <TickBox
                key={l.id}
                isSelected={chosen.includes(l.id)}
                onChange={(on) => {
                  setMissing(false);
                  setChosen(on ? [...chosen, l.id] : chosen.filter((id) => id !== l.id));
                }}
                description={!l.canWrite ? <Trans>Read only for you</Trans> : undefined}
              >
                <bdi>{label(l)}</bdi>
              </TickBox>
            ))}
          </fieldset>
          {missing ? (
            <p role="alert" className="m-0 text-danger text-small">
              <Trans>Pick at least one location.</Trans>
            </p>
          ) : null}
        </div>
        {chosen.length > 1 ? (
          <Notice tone="warn" title={<Trans>More than one location</Trans>}>
            {effective === 'write' ? (
              <Trans>
                The app could move what it finds in one into another, so people in one could see
                what came from the other. Connect it to one location unless you mean that.
              </Trans>
            ) : (
              <Trans>
                The app reads all of them together, and could repeat what it reads in one to someone
                who uses another. Connect it to one location unless you mean that.
              </Trans>
            )}
          </Notice>
        ) : null}
        {failed ? <Notice tone="danger">{failed}</Notice> : null}
        {!online ? (
          <p className="m-0 text-ink-2 text-small">
            <Trans>Needs a connection</Trans>
          </p>
        ) : null}
      </div>
    </AuthFrame>
  );
}

/** Offline before the page's first load: "Needs a connection", in the auth frame. */
function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useLingui();
  return (
    <AuthFrame title={t`Connect an app`}>
      <ErrorState error={error} onRetry={reset} />
    </AuthFrame>
  );
}
