/**
 * "What's in <location>" under the map (1.x, D237; the spike's list): a summary, a search, a
 * floor filter, By room or Needs attention, and Show more per card, all in the address. Picking a
 * row shows it on the map.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import type { MapAttentionKind, MapView } from '@/api/map/types';
import { ThingCount } from '@/components/counts';
import { printedCode } from '@/components/id-chip';
import { useFormat } from '@/lib/format';
import { useAttentionWords } from './card';
import type { Contents, Plan } from './layout';
import {
  ATTENTION_ROWS,
  attentionGroups,
  type ListQuery,
  ROOM_ROWS,
  type Row,
  roomCards,
  summaryOf,
} from './list';

function Dots({ flags }: { flags: MapAttentionKind[] }) {
  return (
    <span className="kmap-dots">
      {flags.map((k) => (
        <span key={k} className={`kmap-dot ${k}`} aria-hidden="true" />
      ))}
    </span>
  );
}

export function WhatsIn({
  name,
  plan,
  view,
  contents,
  query,
  setQuery,
  onRoom,
  onThing,
}: {
  name: string;
  plan: Plan;
  view: MapView;
  contents: Contents;
  query: ListQuery;
  setQuery: (next: Partial<ListQuery>, replace?: boolean) => void;
  onRoom: (roomId: string) => void;
  /** A node or thing: `inner` when it is a thing inside `id`. */
  onThing: (id: string) => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const words = useAttentionWords();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpened((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const sum = summaryOf(plan, view);
  const q = query.q.trim();
  const titles: Record<MapAttentionKind, string> = {
    low: t`Low stock`,
    lent: t`Lent out`,
    due: t`Due soon`,
  };

  const row = (r: Row, depth: number) => {
    const line = (
      <>
        <button type="button" className="kmap-nm" onClick={() => onThing(r.id)}>
          {r.name}
          {r.kind === 'thing' && r.quantity !== 1 ? ` ×${f.num(r.quantity)}` : ''}
        </button>
        {r.shortCode ? <small dir="ltr">{printedCode(r.shortCode)}</small> : null}
        <span className="kmap-fill" />
        <Dots flags={r.flags} />
        <span className="kmap-c">{r.count !== null ? f.num(r.count) : ''}</span>
      </>
    );
    if (!r.children.length || depth > 4)
      return (
        <div key={r.id} className="kmap-orow">
          {line}
          <span className="kmap-chev" />
        </div>
      );
    return (
      <details key={r.id} open={!!q}>
        <summary className="kmap-orow">
          {line}
          <span className="kmap-chev" aria-hidden="true">
            ›
          </span>
        </summary>
        <ul className="kmap-crows">
          {r.children.map((c) => (
            <li key={c.id}>{c.children.length ? row(c, depth + 1) : childButton(c)}</li>
          ))}
        </ul>
      </details>
    );
  };
  const childButton = (c: Row) => (
    <button type="button" onClick={() => onThing(c.id)}>
      {c.name}
      {c.quantity !== 1 ? ` ×${f.num(c.quantity)}` : ''}{' '}
      {c.shortCode ? <small dir="ltr">{printedCode(c.shortCode)}</small> : null}
      <Dots flags={c.flags} />
    </button>
  );

  let body: React.ReactNode;
  if (query.show === 'attention') {
    const groups = attentionGroups(plan, view, query);
    body = (
      <div className="kmap-grid">
        {groups.map((g) => {
          const all = opened.has(`flag:${g.kind}`);
          const show = all ? g.rows : g.rows.slice(0, ATTENTION_ROWS);
          return (
            <article key={g.kind} className="kmap-rcard">
              <header>
                <span className={`kmap-dot ${g.kind}`} aria-hidden="true" />
                <h3 className="m-0 font-semibold text-[16px]">{titles[g.kind]}</h3>
                <span className="kmap-cnt">{f.num(g.rows.length)}</span>
              </header>
              {g.rows.length ? (
                <ul className="kmap-flist">
                  {show.map((r) => (
                    <li
                      key={`${r.id}:${r.attention.kind}:${r.attention.dueOn ?? ''}:${r.attention.title ?? ''}`}
                    >
                      <button type="button" onClick={() => onThing(r.id)}>
                        <span>{r.name}</span>
                        <small>
                          {r.where.join(' › ')}
                          {r.shortCode ? (
                            <>
                              {' '}
                              · <bdi dir="ltr">{printedCode(r.shortCode)}</bdi>
                            </>
                          ) : null}
                        </small>
                        <span className="why">{words(r.attention)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="kmap-empty">
                  <Trans>Nothing here.</Trans>
                </p>
              )}
              {g.rows.length > ATTENTION_ROWS ? (
                <button
                  type="button"
                  className="kmap-more"
                  onClick={() => toggle(`flag:${g.kind}`)}
                >
                  {all ? (
                    <Trans>Show fewer</Trans>
                  ) : (
                    <Trans>Show {g.rows.length - ATTENTION_ROWS} more</Trans>
                  )}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    );
  } else {
    const cards = roomCards(plan, view, contents, query);
    body = cards.length ? (
      <div className="kmap-grid">
        {cards.map((c) => {
          const all = !!q || opened.has(c.room.id);
          const show = all ? c.rows : c.rows.slice(0, ROOM_ROWS);
          return (
            <article key={c.room.id} className="kmap-rcard">
              <header>
                <button type="button" onClick={() => onRoom(c.room.id)}>
                  {c.room.name}
                </button>
                {plan.levels.length > 1 && c.level ? (
                  <span className="kmap-lv" title={c.level.name}>
                    {c.level.short}
                  </span>
                ) : null}
                <span className="kmap-cnt">
                  <ThingCount n={c.total} />
                </span>
              </header>
              {show.length ? (
                show.map((r) => row(r, 0))
              ) : (
                <p className="kmap-empty">
                  <Trans>Nothing here yet.</Trans>
                </p>
              )}
              {!q && c.rows.length > ROOM_ROWS ? (
                <button type="button" className="kmap-more" onClick={() => toggle(c.room.id)}>
                  {all ? (
                    <Trans>Show fewer</Trans>
                  ) : (
                    <Trans>Show {c.rows.length - ROOM_ROWS} more</Trans>
                  )}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    ) : (
      <p className="kmap-empty">
        <Trans>Nothing matches.</Trans>
      </p>
    );
  }

  return (
    <section className="grid gap-3" aria-labelledby="kmap-whats-in">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="kmap-whats-in" className="m-0 font-semibold text-title">
          <Trans>What’s in {name}</Trans>
        </h2>
        <p className="kmap-sum">
          <span>
            <b>
              <ThingCount n={sum.things} />
            </b>
            <span aria-hidden="true">·</span>
            <Plural value={sum.rooms} one="# room" other="# rooms" />
            {sum.floors > 1 ? (
              <>
                <span aria-hidden="true">·</span>
                <Plural value={sum.floors} one="# floor" other="# floors" />
              </>
            ) : null}
          </span>
          <span>
            <span className="kmap-dot low" aria-hidden="true" />
            <Trans>
              <b>{f.num(sum.low)}</b> low
            </Trans>
          </span>
          <span>
            <span className="kmap-dot lent" aria-hidden="true" />
            <Trans>
              <b>{f.num(sum.lent)}</b> lent
            </Trans>
          </span>
          <span>
            <span className="kmap-dot due" aria-hidden="true" />
            <Trans>
              <b>{f.num(sum.due)}</b> due
            </Trans>
          </span>
        </p>
      </div>
      {view.more > 0 ? (
        <p className="kmap-empty">
          <Trans>
            The map lists the first {f.num(view.things.length)} things; search the location for the
            rest.
          </Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          className="kmap-input min-w-0 flex-[1_1_240px]"
          value={query.q}
          onChange={(e) => setQuery({ q: e.target.value }, true)}
          placeholder={t`Find a thing or a short ID`}
          aria-label={t`Find a thing`}
        />
        {plan.levels.length > 1 ? (
          <fieldset className="kmap-seg" aria-label={t`Floor`}>
            <button
              type="button"
              aria-pressed={query.floor === 'all'}
              onClick={() => setQuery({ floor: 'all' })}
            >
              <Trans>All floors</Trans>
            </button>
            {plan.levels.map((l) => (
              <button
                key={l.key}
                type="button"
                aria-pressed={query.floor === l.key}
                onClick={() => setQuery({ floor: l.key })}
              >
                {l.name}
              </button>
            ))}
          </fieldset>
        ) : null}
        <fieldset className="kmap-seg" aria-label={t`Show`}>
          <button
            type="button"
            aria-pressed={query.show === 'room'}
            onClick={() => setQuery({ show: 'room' })}
          >
            <Trans>By room</Trans>
          </button>
          <button
            type="button"
            aria-pressed={query.show === 'attention'}
            onClick={() => setQuery({ show: 'attention' })}
          >
            <Trans>Needs attention</Trans>
          </button>
        </fieldset>
      </div>
      {body}
    </section>
  );
}
