/**
 * A vehicle's Documents (plan T22): the Corolla's licence due in 23 days and its insurance valid,
 * with their issue dates and costs; the registration card's row until there is one; Add and Renew
 * with an issue date and a cost; the viewer (no writes, no cost); Arabic dates.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { householdPaths as hp } from '@/api/household/paths';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded, VEHICLE_IDS as V } from '@/api/vehicles/mock';
import { COROLLA } from '@/api/vehicles/mock/state';
import { toastQueue } from '@/components/ui/toast';
import { expectLogicalOnly } from '@/test/render';
import { renderThingPart } from '@/test/thing-part';
import { VehicleDocuments } from './documents-tab';

vi.setConfig({ testTimeout: 20_000 });

function seeded(patch?: (s: MockState) => void): MockState {
  const s = ownerScenario();
  ensureVehiclesSeeded(s);
  patch?.(s);
  return s;
}
const render = (state = seeded(), locale: 'en' | 'ar' = 'en') =>
  renderThingPart(<VehicleDocuments />, {
    thingId: COROLLA.thing,
    state,
    locale,
    digits: locale === 'ar' ? 'eastern' : 'western',
  });
const year = new Date().getFullYear();

afterEach(() => {
  vi.unstubAllGlobals();
  for (const t of toastQueue.visibleToasts) toastQueue.close(t.key);
});

describe("a vehicle's documents", () => {
  it('lists the licence due in 23 days and the insurance valid, with issue dates and costs', async () => {
    await render();
    const list = await screen.findByRole('list', { name: /^Documents of / });
    const rows = within(list).getAllByRole('listitem');
    const licence = rows.find((r) => r.textContent?.startsWith('Licence')) as HTMLElement;
    expect(licence).toHaveTextContent('Due in 23 days');
    expect(licence).toHaveTextContent('EGP 1,200.00');
    expect(licence).toHaveTextContent('Reminds 30 days before');
    const insurance = rows.find((r) => r.textContent?.startsWith('Insurance')) as HTMLElement;
    expect(insurance).toHaveTextContent('Valid');
    expect(insurance).toHaveTextContent('Issued May 15');
    expect(insurance).toHaveTextContent('EGP 3,500.00');
    expect(
      within(list).getByText('Read in LABEL mode: VIN, plate and licence expiry'),
    ).toBeInTheDocument();
  });

  it('adds the registration card with its issue date and cost', async () => {
    const { user, mock } = await render();
    await user.click(await screen.findByRole('button', { name: 'Add a document' }));
    const dialog = await screen.findByRole('dialog', { name: /^Expiring document for / });
    const segments = within(dialog).getAllByRole('spinbutton');
    // Runs out on, then Issued on: month, day, year in English.
    await user.click(segments[0] as HTMLElement);
    await user.keyboard(`0101${year + 1}`);
    await user.click(segments[3] as HTMLElement);
    await user.keyboard(`0102${year}`);
    await user.type(within(dialog).getByRole('textbox', { name: 'Cost (optional)' }), '450');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mock.lastCall('POST', hp.documents)).toBeTruthy());
    expect(mock.lastCall('POST', hp.documents)?.body).toMatchObject({
      subject: { thingId: COROLLA.thing },
      kind: 'registration',
      expiresOn: `${year + 1}-01-01`,
      issuedOn: `${year}-01-02`,
      cost: '450',
      currency: 'EGP',
    });
    const list = await screen.findByRole('list', { name: /^Documents of / });
    await waitFor(() =>
      expect(
        within(list).queryByText('Read in LABEL mode: VIN, plate and licence expiry'),
      ).toBeNull(),
    );
  });

  it('renews the licence with the new term’s cost, with Undo', async () => {
    const { user, mock } = await render();
    const list = await screen.findByRole('list', { name: /^Documents of / });
    const licence = within(list)
      .getAllByRole('listitem')
      .find((r) => r.textContent?.startsWith('Licence')) as HTMLElement;
    await user.click(within(licence).getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Renew' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renew Licence' });
    const segments = within(dialog).getAllByRole('spinbutton');
    await user.click(segments[0] as HTMLElement);
    await user.keyboard(`0601${year + 2}`);
    await user.type(within(dialog).getByRole('textbox', { name: 'Cost (optional)' }), '1300');
    await user.click(within(dialog).getByRole('button', { name: 'Renew' }));
    const path = hp.documentRenew(V.document.licence);
    await waitFor(() => expect(mock.lastCall('POST', path)).toBeTruthy());
    expect(mock.lastCall('POST', path)?.body).toMatchObject({
      expiresOn: `${year + 2}-06-01`,
      cost: '1300',
      currency: 'EGP',
    });
    expect(await screen.findByText('Renewed Licence')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('shows a viewer the terms without Add, Renew or the cost', async () => {
    await render(
      seeded((s) => {
        const g = s.locations.find((l) => l.id === IDS.garage);
        if (g) g.role = 'viewer';
      }),
    );
    const list = await screen.findByRole('list', { name: /^Documents of / });
    expect(within(list).getAllByText('Hidden in this location').length).toBeGreaterThan(0);
    expect(within(list).queryByText(/EGP/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a document' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('reads its dates in Arabic, right to left', async () => {
    await render(seeded(), 'ar');
    const list = await screen.findByRole('list', { name: /.+/ });
    await waitFor(() => expect(list.textContent).toMatch(/[٠-٩]/));
    expect(list.textContent).not.toMatch(/\d{2}/);
    expectLogicalOnly();
  });
});
