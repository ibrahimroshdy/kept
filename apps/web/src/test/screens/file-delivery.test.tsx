/**
 * Files Kept makes, handed over on every platform (lib/files.ts). An installed iPhone app doesn't
 * handle downloads, so a finished inventory PDF offers Open PDF (inline, a new tab), Share (the
 * PDF itself on the share sheet, where the browser shares files) and Download (where downloads
 * work); only a desktop browser downloads by itself. The label images and the AI calls' CSV
 * reach the share sheet there too, and so do uploaded originals (receipts, manuals, a place's
 * attachments), which stay attachment-only (D157) and are fetched ahead. Each surface is checked
 * on a desktop browser, iPhone Safari, and the installed iPhone app, with `navigator.share` and
 * `navigator.canShare` mocked.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePaths as cp } from '@/api/capture/paths';
import type { LabelBatch } from '@/api/capture/types';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import type { AttachmentView, FileView, ReportRun } from '@/api/inventory/types';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/kit';
import { findHeading, renderApp } from '@/test/app';

vi.setConfig({ testTimeout: 20_000 });

// Making real PNGs needs a canvas: the label images are stood in for.
const pngs = vi.hoisted(() => ({ made: 0 }));
vi.mock('@/components/labels/png', async (original) => ({
  ...(await original<typeof import('@/components/labels/png')>()),
  labelPngs: async () => {
    pngs.made += 1;
    return [new File(['png'], 'kept-AR7HDM.png', { type: 'image/png' })];
  },
}));

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

type Platform = { ua: string; standalone?: boolean; shares?: boolean };
const added: string[] = [];

function define(key: string, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  added.push(key);
}

/** Pretends to be `ua`, installed or not, with a share sheet that takes files or none. */
function on({ ua, standalone = false, shares = false }: Platform) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  define('maxTouchPoints', ua === IPHONE ? 5 : 0);
  define('standalone', standalone);
  const share = vi.fn(async (_data: ShareData) => {});
  if (shares) {
    define('share', share);
    define('canShare', (data: ShareData) => (data.files?.length ?? 0) > 0);
  }
  return share;
}

afterEach(() => {
  for (const key of added.splice(0)) delete (navigator as unknown as Record<string, unknown>)[key];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pngs.made = 0;
});

// ----- the inventory PDF ----------------------------------------------------------------------

const RUN = '01926f00-0000-7000-8000-00000000e202';
const PDF = 'https://files.kept.test/f/report-attachment?sig=1';
const VIEW = 'https://files.kept.test/f/report-inline?sig=1';
const CREATED = '2026-09-30T06:00:00.000Z';

const done = (n = 1): ReportRun => ({
  id: RUN,
  status: 'done',
  scope: { locationId: IDS.home },
  progress: { done: 4, total: 4 },
  fileUrl: PDF.replace('sig=1', `sig=${n}`),
  viewUrl: VIEW.replace('sig=1', `sig=${n}`),
  bytes: 38_000,
  createdAt: CREATED,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

/** Makes a report on the location page; each read of the run is `done` with new links, and
 * a read after the first waits for `held` while it is set. */
let held: Promise<void> | null = null;
async function makeReport() {
  let reads = 0;
  const app = await renderApp(`/loc/${IDS.home}`, {
    setup: (m) => {
      m.on(
        'POST',
        p.reportsInventory,
        () => new MockReply(202, { id: RUN, status: 'queued', expiresAt: done().expiresAt }),
      );
      m.on('GET', p.report(':id'), async () => {
        reads += 1;
        const n = reads;
        if (n > 1 && held) await held;
        return done(n);
      });
    },
  });
  // The PDF's bytes, for Share.
  const real = app.mock.fetch;
  const pdfFetches: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://files.kept.test/')) {
      pdfFetches.push(url);
      return Promise.resolve(
        new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
      );
    }
    return real(input, init);
  });
  await findHeading('Home');
  await app.user.click(await screen.findByRole('button', { name: 'Print inventory' }));
  const dialog = await screen.findByRole('dialog', { name: 'Print inventory' });
  await app.user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
  await within(dialog).findByText('Your PDF is ready', {}, { timeout: 5000 });
  return { ...app, dialog, reads: () => reads, pdfFetches };
}

