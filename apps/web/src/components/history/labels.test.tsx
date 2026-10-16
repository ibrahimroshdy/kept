import { SUMMARY_KEYS, SUMMARY_LINE_KEYS } from '@kept/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppProviders } from '@/app-providers';
import { activateLocale } from '@/i18n/i18n';
import { plainText, useSummary, useSummaryLine } from './labels';

// #140: every key the server can send reads as a sentence in the reader's language, never the
// server's English fallback. The sentence map is typed by SUMMARY_KEYS, so a missing key fails the
// typecheck; this checks each one renders, in English and in Arabic.

const FALLBACK = 'English fallback';
const params = { name: 'Desk lamp', count: '3', service: 'Car', host: 'Desk', room: 'Study' };

function All() {
  const say = useSummary();
  const line = useSummaryLine();
  return (
    <ul>
      {SUMMARY_KEYS.filter((k) => k !== 'event').map((key) => (
        <li key={key} data-key={key}>
          {plainText(say({ summaryKey: key, summaryParams: params, summary: FALLBACK }))}
        </li>
      ))}
      {SUMMARY_LINE_KEYS.map((key) => (
        <li key={key} data-key={key}>
          {plainText(line({ key, params: { ...params, from: 'a', to: 'b' }, text: FALLBACK }))}
        </li>
      ))}
    </ul>
  );
}

describe.each(['en', 'ar'] as const)('every summary in %s', (locale) => {
  it('is a sentence of its own', async () => {
    await activateLocale(locale);
    render(
      <AppProviders locale={locale}>
        <All />
      </AppProviders>,
    );
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(SUMMARY_KEYS.length - 1 + SUMMARY_LINE_KEYS.length);
    for (const li of items) {
      const text = li.textContent ?? '';
      expect(text, li.dataset.key).not.toBe(FALLBACK);
      expect(text, li.dataset.key).not.toMatch(/^$|\{|undefined|[a-z]+\.[a-z_]+/);
    }
  });
});
