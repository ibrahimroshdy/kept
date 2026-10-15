import { MAP_MODEL_KEYS, type ShapeInput } from '@kept/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { ShapeField, ShapePicker } from './shapes';
import { THUMB_CELLS } from './thumbs/sprite';

const tv: ShapeInput = {
  name: 'Living room 55"',
  typeKey: 'tv_display',
  typeName: null,
  isContainer: false,
};

function picker(onPick = vi.fn(), input = tv, locale: 'en' | 'ar' = 'en') {
  return renderUI(
    <ShapePicker
      isOpen
      onOpenChange={() => {}}
      name="Samsung TV"
      value="item"
      input={input}
      onPick={onPick}
    />,
    { locale },
  );
}

const sections = () => within(screen.getByRole('listbox')).getAllByRole('group');

describe('the shape sprite (D249)', () => {
  it('has a picture for every shape, each in its own cell', () => {
    const cells = MAP_MODEL_KEYS.map((k) => THUMB_CELLS[k]);
    expect(cells.every((c) => Number.isInteger(c))).toBe(true);
    expect(new Set(cells).size).toBe(MAP_MODEL_KEYS.length);
  });
});

describe('ShapePicker', () => {
  it('puts the suggestions first, then every shape by group, each with its name', async () => {
    await picker();
    expect(screen.getByRole('dialog', { name: 'Shape for Samsung TV' })).toBeTruthy();
    const [suggested, ...groups] = sections();
    expect(suggested?.getAttribute('aria-label') ?? suggested?.textContent).toMatch(/Suggested/);
    const first = within(suggested as HTMLElement).getAllByRole('option')[0];
    expect(first?.textContent).toBe('TV');
    expect(groups.length).toBeGreaterThanOrEqual(8);
    const all = groups.flatMap((g) => within(g).getAllByRole('option'));
    expect(all).toHaveLength(MAP_MODEL_KEYS.length);
    // The pictures are decoration: the name is what a screen reader hears.
    for (const o of all.slice(0, 5)) {
      expect(o.querySelector('.kshape-thumb')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('marks the current shape as selected', async () => {
    await renderUI(
      <ShapePicker
        isOpen
        onOpenChange={() => {}}
        name="Samsung TV"
        value="tv"
        input={tv}
        onPick={() => {}}
      />,
    );
    const selected = screen.getAllByRole('option', { selected: true });
    expect(selected.map((o) => o.textContent)).toEqual(['TV', 'TV']);
  });

  it('searches names and words in any language', async () => {
    const { user } = await picker();
    await user.type(screen.getByRole('searchbox', { name: 'Find a shape' }), 'Fernseher');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['TV']);
    await user.clear(screen.getByRole('searchbox', { name: 'Find a shape' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find a shape' }), 'webcam');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Small device']);
    await user.clear(screen.getByRole('searchbox', { name: 'Find a shape' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find a shape' }), 'zzqx');
    expect(document.querySelectorAll('.kshape-option')).toHaveLength(0);
    expect(screen.getByText(/No shape matches/)).toBeTruthy();
  });

  it('picks a shape with a click', async () => {
    const onPick = vi.fn();
    const { user } = await picker(onPick);
    await user.click(screen.getAllByRole('option', { name: 'Monitor' })[0] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith('monitor');
  });

  it('picks a shape with the keyboard', async () => {
    const onPick = vi.fn();
    const { user } = await picker(onPick);
    const box = screen.getByRole('searchbox', { name: 'Find a shape' });
    await user.type(box, 'fridge');
    await user.tab();
    expect(document.activeElement?.getAttribute('role')).toBe('option');
    expect(document.activeElement?.textContent).toBe('Fridge');
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('fridge');
  });

  it('moves through the shapes with Home and the arrow keys', async () => {
    const { user } = await picker();
    await user.tab();
    await user.tab();
    const start = document.activeElement?.textContent;
    expect(document.activeElement?.getAttribute('role')).toBe('option');
    await user.keyboard('{Home}');
    expect(document.activeElement?.textContent).not.toBe(start);
    expect(document.activeElement?.textContent).toBe('TV');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('role')).toBe('option');
    expect(document.activeElement?.textContent).not.toBe('TV');
  });

  it('suggests the small device first for a webcam', async () => {
    await picker(vi.fn(), {
      name: 'Logitech webcam',
      typeKey: null,
      typeName: null,
      isContainer: false,
    });
    const [suggested] = sections();
    const names = within(suggested as HTMLElement)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names[0]).toBe('Small device');
  });

  it('reads in Arabic, right to left, with logical sides only', async () => {
    await picker(vi.fn(), tv, 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('dialog', { name: 'شكل Samsung TV' })).toBeTruthy();
    const [suggested] = sections();
    expect(within(suggested as HTMLElement).getAllByRole('option')[0]?.textContent).toBe('تلفاز');
    expectLogicalOnly();
  });
});

describe('ShapeField', () => {
  const item = { id: 't1', name: 'Samsung TV', model: 'tv' as const };

  it('says where the shape came from, and opens the picker', async () => {
    const { user } = await renderUI(
      <ShapeField item={{ ...item, shapeFrom: 'type' }} input={tv} onShape={() => {}} />,
    );
    expect(screen.getByText('Shape: TV, from its type')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('dialog', { name: 'Shape for Samsung TV' })).toBeTruthy();
  });

  it('asks for a shape when it is a guess, and a pick clears the guess', async () => {
    const onShape = vi.fn();
    const { user } = await renderUI(
      <ShapeField
        item={{ ...item, model: 'device', shapeFrom: 'guess' }}
        input={{ name: 'Logitech webcam' }}
        onShape={onShape}
      />,
    );
    expect(screen.getByText('Shape: Small device, a guess')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pick a shape' }));
    // Keeping the guess is a choice too: the card stops calling it one.
    await user.click(screen.getAllByRole('option', { name: 'Small device' })[0] as HTMLElement);
    expect(onShape).toHaveBeenCalledWith('t1', 'device');
  });

  it('says nothing about where a chosen shape came from', async () => {
    await renderUI(<ShapeField item={item} input={tv} onShape={() => {}} />);
    expect(screen.getByText('Shape: TV')).toBeTruthy();
  });
});
