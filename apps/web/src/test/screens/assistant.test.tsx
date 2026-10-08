/**
 * The assistant (step-6 plan T19, T20; D22–D25, D123, D179, D206, D213; screens §5 and §8), on
 * the mock (api/assistant/mock): the sheet and the docked panel, threads, the context chip, the
 * composer's states, dictation with a stubbed recogniser only (never the real microphone), the
 * palette's hand-off (search.test.tsx), and the confirmation card drawn from the proposal.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_IDS as A, assistantMock } from '@/api/assistant/mock/state';
import { assistantPaths } from '@/api/assistant/paths';
import type { ConfirmBody } from '@/api/assistant/types';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { ownerScenario } from '@/api/mock/fixtures';
import { reply } from '@/api/mock/kit';
import { resetDictation } from '@/assistant/dictation';
import { openAssistant, showThread } from '@/assistant/store';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';
import { installSpeechStub, StubRecognition } from '@/test/speech';

const GARAGE = `/loc/${INV_IDS.loc.garage}`;

/** jsdom has no matchMedia: the queries listed match (the desktop's docked panel). */
function media(matching: string[]) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matching.includes(q),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

/** The header's button, once the page has loaded (a loading page's header is replaced). */
async function assistantButton(heading: string | RegExp = 'Garage') {
  await findHeading(heading);
  return screen.getByRole('button', { name: 'Assistant' });
}

const sheet = () => screen.findByRole('dialog', { name: 'Assistant' }, { timeout: 4000 });
const composer = (root: HTMLElement) =>
  within(root).getByRole('textbox', { name: 'Ask about your things' });

afterEach(() => resetDictation());

