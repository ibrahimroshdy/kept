import { PROVIDER_KINDS } from '@kept/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderUI } from '@/test/render';
import { DataUseNote, PROVIDER_TERMS } from './data-use-note';

describe("a provider's data-use note", () => {
  it('has terms for every hosted provider, each read from an https page on a real day', () => {
    for (const kind of PROVIDER_KINDS) {
      const terms = PROVIDER_TERMS[kind];
      if (kind === 'openai_compatible') {
        expect(terms).toBeUndefined();
        continue;
      }
      expect(terms?.url).toMatch(/^https:\/\//);
      expect(terms?.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${terms?.checked}T12:00:00Z`))).toBe(false);
    }
  });

  it("says what the provider's own terms say, and links to them with the day they were read", async () => {
    await renderUI(<DataUseNote kind="groq" />);
    expect(screen.getByText(/Groq says it doesn't keep inference requests/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Groq's terms, checked/ });
    expect(link).toHaveAttribute('href', PROVIDER_TERMS.groq?.url);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('says a server you run keeps what you let it keep, with no terms link', async () => {
    await renderUI(<DataUseNote kind="openai_compatible" />);
    expect(
      screen.getByText('A server you run yourself keeps what you let it keep.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('is translated, with Eastern digits in Arabic', async () => {
    await renderUI(<DataUseNote kind="openai" />, { locale: 'ar' });
    expect(screen.getByText(/مدة تصل إلى ٣٠ يومًا/)).toBeInTheDocument();
  });
});
