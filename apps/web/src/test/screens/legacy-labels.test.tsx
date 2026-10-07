/**
 * Old labels open in Kept (step-7 T20; D146): `/a/<assetId>` with one match opens it, with two
 * asks which (naming each thing's location) and opens the one chosen; `/item/<uuid>` opens
 * directly; an unknown one is "Not in your Kept"; and offline, a printed Kept label a Kept import
 * re-issued opens from the phone's copy by its old code.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOMEBOX_ASSET } from '@/api/capture/mock/state';
import { capturePaths as cp } from '@/api/capture/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { ownerScenario } from '@/api/mock/fixtures';
import { pageStore } from '@/pwa/page-store';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { firstPage } from '@/test/store-contract';

const T = INV_IDS.thing;
afterEach(() => vi.restoreAllMocks());

describe('an old Homebox label', () => {
  it('/a/<assetId> with one match opens it, resolving the whole label URL', async () => {
    const { router, mock } = await renderApp(`/a/${HOMEBOX_ASSET.unique}`);
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${T.drill}`));
    const body = mock.lastCall('POST', cp.scanResolve)?.body as { text: string };
    expect(new URL(body.text).pathname).toBe(`/a/${HOMEBOX_ASSET.unique}`);
  });

  it('/a/<assetId> on two things asks which, naming each location, and opens the one chosen', async () => {
    const { user, router } = await renderApp(`/a/${HOMEBOX_ASSET.ambiguous}`);
    expect(await findHeading('Old Homebox label')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Things with this label' });
    const choices = within(list).getAllByRole('button');
    expect(choices).toHaveLength(2);
    expect(list).toHaveTextContent('Home');
    await user.click(choices[0] as HTMLElement);
    await waitFor(() => expect(pathOf(router)).toMatch(/^\/t\//));
  });

  it('/item/<uuid> opens directly', async () => {
    const state = ownerScenario();
    const uuid = '0192f0a0-0000-7000-8000-00000000abcd';
    const capture = state.capture as unknown as {
      legacyCodes: { locationId: string; source: string; code: string; target: unknown }[];
    };
    const drill = capture.legacyCodes[0];
    if (!drill) throw new Error('no legacy code');
    capture.legacyCodes.push({ ...drill, code: uuid });
    const { router } = await renderApp(`/item/${uuid}`, { state });
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${T.drill}`));
  });

  it('an unknown asset is not in your Kept', async () => {
    await renderApp('/a/000-999');
    expect(await findHeading('Old Homebox label')).toBeInTheDocument();
    expect(await screen.findByText(/Not in your Kept/)).toBeInTheDocument();
  });
});

describe('a re-issued Kept label, offline', () => {
  it('opens from the phone by its old code', async () => {
    const page = firstPage();
    const drill = page.changes.things[0];
    if (!drill) throw new Error('no thing');
    await pageStore().applySnapshot(
      firstPage({
        changes: {
          ...page.changes,
          legacyCodes: [
            ...page.changes.legacyCodes,
            {
              locationId: drill.locationId,
              source: 'kept',
              sourceCollection: '',
              code: 'QQ7R2M',
              thingId: drill.id,
              placeId: null,
            },
          ],
        },
      }),
    );
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { router, mock } = await renderApp('/l/qq7r2m');
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${drill.id}`));
    expect(mock.lastCall('POST', cp.scanResolve)).toBeUndefined();
  });
});
