/**
 * Step 8's frame (plan T3): Backups beside Status in the instance admin's tabs, and the two
 * step-8 routes answering.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findHeading, renderApp } from '../app';

describe('the step-8 routes', () => {
  it('puts Backups in the instance admin’s tabs', async () => {
    await renderApp('/admin/status');
    expect(await screen.findByRole('link', { name: 'Backups' })).toHaveAttribute(
      'href',
      '/admin/backups',
    );
  });

  it('/admin/backups answers', async () => {
    await renderApp('/admin/backups');
    expect(await findHeading('Runs')).toBeInTheDocument();
  });

  it('/settings/device answers', async () => {
    await renderApp('/settings/device');
    expect(await findHeading('This device')).toBeInTheDocument();
  });
});
