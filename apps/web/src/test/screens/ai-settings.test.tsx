/**
 * AI settings (T29; D191, D202, D206): what uses AI, paste-and-test with kind detection, the
 * write-only key, the model picker, the suggested cap, caps, the member and viewer views, the paused
 * state with Resume now, and RTL.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { capturePaths as cp } from '@/api/capture/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

const L = INV_IDS.loc;

/** No key yet, the recovery kit acknowledged, Home not paused. */
function freshOwner() {
  const s = ownerScenario();
  s.capture.providers = [];
  s.capture.caps = [];
  s.me.instance.recoveryKitAcknowledged = true;
  const home = s.capture.aiStatus[L.home];
  if (home) Object.assign(home, { pausedUntil: null, reason: null, pausedBy: null });
  return s;
}

describe('AI settings', () => {
  it('opens with What uses AI, then where the key lives, and marks the page opened (D191)', async () => {
    const { mock } = await renderApp('/settings/ai', { state: freshOwner() });
    expect(await screen.findByText('What uses AI in Kept')).toBeInTheDocument();
    expect(await screen.findByText('Each captured photo')).toBeInTheDocument();
    expect(screen.getByText(/Measured by Kept on/)).toBeInTheDocument();
    expect(screen.getByText(/This key pays for all of/)).toHaveTextContent('Home, Garage');
    expect(screen.getByRole('heading', { name: 'Recommended: Groq' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get a Groq key' })).toHaveAttribute(
      'href',
      'https://console.groq.com/keys',
    );
    await waitFor(() =>
      expect(mock.lastCall('PUT', '/api/v1/me/hints/ai_settings_opened')?.body).toEqual({
        seen: true,
      }),
    );
  });

  it('a Groq key picks qwen, tests itself, is never echoed back, and suggests a limit once', async () => {
    const { user, mock } = await renderApp('/settings/ai', { state: freshOwner() });
    const box = await screen.findByLabelText('Paste your key');
    await user.type(box, 'gsk_live0000secretWXYZ');
    expect(screen.getByText('Looks like a Groq key.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(mock.lastCall('PUT', cp.aiProvider('account'))).toBeTruthy());
    expect(mock.lastCall('PUT', cp.aiProvider('account'))?.body).toEqual({
      apiKey: 'gsk_live0000secretWXYZ',
    });
    expect(await screen.findByText('Structured answers')).toBeInTheDocument();
    expect(screen.getByText(/Test used/)).toBeInTheDocument();
    // Write-only: the key is nowhere in the page, only its last four.
    expect(document.body.innerHTML).not.toContain('secretWXYZ');
    expect(screen.getByText(/WXYZ/)).toHaveTextContent('••••WXYZ');
    expect(screen.getAllByText('qwen/qwen3.8-27b', { exact: false }).length).toBeGreaterThan(0);
    // "Set a monthly limit?" with the suggestion; No limit sets nothing.
    expect(await screen.findByText('Set a monthly limit?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'No limit' }));
    expect(screen.queryByText('Set a monthly limit?')).not.toBeInTheDocument();
    expect(mock.lastCall('PUT', cp.aiCaps)).toBeUndefined();
  });

  it('an sk-or- key is OpenRouter, not OpenAI; an unknown key opens Advanced', async () => {
    const { user } = await renderApp('/settings/ai', { state: freshOwner() });
    const box = await screen.findByLabelText('Paste your key');
    await user.type(box, 'sk-or-v1-abcdef');
    expect(screen.getByText('Looks like a OpenRouter key.')).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'mystery-key-123456');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(
      await screen.findByText(
        "Kept can't tell which provider this key is for. Choose it under Advanced.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('the first key needs the recovery kit (D193)', async () => {
    const s = freshOwner();
    s.me.instance.recoveryKitAcknowledged = false;
    const { user } = await renderApp('/settings/ai', { state: s });
    await user.type(await screen.findByLabelText('Paste your key'), 'gsk_abcdefgh');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByText('Download the recovery kit first')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the status page' })).toBeInTheDocument();
  });

  it('the model picker offers only photo-reading models for photos, and flags a missing one', async () => {
    const s = ownerScenario();
    const provider = s.capture.providers[0];
    if (provider) provider.models = { vision: 'qwen/qwen3.8-27b', chat: 'retired-model' };
    const { user } = await renderApp('/settings/ai', { state: s });
    await user.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText(/is no longer offered by Groq/)).toBeInTheDocument();
    const photos = screen.getByRole('combobox', { name: 'Photos and receipts' });
    await user.click(photos);
    await user.clear(photos);
    const listbox = await screen.findByRole('listbox');
    const names = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    expect(names.some((n) => n.startsWith('qwen/qwen3.8-27b') && n.includes('Recommended'))).toBe(
      true,
    );
    expect(names.some((n) => n.includes('gpt-oss-120b'))).toBe(false);
    expect(names.some((n) => n.includes('Run Test to check photos'))).toBe(true);
    // No custom model id for a named provider.
    expect(screen.queryByLabelText(/Custom model id/)).not.toBeInTheDocument();
  });

  it('a location cap above the account cap is refused inline', async () => {
    const s = ownerScenario();
    s.capture.caps.push({
      id: 'cap-account',
      scope: 'account',
      target: { id: 'account', label: 'Ibrahim' },
      task: null,
      monthlyCap: { amount: '5.00', currency: 'USD' },
      used: { tokens: 0, cost: [], unknownCostCalls: 0 },
      percent: 0,
      state: 'active',
      cappedByAccount: false,
      rowVersion: 1,
      canEdit: true,
    });
    const { user } = await renderApp('/settings/ai', { state: s });
    await user.click(await screen.findByRole('button', { name: 'Advanced' }));
    const garage = (await screen.findAllByText('Garage')).find((el) => el.closest('li'));
    const row = garage?.closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Set a limit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set a limit' });
    await user.type(within(dialog).getByLabelText('Money a month'), '9');
    expect(within(dialog).getByText("Can't be above the account's cap")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save limit' })).toBeDisabled();
  });

  it('paused: the banner, and Resume now raises the cap by 25% and resumes', async () => {
    const { user, mock } = await renderApp('/settings/ai');
    expect(await screen.findByText(/Home's monthly cap reached/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume now' }));
    const sheet = await screen.findByRole('dialog', { name: 'Resume AI' });
    expect(within(sheet).getByText(/has used USD 5.00 of USD 5.00 this month/)).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Raise the cap to (USD)')).toHaveValue('6.25');
    await user.click(within(sheet).getByRole('button', { name: 'Raise and resume' }));
    await waitFor(() =>
      expect(
        mock.lastCall('POST', cp.aiCapResume(mock.state.capture.caps[0]?.id ?? ''))?.body,
      ).toEqual({ raiseTo: { amount: '6.25', currency: 'USD' } }),
    );
    expect(await screen.findByText('AI resumed')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/Home's monthly cap reached/)).not.toBeInTheDocument(),
    );
  });

  it('a member sees who pays and their own month, no key box, and is told whom to ask', async () => {
    await renderApp('/settings/ai', { state: memberScenario() });
    expect(await screen.findByText('What uses AI in Kept')).toBeInTheDocument();
    expect(await screen.findByText(/is paid by/)).toHaveTextContent(
      "AI in Home is paid by Ibrahim's account.",
    );
    expect(screen.queryByLabelText('Paste your key')).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'SPAN' && el.textContent === 'Ask Ibrahim to resume',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume now' })).not.toBeInTheDocument();
  });

  it('what uses AI: history once there are 5 calls, and tokens only without a price', async () => {
    const s = ownerScenario();
    s.capture.prices = [];
    const { unmount } = await renderApp('/settings/ai', { state: s });
    expect(await screen.findByText('Each captured photo')).toBeInTheDocument();
    expect(screen.getAllByText(/add a price to see cost/).length).toBeGreaterThan(0);
    unmount();
    const h = ownerScenario();
    const base = h.capture.calls.find((c) => c.task === 'extract_thing' && c.sent);
    if (base)
      for (let i = 0; i < 5; i++)
        h.capture.calls.push({ ...base, id: `hist-${i}`, at: new Date().toISOString() });
    await renderApp('/settings/ai', { state: h });
    expect(
      await screen.findByText('From your last 30 days, for actions you’ve used at least 5 times.', {
        normalizer: (x) => x.replace(/'/g, '’'),
      }),
    ).toBeInTheDocument();
  });

  it('Test is disabled offline, with the reason', async () => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      await renderApp('/settings/ai');
      expect(await screen.findByRole('button', { name: 'Test' })).toBeDisabled();
      expect(screen.getByText('Test needs a connection')).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(navigator, 'onLine', original);
      else Reflect.deleteProperty(navigator, 'onLine');
    }
  });

  it('Personal AI key carries its note; Admin → AI edits prices in versions', async () => {
    await renderApp('/settings/me/ai');
    expect(
      await screen.findByText(
        'Used for Personal, your private threads, and questions that span owners.',
      ),
    ).toBeInTheDocument();
  });

  it('Admin → AI: a new price version, and a prefill that saves nothing', async () => {
    const s = ownerScenario();
    s.capture.providers = s.capture.providers.map((p) => ({ ...p, scope: 'instance' as const }));
    const { user, mock } = await renderApp('/admin/ai', { state: s });
    await user.click(await screen.findByRole('button', { name: 'New version' }));
    const sheet = await screen.findByRole('dialog', { name: 'New price version' });
    const input = within(sheet).getByLabelText('Input, per million tokens');
    await user.clear(input);
    await user.type(input, '0.12');
    await user.click(within(sheet).getByRole('button', { name: 'Save price' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', cp.adminAiPrices)?.body).toMatchObject({ inputPerMtok: '0.12' }),
    );
    expect(await screen.findByText(/Price saved as version 2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Fill from Groq's listing" }));
    expect(await screen.findByText(/proposed from the listing/)).toBeInTheDocument();
    expect(mock.state.capture.prices.filter((p) => p.source === 'provider_listing')).toHaveLength(
      0,
    );
    // Saving a proposed row says when the provider listed it (T9: a provider_listing version).
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    const review = await screen.findByRole('dialog', { name: 'Add a price' });
    await user.click(within(review).getByRole('button', { name: 'Save price' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', cp.adminAiPrices)?.body).toMatchObject({
        listingFetchedAt: expect.any(String),
      }),
    );
    await waitFor(() =>
      expect(mock.state.capture.prices.filter((p) => p.source === 'provider_listing')).toHaveLength(
        1,
      ),
    );
  });

  it('Admin → AI: an account found by its owner gets its own cap on the server key (T19)', async () => {
    const s = ownerScenario();
    s.capture.providers = s.capture.providers.map((p) => ({ ...p, scope: 'instance' as const }));
    const { user } = await renderApp('/admin/ai', { state: s });
    await user.click(await screen.findByRole('button', { name: /Advanced/ }));
    const picker = await screen.findByRole('combobox', { name: 'Limit an account' });
    await user.type(picker, 'Bru');
    await user.click(await screen.findByRole('option', { name: /Bruce/ }));
    expect(
      await screen.findByRole('dialog', { name: 'Set a limit for Bruce' }),
    ).toBeInTheDocument();
  });

  it('replacing a key sends If-Match with the version it started from (T9)', async () => {
    const { user, mock } = await renderApp('/settings/ai');
    await user.click(await screen.findByRole('button', { name: 'Replace key' }));
    await user.type(await screen.findByLabelText('Paste the new key'), 'gsk_live0000secretABCD');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(mock.lastCall('PUT', cp.aiProvider('account'))).toBeTruthy());
    expect(mock.lastCall('PUT', cp.aiProvider('account'))?.headers['if-match']).toBe('1');
  });

  it('a model list the provider refused or never answered says so (409 ai_unavailable)', async () => {
    const s = ownerScenario();
    const provider = s.capture.providers[0];
    if (provider)
      Object.assign(provider, {
        kind: 'openai_compatible',
        baseUrl: 'http://ollama.invalid:11434/v1',
        models: { vision: 'qwen2.5vl:7b' },
      });
    const { user } = await renderApp('/settings/ai', { state: s });
    await user.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('No model list')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't get the model list from/)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this")).toBeNull();
  });

  it('says up top when the photo model has no price, and an admin prices Groq in one tap', async () => {
    const s = ownerScenario();
    s.capture.prices = [];
    const { user, mock } = await renderApp('/settings/ai', { state: s });
    const notice = (
      await screen.findByText('No price for this model, so every call says cost unknown')
    ).closest('div.flex') as HTMLElement;
    expect(notice.textContent).toMatch(/qwen\/qwen3\.8-27b/);
    expect(notice.textContent).toMatch(/Groq listed it at USD 0\.8 per million input tokens/);
    await user.click(within(notice).getByRole('button', { name: "Use Groq's listed price" }));
    // The listing's own price when there is one (the mock lists 0.10 / 0.30), then this month's
    // unpriced calls are costed.
    await waitFor(() =>
      expect(mock.lastCall('POST', cp.adminAiPricesRecost)?.body).toEqual({
        providerKind: 'groq',
        model: 'qwen/qwen3.8-27b',
        since: '2026-09-26T00:00:00.000Z',
      }),
    );
    expect(mock.lastCall('POST', cp.adminAiPrices)?.body).toMatchObject({
      providerKind: 'groq',
      model: 'qwen/qwen3.8-27b',
      inputPerMtok: '0.10',
      outputPerMtok: '0.30',
    });
    await waitFor(() =>
      expect(
        screen.queryByText('No price for this model, so every call says cost unknown'),
      ).toBeNull(),
    );
  });

  it('a member is told who sets the price, with no button', async () => {
    const s = ownerScenario();
    s.capture.prices = [];
    s.me.user.instanceAdmin = false;
    await renderApp('/settings/ai', { state: s });
    expect(
      await screen.findByText(/cost shows once an instance admin sets a price/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Use Groq's listed price" })).toBeNull();
  });

  it('works in Arabic, right to left, with logical CSS only', async () => {
    const { container } = await renderApp('/settings/ai', { locale: 'ar' });
    await findHeading(/.+/);
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expectLogicalOnly(container);
  });

  it('an error loading providers shows a retry', async () => {
    await renderApp('/settings/ai', {
      setup: (m) =>
        m.on('GET', cp.aiProviders, () => new MockReply(500, { error: 'x', code: 'internal' })),
    });
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
  });
});
