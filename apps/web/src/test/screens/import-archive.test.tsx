/**
 * The import stepper for archives (step-7 T19; screens §6; D146, D157): a Homebox export uploaded,
 * inspected, connected, targeted, chosen, checked and imported, with "See what was imported" and
 * the enrichment offer; a Kept export's passphrase and its new-location-only target; a 5 GB + 1
 * file refused before anything is sent; an upload that fails starts again cleanly; leaving
 * mid-upload asks with Kept's own confirm; a refused archive says why; offline, it needs a
 * connection; and the report's every archive and Homebox reason is translated.
 */
import { ARCHIVE_ISSUE_CODES, HB_ISSUE_CODES } from '@kept/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePaths as cp } from '@/api/capture/paths';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { err, PASS } from '@/api/mock/kit';
import { PORTABILITY_IDS, pt } from '@/api/portability/mock/state';
import { portabilityPaths as p } from '@/api/portability/paths';
import type { CreateArchiveImportBody, HomeboxConnectBody } from '@/api/portability/types';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => vi.restoreAllMocks());

const zip = (name = 'homebox-export-3f2a.zip', bytes = 2048) =>
  new File([new Uint8Array(bytes).fill(7)], name, { type: 'application/zip' });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]');

async function chooseSource(label: 'A Homebox export' | 'A Kept export') {
  const app = await renderApp(`/settings/import?location=${IDS.home}`);
  await findHeading('Choose the file');
  await app.user.click(await screen.findByRole('radio', { name: new RegExp(label) }));
  await findHeading(label === 'A Homebox export' ? 'The Homebox export' : 'The Kept export');
  await waitFor(() => expect(fileInput()).not.toBeNull());
  return app;
}

