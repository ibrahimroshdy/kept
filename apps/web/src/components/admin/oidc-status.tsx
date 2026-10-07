/**
 * Admin → Status's sign-in and connector rows (step-6 plan T22; D63, D125, D127, spike S6.7):
 * - OIDC: configured or not, its name and issuer, the callback URL to register at the provider,
 *   and why boot-time discovery failed (OIDC is then off until Kept restarts);
 * - the MCP endpoint's URL, and whether OAuth connectors are available or need an https public
 *   URL (D125); personal tokens work either way.
 * OIDC is configured by environment only (step-6 plan Q16): there is nothing to edit here.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { AdminStatus } from '@/api/types';
import { List, Notice, Pill, Section } from '@/components/page';
import { CopyButton } from '@/components/ui/copy-button';

type Oidc = NonNullable<AdminStatus['oidc']>;
type Connectors = NonNullable<AdminStatus['connectors']>;

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <li className="grid gap-1 px-3.5 py-2.5">
      <span className="text-small text-ink-3">{label}</span>
      <span className="text-[15px] text-ink [overflow-wrap:anywhere]">{children}</span>
    </li>
  );
}

function UrlValue({ url, copy }: { url: string; copy: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code dir="ltr" className="min-w-0 flex-1 basis-56 break-all font-mono text-[13px]">
        {url}
      </code>
      <CopyButton text={url} label={copy} size="small" />
    </span>
  );
}

/** Why discovery failed at boot, in words (the reason codes the spike proposed for T16). */
function useOidcErrorWords() {
  const { t } = useLingui();
  return (code: string) => {
    switch (code) {
      case 'private_address':
        return t`The provider's address is on a private network, which this server doesn't allow.`;
      case 'issuer_mismatch':
        return t`The provider says it's a different issuer from KEPT_OIDC_ISSUER.`;
      case 'insecure_endpoint':
        return t`One of the provider's addresses isn't https.`;
      case 'http_status':
        return t`The provider's discovery document didn't load.`;
      default:
        return t`The provider couldn't be reached when Kept started.`;
    }
  };
}

export function OidcStatus({ oidc }: { oidc: Oidc }) {
  const { t } = useLingui();
  const reason = useOidcErrorWords();
  const name = oidc.name ?? 'OIDC';
  return (
    <Section title={<Trans>Sign-in with OIDC</Trans>}>
      {oidc.error ? (
        <Notice tone="warn" title={<Trans>OIDC sign-in is off</Trans>}>
          {reason(oidc.error)}{' '}
          <Trans>Fix it, then restart Kept. Everything else works meanwhile.</Trans>
        </Notice>
      ) : null}
      <List>
        <Line label={<Trans>State</Trans>}>
          {oidc.configured && !oidc.error ? (
            <span className="flex flex-wrap items-center gap-2">
              <Pill tone="ok">
                <Trans>On</Trans>
              </Pill>
              <Trans>
                People see "Sign in with <bdi>{name}</bdi>"
              </Trans>
            </span>
          ) : oidc.configured ? (
            <Pill tone="warn">
              <Trans>Configured, not working</Trans>
            </Pill>
          ) : (
            <span className="grid gap-1">
              <Pill>
                <Trans>Not configured</Trans>
              </Pill>
              <span className="text-small text-ink-2">
                <Trans>
                  Set <code className="ltr whitespace-nowrap">KEPT_OIDC_ISSUER</code>,{' '}
                  <code className="ltr whitespace-nowrap">KEPT_OIDC_CLIENT_ID</code> and{' '}
                  <code className="ltr whitespace-nowrap">KEPT_OIDC_CLIENT_SECRET</code>, then
                  restart Kept.
                </Trans>
              </span>
            </span>
          )}
        </Line>
        {oidc.issuer ? (
          <Line label={<Trans>Issuer</Trans>}>
            <code dir="ltr" className="break-all font-mono text-[13px]">
              {oidc.issuer}
            </code>
          </Line>
        ) : null}
        {oidc.callbackUrl ? (
          <Line label={<Trans>Callback URL to register at the provider</Trans>}>
            <UrlValue url={oidc.callbackUrl} copy={t`Copy`} />
          </Line>
        ) : null}
      </List>
      <p className="m-0 text-small text-ink-3">
        <Trans>
          Signing in this way reaches only an account already linked to it, or someone invited here.
          Kept never joins accounts because their emails match.
        </Trans>
      </p>
    </Section>
  );
}

export function ConnectorsStatus({ connectors }: { connectors: Connectors }) {
  const { t } = useLingui();
  return (
    <Section title={<Trans>Connections from other apps</Trans>}>
      <List>
        <Line label={<Trans>MCP endpoint</Trans>}>
          <UrlValue url={connectors.mcpUrl} copy={t`Copy`} />
        </Line>
        <Line label={<Trans>Connectors (OAuth)</Trans>}>
          {connectors.oauth === 'available' ? (
            <Pill tone="ok">
              <Trans>Available</Trans>
            </Pill>
          ) : (
            <span className="grid gap-1">
              <Pill tone="warn">
                <Trans>Needs an https public URL</Trans>
              </Pill>
              <span className="text-small text-ink-2">
                <Trans>
                  Apps like claude.ai connect over OAuth only to an https address they can reach.
                  Set <code className="ltr whitespace-nowrap">KEPT_PUBLIC_URL</code> to one. Until
                  then, people connect apps with a personal token.
                </Trans>
              </span>
            </span>
          )}
        </Line>
      </List>
    </Section>
  );
}
