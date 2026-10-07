/**
 * The CSV import stepper (T30; D73; screens §6): Arabic headers are mapped by themselves, the dry
 * run's reasons are translated from their codes, the report is paged, a 10,001-row file is refused
 * before anything is sent, a member sees only locations they own, and the server's 403, 409 and
 * 413 are explained. A stopped import resumes; a running one can be cancelled.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { capturePaths as cp } from '@/api/capture/paths';
import type { CreateImportBody, ImportRun } from '@/api/capture/types';
import { IDS, memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const csvFile = (text: string, name = 'things.csv') => new File([text], name, { type: 'text/csv' });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]');

const ARABIC = [
  'الاسم,المكان,الكمية,تاريخ الشراء,Wattage',
  'غلاية,المطبخ > الرف,١,25/03/2024,1500',
  'Toaster,المطبخ > الرف,2,31/02/2024,',
  ',Garage,1,,',
].join('\n');

async function openWithFile(text: string, path = `/settings/import?location=${IDS.home}`) {
  const app = await renderApp(path);
  await findHeading('Choose the file');
  await waitFor(() => expect(fileInput()).not.toBeNull());
  await app.user.upload(fileInput() as HTMLInputElement, csvFile(text));
  return app;
}

describe('CSV import', () => {
  it('maps Arabic headers, checks, translates the reasons, and imports', async () => {
    const { user, mock } = await openWithFile(ARABIC);
    expect(await findHeading('Match the columns')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'الاسم goes to' })).toHaveValue('Name');
    expect(screen.getByRole('combobox', { name: 'المكان goes to' })).toHaveValue(
      'Place (a path like Garage > Shelf A)',
    );
    expect(screen.getByRole('combobox', { name: 'Wattage goes to' })).toHaveValue("Don't import");
    expectLogicalOnly();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await findHeading('A few choices')).toBeInTheDocument();
    expect(screen.getByText('Worked out from the dates in the file.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check the import' }));

    expect(await findHeading('What the import will do')).toBeInTheDocument();
    const body = mock.lastCall('POST', cp.importsCsv)?.body as CreateImportBody;
    expect(body.mapping).toEqual({
      الاسم: 'name',
      المكان: 'place_path',
      الكمية: 'quantity',
      'تاريخ الشراء': 'purchased_on',
    });
    expect(body.choices).toMatchObject({
      placeSeparator: '>',
      dateFormat: 'DD/MM/YYYY',
      createPlaces: true,
      defaultTarget: { unplaced: true },
    });
    expect(body.rows).toHaveLength(3);

    const rows = await screen.findByRole('list', { name: 'Rows' });
    expect(within(rows).getByText('Partly as text')).toBeInTheDocument();
    expect(rows).toHaveTextContent(
      'تاريخ الشراء: Not a date written as DD/MM/YYYY; kept in the notes.',
    );
    expect(rows).toHaveTextContent("الاسم: No name, so it's skipped.");
    // The file is still here, so each row shows its name.
    expect(within(rows).getByText('غلاية')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import 2 things' }));
    expect(await findHeading('Done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Home' })).toHaveAttribute(
      'href',
      `/loc/${IDS.home}`,
    );
    expect(screen.getByRole('link', { name: 'Search Home' })).toBeInTheDocument();
  });

  it('reads in Arabic, right to left, with the reasons translated from their codes', async () => {
    const app = await renderApp(`/settings/import?location=${IDS.home}`, { locale: 'ar' });
    await findHeading('اختر الملف');
    expect(document.documentElement.dir).toBe('rtl');
    await waitFor(() => expect(fileInput()).not.toBeNull());
    await app.user.upload(fileInput() as HTMLInputElement, csvFile(ARABIC));
    await findHeading('طابِق الأعمدة');
    expect(screen.getByRole('combobox', { name: 'الاسم يذهب إلى' })).toHaveValue('الاسم');
    await app.user.click(screen.getByRole('button', { name: 'التالي' }));
    await app.user.click(await screen.findByRole('button', { name: 'فحص الاستيراد' }));
    const rows = await screen.findByRole('list', { name: 'الصفوف' });
    expect(rows).toHaveTextContent('ليس تاريخًا مكتوبًا بصيغة DD/MM/YYYY؛ حُفظ في الملاحظات.');
    expect(rows).toHaveTextContent('بلا اسم، فيُتخطّى.');
    expectLogicalOnly();
  });

  it('refuses a 10,001-row file before anything is sent', async () => {
    const lines = ['Name', ...Array.from({ length: 10_001 }, (_, i) => `Thing ${i}`)].join('\n');
    const { mock } = await openWithFile(lines);
    expect(
      await screen.findByText(
        'This file has 10,001 rows; an import takes at most 10,000. Split it into smaller files.',
      ),
    ).toBeInTheDocument();
    expect(mock.lastCall('POST', cp.importsCsv)).toBeUndefined();
  });

  it('asks for a name column before going on', async () => {
    const { user } = await openWithFile('Wattage,Colour\n1500,Red\n');
    await findHeading('Match the columns');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByText('Choose which column is the name: every thing needs one.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'A few choices' })).toBeNull();
  });

  it('shows the report a hundred rows at a time', async () => {
    const lines = [
      'Name,Qty',
      ...Array.from({ length: 250 }, (_, i) => `Thing ${i},${i % 2 ? 'lots' : '1'}`),
    ].join('\n');
    const { user } = await openWithFile(lines);
    await findHeading('Match the columns');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Check the import' }));
    const rows = await screen.findByRole('list', { name: 'Rows' });
    expect(rows.querySelectorAll('[data-list-row]')).toHaveLength(100);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows.querySelectorAll('[data-list-row]')).toHaveLength(200));
  });

  it('explains a 403 and a 413 from the server', async () => {
    const { user, mock } = await openWithFile('Name\nKettle\n');
    mock.on(
      'POST',
      cp.importsCsv,
      () => new MockReply(403, { error: 'Forbidden', code: 'forbidden' }),
    );
    await findHeading('Match the columns');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Check the import' }));
    expect(
      await screen.findByText('Only owners and admins of this location can import into it.'),
    ).toBeInTheDocument();
    mock.on(
      'POST',
      cp.importsCsv,
      () => new MockReply(413, { error: 'Too large', code: 'payload_too_large' }),
    );
    await user.click(screen.getByRole('button', { name: 'Check the import' }));
    expect(
      await screen.findByText(
        'An import takes at most 10,000 rows. Split the file and import each part.',
      ),
    ).toBeInTheDocument();
  });

  it('a 409 on Import offers the check again', async () => {
    const { user, mock } = await openWithFile('Name\nKettle\n');
    await findHeading('Match the columns');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Check the import' }));
    await findHeading('What the import will do');
    mock.on(
      'POST',
      cp.importStart(':id'),
      () => new MockReply(409, { error: 'Run the dry run first.', code: 'conflict' }),
    );
    await user.click(screen.getByRole('button', { name: 'Import 1 thing' }));
    expect(await screen.findByText('Check the import first, then import.')).toBeInTheDocument();
  });

  it('a member is offered only the locations they own', async () => {
    const { user } = await renderApp('/settings/import', { state: memberScenario() });
    await findHeading('Choose the file');
    // Alfred owns only his Personal location: it is the one choice, so it's chosen.
    const box = screen.getByRole('combobox', { name: 'Import into' });
    await waitFor(() => expect(box).not.toHaveValue(''));
    expect(box).not.toHaveValue('Home');
    await user.click(screen.getByRole('button', { name: 'Choose a CSV file' }));
    expect(screen.getByRole('button', { name: 'Choose a CSV file' })).toBeEnabled();
  });

  it('resumes a stopped import, and cancels a running one', async () => {
    const state = ownerScenario();
    const failed: ImportRun = {
      id: '01926f00-0000-7000-8000-00000000e201',
      locationId: IDS.home,
      source: 'csv',
      status: 'failed',
      mapping: { Name: 'name' },
      choices: {
        placeSeparator: '>',
        createPlaces: true,
        dateFormat: 'YYYY-MM-DD',
        defaultTarget: { unplaced: true },
        typeByName: true,
      },
      progress: 400,
      total: 1000,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: 'The database went away.',
      updatedAt: new Date().toISOString(),
      rowVersion: 3,
    };
    state.capture.imports.unshift(failed);
    const { user, mock } = await renderApp(
      `/settings/import?location=${IDS.home}&run=${failed.id}`,
      { state },
    );
    expect(await screen.findByText('Resume to carry on from row 400')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(mock.lastCall('POST', cp.importStart(failed.id))).toBeTruthy());
    expect(await screen.findByText('Importing…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel the import' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel the import?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the import' }));
    expect(await screen.findByText('Import cancelled')).toBeInTheDocument();
    expect(mock.lastCall('POST', cp.importCancel(failed.id))).toBeTruthy();
  });
});
