/**
 * Plan T23: the paperwork library (search by a word inside, the filter strip, list or grid), the
 * Expiring screen (from the agenda, Renew with Undo), and the Paperwork section on a location's
 * and a place's page (D155): add an expiring document, renew it, the viewer and module-off
 * variants, offline, and Arabic (RTL).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HOUSEHOLD_IDS } from '@/api/household/mock/state';
import { householdPaths as hp } from '@/api/household/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '../app';
import { expectLogicalOnly } from '../render';

const H = HOUSEHOLD_IDS;
const P = INV_IDS.place;

function asRole(role: 'viewer' | 'member' | 'admin', state: MockState = ownerScenario()) {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (home) home.role = role;
  return state;
}

function paperworkOff(state: MockState = ownerScenario()) {
  for (const l of state.locations) {
    l.modules = l.modules.filter((m) => m !== 'paperwork');
    if (l.effectiveModules)
      l.effectiveModules = l.effectiveModules.filter((m) => m !== 'paperwork');
  }
  return state;
}

const section = async (name: string) => (await findHeading(name)).closest('section') as HTMLElement;

describe('/paperwork', () => {
  it('finds the Arabic lease by a word of its text, with the matching line', async () => {
    const { user, mock } = await renderApp('/paperwork');
    await findHeading('Paperwork');
    await screen.findByRole('list', { name: 'Paperwork' });
    await user.type(screen.getByRole('searchbox', { name: 'Search your paperwork' }), 'المؤجر');
    // The list reloads under the search: find the matching line in the new one.
    const line = await screen.findByText(/المؤجر: بروس/);
    const lease = line.closest('article') as HTMLElement;
    expect(lease).toHaveAccessibleName(/Lease/);
    expect(mock.lastCall('GET', hp.paperwork)).toBeTruthy();
    expect(within(lease).getByRole('link', { name: 'بيت العائلة' })).toHaveAttribute(
      'href',
      `/loc/${IDS.family}`,
    );
    expect(within(lease).getByText(/Runs out/)).toBeInTheDocument();
  });

  it('opens a file through a signed URL', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const { user, mock } = await renderApp('/paperwork');
    const list = await screen.findByRole('list', { name: 'Paperwork' });
    const lease = await within(list).findByRole('article', { name: /Lease/ });
    await user.click(within(lease).getByRole('button', { name: /^Open Lease/ }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(mock.lastCall('POST', `/api/v1/files/${H.file.familyLease}/url`)?.body).toEqual({
      variant: 'original',
    });
  });

  it('narrows by what it is on, and shows a grid through Display (D211)', async () => {
    const { router } = await renderApp('/paperwork?f.subject=location&view=grid');
    const list = await screen.findByRole('list', { name: 'Paperwork' });
    await within(list).findByRole('article', { name: /Lease/ });
    expect(list.className).toMatch(/grid-cols-2/);
    expect((router.state.location.search as Record<string, unknown>)['f.subject']).toEqual([
      'location',
    ]);
    expect(await screen.findByRole('button', { name: /Display/ })).toBeInTheDocument();
  });

  it('links to Expiring', async () => {
    await renderApp('/paperwork');
    await findHeading('Paperwork');
    expect(screen.getByRole('link', { name: 'Expiring' })).toHaveAttribute('href', '/expiring');
  });

  it('with Paperwork off everywhere, says so', async () => {
    await renderApp('/paperwork', { state: paperworkOff() });
    expect(await screen.findByText(/Paperwork is off in every location/)).toBeInTheDocument();
  });

  it('reads right to left in Arabic, with logical CSS only', async () => {
    await renderApp('/paperwork', { locale: 'ar' });
    await screen.findByRole('list');
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
  });
});

describe('/expiring', () => {
  it('lists warranties, documents and things by state, from the agenda', async () => {
    const { mock } = await renderApp('/expiring');
    await findHeading('Expiring');
    const list = await screen.findByRole('list', { name: 'Expiring' });
    const insurance = await within(list).findByRole('article', { name: 'Home insurance' });
    expect(insurance).toHaveTextContent('Runs out soon');
    expect(mock.lastCall('GET', hp.agenda)).toBeTruthy();
  });

  it('renews a document, keeping the old term, with Undo (D172, D150)', async () => {
    const { user, mock } = await renderApp('/expiring');
    const list = await screen.findByRole('list', { name: 'Expiring' });
    const insurance = await within(list).findByRole('article', { name: 'Home insurance' });
    await user.click(within(insurance).getByRole('button', { name: 'Renew Home insurance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renew Home insurance' });
    const next = new Date(Date.now() + 400 * 86_400_000);
    const segments = within(dialog).getAllByRole('spinbutton');
    // Month, day, year in English.
    await user.click(segments[0] as HTMLElement);
    await user.keyboard(
      `${next.getMonth() + 1}`.padStart(2, '0') +
        `${next.getDate()}`.padStart(2, '0') +
        `${next.getFullYear()}`,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Renew' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', hp.documentRenew(H.document.homeInsurance))).toBeTruthy(),
    );
    expect(
      mock.lastCall('POST', hp.documentRenew(H.document.homeInsurance))?.headers['if-match'],
    ).toBe('1');
    expect(await screen.findByText('Renewed Home insurance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('a viewer sees the list without Renew', async () => {
    await renderApp('/expiring', { state: asRole('viewer') });
    const list = await screen.findByRole('list', { name: 'Expiring' });
    const insurance = await within(list).findByRole('article', { name: 'Home insurance' });
    expect(within(insurance).queryByRole('button', { name: /Renew/ })).toBeNull();
  });

  it("Home's overdue row opens it with the state and the sources it counts", async () => {
    await renderApp('/expiring?f.state=overdue&f.source=loan');
    const list = await screen.findByRole('list', { name: 'Expiring' });
    const rows = await within(list).findAllByRole('article');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toHaveTextContent('Overdue');
    expect(within(list).getAllByRole('link', { name: 'Open Lending' })[0]).toHaveAttribute(
      'href',
      '/lending',
    );
  });

  it('titles every warranty as a warranty, by its provider or its kind (UI step-4 review L6)', async () => {
    await renderApp('/expiring?f.source=warranty');
    const list = await screen.findByRole('list', { name: 'Expiring' });
    const rows = await within(list).findAllByRole('article');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.getAttribute('aria-label')).toMatch(/warranty$/i);
  });
});

describe('the Paperwork section (D155)', () => {
  it('a location lists its documents: the lease with its file, and Renew', async () => {
    await renderApp(`/loc/${IDS.family}`);
    const paperwork = await section('Paperwork');
    const lease = await within(paperwork).findByText('عقد الإيجار');
    const row = lease.closest('li') as HTMLElement;
    expect(row).toHaveTextContent('Lease');
    expect(row).toHaveTextContent('1 earlier term');
    expect(within(row).getByRole('button', { name: /^Open عقد الإيجار/ })).toBeInTheDocument();
  });

  it('adds an expiring document to the whole home', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    const paperwork = await section('Paperwork');
    await user.click(within(paperwork).getByRole('button', { name: 'Add expiring document' }));
    // The name is isolated in the title (U+2068 … U+2069) since step 5's UI pass.
    const dialog = await screen.findByRole('dialog', {
      name: /^Expiring document for \u2068?Home\u2069?$/,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('Pick the day it runs out.')).toBeInTheDocument();
    const segments = within(dialog).getAllByRole('spinbutton');
    await user.click(segments[0] as HTMLElement);
    await user.keyboard(`0101${new Date().getFullYear() + 1}`);
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Boiler certificate');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mock.lastCall('POST', hp.documents)).toBeTruthy());
    expect(mock.lastCall('POST', hp.documents)?.body).toMatchObject({
      subject: { locationId: IDS.home },
      kind: 'insurance',
      title: 'Boiler certificate',
      expiresOn: `${new Date().getFullYear() + 1}-01-01`,
      leadDays: 30,
    });
    expect(await within(paperwork).findByText('Boiler certificate')).toBeInTheDocument();
  });

  it('"other" needs a name (Q31)', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`);
    const paperwork = await section('Paperwork');
    await user.click(within(paperwork).getByRole('button', { name: 'Add expiring document' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Kind/ }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(
      await within(dialog).findByText('Name it, like Building inspection.'),
    ).toBeInTheDocument();
  });

  it('a viewer reads, with no Add', async () => {
    await renderApp(`/loc/${IDS.home}`, { state: asRole('viewer') });
    const paperwork = await section('Paperwork');
    await within(paperwork).findByText('Home insurance');
    expect(within(paperwork).queryByRole('button', { name: /Add/ })).toBeNull();
    expect(within(paperwork).queryByRole('button', { name: 'Renew' })).toBeNull();
  });

  it('is hidden with Paperwork off in the location', async () => {
    await renderApp(`/loc/${IDS.home}`, { state: paperworkOff() });
    await findHeading('Home');
    await screen.findByRole('heading', { name: 'Places' }).catch(() => undefined);
    expect(screen.queryByRole('heading', { name: 'Paperwork' })).toBeNull();
  });

  it('offline, adding says it needs a connection', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      await renderApp(`/loc/${IDS.home}`);
      const paperwork = await section('Paperwork');
      expect(
        within(paperwork).getByRole('button', { name: /Add expiring document/ }),
      ).toBeDisabled();
      expect(within(paperwork).getByText('Needs a connection')).toBeInTheDocument();
    } finally {
      online.mockRestore();
    }
  });

  it('a place has one too, with Add document', async () => {
    await renderApp(`/p/${P.kitchen}`);
    const paperwork = await section('Paperwork');
    expect(within(paperwork).getByRole('button', { name: /Add document/ })).toBeInTheDocument();
    expect(
      within(paperwork).getByRole('button', { name: /Add expiring document/ }),
    ).toBeInTheDocument();
  });
});
