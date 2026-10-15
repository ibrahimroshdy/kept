/**
 * A thing's shape on the map (1.x, D249): the card's "Shape: TV, from its type · Change" line
 * and the picker it opens. The picker is a sheet (a dialog from `md` up): a search over the
 * shapes' names and their words in five languages, then **Suggested** (from the thing's type and
 * name, @kept/shared suggestShapes) and every shape in its group, each with its picture. While a
 * search is typed only the shapes that match show, best first, in one grid (#130). The pictures
 * are one sprite (thumbs/shapes.webp, scripts/render-map-thumbs.mjs), fetched the first time the
 * picker opens. One listbox, so arrow keys, Home and End move through it and a screen reader
 * hears each shape's name. On a phone the sheet stays above the keyboard and only the shapes
 * scroll (Sheet's `fitKeyboard`).
 */
import {
  MAP_MODEL_KEYS,
  type MapModelKey,
  SHAPE_GROUP,
  SHAPE_GROUPS,
  type ShapeFrom,
  type ShapeInput,
  type ShapeLang,
  searchShapes,
  suggestShapes,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  type Selection,
} from 'react-aria-components';
import type { MapView } from '@/api/map/types';
import { Sheet } from '@/components/things/sheet';
import { TextField } from '@/components/ui/text-field';
import { useModelNames, useShapeGroupNames } from './labels';
import type { Item } from './layout';
import spriteUrl from './thumbs/shapes.webp?url';
import { THUMB_CELLS, THUMB_COLS } from './thumbs/sprite';

/** The search's language: the reader's, by its first subtag ("fr-CA" is French). */
const shapeLang = (locale: string): ShapeLang => {
  const l = locale.slice(0, 2);
  return l === 'ar' || l === 'fr' || l === 'de' || l === 'it' ? l : 'en';
};

/** What the suggestions read for a thing or place on the map. */
export function shapeInputOf(
  view: MapView,
  it: Pick<Item, 'id' | 'name' | 'subject' | 'isContainer'>,
): ShapeInput {
  const thing = view.things.find((x) => x.id === it.id);
  const node = view.nodes.find((x) => x.id === it.id);
  return {
    name: it.name,
    typeKey: thing?.typeKey ?? node?.typeKey ?? null,
    typeName: thing?.typeName ?? null,
    isContainer: it.subject === 'place' || it.isContainer || !!thing?.isContainer,
  };
}

/** A shape's picture: its cell of the sprite, `size` px square. */
export function ShapeThumb({ model, size = 52 }: { model: MapModelKey; size?: number }) {
  const i = THUMB_CELLS[model];
  const col = i % THUMB_COLS;
  const row = Math.floor(i / THUMB_COLS);
  return (
    <span
      aria-hidden="true"
      className="kshape-thumb"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${spriteUrl})`,
        backgroundSize: `${THUMB_COLS * size}px auto`,
        backgroundPosition: `${-col * size}px ${-row * size}px`,
      }}
    />
  );
}

/** The card's shape line while arranging: what it is, why, and Change. */
export function ShapeField({
  item,
  input,
  onShape,
}: {
  item: Pick<Item, 'id' | 'name' | 'model'> & { shapeFrom?: ShapeFrom | undefined };
  input: ShapeInput;
  onShape: (id: string, model: MapModelKey) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const names = useModelNames();
  const shape = names[item.model];
  const guess = item.shapeFrom === 'guess';
  const line =
    item.shapeFrom === 'type'
      ? t`Shape: ${shape}, from its type`
      : item.shapeFrom === 'name'
        ? t`Shape: ${shape}, from its name`
        : guess
          ? t`Shape: ${shape}, a guess`
          : t`Shape: ${shape}`;
  return (
    <div className="kmap-shape">
      <span>{line}</span>
      <button
        type="button"
        className={`kmap-btn${guess ? ' primary' : ''}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {guess ? <Trans>Pick a shape</Trans> : <Trans>Change</Trans>}
      </button>
      {open ? (
        <ShapePicker
          isOpen
          onOpenChange={setOpen}
          name={item.name}
          value={item.model}
          input={input}
          onPick={(m) => {
            setOpen(false);
            if (m !== item.model || item.shapeFrom) onShape(item.id, m);
          }}
        />
      ) : null}
    </div>
  );
}

function Option({ id, model, name }: { id: string; model: MapModelKey; name: string }) {
  return (
    <ListBoxItem id={id} textValue={name} className="kshape-option">
      <ShapeThumb model={model} />
      <span>{name}</span>
    </ListBoxItem>
  );
}

/** The picker: search, Suggested, then every shape by group. Picking one closes it. */
export function ShapePicker({
  isOpen,
  onOpenChange,
  name,
  value,
  input,
  onPick,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The thing's name, for the title. */
  name: string;
  value: MapModelKey;
  input: ShapeInput;
  onPick: (model: MapModelKey) => void;
}) {
  const { t, i18n } = useLingui();
  const names = useModelNames();
  const groups = useShapeGroupNames();
  const lang = shapeLang(i18n.locale);
  const [query, setQuery] = useState('');
  const suggested = useMemo(() => suggestShapes(input).shapes.map((s) => s.model), [input]);
  const found = query.trim() ? searchShapes(query, names, lang) : null;
  // A new search starts at its best match.
  const listRef = useRef<HTMLDivElement>(null);
  const searching = found !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the search changes
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, searching]);
  const selected = new Set([`s:${value}`, `a:${value}`, `r:${value}`]);
  const pick = (keys: Selection) => {
    const key = keys === 'all' ? null : ([...keys][0] as string | undefined);
    // Choosing the shape it already has deselects it: that is a pick too.
    const model = (key?.slice(2) ?? value) as MapModelKey;
    onPick(model);
  };
  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} title={t`Shape for ${name}`} fitKeyboard>
      <div className="kshape">
        <TextField
          aria-label={t`Find a shape`}
          placeholder={t`Find a shape: TV, shelf, box…`}
          value={query}
          onChange={setQuery}
          inputProps={{ type: 'search', enterKeyHint: 'search' }}
        />
        <ListBox
          aria-label={t`Shapes`}
          layout="grid"
          selectionMode="single"
          selectedKeys={selected}
          onSelectionChange={pick}
          ref={listRef}
          className={found ? 'kshape-list kshape-found' : 'kshape-list'}
          renderEmptyState={() => (
            <p className="m-0 p-3 text-ink-2">
              <Trans>
                No shape matches “{query}”. Try Small thing or Small device, and give it a name that
                says what it is.
              </Trans>
            </p>
          )}
        >
          {found
            ? found.map((m) => <Option key={m} id={`r:${m}`} model={m} name={names[m]} />)
            : [
                <ListBoxSection key="suggested" id="suggested" className="kshape-section">
                  <Header className="kshape-head">
                    <Trans>Suggested</Trans>
                  </Header>
                  {suggested.map((m) => (
                    <Option key={m} id={`s:${m}`} model={m} name={names[m]} />
                  ))}
                </ListBoxSection>,
                ...SHAPE_GROUPS.map((g) => (
                  <ListBoxSection key={g} id={g} className="kshape-section">
                    <Header className="kshape-head">{groups[g]}</Header>
                    {MAP_MODEL_KEYS.filter((m) => SHAPE_GROUP[m] === g).map((m) => (
                      <Option key={m} id={`a:${m}`} model={m} name={names[m]} />
                    ))}
                  </ListBoxSection>
                )),
              ]}
        </ListBox>
      </div>
    </Sheet>
  );
}
