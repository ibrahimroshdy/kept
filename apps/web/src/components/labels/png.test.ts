// @vitest-environment node
/**
 * The phone PNG (plan T28; D185): the right pixel size per stock at 300 dpi, and a QR the app's
 * own scanner reads (the T26 wasm decoder, as in camera/scanner.decode.test.ts). `drawLabel` is
 * run against a small rasterising context: its rectangles become pixels, its text calls are
 * recorded, so no canvas is needed.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LABEL_STOCKS, labelStock } from '@kept/shared';
import { encode } from 'uqr';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LabelCellContent } from '@/api/capture/types';
import { drawLabel, type LabelContext, labelPixelSize, wrapText } from './png';
import { qrMatrix } from './qr';

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

type Text = { text: string; x: number; y: number; direction: string; align: string };

/** A context that paints rectangles into RGBA pixels and records text. */
function raster(width: number, height: number) {
  const px = new Uint8ClampedArray(width * height * 4).fill(128);
  const texts: Text[] = [];
  const ctx = {
    fillStyle: '#000000' as string | CanvasGradient | CanvasPattern,
    font: '10px sans-serif',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    direction: 'inherit' as CanvasDirection,
    fillRect(x: number, y: number, w: number, h: number) {
      const v = this.fillStyle === '#FFFFFF' ? 255 : 0;
      for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++)
        for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
          const i = (yy * width + xx) * 4;
          px[i] = v;
          px[i + 1] = v;
          px[i + 2] = v;
          px[i + 3] = 255;
        }
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, direction: this.direction, align: this.textAlign });
    },
    measureText(text: string) {
      const size = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10);
      return { width: text.length * size * 0.55 } as TextMetrics;
    },
  };
  return { ctx: ctx as unknown as LabelContext, image: new ImageData(px, width, height), texts };
}

const label = (over: Partial<LabelCellContent> = {}): LabelCellContent => ({
  code: '7KQ4MZ',
  url: 'https://kept.example/l/7KQ4MZ',
  kind: 'thing',
  name: 'Ramadan decorations box',
  path: 'Garage › Shelf A',
  ...over,
});

describe('labelPixelSize', () => {
  it('is the cell at 300 dpi', () => {
    expect(Object.fromEntries(LABEL_STOCKS.map((s) => [s.key, labelPixelSize(s)]))).toEqual({
      thermal_50x30: { width: 591, height: 354 },
      thermal_40x30: { width: 472, height: 354 },
      thermal_62x29: { width: 732, height: 343 },
      a4_24_70x37: { width: 827, height: 437 },
      a4_65_38x21: { width: 450, height: 250 },
      letter_30_67x25: { width: 788, height: 300 },
    });
  });
});

describe('drawLabel', () => {
  it.each(LABEL_STOCKS.map((s) => [s.key] as const))(
    '%s: the scanner reads the QR back',
    async (key) => {
      const stock = labelStock(key);
      const { width, height } = labelPixelSize(stock);
      const { ctx, image } = raster(width, height);
      const l = label();
      drawLabel(ctx, stock, l, qrMatrix(encode, l.url));
      const [read] = await new ponyfill.BarcodeDetector({ formats: ['qr_code'] }).detect(image);
      expect(read?.rawValue).toBe(l.url);
    },
  );

  it('writes the code as printed, then an Arabic name set from the far edge of its column', () => {
    const stock = labelStock('thermal_50x30');
    const { width, height } = labelPixelSize(stock);
    const { ctx, texts } = raster(width, height);
    const l = label({ name: 'زينة رمضان', path: 'الجراج › الرف أ' });
    drawLabel(ctx, stock, l, qrMatrix(encode, l.url));
    expect(texts[0]).toMatchObject({ text: '7KQ‑4MZ', direction: 'ltr', align: 'left' });
    const name = texts.find((t) => t.text === 'زينة رمضان');
    expect(name).toMatchObject({ direction: 'rtl', align: 'right' });
    expect(name?.x).toBeGreaterThan(texts[0]?.x ?? 0);
  });

  it('prints only the QR and the code on the compact stock', () => {
    const stock = labelStock('a4_65_38x21');
    const { width, height } = labelPixelSize(stock);
    const { ctx, texts } = raster(width, height);
    drawLabel(ctx, stock, label(), qrMatrix(encode, label().url));
    expect(texts.map((t) => t.text)).toEqual(['7KQ‑4MZ']);
  });
});

describe('wrapText', () => {
  const measure = (s: string) => s.length;
  it('wraps by words into at most two lines', () => {
    expect(wrapText(measure, 'Paint roller set with tray', 12, 2)).toEqual([
      'Paint roller',
      'set with',
    ]);
  });
  it('breaks a word longer than the line', () => {
    expect(wrapText(measure, 'Extension', 4, 3)).toEqual(['Exte', 'nsio', 'n']);
  });
});
