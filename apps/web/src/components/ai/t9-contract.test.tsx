/**
 * The web's side of T9's contract (apps/server/src/ai/api.ts), where the server leaves a label
 * empty or a figure at zero: the instance key's calls and the instance's own caps have an empty
 * label, and "This server" names them; a Test whose photo request was never made has
 * `vision.latencyMs` 0, which reads "not sent".
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AiCallSummary, AiCap, AiStatus, AiTestResult } from '@/api/capture/types';
import { renderUI } from '@/test/render';
import { AiLine } from './ai-line';
import { useCapName, useCapWho } from './cap-bars';
import { TestResultLine } from './paste-key';
import { usePauseReason } from './paused-banner';

function Reason({ status }: { status: Pick<AiStatus, 'reason' | 'pausedBy'> }) {
  return <p>{usePauseReason()(status as AiStatus)}</p>;
}

const call: AiCallSummary = {
  model: 'qwen2.5vl:7b',
  providerKind: 'openai_compatible',
  tokens: 1670,
  images: 1,
  costSource: 'unknown',
  paidBy: { scope: 'instance', label: '' },
  outcome: 'ok',
};

const cap = (scope: AiCap['scope'], id: string | null): AiCap => ({
  id: 'c',
  scope,
  target: { id, label: '' },
  task: null,
  used: { tokens: 0, cost: [], unknownCostCalls: 0 },
  percent: null,
  state: 'active',
  cappedByAccount: false,
  rowVersion: 1,
  canEdit: true,
});

function Names({ caps }: { caps: AiCap[] }) {
  const name = useCapName();
  const who = useCapWho();
  return (
    <ul>
      {caps.map((c) => (
        <li key={`${c.scope}:${c.target.id}`}>
          {name(c)} | {who(c)}
        </li>
      ))}
    </ul>
  );
}

describe("T9's empty labels and zero latency", () => {
  it('a call the instance key paid reads "paid by this server"', async () => {
    await renderUI(<AiLine call={call} />);
    expect(screen.getByText(/paid by this server/)).toBeInTheDocument();
  });

  it("the instance's caps are this server's, whatever their empty label", async () => {
    await renderUI(
      <Names
        caps={[
          cap('instance', null),
          cap('instance_account', null),
          cap('instance_account', 'acct'),
        ]}
      />,
    );
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual([
      'This server, overall | This server',
      "Each account on this server's key | This server",
      "An account on this server's key | This server",
    ]);
  });

  it("a pause by the instance's cap names this server", async () => {
    await renderUI(
      <Reason status={{ reason: 'cap_money', pausedBy: { scope: 'instance', label: '' } }} />,
    );
    expect(screen.getByText("This server's monthly cap reached")).toBeInTheDocument();
  });

  it('a Test whose photo request was never made says "not sent", not "not read"', async () => {
    const result: AiTestResult = {
      vision: { ok: false, latencyMs: 0, error: 'paused_cap_money' },
      structured: { ok: false, error: 'not_run' },
      model: 'qwen/qwen3.8-27b',
      tokens: 0,
    };
    await renderUI(<TestResultLine result={result} />);
    expect(screen.getByText('Photos: not sent')).toBeInTheDocument();
    expect(screen.queryByText('Photos: not read')).toBeNull();
    expect(screen.getByText(/wasn't sent/)).toBeInTheDocument();
  });

  it('a photo the model answered wrongly reads "not read"', async () => {
    await renderUI(
      <TestResultLine
        result={{
          vision: { ok: false, latencyMs: 640, error: 'wrong_answer' },
          structured: { ok: true },
          model: 'llama-3.3-70b-versatile',
          tokens: 1300,
        }}
      />,
    );
    expect(screen.getByText('Photos: not read')).toBeInTheDocument();
    expect(screen.getByText(/can't read photos here/)).toBeInTheDocument();
  });
});
