/**
 * The PWA shell (plan T23): the manifest, the worker's routing, the update prompt's gates (D148),
 * the share target's hand-over (D140) and the diagnostics report (D188).
 */
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareArrival } from '@/components/capture/share-arrival';
import { toastQueue } from '@/components/ui/toast';
import { MemoryStore, type SharedInto } from '@/offline/store';
import { expectLogicalOnly, renderUI } from '@/test/render';
import manifestText from '../../public/manifest.webmanifest?raw';
import { DiagnosticsPanel } from './diagnostics';
import { InsecureBanner } from './insecure-banner';
import { PROBE_KEYS, type ProbeKey, type ProbeResult, reportText } from './probes';
import { addUpdateGate, Updates, uploadIdle } from './register';
import { claimShare, SHARE_MAX_FILES, shareFromForm } from './share-target';
import {
  isAuthenticatedPath,
  isHouseholdChunk,
  isIconChunk,
  isLocaleChunk,
  NAVIGATE_FALLBACK_DENYLIST,
} from './sw-routes';
import { UpdatePrompt } from './update-prompt';

afterEach(() => {
  act(() => toastQueue.clear());
});

describe('manifest.webmanifest (§2.7)', () => {
  const manifest = JSON.parse(manifestText);
  const publicFiles = Object.keys(import.meta.glob('../../public/*')).map((k) =>
    k.replace('../../public', ''),
  );

  it('installs standalone at the root, in the paper colour', () => {
    expect(manifest).toMatchObject({
      name: 'Kept',
      short_name: 'Kept',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#F2F1EC',
      background_color: '#F2F1EC',
    });
  });

  it('lists the icons from step 2, maskable included, and each exists', () => {
    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
    expect(purposes).toContain('maskable');
    for (const icon of manifest.icons as { src: string }[]) expect(publicFiles).toContain(icon.src);
  });

  it('is a share target for images and PDFs, POSTed as multipart to /share', () => {
    expect(manifest.share_target).toEqual({
      action: '/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [{ name: 'files', accept: ['image/*', 'application/pdf', '.pdf'] }],
      },
    });
  });
});

describe('the service worker routes (D181)', () => {
  it('never caches the API or files: they are NetworkOnly', () => {
    for (const p of ['/api', '/api/v1/me', '/f/abc', '/f'])
      expect(isAuthenticatedPath(p)).toBe(true);
    for (const p of ['/', '/assets/index-abc.js', '/apiary', '/files', '/fish', '/share'])
      expect(isAuthenticatedPath(p)).toBe(false);
  });

  it('keeps icon chunks at runtime, and never answers /api, /f or /share with the shell', () => {
    expect(isIconChunk('/assets/icons/drill-abc.js')).toBe(true);
    expect(isIconChunk('/assets/icons/DynamicIcon-abc.js')).toBe(true);
    expect(isIconChunk('/assets/index-abc.js')).toBe(false);
    expect(isLocaleChunk('/assets/locales/messages-abc.js')).toBe(true);
    expect(isLocaleChunk('/assets/messages-abc.js')).toBe(false);
    expect(isHouseholdChunk('/assets/household/household-sections-abc.js')).toBe(true);
    expect(isHouseholdChunk('/assets/household-sections-abc.js')).toBe(false);
    const denied = (p: string) => NAVIGATE_FALLBACK_DENYLIST.some((r) => r.test(p));
    expect(['/api/v1/me', '/f/abc', '/share'].every(denied)).toBe(true);
    expect(['/', '/things/1', '/capture'].some(denied)).toBe(false);
  });
});

describe('the update prompt (D148)', () => {
  it('waits while something uploads, then offers Reload, and hands over on Reload', async () => {
    const store = new MemoryStore();
    await store.enqueue(
      {
        clientId: '01926f00-0000-7000-8000-00000020001a',
        idempotencyKey: 'cap:1',
        op: 'create_thing',
        takenAt: '2026-09-27T11:05:00.000Z',
        locationId: '01926f00-0000-7000-8000-00000000b002',
        payload: {},
      },
      [],
    );
    const [entry] = await store.pending();
    if (entry) entry.state = 'uploading';
    const removeGate = addUpdateGate(uploadIdle(store));
    const messageSkipWaiting = vi.fn();
    const reload = vi.fn();
    const updates = new Updates({ messageSkipWaiting }, reload);
    try {
      const { user } = await renderUI(<UpdatePrompt updates={updates} recheckMs={20} />);
      act(() => updates.onWaiting());
      await new Promise((r) => setTimeout(r, 80));
      expect(screen.queryByText('A new version is ready')).not.toBeInTheDocument();

      // The upload finishes: the next check shows the prompt.
      if (entry) entry.state = 'applied';
      expect(await screen.findByText('A new version is ready')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Reload' }));
      await waitFor(() => expect(messageSkipWaiting).toHaveBeenCalledOnce());
      expect(reload).not.toHaveBeenCalled();
      updates.onControlling(true);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      removeGate();
    }
  });

  it('never reloads mid-capture: Reload waits while a capture session holds updates', async () => {
    let capturing = false;
    const removeGate = addUpdateGate(() => !capturing);
    const messageSkipWaiting = vi.fn();
    const updates = new Updates({ messageSkipWaiting }, vi.fn());
    try {
      const { user } = await renderUI(<UpdatePrompt updates={updates} recheckMs={20} />);
      act(() => updates.onWaiting());
      expect(await screen.findByText('A new version is ready')).toBeInTheDocument();
      capturing = true;
      await user.click(screen.getByRole('button', { name: 'Reload' }));
      await new Promise((r) => setTimeout(r, 60));
      expect(messageSkipWaiting).not.toHaveBeenCalled();
      capturing = false;
      expect(await screen.findByText('A new version is ready')).toBeInTheDocument();
    } finally {
      removeGate();
    }
  });

  it('a page another tab already updated reloads without messaging the worker', async () => {
    const messageSkipWaiting = vi.fn();
    const reload = vi.fn();
    const updates = new Updates({ messageSkipWaiting }, reload);
    updates.onControlling(true);
    expect(updates.getState()).toBe('stale');
    expect(await updates.apply()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(messageSkipWaiting).not.toHaveBeenCalled();
  });
});

describe('share into Kept (D140)', () => {
  const pdf = new File(['%PDF-1.7'], 'receipt.pdf', { type: 'application/pdf' });
  const jpg = new File(['jpeg'], 'drill.jpg', { type: 'image/jpeg' });

  it('reads the images and PDFs from the share-target form, at most 20', () => {
    const form = new FormData();
    form.append('title', '  Receipt from Carrefour ');
    form.append('files', pdf);
    form.append('files', jpg);
    form.append('files', new File(['x'], 'notes.txt', { type: 'text/plain' }));
    const share = shareFromForm(form, 'share-1', '2026-09-27T11:07:00.000Z');
    expect(share.title).toBe('Receipt from Carrefour');
    expect(share.text).toBeNull();
    expect(share.files.map((f) => f.name)).toEqual(['receipt.pdf', 'drill.jpg']);

    const many = new FormData();
    for (let i = 0; i < 25; i += 1) many.append('files', jpg);
    expect(shareFromForm(many, 's', 'now').files).toHaveLength(SHARE_MAX_FILES);
  });

  it('claims a share from the worker once, then from the store', async () => {
    const store = new MemoryStore();
    const share: SharedInto = { id: 's1', at: 'now', title: null, text: null, files: [] };
    const ask = vi.fn(async (id: string) => (id === 's1' ? share : null));
    expect(await claimShare('s1', store, ask)).toEqual(share);
    expect(await claimShare('s1', store, ask)).toEqual(share);
    expect(ask).toHaveBeenCalledOnce();
    expect(await claimShare('gone', store, ask)).toBeUndefined();
  });

  it('opens "Shared into Kept" with RECEIPT chosen; Discard drops the files', async () => {
    const store = new MemoryStore();
    const share: SharedInto = {
      id: 's2',
      at: 'now',
      title: null,
      text: null,
      files: [
        { name: 'receipt.pdf', type: 'application/pdf', blob: pdf },
        { name: 'drill.jpg', type: 'image/jpeg', blob: jpg },
      ],
    };
    const onDone = vi.fn();
    const { user } = await renderUI(
      <ShareArrival sharedId="s2" store={store} ask={async () => share} onDone={onDone} />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('receipt.pdf');
    expect(dialog).toHaveTextContent('drill.jpg');
    expect(screen.getAllByRole('radio')[0]).toBeChecked();
    expectLogicalOnly(dialog);
    expect(await store.shared('s2')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await store.shared('s2')).toBeUndefined();
  });

  it('explains a share the server answered because the worker was not running (Q26)', async () => {
    await renderUI(<ShareArrival problem="unavailable" onDone={() => undefined} />);
    expect(screen.getByText('Open Kept once, then share again')).toBeInTheDocument();
  });
});

describe('plain HTTP (D31)', () => {
  it('shows what needs HTTPS, only on an insecure page', async () => {
    const { rerender } = await renderUI(<InsecureBanner insecure />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Camera, offline capture and install need HTTPS.',
    );
    rerender(<InsecureBanner insecure={false} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('diagnostics (D188)', () => {
  it('runs nothing until asked, then lists every check and copies a text report', async () => {
    const run = vi.fn(
      async (key: ProbeKey): Promise<ProbeResult> =>
        key === 'heic'
          ? { key, status: 'fail', facts: ['error=EncodingError: decode failed'] }
          : { key, status: 'ok', facts: [`${key}=yes`] },
    );
    const { user } = await renderUI(<DiagnosticsPanel run={run} />);
    expect(run).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Run the checks' }));
    const list = await screen.findByRole('list', { name: 'Diagnostics results' });
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(PROBE_KEYS.length));
    expect(list).toHaveTextContent('iPhone photos (HEIC)');
    expect(screen.getByRole('button', { name: 'Copy report' })).toBeInTheDocument();
  });

  it('writes the report as plain lines with ✓ and ✗', () => {
    expect(
      reportText(
        ['Kept diagnostics'],
        [
          { label: 'Camera', result: { key: 'camera', status: 'ok', facts: ['best=1920x1080'] } },
          { label: 'HEIC', result: { key: 'heic', status: 'fail', facts: [] } },
        ],
      ),
    ).toBe('Kept diagnostics\n\n✓ Camera: best=1920x1080\n✗ HEIC');
  });
});