describe('the assistant sheet (phone)', () => {
  it('opens from the header, asks with the page as context, answers with internal links, and gives focus back', async () => {
    const { user, mock } = await renderApp(GARAGE);
    const button = await assistantButton();
    await user.click(button);
    const s = await sheet();
    await waitFor(() => expect(composer(s)).toHaveFocus());
    // The context chip: the page it came from (D24).
    expect(within(s).getByRole('button', { name: 'Remove page context' })).toBeInTheDocument();
    expect(within(s).getByText('Garage')).toBeInTheDocument();

    await user.type(composer(s), 'Where is the HDMI cable?{Enter}');
    expect(await within(s).findByText('Where is the HDMI cable?')).toBeInTheDocument();
    const turns = mock.calls.find((c) => c.method === 'POST' && c.path.endsWith('/turns'));
    expect(turns?.body).toEqual({
      text: 'Where is the HDMI cable?',
      context: { kind: 'location', id: INV_IDS.loc.garage },
      locale: 'en',
    });
    const links = await within(s).findAllByRole(
      'link',
      { name: /HDMI cable, 2 m/ },
      { timeout: 6000 },
    );
    expect(links[0]).toHaveAttribute('href', `/t/${INV_IDS.thing.hdmiCable}`);
    // The composer was cleared, and nothing on the phone is cut short with an ellipsis.
    expect(composer(s)).toHaveValue('');
    expect(s.querySelector('.truncate, .text-ellipsis')).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant' })).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  }, 20_000);

  it('removes the page context, and says why it can’t ask while AI is paused (D206)', async () => {
    const { user } = await renderApp(`/t/${INV_IDS.thing.hdmiCable}`);
    await user.click(await assistantButton('HDMI cable, 2 m'));
    const s = await sheet();
    // Home's AI is paused in the mock: the composer is disabled with the reason.
    expect(await within(s).findByText(/AI paused until/)).toBeInTheDocument();
    expect(composer(s)).toBeDisabled();
    await user.click(within(s).getByRole('button', { name: 'Remove page context' }));
    expect(within(s).queryByRole('button', { name: 'Remove page context' })).toBeNull();
    // Without the context nothing names Home's pause: the person's own cascade answers.
    await waitFor(() => expect(composer(s)).toBeEnabled());
  });

  it('shows a viewer their line, and is disabled offline', async () => {
    const state = ownerScenario();
    state.locations = state.locations.map((l) =>
      l.id === INV_IDS.loc.garage ? { ...l, role: 'viewer' } : l,
    );
    const { user } = await renderApp(GARAGE, { state });
    await user.click(await assistantButton());
    const s = await sheet();
    expect(within(s).getByText('Viewers can ask; changes need an admin')).toBeInTheDocument();
    await user.click(within(s).getByRole('button', { name: 'Close' }));

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(
      await screen.findByRole('button', { name: 'Assistant, needs a connection' }),
    ).toBeDisabled();
    vi.restoreAllMocks();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
  });

  it('says when a question is more than the AI plan allows in a minute, instead of "Ask again"', async () => {
    // The maintainer's instance, 2026-10-07: Groq's free tier refused the request's size (413).
    const { user } = await renderApp(GARAGE, {
      setup: (m) =>
        m.on('GET', assistantPaths.turn(':id'), () =>
          reply(200, {
            status: 'failed',
            statusReason: 'too_large',
            pausedUntil: null,
            steps: 1,
            messages: [],
            proposals: [],
          }),
        ),
    });
    await user.click(await assistantButton());
    const s = await sheet();
    await user.type(composer(s), 'How many things do I have?{Enter}');
    expect(
      await within(s).findByText(/more than your AI plan allows in one minute/, undefined, {
        timeout: 4000,
      }),
    ).toBeInTheDocument();
    expect(within(s).queryByText(/Ask again/)).toBeNull();
  });

  it('says why a question from a page with no location is refused, and waits for an edit (UI review L1)', async () => {
    // No location in the context: the status can't say whose AI would answer, so Send is on,
    // and the server's 400 ai_unavailable is said under the field.
    const { user } = await renderApp('/', {
      setup: (m) =>
        m.on('POST', assistantPaths.threadTurns(':id'), () =>
          reply(400, { error: 'connect AI in Settings', code: 'ai_unavailable' }),
        ),
    });
    await user.click(await assistantButton('Home'));
    const s = await sheet();
    await user.type(composer(s), 'Where is the drill?{Enter}');
    expect(
      await within(s).findByText(/You have no AI of your own to answer here/),
    ).toBeInTheDocument();
    // The question comes back into the field, and Send waits until it changes.
    expect(composer(s)).toHaveValue('Where is the drill?');
    expect(within(s).getByRole('button', { name: 'Send' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.type(composer(s), '?');
    expect(within(s).getByRole('button', { name: 'Send' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('lists threads, opens one, and deletes one after asking (D23)', async () => {
    const { user } = await renderApp(GARAGE);
    await assistantButton();
    act(() => openAssistant());
    const s = await sheet();
    await user.click(within(s).getByRole('button', { name: 'Threads' }));
    const list = await within(s).findByRole('list', { name: 'Your threads' });
    expect(within(list).getByText('Where is the HDMI cable?')).toBeInTheDocument();
    expect(within(s).getByText(/Deleted after/)).toBeInTheDocument();
    // Talia's thread is hers alone.
    expect(within(list).queryByText('Can you move the kettle?')).toBeNull();

    await user.click(within(list).getByRole('button', { name: /Delete “.*Arabic|Delete “.*وين/ }));
    const ask = await screen.findByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(within(list).queryByText('وين كابل الـ HDMI؟')).toBeNull());

    await user.click(within(list).getByText('Where is the HDMI cable?'));
    expect(await within(s).findByText(/There are 3/)).toBeInTheDocument();
    expect(within(s).getByText(/Looked in .*Home/)).toBeInTheDocument();
  });

  it('reads an Arabic thread right to left', async () => {
    await renderApp(GARAGE, { locale: 'ar' });
    await screen.findAllByRole('navigation', {}, { timeout: 4000 });
    act(() => showThread(A.thread.arabic));
    const s = await screen.findByRole('dialog', { name: 'المساعد' }, { timeout: 4000 });
    expect(await within(s).findByText('وين كابل الـ HDMI؟')).toBeInTheDocument();
    expect(within(s).getAllByRole('link', { name: 'كابل HDMI' })[0]).toBeInTheDocument();
    expectLogicalOnly(s);
  });

  it('dictates into the composer with a stubbed recogniser, and has no mic without one', async () => {
    const { user } = await renderApp(GARAGE);
    await user.click(await assistantButton());
    let s = await sheet();
    expect(within(s).queryByRole('button', { name: 'Dictate' })).toBeNull();
    await user.click(within(s).getByRole('button', { name: 'Close' }));

    installSpeechStub();
    await user.click(screen.getByRole('button', { name: 'Assistant' }));
    s = await sheet();
    await user.click(within(s).getByRole('button', { name: 'Dictate' }));
    act(() => StubRecognition.last.hear(['I have a drill and two paint cans'], true));
    expect(composer(s)).toHaveValue('I have a drill and two paint cans');
    expect(StubRecognition.last.lang).toBe('en');
  });
});

describe('the docked panel (768 px and up)', () => {
  it('docks beside the page, follows the route, and toggles with ⌘J', async () => {
    media(['(min-width: 768px)', '(min-width: 1024px)']);
    const { user, router } = await renderApp(GARAGE);
    const button = await assistantButton();
    fireEvent.keyDown(document.body, { key: 'j', metaKey: true });
    const panel = await screen.findByRole('complementary', { name: 'Assistant' });
    expect(within(panel).getByText('About')).toBeInTheDocument();
    expect(within(panel).getByText('Garage')).toBeInTheDocument();
    await act(() => router.navigate({ to: '/t/$id', params: { id: INV_IDS.thing.hdmiCable } }));
    expect(
      await within(panel).findByText('HDMI cable, 2 m', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(panel).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
  });
});

describe('the confirmation card (T20)', () => {
  it('confirms a move drawn from its arguments, with Undo', async () => {
    const { user, mock } = await renderApp(GARAGE);
    await assistantButton();
    act(() => showThread(A.thread.found));
    const s = await sheet();
    await within(s).findByText('Confirm 1 change');
    // The open card; the expired and changed-since ones from the same thread come after it.
    const card = within(s)
      .getAllByRole('group', { name: 'Changes for you to confirm, drawn by Kept' })
      .find((r) => within(r).queryByText('Confirm 1 change')) as HTMLElement;
    expect(within(card).getByRole('timer')).toBeInTheDocument();
    expect(within(card).getByText('Move')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'HDMI cable, 2 m' })).toBeInTheDocument();
    expect(within(card).getByText('From')).toBeInTheDocument();
    expect(within(card).getByText('To')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Confirm 1' }));
    // The card says what was done, and the toast offers Undo, in the same fixed words.
    expect(await screen.findAllByText(/Moved .*HDMI cable, 2 m.* to .*Box 3/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    const body = mock.lastCall('POST', assistantPaths.proposalsConfirm)?.body as ConfirmBody;
    expect(body.proposals).toEqual([{ id: A.proposal.open, argsHash: expect.any(String) }]);
  });

  it('shows an expired card and a changed-since card without Confirm (screens §8)', async () => {
    await renderApp(GARAGE);
    await assistantButton();
    act(() => showThread(A.thread.found));
    const s = await sheet();
    expect(await within(s).findByText('Expired · ask again')).toBeInTheDocument();
    expect(within(s).getByText('Changed since you asked')).toBeInTheDocument();
    expect(within(s).getByText(/Bruce/)).toBeInTheDocument();
    expect(within(s).getAllByRole('button', { name: 'Ask again' })).toHaveLength(2);
    expect(within(s).getAllByRole('button', { name: /^Confirm/ })).toHaveLength(1);
  });

  it('adds a spoken list as one card: untick, edit, one Confirm, and Undo in reverse (D213)', async () => {
    const { user, mock } = await renderApp(GARAGE);
    mock.on('POST', '/api/v1/audit/:id/undo', () => reply(200, { undone: true }));
    await assistantButton();
    act(() => showThread(A.thread.list));
    const s = await sheet();
    const card = await within(s).findByRole('group', {
      name: 'Changes for you to confirm, drawn by Kept',
    });
    expect(within(card).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(card).getByText('New place')).toBeInTheDocument();
    await user.click(within(card).getByRole('checkbox', { name: /Ladder/ }));
    expect(within(card).getByRole('button', { name: 'Confirm 2' })).toBeInTheDocument();
    const edits = within(card).getAllByRole('button', { name: 'Edit' });
    await user.click(edits[2] as HTMLElement);
    const name = within(card).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Paint tin');
    const qty = within(card).getByRole('textbox', { name: 'How many' });
    await user.clear(qty);
    await user.type(qty, '3');
    await user.click(within(card).getByRole('button', { name: 'Confirm 2' }));
    expect(await screen.findAllByText(/Added .*Drill.* and .*Paint tin/)).toHaveLength(2);
    const body = mock.lastCall('POST', assistantPaths.proposalsConfirm)?.body as ConfirmBody;
    expect(body.proposals[0]?.items).toEqual([
      { index: 0 },
      { index: 2, name: 'Paint tin', quantity: 3 },
    ]);
    const proposal = assistantMock(mock.state).proposals.find((p) => p.id === A.proposal.list);
    expect(proposal?.status).toBe('confirmed');
    // A new place ("Shelf C"), then the two things, in write order.
    const ids = (proposal?.result as { eventIds: string[] } | undefined)?.eventIds ?? [];
    expect(ids).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.path.endsWith('/undo')).map((c) => c.path.split('/')[4]),
      ).toEqual([...ids].reverse()),
    );
  });

  it('defaults a 30-row card to all ticked, narrows it, and locks at zero', async () => {
    const { user, mock } = await renderApp(GARAGE);
    const list = assistantMock(mock.state).proposals.find((p) => p.id === A.proposal.list);
    if (!list) throw new Error('no list fixture');
    list.args = {
      ...list.args,
      items: Array.from({ length: 30 }, (_, i) => ({ name: `Jar ${i + 1}` })),
    };
    list.expiresAt = new Date(Date.now() + 2500).toISOString();
    await assistantButton();
    act(() => showThread(A.thread.list));
    const s = await sheet();
    expect(await within(s).findByRole('button', { name: 'Confirm 30' })).toBeInTheDocument();
    await user.click(within(s).getByRole('checkbox', { name: /Jar 1(?!\d)/ }));
    await user.click(within(s).getByRole('checkbox', { name: /Jar 2(?!\d)/ }));
    expect(within(s).getByRole('button', { name: 'Confirm 28' })).toBeInTheDocument();
    expect(
      await within(s).findByText('Expired · ask again', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(within(s).queryByRole('checkbox')).toBeNull();
    expect(within(s).queryByRole('button', { name: /^Confirm/ })).toBeNull();
  }, 15_000);
});