describe('the inventory PDF, once made', () => {
  it('on a desktop browser: Open PDF, Download, and the download starts by itself once', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    on({ ua: MAC });
    const { dialog } = await makeReport();
    const open = within(dialog).getByRole('link', { name: 'Open PDF' });
    expect(open).toHaveAttribute('href', done(1).viewUrl);
    expect(open).toHaveAttribute('target', '_blank');
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      done(1).fileUrl,
    );
    expect(within(dialog).queryByRole('button', { name: 'Share' })).toBeNull();
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.contexts[0] as HTMLAnchorElement).href).toBe(done(1).fileUrl);
  });

  it('in the installed iPhone app: Open PDF and Share, no Download, nothing starts by itself', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const share = on({ ua: IPHONE, standalone: true, shares: true });
    const { dialog, user, pdfFetches } = await makeReport();
    expect(within(dialog).getByRole('link', { name: 'Open PDF' })).toHaveAttribute(
      'href',
      done(1).viewUrl,
    );
    expect(within(dialog).queryByRole('link', { name: 'Download' })).toBeNull();
    // The PDF is fetched ahead, through the link in hand, so the press shares at once.
    const button = await within(dialog).findByRole('button', { name: 'Share' });
    expect(pdfFetches).toEqual([done(1).fileUrl]);
    await user.click(button);
    expect(share).toHaveBeenCalledTimes(1);
    const file = share.mock.calls[0]?.[0].files?.[0];
    expect(file?.name).toBe('kept-inventory-2026-09-30.pdf');
    expect(file?.type).toBe('application/pdf');
    expect(click).not.toHaveBeenCalled();
  });

  it('in iPhone Safari without file sharing: Open PDF and Download, no Share, no download by itself', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    on({ ua: IPHONE });
    const { dialog, pdfFetches } = await makeReport();
    expect(within(dialog).getByRole('link', { name: 'Open PDF' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Download' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Share' })).toBeNull();
    expect(pdfFetches).toEqual([]);
    expect(click).not.toHaveBeenCalled();
  });

  it('a link past its four minutes is never offered: Open waits for a new one', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    on({ ua: MAC });
    const { dialog, reads } = await makeReport();
    expect(within(dialog).getByRole('link', { name: 'Open PDF' })).toHaveAttribute(
      'href',
      done(1).viewUrl,
    );
    const before = reads();
    let release = () => {};
    held = new Promise((ok) => {
      release = ok;
    });
    try {
      // Five minutes on (a phone back from the background): the page comes back into view.
      const real = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => real() + 5 * 60_000);
      document.dispatchEvent(new Event('visibilitychange'));
      // While the new link is on its way, Open and Download are waiting buttons, not old links.
      expect(await within(dialog).findByRole('button', { name: 'Open PDF' })).toHaveAttribute(
        'data-pending',
        'true',
      );
      expect(within(dialog).queryByRole('link', { name: 'Open PDF' })).toBeNull();
      expect(within(dialog).queryByRole('link', { name: 'Download' })).toBeNull();
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    } finally {
      release();
      held = null;
    }
    await waitFor(() =>
      expect(within(dialog).getByRole('link', { name: 'Open PDF' })).toHaveAttribute(
        'href',
        done(reads()).viewUrl,
      ),
    );
  });
});

// ----- the label images -----------------------------------------------------------------------

const BATCH = '01926f00-0000-7000-8000-000000100098';
const batch = (): LabelBatch => ({
  id: BATCH,
  locationId: IDS.family,
  kind: 'things',
  stock: 'thermal_50x30',
  startCell: 1,
  createdAt: '2026-10-06T08:00:00Z',
  printedConfirmedAt: null,
  labels: [
    {
      code: 'AR7HDM',
      url: 'https://kept.example/l/AR7HDM',
      kind: 'thing',
      name: 'كابل HDMI',
      path: 'غرفة المعيشة',
      targetId: INV_IDS.thing.arHdmi,
    },
  ],
});

