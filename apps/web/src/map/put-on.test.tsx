import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MapView } from '@/api/map/types';
import { printedCode } from '@/components/id-chip';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { MapCard } from './card';
import { contentsOf, type Item, type Plan, putOn } from './layout';
import { AddOnSheet, PutOnSheet } from './put-on';

// #137: Put on… and Add on it, the cards that open them, and what a viewer sees.

const id = (n: number) => `01926f00-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ROOM = id(10);
let n = 100;
const item = (over: Partial<Item>): Item => ({
  id: id(n++),
  subject: 'thing',
  roomId: ROOM,
  name: 'x',
  shortCode: null,
  model: 'item',
  x: 1,
  z: 1,
  rot: 0,
  on: null,
  parentId: ROOM,
  isContainer: false,
  quantity: 1,
  auto: false,
  ...over,
});

function office() {
  const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
  const monitor = item({ model: 'monitor', name: 'Monitor', x: 3, z: 1 });
  const webcam = item({ model: 'webcam', name: 'HD webcam', x: 0.5, z: 3, shortCode: 'WEB123' });
  const keyboard = item({ model: 'keyboard', name: 'Keyboard', x: 1.5, z: 3 });
  const echo = item({ model: 'smart_speaker', name: 'Echo Dot', x: 2.5, z: 3 });
  const sofa = item({ model: 'sofa', name: 'Sofa', x: 3, z: 3 });
  const plan: Plan = {
    levels: [{ key: '_', id: null, name: 'Maple flat', short: 'M' }],
    rooms: [
      {
        id: ROOM,
        levelKey: '_',
        name: 'Study',
        shortCode: null,
        kindKey: 'room',
        x: 0,
        z: 0,
        w: 5,
        d: 4,
        kind: 'room',
        surface: 'wood',
      },
    ],
    items: [desk, monitor, webcam, keyboard, echo, sofa],
  };
  return { plan, desk, monitor, webcam, keyboard, echo, sofa };
}

const view = (plan: Plan): MapView => ({
  locationId: id(99),
  canArrange: true,
  version: null,
  levels: [{ id: null, name: null }],
  rooms: [],
  nodes: plan.items.map((i) => ({
    id: i.id,
    subject: i.subject,
    name: i.name,
    shortCode: i.shortCode,
    roomId: i.roomId,
    parentId: i.parentId,
    kindKey: null,
    typeKey: null,
    isContainer: false,
    quantity: 1,
    layout: null,
  })),
  things: [],
  more: 0,
  attention: [],
});

async function card(plan: Plan, it: Item, arranging: boolean, over: Record<string, unknown> = {}) {
  const v = view(plan);
  const props = {
    sel: { type: 'item' as const, id: it.id },
    plan,
    view: v,
    contents: contentsOf(v),
    level: plan.levels[0],
    focused: null,
    arranging,
    inner: null,
    setInner: () => {},
    detail: false,
    setDetail: () => {},
    onClose: () => {},
    onSelect: () => {},
    onOpenRoom: () => {},
    onGoLevel: () => {},
    onTurn: vi.fn(),
    onShape: () => {},
    onRemove: () => {},
    onRoomKind: () => {},
    onSurface: () => {},
    onAdd: () => {},
    onPutOn: vi.fn(),
    onTakeOff: vi.fn(),
    onAddOn: vi.fn(),
    ...over,
  };
  return { props, ...(await renderUI(<MapCard {...props} />)) };
}

describe('Put on… (#137)', () => {
  it('lists what in the room can carry it, with each holder’s picture and name', async () => {
    const { plan, webcam } = office();
    const onPut = vi.fn();
    await renderUI(
      <PutOnSheet
        item={webcam}
        plan={plan}
        roomName="Study"
        onOpenChange={() => {}}
        onPut={onPut}
        onTakeOff={() => {}}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Put HD webcam on…' })).toBeTruthy();
    const options = within(screen.getByRole('listbox', { name: 'What can carry it' })).getAllByRole(
      'option',
    );
    // The desk and the monitor: not the sofa, not the other small things.
    expect(options.map((o) => o.textContent)).toEqual(['Corner deskDesk', 'MonitorMonitor']);
    for (const o of options)
      expect(o.querySelector('.kshape-thumb')?.getAttribute('aria-hidden')).toBe('true');
    expectLogicalOnly();
  });

  it('puts it on with the keyboard alone', async () => {
    const { plan, webcam, monitor } = office();
    const onPut = vi.fn();
    const { user } = await renderUI(
      <PutOnSheet
        item={webcam}
        plan={plan}
        roomName="Study"
        onOpenChange={() => {}}
        onPut={onPut}
        onTakeOff={() => {}}
      />,
    );
    await user.tab();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPut).toHaveBeenCalledWith(monitor.id);
  });

  it('shows where it is now, with Take off', async () => {
    const { plan, webcam, monitor } = office();
    putOn(plan.items, webcam, monitor);
    const onTakeOff = vi.fn();
    const { user } = await renderUI(
      <PutOnSheet
        item={webcam}
        plan={plan}
        roomName="Study"
        onOpenChange={() => {}}
        onPut={() => {}}
        onTakeOff={onTakeOff}
      />,
    );
    expect(screen.getByText('On Monitor')).toBeTruthy();
    // The monitor it is on isn't offered again; the desk still is.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Corner deskDesk']);
    await user.click(screen.getByRole('button', { name: 'Take off' }));
    expect(onTakeOff).toHaveBeenCalled();
  });

  it('reads right to left in Arabic, nothing cut short', async () => {
    const { plan, webcam } = office();
    await renderUI(
      <PutOnSheet
        item={webcam}
        plan={plan}
        roomName="المكتب"
        onOpenChange={() => {}}
        onPut={() => {}}
        onTakeOff={() => {}}
      />,
      { locale: 'ar' },
    );
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('dialog', { name: 'ضع HD webcam على…' })).toBeTruthy();
    expect(screen.getAllByRole('option')[1]?.textContent).toContain('شاشة');
    expect(document.body.innerHTML).not.toMatch(/truncate|text-ellipsis/);
  });
});

describe('Add on it (#137)', () => {
  it('picks several of the room’s small things and puts them on together', async () => {
    const { plan, desk, webcam, keyboard, echo } = office();
    const onAdd = vi.fn();
    const { user } = await renderUI(
      <AddOnSheet host={desk} plan={plan} roomName="Study" onOpenChange={() => {}} onAdd={onAdd} />,
    );
    const list = screen.getByRole('listbox', { name: 'Things to add on it' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Echo DotSmart speaker',
      `HD webcamWebcam · ${printedCode('WEB123')}`,
      'KeyboardKeyboard',
      'MonitorMonitor',
    ]);
    expect(
      (screen.getByRole('button', { name: 'Pick what goes on it' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(within(list).getByRole('option', { name: 'Echo Dot' }));
    await user.click(within(list).getByRole('option', { name: 'Keyboard' }));
    await user.click(within(list).getByRole('option', { name: 'HD webcam' }));
    await user.click(screen.getByRole('button', { name: 'Put 3 on it' }));
    expect(onAdd).toHaveBeenCalledWith([echo.id, keyboard.id, webcam.id]);
  });

  it('takes no more than an arm holds, and says when it is full', async () => {
    const { plan, desk, monitor } = office();
    const arm = item({ model: 'monitor_arm', name: 'Arm' });
    const other = item({ model: 'monitor', name: 'Second monitor', x: 0.3, z: 3.2 });
    plan.items.push(arm, other);
    putOn(plan.items, arm, desk);
    const { user, unmount } = await renderUI(
      <AddOnSheet
        host={arm}
        plan={plan}
        roomName="Study"
        onOpenChange={() => {}}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByText('Room for one more.')).toBeTruthy();
    const list = screen.getByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['MonitorMonitor', 'Second monitorMonitor']);
    await user.click(within(list).getByRole('option', { name: 'Monitor' }));
    expect(
      within(list).getByRole('option', { name: 'Second monitor' }).getAttribute('aria-disabled'),
    ).toBe('true');
    unmount();
    putOn(plan.items, monitor, arm);
    await renderUI(
      <AddOnSheet
        host={arm}
        plan={plan}
        roomName="Study"
        onOpenChange={() => {}}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByText('Full: it holds one monitor.')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('On it now: Monitor')).toBeTruthy();
  });

  it('changes nothing when cancelled', async () => {
    const { plan, desk } = office();
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    const { user } = await renderUI(
      <AddOnSheet
        host={desk}
        plan={plan}
        roomName="Study"
        onOpenChange={onOpenChange}
        onAdd={onAdd}
      />,
    );
    await user.click(screen.getByRole('option', { name: 'Keyboard' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe('the card (#137)', () => {
  it('offers Put on… on a small thing and Add on it on a holder while arranging', async () => {
    const { plan, webcam, desk } = office();
    const { user, props, unmount } = await card(plan, webcam, true);
    await user.click(screen.getByRole('button', { name: 'Put on…' }));
    expect(screen.getByRole('dialog', { name: 'Put HD webcam on…' })).toBeTruthy();
    await user.click(screen.getByRole('option', { name: 'Corner desk' }));
    expect(props.onPutOn).toHaveBeenCalledWith(webcam.id, desk.id);
    unmount();
    const held = await card(plan, desk, true);
    expect(screen.queryByRole('button', { name: 'Put on…' })).toBeNull();
    await held.user.click(screen.getByRole('button', { name: 'Add on it' }));
    expect(screen.getByRole('dialog', { name: 'Add on Corner desk' })).toBeTruthy();
  });

  it('shows a viewer neither, and nothing to change', async () => {
    const { plan, webcam, monitor } = office();
    putOn(plan.items, webcam, monitor);
    await card(plan, webcam, false);
    for (const name of ['Put on…', 'Add on it', 'Turn', 'Take off the map'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    // Where it stands is still said: on the monitor.
    expect(screen.getByText(/Monitor/)).toBeTruthy();
  });

  it('turns a clipped webcam only with its monitor', async () => {
    const { plan, webcam, monitor } = office();
    putOn(plan.items, webcam, monitor);
    await card(plan, webcam, true);
    expect(screen.queryByRole('button', { name: 'Turn' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Put on…' })).toBeTruthy();
    await act(async () => {});
  });
});
