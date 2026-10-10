/** New-location wizard, the location page, What to track, and accepting an invite. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  IDS,
  INVITE_TOKEN,
  memberScenario,
  ownerScenario,
  signedOutScenario,
} from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { paths } from '@/api/paths';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

describe('new location wizard (D194)', () => {
  it('needs a name', async () => {
    const { user } = await renderApp('/locations/new');
    await findHeading('New location');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Give it a name, like Home or Garage.')).toBeInTheDocument();
  });

  it('name and kind → the template rooms → what to track → creates it', async () => {
    const { user, mock, router } = await renderApp('/locations/new');
    await findHeading('New location');
    await user.type(screen.getByLabelText('Name'), 'Beach flat');
    await user.click(screen.getByRole('radio', { name: 'Garage' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await findHeading('Rooms in Beach flat');
    const rooms = () => screen.getAllByRole('textbox').map((i) => (i as HTMLInputElement).value);
    expect(rooms()).toEqual(['Tool wall', 'Shelves', 'Floor']);
    expect(screen.getByText('Unplaced')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Floor' }));
    await user.click(screen.getByRole('button', { name: 'Add room or spot' }));
    await user.type(screen.getByLabelText('Room or spot 3'), 'Bike rack');
    expect(rooms()).toEqual(['Tool wall', 'Shelves', 'Bike rack']);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await findHeading('What should Beach flat track?');
    expect(screen.getByRole('radio', { name: /^Household/ })).toBeChecked();
    expect(screen.getByText(/from this device/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^Essentials/ }));
    await user.click(screen.getByRole('button', { name: 'Create Beach flat' }));
    await findHeading('Home');
    expect(pathOf(router)).toBe('/');
    expect(mock.lastCall('POST', paths.locations)?.body).toEqual({
      name: 'Beach flat',
      kind: 'garage',
      rooms: ['Tool wall', 'Shelves', 'Bike rack'],
      preset: 'essentials',
      timezone: expect.any(String),
      currency: expect.stringMatching(/^[A-Z]{3}$/),
    });
    // The new location is on Home, with its Invite card (D194).
    expect(await screen.findByText('Invite people to Beach flat')).toBeInTheDocument();
  });

  it('Skip on the rooms step keeps only Unplaced', async () => {
    const { user, mock } = await renderApp('/locations/new');
    await findHeading('New location');
    await user.type(screen.getByLabelText('Name'), 'Flat');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await findHeading('Rooms in Flat');
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(await screen.findByRole('button', { name: 'Create Flat' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.locations)?.body).toMatchObject({ rooms: [] }),
    );
  });

  it('renders the Arabic templates right to left', async () => {
    const { user } = await renderApp('/locations/new', { locale: 'ar' });
    await findHeading('موقع جديد');
    await user.type(screen.getByLabelText('الاسم'), 'البيت');
    await user.click(screen.getByRole('button', { name: 'التالي' }));
    await findHeading('الغرف في «البيت»');
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('غرفة المعيشة');
    expectLogicalOnly();
  });
});

describe('the location page', () => {
  it('owner: settings links, no Leave', async () => {
    await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    expect(screen.getByRole('link', { name: /Members and roles/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /What to track/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave this location' })).not.toBeInTheDocument();
  });

  it('Personal: no Members, no Leave (D114)', async () => {
    await renderApp(`/loc/${IDS.personal}`);
    await findHeading('Personal');
    expect(screen.queryByRole('link', { name: /Members and roles/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave this location' })).not.toBeInTheDocument();
    expect(screen.getByText(/Personal is yours alone/)).toBeInTheDocument();
  });

  it('a member can leave, after a confirm that says what stops working (D180)', async () => {
    const state = memberScenario();
    state.members[IDS.home]?.members.forEach((m) => {
      m.isYou = m.displayName === 'Alfred';
    });
    const { user, mock, router } = await renderApp(`/loc/${IDS.home}`, { state });
    await findHeading('Home');
    expect(screen.queryByRole('link', { name: /Members and roles/ })).not.toBeInTheDocument();
    const leave = await screen.findByRole('button', { name: 'Leave this location' });
    await waitFor(() => expect(leave).toBeEnabled());
    await user.click(leave);
    const dialog = screen.getByRole('alertdialog', { name: 'Leave Home?' });
    expect(dialog).toHaveTextContent(
      'Webhooks, share links and exports you made for Home stop working.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Leave Home' }));
    await waitFor(() => expect(pathOf(router)).toBe('/'));
    expect(mock.lastCall('DELETE', paths.locationMember(IDS.home, 'm-alfred'))).toBeTruthy();
  });

  it('not found', async () => {
    await renderApp('/loc/01926f00-0000-7000-8000-00000000ffff');
    expect(
      await screen.findByText("This isn't here any more, or you can't see it."),
    ).toBeInTheDocument();
  });
});

describe('What to track (D191)', () => {
  const url = `/settings/location/${IDS.garage}/track`;

  it('shows the preset cards, and lists what a switch turns on and off', async () => {
    const { user, mock } = await renderApp(url);
    await findHeading('What to track');
    expect(screen.getByRole('radio', { name: /^Essentials/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /^Complete/ }));
    expect(screen.getByText(/Turns on: .*Vehicles.*Connect ChatGPT or Claude/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.locationModules(IDS.garage))?.body).toMatchObject({
        preset: 'complete',
      }),
    );
    const body = mock.lastCall('POST', paths.locationModules(IDS.garage))?.body as {
      modules: string[];
    };
    expect(body.modules).toContain('fuel');
    expect(body.modules).not.toContain('ai_capture');
  });

  it('Fuel needs Vehicles: off and disabled until Vehicles is on', async () => {
    const { user } = await renderApp(url);
    await findHeading('What to track');
    const fuel = screen.getByRole('switch', { name: /Fuel/ });
    expect(fuel).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Vehicles' }));
    expect(fuel).toBeEnabled();
    await user.click(fuel);
    expect(fuel).toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Vehicles' }));
    expect(fuel).not.toBeChecked();
  });

  it('turning something off says it is hidden, not deleted', async () => {
    const { user } = await renderApp(`/settings/location/${IDS.home}/track`);
    await findHeading('What to track');
    await user.click(screen.getByRole('switch', { name: 'Lending' }));
    expect(screen.getByText('Turns off: Lending. Hidden, not deleted.')).toBeInTheDocument();
  });

  it('members are told to ask an admin', async () => {
    await renderApp(`/settings/location/${IDS.home}/track`, { state: memberScenario() });
    expect(await screen.findByText('Only the owner and admins change this')).toBeInTheDocument();
  });
});

describe('accept invite (D190)', () => {
  it('signed in: shows who, where and until when, then joins', async () => {
    const { user, mock, router } = await renderApp(`/invite#${INVITE_TOKEN}`);
    expect(await screen.findByText('Ibrahim invites you to')).toBeInTheDocument();
    expect(screen.getByText(/Member until/)).toBeInTheDocument();
    expect(screen.getByText(/asks for two-factor/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Join Home' }));
    await waitFor(() => expect(pathOf(router)).toMatch(/^\/loc\//));
    expect(mock.lastCall('POST', paths.inviteAccept(INVITE_TOKEN))?.body).toEqual({});
  });

  it('signed out: creating the account and joining is one step', async () => {
    const { user, mock } = await renderApp(`/invite#${INVITE_TOKEN}`, {
      state: signedOutScenario(),
    });
    await screen.findByText('Ibrahim invites you to');
    expect(screen.getByRole('link', { name: 'I have an account: sign in' })).toHaveAttribute(
      'href',
      expect.stringContaining('/signin'),
    );
    await user.click(screen.getByRole('button', { name: 'Create an account and join' }));
    await user.click(screen.getByRole('button', { name: 'Create account and join' }));
    expect(screen.getByText('Enter your name.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your name'), 'Louis');
    await user.type(screen.getByLabelText('Email'), 'louis@example.com');
    await user.type(screen.getByLabelText('Password'), 'long enough pass');
    await user.click(screen.getByRole('button', { name: 'Create account and join' }));
    // The server answers 202 {next: 'sign-in'}; the page signs the new account in.
    expect(await findHeading('Home')).toBeInTheDocument();
    const accepts = mock.calls.filter(
      (c) => c.method === 'POST' && c.path === paths.inviteAccept(INVITE_TOKEN),
    );
    // Signed out with newAccount, then again signed in (joins an address that already existed).
    expect(accepts.map((c) => c.body)).toEqual([
      {
        newAccount: {
          displayName: 'Louis',
          email: 'louis@example.com',
          password: 'long enough pass',
        },
      },
      {},
    ]);
    expect(accepts[0]?.body).toEqual({
      newAccount: {
        displayName: 'Louis',
        email: 'louis@example.com',
        password: 'long enough pass',
      },
    });
    expect(mock.lastCall('POST', paths.auth.signInEmail)?.body).toEqual({
      email: 'louis@example.com',
      password: 'long enough pass',
    });
  });

  it('a used or expired invite says so', async () => {
    await renderApp('/invite#usedToken123');
    expect(await findHeading('This invite no longer works')).toBeInTheDocument();
  });

  it('a link with no token says it is incomplete', async () => {
    await renderApp('/invite');
    expect(await findHeading('This invite link is incomplete')).toBeInTheDocument();
  });

  it('already a member: opens the location', async () => {
    const state = ownerScenario();
    const invite = state.invites[INVITE_TOKEN];
    if (invite) invite.alreadyMemberLocationId = IDS.home;
    await renderApp(`/invite#${INVITE_TOKEN}`, { state });
    expect(await findHeading("You're already in Home")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Home' })).toHaveAttribute(
      'href',
      `/loc/${IDS.home}`,
    );
  });

  it('shows the server error when joining fails for another reason', async () => {
    const { user } = await renderApp(`/invite#${INVITE_TOKEN}`, {
      setup: (m) =>
        m.on(
          'POST',
          paths.inviteAccept(':token'),
          () => new MockReply(500, { error: 'x', code: 'internal' }),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Join Home' }));
    expect(
      await screen.findByText('Something went wrong on the server. Try again in a moment.'),
    ).toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    await renderApp(`/invite#${INVITE_TOKEN}`, { locale: 'ar' });
    expect(await screen.findByText('يدعوك Ibrahim إلى')).toBeInTheDocument();
    expectLogicalOnly();
  });
});

describe('location settings → General (timezone, currency)', () => {
  const section = async (title: string) =>
    (await screen.findByRole('heading', { name: title })).closest('section')
      ?.parentElement as HTMLElement;

  it('saves a timezone picked from the IANA list, with If-Match', async () => {
    const { user, mock } = await renderApp(`/settings/location/${IDS.home}/general`);
    const root = await section('Timezone');
    const box = within(root).getByRole('combobox', { name: 'Timezone' });
    expect(box).toHaveValue('Africa/Cairo');
    await user.click(box);
    await user.clear(box);
    await user.type(box, 'berlin');
    await user.click(await screen.findByRole('option', { name: 'Europe/Berlin' }));
    await user.click(within(root).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('PATCH', paths.location(IDS.home))?.body).toEqual({
        timezone: 'Europe/Berlin',
      }),
    );
  });

  it('saves a currency picked from the enabled list, uppercased', async () => {
    const { user, mock } = await renderApp(`/settings/location/${IDS.home}/general`);
    const root = await section('Currency');
    await user.click(within(root).getByRole('button', { name: /Currency/ }));
    await user.click(await screen.findByRole('option', { name: /US dollar/ }));
    await user.click(within(root).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('PATCH', paths.location(IDS.home))?.body).toEqual({
        currency: 'USD',
      }),
    );
  });
});
