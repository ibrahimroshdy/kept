import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { v7 } from 'uuid';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, own } from '../../test/things.js';

// Saved views are bounded (route security review #34): at most 100 of one's own, and the list
// pages instead of cutting off silently. Then the filter strip's views (D205), below.

let db: TestDb;
let t: TestApp;
let ann: Person;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ann = await person(t, db, 'ann');
  // 99 of Ann's own, straight in; the 100th and the refusal go through the route.
  await own(
    db,
    `INSERT INTO public.saved_views (user_id, name, query, shared)
     SELECT $1, 'View ' || lpad(n::text, 3, '0'), '{}'::jsonb, false
       FROM generate_series(1, 99) AS n`,
    [ann.userId],
  );
});

type Page = { views: { id: string; name: string }[]; next_cursor: string | null };

describe('saved views: cap and paging (#34)', () => {
  // catalogue: POST /api/v1/saved-views
  it('takes a 100th view, audited, and refuses a 101st (409)', async () => {
    const hundredth = await call(t, '/api/v1/saved-views', {
      as: ann,
      body: { name: 'View 100', query: {} },
    });
    expect(hundredth.statusCode, hundredth.body).toBe(201);
    const [audit] = await own<{ action: string }>(
      db,
      `SELECT action FROM public.audit_events WHERE entity_id = $1`,
      [hundredth.json().id],
    );
    expect(audit?.action).toBe('saved_view.create');
    const refused = await call(t, '/api/v1/saved-views', {
      as: ann,
      body: { name: 'View 101', query: {} },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'conflict', reason: 'limit' });
  });

  it('pages the list by name with a cursor, without repeats or gaps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/saved-views?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await call(t, url, { as: ann });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as Page;
      seen.push(...page.views.map((v) => v.name));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    expect(seen).toEqual([...seen].sort());
    const bad = await call(t, '/api/v1/saved-views?cursor=not-a-cursor', { as: ann });
    expect(bad.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// D205: a saved view belongs to one list (its surface), holds that list's state, and each person
// pins views and picks a default per list.
// ---------------------------------------------------------------------------------------------

type View = {
  id: string;
  name: string;
  surface: string;
  query: Record<string, unknown>;
  mine: boolean;
  sharedLocationId: string | null;
  moneyHidden?: true;
};
type Prefs = { defaultViewId: string | null; pinned: string[] };
type ListPage = { views: View[]; next_cursor: string | null; prefs: Prefs | null };

describe('saved views by list (D205)', () => {
  let mel: Person;
  let vic: Person;
  let bob: Person;
  let home: Loc;

  beforeAll(async () => {
    db = await testDb();
    await db.reset();
    t = await peopleApp(db);
    ann = await person(t, db, 'ann');
    mel = await person(t, db, 'mel');
    vic = await person(t, db, 'vic');
    bob = await person(t, db, 'bob');
    home = await createLocation(t, db, ann, 'household');
    await join(db, home.id, mel.userId, 'member');
    await join(db, home.id, vic.userId, 'viewer');
  });

  const save = async (as: Person, body: Record<string, unknown>) => {
    const res = await call(t, '/api/v1/saved-views', { as, body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as View;
  };
  const list = async (as: Person, surface?: string) => {
    const res = await call(t, `/api/v1/saved-views${surface ? `?surface=${surface}` : ''}`, { as });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as ListPage;
  };
  const putPrefs = (as: Person, surface: string, body: unknown) =>
    call(t, `/api/v1/saved-views/prefs/${surface}`, { as, method: 'PUT', body });
  const accountAudit = (userId: string, entityType: string) =>
    own<{ action: string; diff: Record<string, { before?: unknown; after?: unknown }> }>(
      db,
      `SELECT e.action, e.diff FROM public.audit_events e
         JOIN public.owner_accounts a ON a.id = e.owner_account_id
        WHERE a.user_id = $1 AND e.location_id IS NULL AND e.entity_type = $2
        ORDER BY e.at, e.id`,
      [userId, entityType],
    );

  it('keeps a view to its list: the surface on create, ?surface= on the list, and mine', async () => {
    const activity = await save(ann, {
      name: 'Alfred this week',
      surface: 'activity',
      query: { filters: { actor: [mel.userId], when: ['week'] } },
    });
    expect(activity).toMatchObject({
      surface: 'activity',
      query: { filters: { actor: [mel.userId], when: ['week'] } },
      mine: true,
    });
    const search = await save(ann, { name: 'Cables', query: { q: 'cable' } });
    expect(search.surface).toBe('search');
    const shared = await save(mel, {
      name: 'Garage',
      surface: 'contents',
      query: { filters: { type: ['a'] }, group: 'type' },
      sharedLocationId: home.id,
    });

    const all = await list(ann);
    expect(all.prefs).toBeNull();
    expect(all.views.map((v) => v.name)).toEqual(['Alfred this week', 'Cables', 'Garage']);
    expect(Object.fromEntries(all.views.map((v) => [v.name, v.mine]))).toEqual({
      Cables: true,
      Garage: false,
      'Alfred this week': true,
    });
    const onActivity = await list(ann, 'activity');
    expect(onActivity.views.map((v) => v.id)).toEqual([activity.id]);
    expect(onActivity.prefs).toEqual({ defaultViewId: null, pinned: [] });
    expect((await list(mel, 'contents')).views).toMatchObject([{ id: shared.id, mine: true }]);
    expect((await list(bob, 'contents')).views).toEqual([]);
    expect((await call(t, '/api/v1/saved-views?surface=nope', { as: ann })).statusCode).toBe(400);
  });

  it('saves a view of the AI call list (the ai-calls surface, D206, T19)', async () => {
    const view = await save(ann, {
      name: 'Failed this month',
      surface: 'ai-calls',
      query: {
        filters: { at: ['month'], outcome: ['error'], provider: ['groq'] },
        not: ['provider'],
        sort: 'at',
        dir: 'desc',
      },
    });
    expect(view).toMatchObject({
      surface: 'ai-calls',
      query: { filters: { at: ['month'], outcome: ['error'], provider: ['groq'] } },
    });
    expect((await list(ann, 'ai-calls')).views.map((v) => v.id)).toEqual([view.id]);
    for (const query of [
      { filters: { at: ['last spring'] } },
      { filters: { actor: ['x'] } },
      { filters: { costMin: ['1'] }, not: ['costMin'] },
    ]) {
      const res = await call(t, '/api/v1/saved-views', {
        as: ann,
        body: { name: 'Bad', surface: 'ai-calls', query },
      });
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
    }
  });

  it("holds a query to its list's filters, and stores it compacted", async () => {
    const refused = [
      { surface: 'search', query: { filters: { actor: ['x'] } } },
      { surface: 'activity', query: { filters: { price: ['1'] } } },
      { surface: 'activity', query: { filters: { when: ['yesterday'] } } },
      { surface: 'trash', query: { filters: { when: ['2026-09-30..2026-09-01'] } } },
      { surface: 'search', query: { filters: { priceMin: ['5'] }, not: ['priceMin'] } },
      { surface: 'things', query: { filters: { tag: ['x'] }, not: ['actor'] } },
      { surface: 'inbox', query: { filters: { tag: ['x'] } } },
      { surface: 'search', query: { kind: 'things' } },
      { surface: 'lists', query: {} },
      { surface: 'contents', query: { sort: 'name', dir: 'up' } },
    ];
    for (const body of refused) {
      const res = await call(t, '/api/v1/saved-views', { as: ann, body: { name: 'Bad', ...body } });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const view = await save(ann, {
      name: 'Tidy',
      surface: 'trash',
      query: {
        q: '  ',
        filters: { kind: ['thing', 'thing'], location: [], when: ['2026-09-01..'] },
        not: ['location', 'kind', 'kind'],
        sort: 'deleted',
      },
    });
    // The inbox's views (T27): kind, location and whose.
    const inbox = await save(ann, {
      name: "Everyone's drafts",
      surface: 'inbox',
      query: { filters: { kind: ['draft'], mine: ['everyone'], location: [home.id] } },
    });
    expect(inbox).toMatchObject({
      surface: 'inbox',
      query: { filters: { kind: ['draft'], mine: ['everyone'], location: [home.id] } },
    });
    expect(view.query).toEqual({
      filters: { kind: ['thing'], when: ['2026-09-01..'] },
      not: ['kind'],
      sort: 'deleted',
    });
    // The Display button's state (D211): the order turned around, and the layout.
    const display = await save(ann, {
      name: 'Oldest photos',
      surface: 'contents',
      query: { filters: { type: ['x'] }, sort: 'lastSeen', dir: 'asc', layout: 'photos' },
    });
    expect(display.query).toEqual({
      filters: { type: ['x'] },
      sort: 'lastSeen',
      dir: 'asc',
      layout: 'photos',
    });

    // A change is held to the view's own list, which never changes.
    const url = `/api/v1/saved-views/${view.id}`;
    const patch = (body: object, version: number) =>
      call(t, url, { as: ann, method: 'PATCH', body, headers: { 'if-match': String(version) } });
    expect((await patch({ query: { filters: { type: ['x'] } } }, 1)).statusCode).toBe(400);
    const changed = await patch({ query: { filters: { by: [mel.userId] } } }, 1);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      surface: 'trash',
      query: { filters: { by: [mel.userId] } },
    });
  });

  it('withholds money filters where the location of a personal view hides money (#29)', async () => {
    const query = { q: 'lamp', filters: { location: [home.id], priceMin: ['500'] } };
    const vics = await save(vic, { name: 'Dear lamps', query });
    // Audited as money: the history never shows the amount.
    const [created] = await accountAudit(vic.userId, 'saved_view');
    expect(created?.action).toBe('saved_view.create');
    expect((created?.diff.query as { class?: string } | undefined)?.class).toBe('money');

    const forVic = (await list(vic, 'search')).views.find((v) => v.id === vics.id);
    expect(forVic?.query).toEqual({ q: 'lamp', filters: { location: [home.id] } });
    expect(forVic?.moneyHidden).toBe(true);
    // The owner sees money there: her view keeps its price.
    const anns = await save(ann, { name: 'Dear lamps', query });
    const forAnn = (await list(ann, 'search')).views.find((v) => v.id === anns.id);
    expect(forAnn?.query).toEqual(query);
    expect(forAnn).not.toHaveProperty('moneyHidden');
    // "None of" a location, or several, is no one location: the view keeps what was typed.
    const elsewhere = await save(vic, {
      name: 'Dear elsewhere',
      query: { filters: { location: [home.id], priceMin: ['500'] }, not: ['location'] },
    });
    const shown = (await list(vic, 'search')).views.find((v) => v.id === elsewhere.id);
    expect(shown?.query).toMatchObject({ filters: { priceMin: ['500'] } });
    expect(shown).not.toHaveProperty('moneyHidden');
  });

  // catalogue: PUT /api/v1/saved-views/prefs/:surface
  it('pins views and sets the default per list, audited on the caller account when it changes', async () => {
    const a = await save(ann, { name: 'Pin A', query: {} });
    const b = await save(ann, { name: 'Pin B', query: {} });
    const s = await save(mel, { name: 'Pin S', query: {}, sharedLocationId: home.id });
    const body = { defaultViewId: a.id, pinned: [b.id, s.id, a.id] };
    const res = await putPrefs(ann, 'search', body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(body);
    expect((await list(ann, 'search')).prefs).toEqual(body);
    // Per list: activity's are still empty.
    expect((await list(ann, 'activity')).prefs).toEqual({ defaultViewId: null, pinned: [] });

    const events = await accountAudit(ann.userId, 'saved_view_prefs');
    expect(events.map((e) => e.action)).toEqual(['saved_view_prefs.update']);
    expect(events[0]?.diff.search?.after).toEqual({ default_view_id: a.id, pinned: body.pinned });
    // The same prefs again change nothing, and write nothing.
    expect((await putPrefs(ann, 'search', body)).statusCode).toBe(200);
    expect(await accountAudit(ann.userId, 'saved_view_prefs')).toHaveLength(1);
  });

  it('refuses a view of another list, one out of sight, an unknown list and a bad pin list (400)', async () => {
    const onActivity = await save(ann, { name: 'Other list', surface: 'activity', query: {} });
    const bobs = await save(bob, { name: 'Not yours', query: {} });
    const mine = await save(ann, { name: 'Mine', query: {} });
    for (const [surface, body] of [
      ['search', { defaultViewId: null, pinned: [onActivity.id] }],
      ['search', { defaultViewId: onActivity.id, pinned: [] }],
      ['search', { defaultViewId: bobs.id, pinned: [] }],
      ['search', { defaultViewId: null, pinned: [bobs.id] }],
      ['search', { defaultViewId: null, pinned: [mine.id, mine.id] }],
      ['search', { defaultViewId: null, pinned: Array.from({ length: 21 }, () => v7()) }],
      ['search', { defaultViewId: null }],
      ['search', { defaultViewId: null, pinned: [], extra: 1 }],
      ['nope', { defaultViewId: null, pinned: [] }],
    ] as const) {
      const res = await putPrefs(ann, surface, body);
      expect(res.statusCode, `${surface} ${JSON.stringify(body)}`).toBe(400);
    }
    const named = await putPrefs(ann, 'search', { defaultViewId: null, pinned: [bobs.id] });
    expect(named.json().hint).toContain(bobs.id);
  });

  it('leaves out views deleted or out of sight, and keeps a default through sharing', async () => {
    const a = await save(ann, { name: 'Gone A', query: {} });
    const b = await save(ann, { name: 'Gone B', query: {} });
    const c = await save(ann, { name: 'Kept C', query: {} });
    const s = await save(mel, { name: 'Gone S', query: {}, sharedLocationId: home.id });
    const ok = await putPrefs(ann, 'search', { defaultViewId: a.id, pinned: [b.id, s.id, c.id] });
    expect(ok.statusCode, ok.body).toBe(200);

    expect(
      (await call(t, `/api/v1/saved-views/${b.id}`, { as: ann, method: 'DELETE' })).statusCode,
    ).toBe(204);
    expect((await list(ann, 'search')).prefs).toEqual({
      defaultViewId: a.id,
      pinned: [s.id, c.id],
    });
    // Mel makes hers personal again: out of Ann's sight, out of her pins.
    const unshared = await call(t, `/api/v1/saved-views/${s.id}`, {
      as: mel,
      method: 'PATCH',
      body: { sharedLocationId: null },
      headers: { 'if-match': '1' },
    });
    expect(unshared.statusCode, unshared.body).toBe(200);
    expect((await list(ann, 'search')).prefs).toEqual({ defaultViewId: a.id, pinned: [c.id] });
    // Sharing her default view moves it (delete and insert, same id): still her default.
    const moved = await call(t, `/api/v1/saved-views/${a.id}`, {
      as: ann,
      method: 'PATCH',
      body: { sharedLocationId: home.id },
      headers: { 'if-match': '1' },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await list(ann, 'search')).prefs?.defaultViewId).toBe(a.id);
    // Deleted, the default is gone (its foreign key sets it null).
    expect(
      (await call(t, `/api/v1/saved-views/${a.id}`, { as: ann, method: 'DELETE' })).statusCode,
    ).toBe(204);
    expect((await list(ann, 'search')).prefs).toEqual({ defaultViewId: null, pinned: [c.id] });
    const [row] = await own<{ default_view_id: string | null }>(
      db,
      `SELECT default_view_id FROM public.saved_view_prefs WHERE user_id = $1 AND surface = 'search'`,
      [ann.userId],
    );
    expect(row?.default_view_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Migration 0034 turned every stored search query into list state: its UPDATE, run on a row of
// the old shape (the statement is read from the migration itself, so this checks what shipped).
// ---------------------------------------------------------------------------------------------

describe('migration 0034: old search queries become list state', () => {
  it('moves each old filter into filters as one value, keeps q, and drops kind and limit', async () => {
    const file = await readFile(
      fileURLToPath(new URL('../../migrations/0034_saved_view_surfaces.sql', import.meta.url)),
      'utf8',
    );
    const update = file
      .split('--> statement-breakpoint')
      .map((part) => part.slice(part.indexOf('UPDATE public.saved_views')))
      .find((part) => part.startsWith('UPDATE public.saved_views'));
    expect(update).toBeDefined();
    const old = {
      q: 'drill',
      locationId: '0199e0a0-0000-7000-8000-000000000001',
      placeId: '0199e0a0-0000-7000-8000-000000000002',
      typeId: '0199e0a0-0000-7000-8000-000000000003',
      tagId: '0199e0a0-0000-7000-8000-000000000004',
      state: 'unplaced',
      priceMin: '10',
      priceMax: '20.5',
      currency: 'EGP',
      kind: 'things',
      limit: 5,
    };
    const [a] = await own<{ id: string }>(
      db,
      `INSERT INTO public.saved_views (user_id, name, query) VALUES ($1, 'Old', $2::jsonb)
       RETURNING id`,
      [ann.userId, JSON.stringify(old)],
    );
    const [bare] = await own<{ id: string }>(
      db,
      `INSERT INTO public.saved_views (user_id, name, query) VALUES ($1, 'Bare', '{"kind": "places"}')
       RETURNING id`,
      [ann.userId],
    );
    await own(db, update as string);
    const rows = await own<{ id: string; query: unknown }>(
      db,
      'SELECT id, query FROM public.saved_views WHERE id = ANY ($1::uuid[])',
      [[a?.id, bare?.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.query]));
    expect(byId.get(a?.id as string)).toEqual({
      q: 'drill',
      filters: {
        location: [old.locationId],
        place: [old.placeId],
        type: [old.typeId],
        tag: [old.tagId],
        state: ['unplaced'],
        priceMin: ['10'],
        priceMax: ['20.5'],
        currency: ['EGP'],
      },
    });
    expect(byId.get(bare?.id as string)).toEqual({});
    // Run twice, nothing moves again: a converted row has `filters`.
    await own(db, update as string);
    const again = await own<{ query: unknown }>(
      db,
      'SELECT query FROM public.saved_views WHERE id = $1',
      [a?.id],
    );
    expect(again[0]?.query).toEqual(byId.get(a?.id as string));
  });
});
