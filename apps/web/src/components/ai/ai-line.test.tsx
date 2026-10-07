import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AiCallSummary } from '@/api/capture/types';
import { renderUI } from '@/test/render';
import { AiLine } from './ai-line';

const call = (over: Partial<AiCallSummary> = {}): AiCallSummary => ({
  model: 'qwen/qwen3.8-27b',
  providerKind: 'groq',
  tokens: 1640,
  images: 1,
  costSource: 'unknown',
  paidBy: { scope: 'account', label: 'Personal' },
  outcome: 'ok',
  errorCode: null,
  ...over,
});

/** The whole line: its parts are separate spans, so the text is read off the paragraph. */
const lineOf = () => screen.getByText(/^AI · /).closest('p') as HTMLElement;

describe('the AI line', () => {
  it('is short: provider, compact tokens, cost and payer, no model id', async () => {
    await renderUI(
      <AiLine
        call={call({
          cost: { amount: '0.0039', currency: 'USD' },
          costSource: 'price_table',
          paidBy: { scope: 'account', label: 'Personal', mine: true },
        })}
      />,
    );
    const line = lineOf();
    expect(line.textContent).toBe('AI · Groq · 1.6K tokens · ≈ $0.004 · paid by you');
    expect(line.textContent).not.toMatch(/qwen/);
  });

  it('says cost unknown without a price, and names a payer that is not the viewer', async () => {
    await renderUI(<AiLine call={call({ paidBy: { scope: 'account', label: 'Home' } })} />);
    expect(lineOf().textContent).toBe('AI · Groq · 1.6K tokens · cost unknown · paid by Home');
  });

  it('keeps a code on currencies other than the dollar, and 2 decimals from 0.01', async () => {
    await renderUI(
      <AiLine
        call={call({
          cost: { amount: '0.19', currency: 'EGP' },
          costSource: 'price_table',
          paidBy: { scope: 'user', label: 'Ibrahim', mine: true },
        })}
      />,
    );
    expect(lineOf().textContent).toMatch(/≈ EGP\s0\.19 · paid by you$/);
  });

  it('is a link without a dotted underline when it opens the call', async () => {
    await renderUI(<AiLine call={call({ id: '01926f00-0000-7000-8000-0000000c0001' })} />);
    const button = screen.getByRole('button', { name: /^AI · Groq/ });
    expect(button.className).not.toMatch(/decoration-dotted/);
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  });
});
