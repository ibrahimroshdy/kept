/**
 * The ready-made client configs under a new token (screens §5, T10): the MCP server's URL
 * (`<public URL>/mcp`) and the bearer header, each with Copy. A client's own settings file is
 * shown only when the server sends one (`file`), because its shape has to come from that client's
 * documentation: the web never makes one up (step-6 plan T10; Phase 0's note on clientConfigs).
 * A config that is just the URL and header again isn't repeated.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { ClientConfig, CreatedToken } from '@/api/connections/types';
import { Section } from '@/components/page';
import { CopyButton } from '@/components/ui/copy-button';

function Field({ label, value, copy }: { label: ReactNode; value: string; copy: string }) {
  return (
    <div className="grid gap-1.5 px-3.5 py-2.5">
      <div className="text-small text-ink-2">{label}</div>
      <div className="flex flex-wrap items-start gap-2">
        <code
          dir="ltr"
          className="min-w-0 flex-1 basis-56 select-all break-all font-mono text-[13px] text-ink"
        >
          {value}
        </code>
        <CopyButton text={value} label={copy} size="small" />
      </div>
    </div>
  );
}

export function ClientConfigs({ configs }: { configs: CreatedToken['clientConfigs'] }) {
  const { t } = useLingui();
  const { generic, claudeDesktop } = configs;
  const files: { title: ReactNode; config: ClientConfig }[] = [];
  if (claudeDesktop.file)
    files.push({ title: <Trans>Claude Desktop</Trans>, config: claudeDesktop });
  if (generic.file) files.push({ title: <Trans>Any MCP client</Trans>, config: generic });
  return (
    <Section title={<Trans>Connect an app</Trans>}>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          In the app, add an MCP server (it may be called a connector or an integration) with this
          address, and send the token in this header.
        </Trans>
      </p>
      <div className="grid overflow-hidden rounded-[10px] border border-line bg-surface [&>*+*]:border-line [&>*+*]:border-t">
        <Field label={<Trans>Server address</Trans>} value={generic.url} copy={t`Copy address`} />
        {Object.entries(generic.headers).map(([name, value]) => (
          <Field
            key={name}
            label={<span dir="ltr">{name}</span>}
            value={value}
            copy={t`Copy header`}
          />
        ))}
      </div>
      {files.map(({ title, config }) =>
        config.file ? (
          <div
            key={config.file.name}
            className="grid gap-1.5 rounded-[10px] border border-line bg-surface p-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-[14px] text-ink">
                {title}
                <span className="ms-1.5 font-mono font-normal text-[12.5px] text-ink-2" dir="ltr">
                  {config.file.name}
                </span>
              </span>
              <CopyButton text={config.file.contents} label={t`Copy`} size="small" />
            </div>
            <pre
              dir="ltr"
              className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-sunken p-2.5 font-mono text-[12.5px] text-ink"
            >
              {config.file.contents}
            </pre>
          </div>
        ) : null,
      )}
    </Section>
  );
}
