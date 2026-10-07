import { describe, expect, it } from 'vitest';
import { EMBEDDINGS_SOURCES, embedText, RRF_K, SEMANTIC_LIMIT } from './embeddings.js';

describe('embeddings', () => {
  it('holds the plan’s constants', () => {
    expect(EMBEDDINGS_SOURCES).toEqual(['provider', 'local', 'off']);
    expect(RRF_K).toBe(60);
    expect(SEMANTIC_LIMIT).toBe(50);
  });

  it('builds the text from what describes a thing', () => {
    expect(
      embedText({
        name: 'HDMI cable',
        aliases: ['HDMI', 'كابل HDMI'],
        typeName: 'Cable',
        brand: 'Belkin',
        model: 'HD-2',
        notes: 'For the TV\n in the living room',
        placePath: ['Home', 'Office', 'Drawer'],
        receipt: { vendor: 'B.TECH', lines: [{ description: 'HDMI 2.1 cable 2 m' }] },
      }),
    ).toBe(
      [
        'name: HDMI cable',
        'alias: HDMI',
        'alias: كابل HDMI',
        'type: Cable',
        'brand: Belkin',
        'model: HD-2',
        'notes: For the TV in the living room',
        'place: Home › Office › Drawer',
        'vendor: B.TECH',
        'item: HDMI 2.1 cable 2 m',
      ].join('\n'),
    );
  });

  it('never carries a secret, a serial, a price or the receipt’s raw text (D116, D200, Q12)', () => {
    const thing = {
      name: 'Router',
      notes: null,
      secret_values: { wifi_password: 'hunter2-SECRET' },
      serial: 'SN-99887766',
      purchase_price: { amount: '450.00', currency: 'EGP' },
      file_text: 'TOTAL EGP 450 VAT 14%',
      receipt: { vendor: 'Raya', lines: [{ description: 'Router AX3000', amount: '450.00' }] },
    };
    const text = embedText(thing);
    for (const leak of ['hunter2', 'SN-99887766', '450', 'EGP', 'VAT'])
      expect(text).not.toContain(leak);
    expect(text).toContain('Router AX3000');
  });

  it('leaves empty fields out', () => {
    expect(embedText({ name: 'Drill', brand: ' ', notes: null, placePath: [] })).toBe(
      'name: Drill',
    );
  });
});
