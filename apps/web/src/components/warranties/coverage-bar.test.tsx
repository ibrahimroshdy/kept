/** The coverage bar runs bought → today → covered until (D195; UI step-4 review L4). */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderUI } from '@/test/render';
import { CoverageBar } from './coverage-bar';

const barOf = () => screen.getByRole('img');
const filled = () => (barOf().querySelector('[style]') as HTMLElement).style.inlineSize;

describe('CoverageBar', () => {
  it('starts on the purchase date when the warranty starts later (an extended one)', async () => {
    // Bought 2026-01-01; covered 2027-01-01 → 2029-01-01; today 2028-01-01: 2 of 3 years used.
    await renderUI(
      <CoverageBar
        boughtOn="2026-01-01"
        startsOn="2027-01-01"
        endsOn="2029-01-01"
        today="2028-01-01"
      />,
    );
    expect(barOf()).toHaveAccessibleName(/^Bought [^;]*, covered from [^;]*2027 to [^;]*2029;/);
    expect(filled()).toBe('67%');
  });

  it("starts on the warranty's start without a purchase date, or with one after it", async () => {
    await renderUI(
      <CoverageBar
        boughtOn="2027-06-01"
        startsOn="2027-01-01"
        endsOn="2029-01-01"
        today="2028-01-01"
      />,
    );
    expect(barOf()).toHaveAccessibleName(/^Covered from [^;]*2027 to [^;]*2029;/);
    expect(filled()).toBe('50%');
  });
});
