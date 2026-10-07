/**
 * Drive the filter strip (D205) from a screen test. jsdom has no media queries, so the strip is
 * in its phone layout: "Filters" opens the bottom sheet with the list's fields.
 */
import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Open the Filters sheet (optionally at `field`); returns the sheet. */
export async function openFilters(user: UserEvent, field?: string | RegExp): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: /^Filters/ }));
  const sheet = await screen.findByRole('dialog', { name: 'Filters' });
  if (field) await user.click(await within(sheet).findByRole('option', { name: field }));
  return sheet;
}

/**
 * Filter by `field`: tick `values` (rows of a multi or single field, or a date preset's option),
 * "is none of" when `none`, then Done.
 */
export async function filterBy(
  user: UserEvent,
  field: string | RegExp,
  values: (string | RegExp)[],
  { none = false }: { none?: boolean } = {},
): Promise<void> {
  const sheet = await openFilters(user, field);
  if (none) await user.click(within(sheet).getByRole('radio', { name: 'is none of' }));
  // Values are grid rows; a date field's presets are options.
  const grid = within(sheet).queryByRole('listbox', { name: field }) ? null : 'row';
  for (const value of values) {
    await user.click(await within(sheet).findByRole(grid ?? 'option', { name: value }));
  }
  // A single choice or a date preset closes the sheet by itself.
  const done = screen.queryByRole('button', { name: 'Done' });
  if (done) await user.click(done);
}
