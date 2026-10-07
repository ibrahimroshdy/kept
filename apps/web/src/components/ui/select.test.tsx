import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { Select, SelectItem } from './select';

const sizes = [
  { id: 's', name: 'Small' },
  { id: 'm', name: 'Medium' },
  { id: 'l', name: 'Large' },
];

describe('Select', () => {
  it('opens from the keyboard, moves with arrows and chooses with Enter', async () => {
    const onChange = vi.fn();
    const { user } = await renderUI(
      <Select label="Size" items={sizes} onChange={onChange}>
        {(item) => (
          <SelectItem id={item.id} textValue={item.name}>
            {item.name}
          </SelectItem>
        )}
      </Select>,
    );
    await user.tab();
    await user.keyboard('{ArrowDown}');
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('m');
    expect(screen.getByRole('button', { name: /Size/ })).toHaveTextContent('Medium');
    // Only React Aria's hidden autofill <select> exists, never a visible one.
    for (const s of document.querySelectorAll('select'))
      expect(s.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('mirrors in Arabic with logical properties only', async () => {
    const { user } = await renderUI(
      <Select label="الحجم" items={sizes} selectionMode="multiple" defaultValue={['s', 'l']}>
        {(item) => (
          <SelectItem id={item.id} textValue={item.name}>
            {item.name}
          </SelectItem>
        )}
      </Select>,
      { locale: 'ar' },
    );
    const trigger = screen.getByRole('button', { name: /الحجم/ });
    expect(trigger).toHaveTextContent('Small');
    expect(trigger).toHaveTextContent('Large');
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    expectLogicalOnly();
  });
});
