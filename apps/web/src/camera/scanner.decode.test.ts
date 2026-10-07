// @vitest-environment node
/**
 * The real decoder on fixture images (plan T26): `barcode-detector`'s ponyfill with the installed
 * zxing-wasm reader, run in Node. The images are drawn here, pixel by pixel: a QR code with `uqr`
 * (the same encoder the label sheets use) and an EAN-13 from its published module tables, so the
 * test needs no image files and no canvas.
 *
 * It also pins the pair: the ponyfill bundles zxing-wasm's JS glue, and the wasm we self-host must
 * be the build that glue was made for (the spike's second correction). A bump of one without the
 * other fails here, not on a phone.
 *
 * Node has no `ImageData` or `DOMRectReadOnly`; minimal stand-ins are enough for the ponyfill,
 * which checks the former by its tag and builds boxes with the latter.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseScan } from '@kept/shared';
import { encode } from 'uqr';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

class ImageDataStandIn {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
  get [Symbol.toStringTag]() {
    return 'ImageData';
  }
}
class RectStandIn {
  constructor(
    readonly x = 0,
    readonly y = 0,
    readonly width = 0,
    readonly height = 0,
  ) {}
}

type Ponyfill = typeof import('barcode-detector/ponyfill');
let ponyfill: Ponyfill;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.ImageData ??= ImageDataStandIn;
  g.DOMRectReadOnly ??= RectStandIn;
  ponyfill = await import('barcode-detector/ponyfill');
  const wasm = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
  ponyfill.prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
    fireImmediately: true,
  });
});

/** Greyscale pixels (true = black) as RGBA ImageData. */
function image(width: number, height: number, black: (x: number, y: number) => boolean) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = black(x, y) ? 0 : 255;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  return new ImageData(px, width, height);
}

function qrImage(text: string, scale = 6) {
  const qr = encode(text, { border: 4 });
  const side = qr.size * scale;
  return image(
    side,
    side,
    (x, y) => qr.data[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true,
  );
}

// EAN-13 (ISO/IEC 15420): the first digit picks the left half's L/G pattern.
const R = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];
const L = R.map((r) => [...r].map((b) => (b === '1' ? '0' : '1')).join(''));
const G = R.map((r) => [...r].reverse().join(''));
const PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

function ean13Image(code: string, scale = 3, height = 120) {
  const d = [...code].map(Number);
  const parity = PARITY[d[0] as number] as string;
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[d[i] as number];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i] as number];
  bits += '101';
  const quiet = '0'.repeat(11);
  const all = quiet + bits + quiet;
  return image(all.length * scale, height, (x) => all[Math.floor(x / scale)] === '1');
}

const detector = () =>
  new ponyfill.BarcodeDetector({
    formats: ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  });

describe('the wasm scanner on fixture images', () => {
  it('self-hosts the wasm build the ponyfill was made for', () => {
    const web = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(web.dependencies['zxing-wasm']).toBe(ponyfill.ZXING_WASM_VERSION);
    const wasm = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(ponyfill.ZXING_WASM_SHA256);
  });

  it('reads a Kept label from any host, as the label prints it', async () => {
    const [read] = await detector().detect(qrImage('https://old.example/l/7KQ4MZ'));
    expect(read).toMatchObject({ rawValue: 'https://old.example/l/7KQ4MZ', format: 'qr_code' });
    expect(parseScan(read?.rawValue ?? '', read?.format)).toEqual({ kind: 'kept', code: '7KQ4MZ' });
  });

  it('reads an old Homebox asset label', async () => {
    const [read] = await detector().detect(qrImage('http://homebox.local/a/000-014'));
    expect(parseScan(read?.rawValue ?? '', read?.format)).toMatchObject({
      kind: 'homebox',
      assetId: '000-014',
    });
  });

  it('reads a product barcode and names its format', async () => {
    const [read] = await detector().detect(ean13Image('4006381333931'));
    expect(read).toMatchObject({ rawValue: '4006381333931', format: 'ean_13' });
    expect(parseScan(read?.rawValue ?? '', read?.format)).toMatchObject({
      kind: 'barcode',
      code: '4006381333931',
    });
  });

  it('reads nothing in a blank frame', async () => {
    expect(await detector().detect(image(200, 200, () => false))).toEqual([]);
  });
});