describe('a Homebox export', () => {
  it('uploads, inspects, connects, targets, chooses, checks and imports', async () => {
    const app = await chooseSource('A Homebox export');
    const { user, mock } = app;
    await user.upload(fileInput() as HTMLInputElement, zip());

    expect(await findHeading("What's in it")).toBeInTheDocument();
    const declared = mock.lastCall('POST', p.importsArchive)?.body as CreateArchiveImportBody;
    expect(declared).toMatchObject({ source: 'homebox_zip', bytes: 2048 });
    expect(declared.sha256).toMatch(/^[0-9a-f]{64}$/);
    const put = [...mock.calls].reverse().find((c) => c.method === 'PUT');
    expect(put?.headers['x-kept-sha256']).toBe(declared.sha256);
    expect(screen.getByText('items and locations')).toBeInTheDocument();
    expect(screen.getByText(/version unknown/)).toBeInTheDocument();

    // The optional connection: the key goes in the body once, and the version shows.
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Homebox address' }),
      'https://hb.example.com',
    );
    await user.type(
      screen.getByLabelText('API key', { selector: 'input[type=password]' }),
      'hb_secret',
    );
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connected to Homebox')).toBeInTheDocument();
    const connect = mock.lastCall('POST', p.importHomeboxConnect(declared.id))
      ?.body as HomeboxConnectBody;
    expect(connect).toEqual({ baseUrl: 'https://hb.example.com', apiKey: 'hb_secret' });
    expect(screen.queryByDisplayValue('hb_secret')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await findHeading('Where it goes')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Home');
    await user.click(screen.getByRole('radio', { name: /A location you run/ }));
    const where = screen.getByRole('combobox', { name: 'Location' });
    await user.type(where, 'Gar');
    await user.click(await screen.findByRole('option', { name: 'Garage' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(mock.lastCall('POST', p.importTarget(declared.id))?.body).toEqual({
      locationId: IDS.garage,
    });

    expect(await findHeading('A few choices, before the check')).toBeInTheDocument();
    // The connection's currency, the types matched by name or created, the fields kept.
    const types = await screen.findByRole('list', { name: 'Homebox types' });
    expect(within(types).getByText('Kitchen gear')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Kept type for Kitchen gear' })).toHaveValue(
      'Create "Kitchen gear"',
    );
    expect(screen.getByText('3 items are marked insured.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Import, tagged "Archived in Homebox"' }));
    await user.click(screen.getByRole('button', { name: 'Check the import' }));

    expect(await findHeading('What the import will do')).toBeInTheDocument();
    const choices = mock.lastCall('POST', p.importChoices(declared.id));
    expect(choices?.headers['if-match']).toBeDefined();
    expect(choices?.body).toMatchObject({
      choices: {
        archived: 'tag',
        currency: 'USD',
        insured: 'field',
        seeded: 'skip_unused',
        fields: { Voltage: 'add_to_type', 'Warranty card no.': 'add_to_type' },
      },
    });
    // People to invite come from the connection, with their emails.
    const people = screen.getByRole('list', { name: 'People to invite' });
    expect(within(people).getByText('louis@example.com')).toBeInTheDocument();
    expectLogicalOnly();

    await user.click(screen.getByRole('button', { name: 'Import 5 things' }));
    expect(
      await screen.findByRole('heading', { name: 'Done' }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See what was imported' })).toHaveAttribute(
      'href',
      expect.stringContaining(`/loc/${IDS.garage}?f.importRun=`),
    );
    // The enrichment offer: its cost first, nothing started until asked.
    expect(await screen.findByText(/about 2,000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/USD/)).toBeInTheDocument();
    expect(mock.lastCall('POST', p.importEnrich(declared.id))).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Add search words' }));
    expect(await screen.findByText('Adding search words')).toBeInTheDocument();
  });

  it('lists only the entries with an issue, grouped by their translated reason', async () => {
    const { user } = await renderApp(`/settings/import?run=${PORTABILITY_IDS.homeboxRun}`);
    expect(await findHeading('What the import will do')).toBeInTheDocument();
    const rows = await screen.findByRole('list', { name: 'Needs a look' });
    expect(rows).toHaveTextContent('Quantity 0 became 1: Homebox gives 0 when none was set.');
    expect(rows).toHaveTextContent('drill-manual.docx');
    expect(rows).toHaveTextContent('A location inside an item became a container.');
    for (const code of [...ARCHIVE_ISSUE_CODES, ...HB_ISSUE_CODES])
      expect(rows.textContent).not.toContain(code);
    await user.type(screen.getByRole('searchbox', { name: 'Search the report' }), 'Toolbox');
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Needs a look' })).not.toHaveTextContent(
        'drill-manual.docx',
      ),
    );
  });

  it('says why an archive was refused, and offers another file', async () => {
    const state = ownerScenario();
    const run = pt(state).archiveRuns[0];
    if (!run) throw new Error('no run');
    pt(state).archiveRuns.unshift({
      ...run,
      id: '01926f00-0000-7000-8000-0000000d70ff',
      locationId: null,
      status: 'failed',
      error: 'archive_invalid',
      reason: 'encrypted',
      inspect: null,
      report: undefined,
    } as never);
    const { user, router } = await renderApp(
      '/settings/import?run=01926f00-0000-7000-8000-0000000d70ff',
      {
        state,
      },
    );
    expect(await findHeading("Kept can't read this archive")).toBeInTheDocument();
    expect(
      screen.getByText(
        "It's protected with a ZIP password, which Kept can't open. Export it again without one.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose another file' }));
    expect(await findHeading('The Homebox export')).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ source: 'homebox_zip' });
  });
});

describe('the upload', () => {
  it('refuses a file over 5 GB before anything is sent', async () => {
    const { user, mock } = await chooseSource('A Homebox export');
    const big = zip('huge.zip', 1);
    Object.defineProperty(big, 'size', { value: 5 * 1024 ** 3 + 1 });
    await user.upload(fileInput() as HTMLInputElement, big);
    expect(
      await screen.findByText('This file is 5.4 GB; an import takes at most 5 GB.'),
    ).toBeInTheDocument();
    expect(mock.lastCall('POST', p.importsArchive)).toBeUndefined();
  });

  it('starts again cleanly after an upload fails', async () => {
    let fail = true;
    const { user, mock } = await chooseSource('A Kept export');
    mock.on('PUT', p.importArchive(':id'), () => {
      if (!fail) return PASS;
      fail = false;
      return err(500, 'internal', 'The disk is full.');
    });
    await user.upload(fileInput() as HTMLInputElement, zip('home.zip'));
    expect(await screen.findByText("The upload didn't finish")).toBeInTheDocument();
    const first = (
      mock.lastCall('POST', p.importsArchive)?.body as CreateArchiveImportBody | undefined
    )?.id;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findHeading("What's in it")).toBeInTheDocument();
    const second = (
      mock.lastCall('POST', p.importsArchive)?.body as CreateArchiveImportBody | undefined
    )?.id;
    expect(second).not.toBe(first);
  });

  it('asks with its own confirm before leaving mid-upload', async () => {
    const { user, mock } = await chooseSource('A Homebox export');
    mock.hang('PUT', p.importArchive(':id'));
    await user.upload(fileInput() as HTMLInputElement, zip());
    expect(await screen.findByRole('progressbar', { name: 'Uploading' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Stop the upload?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep uploading' }));
    expect(screen.getByRole('heading', { name: 'The Homebox export' })).toBeInTheDocument();
  });

  it('needs a connection', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await chooseSource('A Homebox export');
    expect(screen.getByRole('button', { name: 'Choose the .zip file' })).toBeDisabled();
    expect(screen.getByText('Needs a connection')).toBeInTheDocument();
  });
});

describe('a Kept export', () => {
  it('opens its secrets with the passphrase and goes only into a new location', async () => {
    const { user, mock } = await renderApp(`/settings/import?run=${PORTABILITY_IDS.keptRun}`);
    expect(await findHeading("What's in it")).toBeInTheDocument();
    expect(screen.getAllByText('بيت العائلة').length).toBeGreaterThan(0);
    const field = screen.getByLabelText('Passphrase');
    await user.type(field, 'not the right one');
    await user.click(screen.getByRole('button', { name: 'Open the secrets' }));
    expect(
      await screen.findByText("That passphrase doesn't open this export's secrets."),
    ).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, PORTABILITY_IDS.passphrase);
    await user.click(screen.getByRole('button', { name: 'Open the secrets' }));
    expect(await screen.findByText('The secrets will be imported')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(PORTABILITY_IDS.passphrase)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await findHeading('Where it goes')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /A location you run/ })).toBeNull();
    expect(
      screen.getByText('A Kept export always comes in as a new location.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('بيت العائلة');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(mock.lastCall('POST', p.importTarget(PORTABILITY_IDS.keptRun))?.body).toMatchObject({
      newLocation: { name: 'بيت العائلة', kind: 'home' },
    });

    expect(await findHeading('Check the import')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check the import' }));
    expect(await findHeading('What the import will do')).toBeInTheDocument();
    expect(mock.lastCall('POST', cp.importDryRun(PORTABILITY_IDS.keptRun))).toBeDefined();
    expect(screen.getByText(/labels kept as printed/)).toBeInTheDocument();
    const people = screen.getByRole('list', { name: 'People to invite' });
    expect(within(people).getByText('Bruce')).toBeInTheDocument();
    expect(within(people).getByRole('link', { name: 'Invite' })).toBeInTheDocument();
  });
});

describe('in Arabic', () => {
  it('reads a Kept export right to left, with its words translated', async () => {
    await renderApp(`/settings/import?run=${PORTABILITY_IDS.keptRun}`, { locale: 'ar' });
    expect(await findHeading('ما في الملف')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByText('فيه أسرار مشفّرة')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'التالي' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
