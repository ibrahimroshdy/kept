/**
 * Location settings → General → "Your own codes" (D208, plan T17a; engineering spec §7.16):
 * automatic numbering (off by default: a prefix and a zero-padded counter, `GAR-0001`) and an
 * optional format rule (a pattern, a message in plain words, an example). Owners and admins only
 * (the page's gate). A form, so its choices keep their controls (D211): a switch, text fields and
 * a segmented choice of digits.
 *
 * The server refuses a pattern it can't read, one too slow to check on a long code, an example the
 * pattern doesn't match, and numbering whose next code the rule would refuse; each refusal is said
 * next to the field. Changing the rule never rewrites a code: the codes that no longer match are
 * listed underneath, each linking to its thing or place.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { Form } from 'react-aria-components';
import { isApiError } from '@/api/client';
import {
  codeApi,
  codeKeys,
  type OwnCodeSettings,
  type OwnCodeSettingsBody,
  useCodeMismatches,
  useOwnCodeSettings,
} from '@/api/inventory/codes';
import { ErrorState, List, LoadingRows, Row, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { CodeText } from './own-codes';

const PADS = ['3', '4', '5', '6'] as const;
type Pad = (typeof PADS)[number];

export function OwnCodeSettingsSection({ locationId }: { locationId: string }) {
  const settings = useOwnCodeSettings(locationId);
  return (
    <Section title={<Trans>Your own codes</Trans>}>
      {settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : settings.data ? (
        <div className="grid gap-5">
          <SettingsForm
            key={`${settings.data.rowVersion}`}
            locationId={locationId}
            saved={settings.data}
          />
          <Mismatches locationId={locationId} hasRule={settings.data.rule !== null} />
        </div>
      ) : (
        <LoadingRows rows={3} />
      )}
    </Section>
  );
}

type Problem = { field: 'pattern' | 'example' | 'numbering' | 'form'; text: string };

function SettingsForm({ locationId, saved }: { locationId: string; saved: OwnCodeSettings }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [numbering, setNumbering] = useState(saved.numbering.enabled);
  const [prefix, setPrefix] = useState(saved.numbering.prefix);
  const [pad, setPad] = useState<Pad>(
    (PADS as readonly string[]).includes(String(saved.numbering.pad))
      ? (String(saved.numbering.pad) as Pad)
      : '4',
  );
  const [ruleOn, setRuleOn] = useState(saved.rule !== null);
  const [pattern, setPattern] = useState(saved.rule?.pattern ?? '');
  const [message, setMessage] = useState(saved.rule?.message ?? '');
  const [example, setExample] = useState(saved.rule?.example ?? '');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  // What the next thing gets with the prefix typed now (the server's counter carries on).
  const nextNumber = saved.numbering.next.slice(saved.numbering.prefix.length).replace(/^0+/, '');
  const preview = `${prefix.trim().toUpperCase()}${(nextNumber || '1').padStart(Number(pad), '0')}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const body: OwnCodeSettingsBody = {
      numbering: { enabled: numbering, prefix: prefix.trim(), pad: Number(pad) },
      rule: ruleOn ? { pattern, message, example } : null,
    };
    setBusy(true);
    try {
      await codeApi.saveSettings(locationId, body, saved.rowVersion);
      await Promise.all([
        qc.invalidateQueries({ queryKey: codeKeys.settings(locationId) }),
        qc.invalidateQueries({ queryKey: codeKeys.mismatches(locationId) }),
      ]);
      toast({ title: t`Saved`, tone: 'ok' });
    } catch (err) {
      const reason = isApiError(err) ? (err.details.reason as string | undefined) : undefined;
      const next = isApiError(err) ? (err.details.next as string | undefined) : undefined;
      if (reason === 'invalid')
        setProblem({
          field: 'pattern',
          text: t`Kept can't read this pattern. Check its brackets.`,
        });
      else if (reason === 'slow')
        setProblem({
          field: 'pattern',
          text: t`This pattern takes too long to check on a long code. Make it simpler, for example without a repeat inside a repeat.`,
        });
      else if (reason === 'example')
        setProblem({ field: 'example', text: t`The example doesn't match the pattern.` });
      else if (reason === 'numbering')
        setProblem({
          field: 'numbering',
          text: t`The next numbered code, ${next ?? preview}, doesn't match the format rule. Change the prefix or the rule.`,
        });
      else setProblem({ field: 'form', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const at = (field: Problem['field']) => (problem?.field === field ? problem.text : undefined);

  return (
    <Form onSubmit={(e) => void submit(e)} className="grid gap-5" aria-label={t`Your own codes`}>
      <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
        <Switch isSelected={numbering} onChange={setNumbering}>
          <Trans>Number new things automatically</Trans>
        </Switch>
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Each new thing here gets the next code, which is never given out again, even after it's
            removed. Its short ID stays as it is.
          </Trans>
        </p>
        {numbering ? (
          <>
            <TextField
              label={t`Prefix`}
              value={prefix}
              onChange={setPrefix}
              maxLength={20}
              inputProps={{ dir: 'ltr', autoCapitalize: 'characters', spellCheck: false }}
              isInvalid={!!at('numbering')}
              errorMessage={at('numbering')}
            />
            <Segmented
              label={t`Digits`}
              options={PADS.map((p) => ({ id: p, label: p }))}
              value={pad}
              onChange={setPad}
            />
            <p className="m-0 text-small text-ink-2">
              <Trans>
                The next thing gets <CodeText code={preview} />.
              </Trans>
            </p>
          </>
        ) : null}
      </div>

      <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
        <Switch isSelected={ruleOn} onChange={setRuleOn}>
          <Trans>Check codes against a format rule</Trans>
        </Switch>
        <p className="m-0 text-small text-ink-2">
          <Trans>
            A code that doesn't match is refused when it's added or imported. Changing the rule
            never changes the codes you have.
          </Trans>
        </p>
        {ruleOn ? (
          <>
            <TextField
              label={t`Pattern`}
              description={t`A regular expression the whole code must match. Capital and small letters count as the same.`}
              value={pattern}
              onChange={setPattern}
              isRequired
              maxLength={200}
              inputProps={{ dir: 'ltr', spellCheck: false }}
              isInvalid={!!at('pattern')}
              errorMessage={at('pattern')}
            />
            <TextField
              label={t`Message when a code doesn't match`}
              description={t`In plain words, for whoever types the code.`}
              value={message}
              onChange={setMessage}
              isRequired
              maxLength={200}
            />
            <TextField
              label={t`Example`}
              value={example}
              onChange={setExample}
              isRequired
              maxLength={100}
              inputProps={{ dir: 'ltr', spellCheck: false }}
              isInvalid={!!at('example')}
              errorMessage={at('example')}
            />
          </>
        ) : null}
      </div>

      {problem?.field === 'form' ? (
        <p role="alert" className="m-0 text-small text-danger">
          {problem.text}
        </p>
      ) : null}
      <Button type="submit" className="w-full md:w-auto md:justify-self-start" isPending={busy}>
        <Trans>Save</Trans>
      </Button>
    </Form>
  );
}

function Mismatches({ locationId, hasRule }: { locationId: string; hasRule: boolean }) {
  const { t } = useLingui();
  const f = useFormat();
  const list = useCodeMismatches(locationId, hasRule);
  if (!hasRule) return null;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (!list.data) return <LoadingRows rows={2} />;
  const items = list.data.items;
  const count = f.num(items.length);
  return (
    <div className="grid gap-2">
      <h3 className="m-0 text-[15px] font-semibold text-ink">
        {items.length === 0 ? (
          <Trans>Every code here matches the rule</Trans>
        ) : (
          <Trans>Codes that don't match the rule ({count})</Trans>
        )}
      </h3>
      {items.length > 0 ? (
        <List aria-label={t`Codes that don't match the rule`}>
          {items.map((m) => (
            <Row
              key={`${m.kind}:${m.id}:${m.code}`}
              title={<CodeText code={m.code} />}
              subtitle={
                <Link
                  to={m.kind === 'thing' ? '/t/$id' : '/p/$id'}
                  params={{ id: m.id }}
                  className="text-info underline underline-offset-2 [overflow-wrap:anywhere]"
                >
                  <bdi>{m.name}</bdi>
                </Link>
              }
            />
          ))}
        </List>
      ) : null}
    </div>
  );
}
