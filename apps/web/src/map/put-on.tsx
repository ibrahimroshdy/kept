/**
 * Putting small things on holders without dragging (#137): the card's **Put on…** (from the small
 * thing: what in the room can carry it) and **Add on it** (from the holder: the room's things on
 * nothing yet). Both are sheets (a dialog from `md` up) with one listbox, so arrow keys move
 * through it and a screen reader hears each name; each row is the holder's or thing's shape
 * picture and its name. Map only: nothing moves in Kept, and the arrange session's Done and Undo
 * cover it like any other change.
 */
import { capacityOf, carryOf } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { ListBox, ListBoxItem, type Selection, Text } from 'react-aria-components';
import { printedCode } from '@/components/id-chip';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useModelNames } from './labels';
import { addableOn, childrenOn, holdersFor, type Item, type Plan, roomOn } from './layout';
import { matches } from './list';
import { ShapeThumb } from './shapes';

/** A list longer than this gets a search. */
const SEARCH_FROM = 8;

function Row({ it, sub }: { it: Item; sub: string }) {
  return (
    <ListBoxItem id={it.id} textValue={it.name} className="kput-option">
      <ShapeThumb model={it.model} size={44} />
      <span className="kput-text">
        <Text slot="label">{it.name}</Text>
        <Text slot="description" elementType="small">
          {sub}
        </Text>
      </span>
    </ListBoxItem>
  );
}

/** Put on…: what in the thing's room can carry it; picking one puts it there and closes. */
export function PutOnSheet({
  item,
  plan,
  roomName,
  onOpenChange,
  onPut,
  onTakeOff,
}: {
  item: Item;
  plan: Plan;
  roomName: string;
  onOpenChange: (open: boolean) => void;
  onPut: (hostId: string) => void;
  onTakeOff: () => void;
}) {
  const { t } = useLingui();
  const names = useModelNames();
  const [query, setQuery] = useState('');
  const holders = useMemo(() => holdersFor(plan.items, item), [plan.items, item]);
  const current = item.on ? plan.items.find((i) => i.id === item.on) : undefined;
  const rows = holders.filter((h) => matches(query, h.name, h.shortCode));
  const subOf = (h: Item) => {
    const on = h.on ? plan.items.find((i) => i.id === h.on)?.name : undefined;
    const shape = names[h.model];
    return on ? t`${shape} · on ${on}` : shape;
  };
  return (
    <Sheet isOpen onOpenChange={onOpenChange} title={t`Put ${item.name} on…`}>
      <div className="kput">
        {current ? (
          <div className="kput-now">
            <span>
              <Trans>On {current.name}</Trans>
            </span>
            <Button variant="secondary" size="small" onPress={onTakeOff}>
              <Trans>Take off</Trans>
            </Button>
          </div>
        ) : null}
        {holders.length > SEARCH_FROM ? (
          <TextField
            aria-label={t`Find a place to put it`}
            placeholder={t`Find in ${roomName}`}
            value={query}
            onChange={setQuery}
            inputProps={{ type: 'search', enterKeyHint: 'search' }}
          />
        ) : null}
        <ListBox
          aria-label={t`What can carry it`}
          selectionMode="single"
          className="kput-list"
          onSelectionChange={(keys: Selection) => {
            const id = keys === 'all' ? undefined : ([...keys][0] as string | undefined);
            if (id) onPut(id);
          }}
          renderEmptyState={() => (
            <p className="kmap-empty">
              {holders.length ? (
                <Trans>Nothing matches.</Trans>
              ) : current ? (
                <Trans>Nothing else in {roomName} can carry it.</Trans>
              ) : (
                <Trans>
                  Nothing in {roomName} can carry it. Put a desk, a shelf or a monitor on the map
                  first.
                </Trans>
              )}
            </p>
          )}
        >
          {rows.map((h) => (
            <Row key={h.id} it={h} sub={subOf(h)} />
          ))}
        </ListBox>
      </div>
    </Sheet>
  );
}

/** Add on it: the room's things on nothing yet, several at once, side by side on the holder. */
export function AddOnSheet({
  host,
  plan,
  roomName,
  onOpenChange,
  onAdd,
}: {
  host: Item;
  plan: Plan;
  roomName: string;
  onOpenChange: (open: boolean) => void;
  onAdd: (ids: string[]) => void;
}) {
  const { t } = useLingui();
  const names = useModelNames();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const things = useMemo(() => addableOn(plan.items, host), [plan.items, host]);
  const max = capacityOf(host.model);
  const limited = Number.isFinite(max);
  const left = roomOn(plan.items, host);
  const full = limited && left <= 0;
  const rows = things.filter((c) => matches(query, c.name, c.shortCode));
  // An arm takes no more than its places: the rest can't be picked once they are taken.
  const disabled = limited && picked.size >= left ? rows.filter((c) => !picked.has(c.id)) : [];
  const n = picked.size;
  const onNow = childrenOn(plan.items, host.id)
    .map((c) => c.name)
    .join(', ');
  return (
    <Sheet isOpen onOpenChange={onOpenChange} title={t`Add on ${host.name}`}>
      {({ close }) => (
        <div className="kput">
          {limited ? (
            <p className="kput-cap">
              {full ? (
                <Plural
                  value={max}
                  one="Full: it holds one monitor."
                  other="Full: it holds # monitors."
                />
              ) : (
                <Plural value={left} one="Room for one more." other="Room for # more." />
              )}
            </p>
          ) : null}
          {full ? null : (
            <>
              {things.length > SEARCH_FROM ? (
                <TextField
                  aria-label={t`Find a thing to add`}
                  placeholder={t`Find in ${roomName}`}
                  value={query}
                  onChange={setQuery}
                  inputProps={{ type: 'search', enterKeyHint: 'search' }}
                />
              ) : null}
              <ListBox
                aria-label={t`Things to add on it`}
                selectionMode="multiple"
                className="kput-list"
                selectedKeys={picked}
                disabledKeys={disabled.map((c) => c.id)}
                onSelectionChange={(keys: Selection) =>
                  setPicked(new Set(keys === 'all' ? rows.map((c) => c.id) : (keys as Set<string>)))
                }
                renderEmptyState={() => (
                  <p className="kmap-empty">
                    {things.length ? (
                      <Trans>Nothing matches.</Trans>
                    ) : carryOf(host.model) === 'arm' ? (
                      <Trans>No monitor in {roomName} is free. Put one on the map first.</Trans>
                    ) : (
                      <Trans>
                        Everything small in {roomName} is on something, or not on the map yet.
                      </Trans>
                    )}
                  </p>
                )}
              >
                {rows.map((c) => (
                  <Row
                    key={c.id}
                    it={c}
                    sub={
                      c.shortCode
                        ? `${names[c.model]} · ${printedCode(c.shortCode)}`
                        : names[c.model]
                    }
                  />
                ))}
              </ListBox>
              <div className="kput-actions">
                <Button
                  isDisabled={!n}
                  onPress={() => {
                    onAdd([...picked]);
                    close();
                  }}
                >
                  {n ? (
                    <Plural value={n} one="Put # on it" other="Put # on it" />
                  ) : (
                    <Trans>Pick what goes on it</Trans>
                  )}
                </Button>
                <Button variant="secondary" onPress={close}>
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            </>
          )}
          {onNow ? (
            <p className="kput-cap">
              <Trans>On it now: {onNow}</Trans>
            </p>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
