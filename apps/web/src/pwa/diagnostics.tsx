/**
 * The diagnostics panel (Settings → Me → This device; D188, L87, L96; plan T23). Opt-in: nothing
 * runs until "Run the checks", because the camera check asks for permission. Each check shows ✓
 * or ✗ with its facts, and "Copy report" copies them as text, for the device checklist.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { CheckCircleIcon, InfoIcon, XIcon } from '@/components/icons';
import { List, Notice } from '@/components/page';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';
import { PROBE_KEYS, type ProbeKey, type ProbeResult, reportText, runProbe } from './probes';

export function DiagnosticsPanel({
  run = runProbe,
}: {
  run?: (key: ProbeKey) => Promise<ProbeResult>;
}) {
  const { t } = useLingui();
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const [running, setRunning] = useState(false);

  const labels: Record<ProbeKey, string> = {
    secure: t`Secure connection (HTTPS)`,
    standalone: t`Opened as the installed app`,
    serviceWorker: t`Offline support (service worker)`,
    storage: t`Storage kept by the phone`,
    indexedDb: t`Saving on this device`,
    barcode: t`Barcode scanner`,
    camera: t`Camera`,
    heic: t`iPhone photos (HEIC)`,
    geolocation: t`Location permission`,
    dictation: t`Dictation (the mic)`,
    print: t`Print page sizes`,
  };

  async function start() {
    setRunning(true);
    const out: ProbeResult[] = [];
    // One at a time: the camera prompt shouldn't race the others.
    for (const key of PROBE_KEYS) {
      out.push(await run(key));
      setResults([...out]);
    }
    setRunning(false);
  }

  const rows = (results ?? []).map((result) => ({ label: labels[result.key], result }));
  const report = reportText(
    [`Kept diagnostics · ${new Date().toISOString()}`, navigator.userAgent],
    rows,
  );

  return (
    <div className="grid gap-3">
      <Notice tone="info">
        <Trans>
          Checks what this phone or browser can do: the camera, offline support, storage and
          install. Nothing is sent; you copy the report yourself. The camera check asks for
          permission.
        </Trans>
      </Notice>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onPress={() => void start()} isDisabled={running}>
          {results ? <Trans>Run the checks again</Trans> : <Trans>Run the checks</Trans>}
        </Button>
        {results && !running ? <CopyButton text={report} label={t`Copy report`} /> : null}
      </div>
      {results ? (
        <List aria-label={t`Diagnostics results`} aria-busy={running}>
          {rows.map(({ label, result }) => (
            <li key={result.key} className="flex items-start gap-3 px-3.5 py-3">
              <StatusMark status={result.status} />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <div className="font-semibold text-[15px]">{label}</div>
                {result.facts.length ? (
                  <div className="ltr text-start font-mono text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">
                    {result.facts.join(' ')}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </List>
      ) : null}
    </div>
  );
}

function StatusMark({ status }: { status: ProbeResult['status'] }) {
  const { t } = useLingui();
  const Icon = status === 'ok' ? CheckCircleIcon : status === 'fail' ? XIcon : InfoIcon;
  const label =
    status === 'ok' ? t`Works` : status === 'fail' ? t`Doesn't work` : t`For information`;
  return (
    <span
      className={cn(
        'mt-0.5 grid size-6 shrink-0 place-items-center [&_svg]:size-5',
        status === 'ok' ? 'text-ok' : status === 'fail' ? 'text-danger' : 'text-ink-2',
      )}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
