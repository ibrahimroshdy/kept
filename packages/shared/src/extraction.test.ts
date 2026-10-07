import { describe, expect, it } from 'vitest';
import {
  AUTO_ACCEPT,
  CONFIDENCE_MIN,
  EXTRACTION_SCHEMAS,
  EXTRACTION_STATUSES,
  LabelExtraction,
  MAX_OUTPUT_TOKENS,
  needsReview,
  outputTokenCap,
  parseLenient,
  REASONING_ALLOWANCE,
  REVIEW_FIELDS,
  ReadingExtraction,
  ReceiptExtraction,
  ServiceInvoiceExtraction,
  ThingExtraction,
} from './extraction.js';

const c = <T>(value: T, confidence = 0.9) => ({ value, confidence });

describe('schemas (§2.1)', () => {
  it('accepts a full THING object', () => {
    const r = ThingExtraction.safeParse({
      objects: [
        {
          bbox: [0.1, 0.1, 0.5, 0.6],
          name: c('Cordless drill'),
          brand: c('Bosch'),
          model: c('GSR 12V-15'),
          colour: c('blue'),
          type_hint: c('power tool'),
          quantity: c(1),
          serial: c('123456'),
          aliases: { en: ['drill', 'driver'], ar: ['دريل'] },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('allows one object in 1.0 (D20 is 1.x)', () => {
    const one = { name: c('Cable'), aliases: {} };
    expect(ThingExtraction.safeParse({ objects: [one, one] }).success).toBe(false);
  });

  it('accepts a RECEIPT with a document box (Q11), a LABEL and a READING', () => {
    expect(
      ReceiptExtraction.safeParse({
        vendor: { name: c('Carrefour'), phone: '+20 2 1234 5678' },
        date: c('2026-09-20'),
        currency: c('E£'),
        total: c(1250.5),
        tax: c(153.57),
        lines: [{ description: c('Kettle'), quantity: c(1), unit_price: c(1250.5) }],
        document_bbox: [0.05, 0.02, 0.9, 0.95],
      }).success,
    ).toBe(true);
    expect(
      LabelExtraction.safeParse({
        vin: c('1M8GDM9AXKP042788'),
        document_kind: c('registration'),
        expires_on: c('2027-01-31'),
      }).success,
    ).toBe(true);
    expect(
      ReadingExtraction.safeParse({ value: c(10500), unit: c('km'), display: 'digital' }).success,
    ).toBe(true);
  });

  it('has a schema per capture mode', () => {
    expect(Object.keys(EXTRACTION_SCHEMAS).sort()).toEqual(
      ['label', 'reading', 'receipt', 'thing'].sort(),
    );
  });

  it('never takes a URL where text is expected (L51)', () => {
    expect(
      ThingExtraction.safeParse({
        objects: [{ name: c('see https://evil.example/x'), aliases: {} }],
      }).success,
    ).toBe(false);
  });
});

describe('parseLenient (L52): drop what fails, one field at a time', () => {
  const cases: Array<{
    name: string;
    schema: Parameters<typeof parseLenient>[0];
    raw: unknown;
    expected: unknown;
    dropped?: string[];
  }> = [
    {
      name: 'a confidence out of range drops that field only',
      schema: LabelExtraction,
      raw: { brand: c('Bosch'), model: { value: 'X1', confidence: 1.4 } },
      expected: { brand: c('Bosch') },
      dropped: ['model'],
    },
    {
      name: 'a wrong type drops the field',
      schema: ReadingExtraction,
      raw: { value: c(10500), unit: c('miles'), display: 'digital' },
      expected: { value: c(10500), display: 'digital' },
      dropped: ['unit'],
    },
    {
      name: 'a bad date in a receipt drops the date, keeps the lines',
      schema: ReceiptExtraction,
      raw: { date: c('20/09/2026'), total: c(10), lines: [{ description: c('Tea') }] },
      expected: { total: c(10), lines: [{ description: c('Tea') }] },
      dropped: ['date'],
    },
    {
      name: 'a broken receipt line is dropped from the list',
      schema: ReceiptExtraction,
      raw: { lines: [{ description: c('Tea') }, { description: 'Milk' }, { quantity: c(2) }] },
      expected: { lines: [{ description: c('Tea') }] },
      dropped: ['lines.1', 'lines.2'],
    },
    {
      name: 'a bad optional inside a line is dropped, the line stays',
      schema: ReceiptExtraction,
      raw: { lines: [{ description: c('Tea'), quantity: c('two') }] },
      expected: { lines: [{ description: c('Tea') }] },
      dropped: ['lines.0.quantity'],
    },
    {
      name: 'extra objects beyond the 1.0 limit are cut, the first kept',
      schema: ThingExtraction,
      raw: {
        objects: [
          { name: c('Cable'), aliases: {} },
          { name: c('Plug'), aliases: {} },
        ],
      },
      expected: { objects: [{ name: c('Cable'), aliases: {} }] },
      dropped: ['objects.1'],
    },
    {
      name: 'a bad alias entry and a URL alias are dropped',
      schema: ThingExtraction,
      raw: {
        objects: [
          { name: c('Cable'), aliases: { en: ['hdmi', 'http://x.example', 7], ar: 'كابل' } },
        ],
      },
      expected: { objects: [{ name: c('Cable'), aliases: { en: ['hdmi'] } }] },
      dropped: ['objects.0.aliases.en.1', 'objects.0.aliases.en.2', 'objects.0.aliases.ar'],
    },
    {
      name: 'a bbox outside 0–1 is dropped',
      schema: ThingExtraction,
      raw: { objects: [{ name: c('Cable'), aliases: {}, bbox: [0, 0, 1.5, 1] }] },
      expected: { objects: [{ name: c('Cable'), aliases: {} }] },
      dropped: ['objects.0.bbox'],
    },
    {
      name: 'unknown keys are ignored',
      schema: ReadingExtraction,
      raw: { value: c(42), id: 'thing-123', url: 'https://x.example' },
      expected: { value: c(42) },
      dropped: [],
    },
  ];

  it.each(cases)('$name', ({ schema, raw, expected, dropped }) => {
    const out = parseLenient(schema, raw);
    expect(out?.value).toEqual(expected);
    if (dropped) expect(out?.dropped).toEqual(dropped);
  });

  it.each([
    ['a required field that fails', ReadingExtraction, { value: c('lots') }],
    ['not an object at all', ReceiptExtraction, 'Sorry, I cannot read this receipt.'],
    ['an object without the required object list', ThingExtraction, { name: c('Cable') }],
    ['null', LabelExtraction, null],
  ])('gives null for %s', (_label, schema, raw) => {
    expect(parseLenient(schema, raw)).toBeNull();
  });

  it('keeps a valid object untouched', () => {
    const raw = { value: c(10500), unit: c('km') };
    expect(parseLenient(ReadingExtraction, raw)).toEqual({ value: raw, dropped: [] });
  });
});

describe('review rules (D19, D41, D128)', () => {
  it('auto-accepts the naming fields at or above 0.6, and never the others', () => {
    expect(CONFIDENCE_MIN).toBe(0.6);
    for (const f of AUTO_ACCEPT) expect(needsReview(f, 0.6)).toBe(false);
    for (const f of AUTO_ACCEPT) expect(needsReview(f, 0.59)).toBe(true);
    for (const f of REVIEW_FIELDS.filter((f) => f !== 'quantity'))
      expect(needsReview(f, 1)).toBe(true);
  });

  it('lets a quantity of 1 through and holds anything above 1', () => {
    expect(needsReview('quantity', 0.95, 1)).toBe(false);
    expect(needsReview('quantity', 0.95, 2)).toBe(true);
    expect(needsReview('quantity', 0.4, 1)).toBe(true);
  });

  it('holds a field it does not know', () => {
    expect(needsReview('plate', 0.99)).toBe(true);
  });
});

describe('token caps (Q6)', () => {
  it('adds the reasoning allowance to the mode’s JSON allowance', () => {
    expect(MAX_OUTPUT_TOKENS).toEqual({ thing: 700, receipt: 2500, label: 600, reading: 200 });
    expect(REASONING_ALLOWANCE).toEqual({
      none: 0,
      minimal: 512,
      low: 2048,
      medium: 6144,
      high: 16384,
    });
    expect(outputTokenCap('receipt', 'low')).toBe(4548);
    expect(outputTokenCap('reading', 'none')).toBe(200);
  });

  it('lists the extraction statuses of §7.8', () => {
    expect(EXTRACTION_STATUSES).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'paused_budget',
      'waiting_provider',
      'no_provider',
      'superseded',
    ]);
  });
});

describe('the service invoice (step 5, Q12)', () => {
  it("is RECEIPT's shape with each line's optional kind", () => {
    const r = ServiceInvoiceExtraction.safeParse({
      vendor: { name: c('Service centre') },
      total: c(1450.5),
      lines: [
        { description: c('Oil filter'), kind: c('part') },
        { description: c('Labour'), kind: c('labour'), line_total: c(300) },
        { description: c('Engine oil 5W-30') },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('drops a bad kind alone, keeping its line (L52)', () => {
    const out = parseLenient(ServiceInvoiceExtraction, {
      lines: [
        { description: c('Tyres, 4'), kind: c('tyres') },
        { description: c('Oil filter'), kind: c('part') },
      ],
    });
    expect(out?.value.lines).toEqual([
      { description: c('Tyres, 4') },
      { description: c('Oil filter'), kind: c('part') },
    ]);
    expect(out?.dropped).toEqual(['lines.0.kind']);
  });

  it('a plain receipt line has no kind', () => {
    const r = ReceiptExtraction.parse({ lines: [{ description: c('Milk'), kind: c('part') }] });
    expect(r.lines[0]).toEqual({ description: c('Milk') });
  });
});
