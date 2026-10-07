/**
 * Every dry-run reason has a sentence of its own (step-7 T19): a test walks IMPORT_ISSUE_CODES,
 * the CSV, archive and Homebox codes alike, and fails on one that falls back to the server's
 * English message. Every ARCHIVE_REFUSALS reason has its words too.
 */
import { ARCHIVE_REFUSALS, IMPORT_ISSUE_CODES } from '@kept/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderUI } from '@/test/render';
import { useIssueText, useRefusalText } from './labels';

const FALLBACK = 'UNTRANSLATED';

function All() {
  const issue = useIssueText();
  const refusal = useRefusalText();
  return (
    <ul>
      {IMPORT_ISSUE_CODES.map((code) => (
        <li key={code} data-code={code}>
          {issue({ column: '', code, message: FALLBACK })}
        </li>
      ))}
      {ARCHIVE_REFUSALS.map((reason) => (
        <li key={reason} data-reason={reason}>
          {refusal(reason) ?? FALLBACK}
        </li>
      ))}
    </ul>
  );
}

describe('the import reasons', () => {
  it.each(['en', 'ar'] as const)('translates every issue code and refusal (%s)', async (locale) => {
    await renderUI(<All />, { locale });
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(IMPORT_ISSUE_CODES.length + ARCHIVE_REFUSALS.length);
    const untranslated = items
      .filter((li) => li.textContent === FALLBACK || li.textContent === '')
      .map((li) => li.dataset.code ?? li.dataset.reason);
    expect(untranslated).toEqual([]);
  });
});