async function printView() {
  const state = ownerScenario();
  state.capture.labelBatches.unshift(batch());
  const app = await renderApp(`/labels/${BATCH}`, { state });
  await screen.findByRole('heading', { level: 1, name: '1 label' });
  return app;
}

describe('Share as images', () => {
  it('in the installed iPhone app, the images are made ahead and the press shares them', async () => {
    const share = on({ ua: IPHONE, standalone: true, shares: true });
    const { user } = await printView();
    const button = screen.getByRole('button', { name: 'Share as images' });
    await waitFor(() => expect(pngs.made).toBe(1));
    await waitFor(() => expect(button).not.toHaveAttribute('data-pending'));
    await user.click(button);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[0].files?.map((f) => f.name)).toEqual(['kept-AR7HDM.png']);
    // Made once, ahead: the press didn't make them again.
    expect(pngs.made).toBe(1);
  });

  it('in the installed iPhone app with no file sharing, it says so rather than download nothing', async () => {
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    on({ ua: IPHONE, standalone: true });
    const { user } = await printView();
    await user.click(screen.getByRole('button', { name: 'Share as images' }));
    expect(
      await screen.findByText("Couldn't share the label images. Try again."),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('on a desktop browser without file sharing, they download, made only on the press', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    on({ ua: MAC });
    const { user } = await printView();
    expect(pngs.made).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Share as images' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.contexts[0] as HTMLAnchorElement).download).toBe('kept-AR7HDM.png');
    expect(await screen.findByText('Saved the label images')).toBeInTheDocument();
  });
});

// ----- the AI calls' CSV ----------------------------------------------------------------------

describe('Export CSV', () => {
  const csvUrl = () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
  };

  it('on a desktop browser, downloads the file', async () => {
    csvUrl();
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    on({ ua: MAC, shares: true });
    const { user, mock } = await renderApp('/settings/ai/usage?scope=me');
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(mock.calls.some((c) => c.path === cp.aiCallsCsv)).toBe(true);
    expect((save.mock.contexts[0] as HTMLAnchorElement).download).toBe('ai-calls.csv');
    expect(screen.queryByText('Your CSV is ready')).toBeNull();
  });

  it('in the installed iPhone app, fetches it, then a second press shares it', async () => {
    csvUrl();
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const share = on({ ua: IPHONE, standalone: true, shares: true });
    const { user } = await renderApp('/settings/ai/usage?scope=me');
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Your CSV is ready')).toBeInTheDocument();
    expect(share).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(share).toHaveBeenCalledTimes(1);
    const file = share.mock.calls[0]?.[0].files?.[0];
    expect(file?.name).toBe('ai-calls.csv');
    expect(file?.type).toBe('text/csv');
    await waitFor(() => expect(screen.queryByText('Your CSV is ready')).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });
});

// ----- uploaded originals ---------------------------------------------------------------------

describe('an uploaded original (a receipt, a manual, a place attachment)', () => {
  const FILE = '01926f00-0000-7000-8000-0000000f0001';
  const ORIGINAL = 'https://files.kept.test/f/original-attachment?sig=1';
  const T = INV_IDS.thing;

  /** A PDF manual on the TV's paperwork, the same PDF as its receipt, and on the living room. */
  function withPdf(): MockState {
    const state = ownerScenario();
    const file: FileView = {
      id: FILE,
      sha256: 'a'.repeat(64),
      bytes: 48_000,
      mime: 'application/pdf',
      class: 'document',
      hasGps: false,
      width: null,
      height: null,
      derivativeState: 'not_applicable',
      thumbUrl: null,
      displayUrl: null,
    };
    const attachment = (
      id: string,
      role: AttachmentView['role'],
      subject: AttachmentView['subject'],
    ) => ({
      id,
      role,
      sort: 0,
      file,
      url: null,
      subject,
      createdBy: { displayName: 'Ibrahim' },
      rowVersion: 1,
      locationId: IDS.home,
    });
    state.inventory.files[FILE] = file;
    const manual = attachment('01926f00-0000-7000-8000-0000000a0001', 'manual', { thingId: T.tv });
    const onPlace = attachment('01926f00-0000-7000-8000-0000000a0002', 'document', {
      placeId: INV_IDS.place.livingRoom,
    });
    const receipt = attachment('01926f00-0000-7000-8000-0000000a0003', 'receipt', {
      purchaseId: '01926f00-0000-7000-8000-00000000003c',
    });
    state.inventory.attachments.push(manual, onPlace);
    const tv = state.inventory.things.find((x) => x.id === T.tv);
    if (tv?.purchase) {
      const { locationId: _l, ...view } = receipt;
      tv.purchase.receipts = [view];
    }
    return state;
  }

  /** Renders `path` with the signed original served from the files host; counts its fetches. */
  async function render(path: string) {
    const app = await renderApp(path, {
      state: withPdf(),
      setup: (m) =>
        m.on('POST', p.fileUrl(':id'), () => ({
          url: ORIGINAL,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })),
    });
    const real = app.mock.fetch;
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://files.kept.test/')) {
        fetched.push(url);
        return Promise.resolve(
          new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
        );
      }
      return real(input, init);
    });
    return { ...app, fetched };
  }

  it('on a desktop browser, Open opens the signed link, as before', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    on({ ua: MAC, shares: true });
    const { user, fetched } = await render(`/t/${T.tv}?tab=paperwork`);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(ORIGINAL, '_blank', 'noopener'));
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(fetched).toEqual([]);
  });

  it('in the installed iPhone app, the manual is fetched ahead and the press shares it', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const share = on({ ua: IPHONE, standalone: true, shares: true });
    const { user, fetched } = await render(`/t/${T.tv}?tab=paperwork`);
    const button = await screen.findByRole('button', { name: 'Share' });
    await waitFor(() => expect(button).not.toHaveAttribute('data-pending'));
    // Fetched ahead: for the manual, and for the same PDF as the purchase's receipt.
    await waitFor(() => expect(fetched).toEqual([ORIGINAL, ORIGINAL]));
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    await user.click(button);
    expect(share).toHaveBeenCalledTimes(1);
    const file = share.mock.calls[0]?.[0].files?.[0];
    expect(file?.name).toBe('kept-manual-01926f00.pdf');
    expect(file?.type).toBe('application/pdf');
    expect(opened).not.toHaveBeenCalled();
  });

  it('in the installed iPhone app, a receipt shares too', async () => {
    const share = on({ ua: IPHONE, standalone: true, shares: true });
    const { user } = await render(`/t/${T.tv}`);
    const button = await screen.findByRole('button', { name: 'Receipt 1' });
    await waitFor(() => expect(button).not.toHaveAttribute('data-pending'));
    await user.click(button);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[0].files?.[0]?.name).toBe('kept-receipt-01926f00.pdf');
  });

  it("in the installed iPhone app, a place's attachment shares", async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const share = on({ ua: IPHONE, standalone: true, shares: true });
    const { user, fetched } = await render(`/p/${INV_IDS.place.livingRoom}`);
    // With Paperwork on, the place's document is in its Paperwork section (plan T23, D155).
    const row = await screen.findByRole('button', { name: 'Share Document' });
    await waitFor(() => expect(fetched).toEqual([ORIGINAL]));
    await user.click(row);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]?.[0].files?.[0]?.name).toBe('kept-document-01926f00.pdf');
    expect(opened).not.toHaveBeenCalled();
  });

  it('in the installed iPhone app with no file sharing, the press says so', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    on({ ua: IPHONE, standalone: true });
    const { user, fetched } = await render(`/t/${T.tv}?tab=paperwork`);
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(
      await screen.findByText("This file can't be shared from the installed app"),
    ).toBeInTheDocument();
    expect(screen.getByText('Open Kept in Safari to download it.')).toBeInTheDocument();
    expect(fetched).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });
});
