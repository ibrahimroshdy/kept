/**
 * Uploads (task 17's wire format, D117, D36): the browser hashes the bytes first
 * (crypto.subtle, mocked here so the digest is known), sends them raw with X-Kept-Sha256, then
 * attaches the file. HEIC is kept with "Preview unavailable", never an error.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { createMockApi, MockReply } from '@/api/mock/server';
import { fileClassOf, putFile, sha256Hex, uploadAndAttach } from '@/components/things/upload';
import { findHeading, renderApp } from '@/test/app';

// Whole-app renders under a parallel run can pass the 5 s default.
vi.setConfig({ testTimeout: 15_000 });

const DIGEST = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
const HEX = Array.from(DIGEST, (b) => b.toString(16).padStart(2, '0')).join('');

function mockDigest(bytes: Uint8Array = DIGEST) {
  return vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(bytes.buffer as ArrayBuffer);
}

const jpeg = (name = 'tv.jpg', type = 'image/jpeg') =>
  new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], name, { type });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('hashing and the wire format', () => {
  it('hashes the file bytes with SHA-256 into lower-case hex', async () => {
    const digest = mockDigest();
    const file = jpeg();
    expect(await sha256Hex(file)).toBe(HEX);
    expect(digest).toHaveBeenCalledWith('SHA-256', expect.any(ArrayBuffer));
    const sent = new Uint8Array(digest.mock.calls[0]?.[1] as ArrayBuffer);
    expect([...sent]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  });

  it('really hashes when not mocked (the empty file’s well-known digest)', async () => {
    expect(await sha256Hex(new Blob([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('PUTs the raw file with its hash, type and size, then attaches it', async () => {
    mockDigest();
    const mock = createMockApi(ownerScenario());
    vi.stubGlobal('fetch', mock.fetch);
    const progress: number[] = [];
    const a = await uploadAndAttach({
      file: jpeg(),
      locationId: IDS.home,
      fileId: '01926f00-0000-7000-8000-00000000f111',
      subject: { thingId: INV_IDS.thing.tv },
      role: 'photo',
      onProgress: (f) => progress.push(f),
    });
    const put = mock.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(p.file('01926f00-0000-7000-8000-00000000f111'));
    expect(put?.headers).toMatchObject({
      'x-kept-sha256': HEX,
      'content-type': 'image/jpeg',
      'content-length': '7',
    });
    expect(put?.body).toBeInstanceOf(File);
    expect(mock.lastCall('POST', p.attachments)?.body).toMatchObject({
      locationId: IDS.home,
      fileId: '01926f00-0000-7000-8000-00000000f111',
      subject: { thingId: INV_IDS.thing.tv },
      role: 'photo',
    });
    expect(a.file?.sha256).toBe(HEX);
    expect(progress).toEqual([0, 1]);
  });

  it('sends the location and the class (from the type) in the query', async () => {
    mockDigest();
    const mock = createMockApi(ownerScenario());
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return mock.fetch(input, init);
    });
    await putFile({ file: jpeg('manual.pdf', 'application/pdf'), locationId: IDS.garage });
    const url = new URL(urls[0] ?? '', 'http://kept.test');
    expect(url.searchParams.get('locationId')).toBe(IDS.garage);
    expect(url.searchParams.get('class')).toBe('document');
    expect(fileClassOf('image/png')).toBe('photo');
    expect(fileClassOf('video/mp4')).toBe('video');
  });

  it('the same bytes in the same location are deduplicated; in another location they are not', async () => {
    mockDigest();
    const mock = createMockApi(ownerScenario());
    vi.stubGlobal('fetch', mock.fetch);
    const first = await putFile({ file: jpeg(), locationId: IDS.home });
    const again = await putFile({ file: jpeg(), locationId: IDS.home });
    const elsewhere = await putFile({ file: jpeg(), locationId: IDS.garage });
    expect(again.deduplicatedFrom).toBe(first.id);
    expect(elsewhere.deduplicatedFrom).toBeUndefined();
    expect(elsewhere.id).not.toBe(first.id);
  });

  it('a checksum refusal surfaces as an error', async () => {
    mockDigest();
    const mock = createMockApi(ownerScenario());
    mock.on(
      'PUT',
      p.file(':id'),
      () => new MockReply(400, { error: 'The bytes do not match.', code: 'checksum_mismatch' }),
    );
    vi.stubGlobal('fetch', mock.fetch);
    const e = await putFile({ file: jpeg(), locationId: IDS.home }).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 400, message: 'The bytes do not match.' });
    // The shared enum knows the code once task 2 lists it; until then it is kept as serverCode.
    const { code, serverCode } = e as { code: string; serverCode?: string };
    expect(serverCode ?? code).toBe('checksum_mismatch');
  });
});

describe('uploading on the thing page', () => {
  const input = () => document.querySelector<HTMLInputElement>('input[type="file"]');

  it('adds a photo to the carousel, with progress while it runs', async () => {
    mockDigest();
    const { user, mock } = await renderApp(`/t/${INV_IDS.thing.tv}`);
    await findHeading('Samsung TV, 55″');
    const picker = input();
    if (!picker) throw new Error('no file input');
    await user.upload(picker, jpeg());
    await waitFor(() => expect(mock.lastCall('POST', p.attachments)).toBeDefined());
    expect(await screen.findByRole('img', { name: 'Photo 1 of 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
  });

  it('HEIC is kept and says "Preview unavailable", never an error (D36)', async () => {
    mockDigest();
    const { user } = await renderApp(`/t/${INV_IDS.thing.tv}`);
    await findHeading('Samsung TV, 55″');
    const picker = input();
    if (!picker) throw new Error('no file input');
    await user.upload(picker, jpeg('IMG_0001.HEIC', 'image/heic'));
    expect(await screen.findByText('Saved. Preview unavailable')).toBeInTheDocument();
    expect(await screen.findByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't upload/)).toBeNull();
  });

  it('a file that is too big says so', async () => {
    mockDigest();
    const { user } = await renderApp(`/t/${INV_IDS.thing.tv}`, {
      setup: (m) =>
        m.on(
          'PUT',
          p.file(':id'),
          () => new MockReply(413, { error: 'Too big.', code: 'payload_too_large' }),
        ),
    });
    await findHeading('Samsung TV, 55″');
    const picker = input();
    if (!picker) throw new Error('no file input');
    await user.upload(picker, jpeg('huge.jpg'));
    expect(await screen.findByText("Couldn't upload huge.jpg")).toBeInTheDocument();
  });

  it('a viewer has no upload', async () => {
    const s = ownerScenario();
    const home = s.locations.find((l) => l.id === IDS.home);
    if (home) home.role = 'viewer';
    await renderApp(`/t/${INV_IDS.thing.tv}`, { state: s });
    await findHeading('Samsung TV, 55″');
    expect(input()).toBeNull();
  });
});
