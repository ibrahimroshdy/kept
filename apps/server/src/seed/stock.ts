import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import { labelPlace } from '../places/service.js';
import { allocateShortId } from '../places/short-id.js';
import { PEOPLE, type PersonKey } from './cast.js';
import { type Client, expectStatus, type Json, SeedError } from './client.js';
import { ACCOUNT_STOCK, type AccountStock, LOCATION_STOCK, type PlaceSpec } from './inventory.js';
import { photoJpeg, sha256Hex } from './photos.js';

// The households' inventory (task 23; D152, D185): registries, custom types, places, things with
// their fields, purchases with lines and receipts, meters and readings, photos, a secret value
// and saved views, all through the real routes, as the person the board shows doing it.
//
// Idempotent the way the step-1 steps are: each step looks first (by name, the natural key of
// the declarations in inventory.ts) and does only what is missing. Fixed UUIDv7s can't be the
// key: a client id must be within 7 days of the server's clock (assertClientId, §7.7), so a
// second run a week later would be refused.
//
// Two steps are not routes, because no route exists for them yet, and run the service code on
// kept_app inside withScope() as the location's owner, so row-level security and the audit
// trail apply exactly as for a request:
// - a place's fixed short ID: places/service.ts labelPlace() with the board's code (the label
//   route draws a random one);
// - a thing's board code: a thing gets a random code when it is made and no route chooses one
//   before step 3's labels, so the seed relabels it (relabelThing(), below): the random code
//   stays as a secondary code, the board's becomes primary, audited as `thing.label`.

export type StockContext = {
  client: Client;
  pools: Pick<Pools, 'app'>;
  /** The session cookie of each person (households.ts signs everyone in). */
  cookieOf: (key: PersonKey) => string;
  /** Household name → location id (households.ts). */
  locations: ReadonlyMap<string, string>;
  /** Whether the app serves files (photos and receipts are skipped without). */
  hasFiles: boolean;
  /** Whether the instance admin can acknowledge the recovery kit (secrets need it, D193). */
  instanceAdmin: PersonKey | null;
  now: Date;
  /** Counts each thing made (0 on a run after a complete one). */
  made: () => void;
  note: (text: string) => void;
};

export type StockSummary = { location: string; places: number; things: number };

type PlaceNode = { id: string; parentId: string | null; name: string; isUnplaced: boolean };
type ThingRow = { id: string; name: string | null; shortCode: string | null };
type ThingView = ThingRow & {
  rowVersion: number;
  lifecycle: string;
  locationUncertain: boolean;
  photos: unknown[];
  secrets: { fieldKey: string; set: boolean }[];
  links: { thing: { id: string } }[];
  meters: { id: string; kind: string }[];
  purchase: { purchaseId: string | null } | null;
};
type AccountRegistries = {
  id: string;
  brands: Map<string, string>;
  vendors: Map<string, string>;
  people: Map<string, string>;
  tags: Map<string, string>;
  /** builtin key, or `custom:<name>` → type id */
  types: Map<string, string>;
};

const SECRET_ROUTE = '/api/v1/things/:id/secrets/:fieldKey';

export async function stockHouseholds(ctx: StockContext): Promise<StockSummary[]> {
  const { client } = ctx;
  const get = (who: PersonKey, url: string, what: string) =>
    client
      .call('GET', url, { cookie: ctx.cookieOf(who) })
      .then((res) => expectStatus(res, [200], what));
  const send = async (
    who: PersonKey,
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    body: unknown,
    ok: number[],
    what: string,
    headers?: Record<string, string>,
  ) =>
    expectStatus(
      await client.call(method, url, {
        cookie: ctx.cookieOf(who),
        body,
        headers: { 'accept-language': PEOPLE[who].locale, ...headers },
      }),
      ok,
      what,
    );

  const userIds = new Map<PersonKey, string>();
  const userId = async (who: PersonKey): Promise<string> => {
    let id = userIds.get(who);
    if (!id) {
      const me = await get(who, '/api/v1/me', `me of ${who}`);
      id = String((me.user as Json).id);
      userIds.set(who, id);
    }
    return id;
  };
  /** Service code on kept_app as `who`, the way a request runs it (http/write.ts). */
  const asPerson = async <T>(
    who: PersonKey,
    fn: (tx: Tx, c: pg.PoolClient, scope: Scope) => Promise<T>,
  ): Promise<T> => {
    const scope: Scope = { userId: await userId(who), mfa: false };
    return withScope(ctx.pools.app, scope, (tx, c) => fn(tx, c, scope));
  };

  // --- account registries and types -----------------------------------------------------------
  const accounts = new Map<PersonKey, AccountRegistries>();
  const accountOf = async (owner: PersonKey): Promise<AccountRegistries> => {
    const known = accounts.get(owner);
    if (known) return known;
    const listed = (await get(owner, '/api/v1/accounts', 'accounts')) as {
      accounts: { id: string; isOwn: boolean }[];
    };
    const id = listed.accounts.find((a) => a.isOwn)?.id;
    if (!id) throw new SeedError(`${owner} has no account of their own`);
    const stock: AccountStock = ACCOUNT_STOCK[owner] ?? {
      brands: [],
      vendors: [],
      people: [],
      tags: [],
      types: [],
    };
    const regs: AccountRegistries = {
      id,
      brands: new Map(),
      vendors: new Map(),
      people: new Map(),
      tags: new Map(),
      types: new Map(),
    };
    const ensure = async (
      kind: 'brands' | 'vendors' | 'people' | 'tags',
      nameKey: 'name' | 'displayName',
      wanted: readonly Json[],
    ) => {
      const page = (await get(
        owner,
        `/api/v1/accounts/${id}/${kind}?limit=200`,
        `${kind} of ${owner}`,
      )) as { items: Json[] };
      for (const item of page.items) regs[kind].set(String(item[nameKey]), String(item.id));
      for (const body of wanted) {
        const name = String(body[nameKey]);
        if (regs[kind].has(name)) continue;
        const res = await send(
          owner,
          'POST',
          `/api/v1/accounts/${id}/${kind}`,
          body,
          [201],
          `${kind}: ${name}`,
        );
        regs[kind].set(name, String((res.item as Json).id));
        ctx.made();
      }
    };
    await ensure('brands', 'name', stock.brands);
    await ensure('vendors', 'name', stock.vendors);
    await ensure(
      'people',
      'displayName',
      stock.people.map((displayName) => ({ displayName })),
    );
    await ensure('tags', 'name', stock.tags);

    const types = async () =>
      (
        (await get(owner, `/api/v1/accounts/${id}/types`, `types of ${owner}`)) as {
          types: { id: string; builtinKey: string | null; name: string | null }[];
        }
      ).types;
    const listedTypes = await types();
    for (const t of listedTypes) {
      if (t.builtinKey && !regs.types.has(t.builtinKey)) regs.types.set(t.builtinKey, t.id);
      if (!t.builtinKey && t.name) regs.types.set(`custom:${t.name}`, t.id);
    }
    for (const spec of stock.types) {
      let typeId = regs.types.get(`custom:${spec.name}`);
      if (!typeId) {
        const created = await send(
          owner,
          'POST',
          `/api/v1/accounts/${id}/types`,
          { parentId: null, name: spec.name, icon: spec.icon, capabilities: spec.capabilities },
          [201],
          `type ${spec.name}`,
        );
        typeId = String(created.id);
        regs.types.set(`custom:${spec.name}`, typeId);
        ctx.made();
      }
      const detail = (await get(owner, `/api/v1/types/${typeId}`, `type ${spec.name}`)) as {
        fields: { key: string }[];
      };
      const have = new Set(detail.fields.map((f) => f.key));
      for (const field of spec.fields) {
        if (have.has(field.key)) continue;
        await send(
          owner,
          'POST',
          `/api/v1/types/${typeId}/fields`,
          field,
          [201],
          `field ${field.key} of ${spec.name}`,
        );
        ctx.made();
      }
    }
    accounts.set(owner, regs);
    return regs;
  };

  // --- uploads ----------------------------------------------------------------------------------
  const upload = async (
    who: PersonKey,
    locationId: string,
    colour: string,
    cls: 'photo' | 'evidence',
  ): Promise<string> => {
    const bytes = await photoJpeg(colour, cls === 'evidence' ? 'receipt' : 'photo');
    const res = await send(
      who,
      'PUT',
      `/api/v1/files/${newId()}?locationId=${locationId}&class=${cls}`,
      bytes,
      [200, 201],
      `upload of a ${cls}`,
      { 'content-type': 'image/jpeg', 'x-kept-sha256': sha256Hex(bytes) },
    );
    return String(res.id);
  };

  // --- the recovery kit, once, before the first secret value (D193) ----------------------------
  let kitReady: boolean | null = null;
  const recoveryKit = async (): Promise<boolean> => {
    if (kitReady !== null) return kitReady;
    const admin = ctx.instanceAdmin;
    if (!admin) {
      ctx.note('secret values skipped: the seed has no instance admin to acknowledge the kit.');
      kitReady = false;
      return kitReady;
    }
    const kit = await get(admin, '/api/v1/admin/recovery-kit', 'recovery kit');
    if (kit.acknowledgedAt === null) {
      await send(
        admin,
        'POST',
        '/api/v1/admin/recovery-kit/acknowledge',
        undefined,
        [200],
        'recovery kit',
      );
      ctx.made();
    }
    kitReady = true;
    return kitReady;
  };
  const secretsRoute = client.app.hasRoute({ method: 'PUT', url: SECRET_ROUTE });
  let secretsNoted = false;
  let secretsOff = false;

  // --- locations ----------------------------------------------------------------------------------
  const summaries: StockSummary[] = [];
  for (const stock of LOCATION_STOCK) {
    const owner = stock.owner;
    const locationId =
      stock.location === 'personal'
        ? String((await get(owner, '/api/v1/me', 'me')).personalLocationId)
        : ctx.locations.get(stock.location);
    if (!locationId || locationId === 'null') {
      throw new SeedError(`no location ${stock.location} to stock`);
    }
    const label =
      stock.location === 'personal' ? `${PEOPLE[owner].displayName}'s Personal` : stock.location;
    const regs = await accountOf(owner);

    // Modules beyond the preset.
    if (stock.modules?.length) {
      const loc = (await get(owner, `/api/v1/locations/${locationId}`, label)) as {
        modules: string[];
      };
      for (const module of stock.modules) {
        if (loc.modules.includes(module)) continue;
        await send(
          owner,
          'POST',
          `/api/v1/locations/${locationId}/modules`,
          { module, enabled: true },
          [200],
          `${module} in ${label}`,
        );
        ctx.made();
      }
    }

    // Places: the tree, by name under each parent.
    const nodes = (
      (await get(owner, `/api/v1/locations/${locationId}/places`, `places of ${label}`)) as {
        places: PlaceNode[];
      }
    ).places;
    const unplacedId = nodes.find((n) => n.isUnplaced)?.id;
    if (!unplacedId) throw new SeedError(`${label} has no Unplaced area`);
    const placeIds = new Map<string, string>();
    const walk = async (specs: readonly PlaceSpec[], parentId: string | null, path: string[]) => {
      for (const spec of specs) {
        const here = [...path, spec.name];
        let id = nodes.find(
          (n) => !n.isUnplaced && n.name === spec.name && n.parentId === parentId,
        )?.id;
        if (!id) {
          const created = await send(
            owner,
            'POST',
            `/api/v1/locations/${locationId}/places`,
            { parentId, name: spec.name, kindKey: spec.kind },
            [201],
            `place ${here.join(' › ')}`,
          );
          id = String(created.id);
          ctx.made();
        }
        placeIds.set(here.join('\u0000'), id);
        if (spec.code) {
          const code = spec.code;
          const placeId = id;
          const made = await asPerson(owner, async (tx, c, scope) => {
            const had = await c.query('SELECT 1 FROM public.short_ids WHERE place_id = $1', [
              placeId,
            ]);
            if (had.rowCount) return false;
            await labelPlace(
              { tx, client: c, scope, jobs: null, requestId: `seed-${newId()}` },
              placeId,
              firstThen(code),
            );
            return true;
          });
          if (made) ctx.made();
        }
        if (spec.children) await walk(spec.children, id, here);
      }
    };
    await walk(stock.places, null, []);
    const placeOf = (path: readonly string[]) => {
      const id = placeIds.get(path.join('\u0000'));
      if (!id) throw new SeedError(`${label}: no place ${path.join(' › ')} in the declarations`);
      return id;
    };

    // Things: found by name, made in declaration order (a container before its contents).
    const existing = new Map<string, ThingRow>();
    let cursor: string | null = null;
    do {
      const page = (await get(
        owner,
        `/api/v1/things?locationId=${locationId}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        `things of ${label}`,
      )) as { items: ThingRow[]; next_cursor: string | null };
      for (const row of page.items) if (row.name) existing.set(row.name, row);
      cursor = page.next_cursor;
    } while (cursor);

    const thingIds = new Map<string, string>();
    const reg = (map: Map<string, string>, name: string | undefined, what: string) => {
      if (name === undefined) return undefined;
      const id = map.get(name);
      if (!id) throw new SeedError(`${label}: no ${what} "${name}" in the account`);
      return id;
    };
    for (const spec of stock.things) {
      const who = spec.by ?? owner;
      let row = existing.get(spec.name);
      if (!row) {
        const at =
          spec.at === 'unplaced'
            ? { placeId: unplacedId }
            : 'place' in spec.at
              ? { placeId: placeOf(spec.at.place) }
              : { containerId: thingIds.get(spec.at.in) };
        if ('containerId' in at && !at.containerId) {
          throw new SeedError(`${spec.name}: its container is declared after it`);
        }
        const body: Json = {
          locationId,
          ...at,
          name: spec.name,
          ...(spec.type ? { typeId: reg(regs.types, spec.type, 'type') } : {}),
          ...(spec.quantity !== undefined ? { quantity: spec.quantity } : {}),
          ...(spec.brand ? { brandId: reg(regs.brands, spec.brand, 'brand') } : {}),
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.serial ? { serial: spec.serial } : {}),
          ...(spec.colour ? { colour: spec.colour } : {}),
          ...(spec.condition ? { condition: spec.condition } : {}),
          ...(spec.notes ? { notes: spec.notes } : {}),
          ...(spec.aliases ? { aliases: spec.aliases } : {}),
          ...(spec.tags ? { tagIds: spec.tags.map((t) => reg(regs.tags, t, 'tag')) } : {}),
          ...(spec.belongsTo
            ? { belongsToPersonId: reg(regs.people, spec.belongsTo, 'person') }
            : {}),
          ...(spec.expiresOn ? { expiresOn: spec.expiresOn } : {}),
          ...(spec.expiryLeadDays !== undefined ? { expiryLeadDays: spec.expiryLeadDays } : {}),
          ...(spec.custom ? { custom: spec.custom } : {}),
          ...(spec.bought
            ? {
                purchase: {
                  purchasedOn: spec.bought.on,
                  currency: spec.bought.currency,
                  price: spec.bought.price,
                  ...(spec.bought.vendor
                    ? { vendorId: reg(regs.vendors, spec.bought.vendor, 'vendor') }
                    : {}),
                },
              }
            : {}),
        };
        const created = (await send(
          who,
          'POST',
          '/api/v1/things',
          body,
          [201],
          spec.name,
        )) as unknown as ThingRow;
        row = created;
        existing.set(spec.name, row);
        ctx.made();
      }
      thingIds.set(spec.key, row.id);
    }

    // What each thing has beyond its fields: a short ID, a photo, a secret, an end, "not here",
    // a link, readings. Read the thing's view only for the specs that ask for one of them.
    for (const spec of stock.things) {
      const needsView =
        spec.code ||
        spec.photo ||
        spec.secret ||
        spec.ended ||
        spec.notHere ||
        spec.link ||
        spec.readings;
      if (!needsView) continue;
      const id = thingIds.get(spec.key) as string;
      const view = async () =>
        (await get(owner, `/api/v1/things/${id}`, spec.name)) as unknown as ThingView;
      let v = await view();

      if (spec.code && v.shortCode !== spec.code) {
        const code = spec.code;
        const got = await asPerson(owner, (tx, c, scope) =>
          relabelThing(tx, c, scope, locationId, id, code),
        );
        if (got !== code) ctx.note(`${spec.name}: the code ${code} is taken; it got ${got}.`);
        ctx.made();
      }
      if (spec.photo && v.photos.length === 0 && ctx.hasFiles) {
        const fileId = await upload(owner, locationId, spec.photo, 'photo');
        await send(
          owner,
          'POST',
          '/api/v1/attachments',
          { locationId, fileId, subject: { thingId: id }, role: 'photo' },
          [201],
          `photo of ${spec.name}`,
        );
        ctx.made();
      }
      if (spec.secret && !v.secrets.find((s) => s.fieldKey === spec.secret?.field)?.set) {
        if (!secretsRoute) {
          if (!secretsNoted) {
            ctx.note(
              `secret values skipped: this build has no ${SECRET_ROUTE} route yet (task 19).`,
            );
            secretsNoted = true;
          }
        } else if (!secretsOff && (await recoveryKit())) {
          const res = await client.call(
            'PUT',
            `/api/v1/things/${id}/secrets/${spec.secret.field}`,
            {
              cookie: ctx.cookieOf(owner),
              body: { value: spec.secret.value },
              headers: { 'accept-language': PEOPLE[owner].locale },
            },
          );
          if (res.statusCode === 503) {
            // The app was built without a keyring (buildSeedApp's `app.secretKeys`).
            secretsOff = true;
            ctx.note('secret values skipped: the seed app has no keyring for secret values.');
          } else {
            expectStatus(res, [204], `${spec.secret.field} of ${spec.name}`);
            ctx.made();
          }
        }
      }
      if (spec.link && !v.links.some((l) => l.thing.id === thingIds.get(spec.link?.to ?? ''))) {
        await send(
          owner,
          'POST',
          `/api/v1/things/${id}/links`,
          { toThingId: thingIds.get(spec.link.to), kind: spec.link.kind },
          [201],
          `link of ${spec.name}`,
        );
        ctx.made();
      }
      if (spec.notHere && !v.locationUncertain) {
        await send(
          spec.by ?? owner,
          'POST',
          `/api/v1/things/${id}/not-here`,
          undefined,
          [200],
          `${spec.name} not here`,
        );
        ctx.made();
        v = await view();
      }
      if (spec.ended && v.lifecycle !== spec.ended.lifecycle) {
        await send(
          spec.by ?? owner,
          'POST',
          `/api/v1/things/${id}/lifecycle`,
          {
            lifecycle: spec.ended.lifecycle,
            endedOn: spec.ended.on,
            ...(spec.ended.to ? { endedTo: spec.ended.to } : {}),
          },
          [200],
          `${spec.name} ${spec.ended.lifecycle}`,
          { 'if-match': String(v.rowVersion) },
        );
        ctx.made();
      }
      if (spec.readings) {
        let meterId = v.meters[0]?.id;
        if (!meterId) {
          const meter = await send(
            owner,
            'POST',
            `/api/v1/things/${id}/meters`,
            { kind: 'distance', unit: 'km' },
            [201],
            `meter of ${spec.name}`,
          );
          meterId = String(meter.id);
          ctx.made();
        }
        const listed = (await get(
          owner,
          `/api/v1/meters/${meterId}/readings?limit=200`,
          `readings of ${spec.name}`,
        )) as { items: { value: string }[] };
        const have = new Set(listed.items.map((r) => r.value));
        for (const reading of spec.readings) {
          if (have.has(reading.value)) continue;
          const takenAt = new Date(ctx.now.getTime() - reading.daysAgo * 86_400_000);
          await send(
            reading.by,
            'POST',
            `/api/v1/meters/${meterId}/readings`,
            { value: reading.value, takenAt: takenAt.toISOString() },
            [201],
            `reading ${reading.value} of ${spec.name}`,
          );
          ctx.made();
        }
      }
    }

    // Receipts: a purchase with lines linked to things, and the receipt's photo (evidence).
    for (const receipt of stock.receipts ?? []) {
      const who = receipt.by ?? owner;
      const first = receipt.lines[0];
      const firstId = first ? thingIds.get(first.thing) : undefined;
      if (!firstId) throw new SeedError(`receipt ${receipt.key} has no first line`);
      const firstView = (await get(
        owner,
        `/api/v1/things/${firstId}`,
        receipt.key,
      )) as unknown as ThingView;
      let purchaseId = firstView.purchase?.purchaseId ?? null;
      if (!purchaseId) {
        const created = await send(
          who,
          'POST',
          '/api/v1/purchases',
          {
            locationId,
            vendorId: reg(regs.vendors, receipt.vendor, 'vendor'),
            purchasedOn: receipt.purchasedOn,
            currency: receipt.currency,
            total: receipt.total,
            ...(receipt.tax ? { tax: receipt.tax } : {}),
            ...(receipt.notes ? { notes: receipt.notes } : {}),
            lines: receipt.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity ?? 1,
              unitPrice: l.unitPrice,
              thingId: thingIds.get(l.thing),
            })),
          },
          [201],
          `purchase ${receipt.key}`,
        );
        purchaseId = String(created.id);
        ctx.made();
      }
      if (ctx.hasFiles) {
        const purchase = (await get(who, `/api/v1/purchases/${purchaseId}`, receipt.key)) as {
          receipts: unknown[];
        };
        if (purchase.receipts.length === 0) {
          const fileId = await upload(who, locationId, receipt.photo, 'evidence');
          await send(
            who,
            'POST',
            '/api/v1/attachments',
            { locationId, fileId, subject: { purchaseId }, role: 'receipt' },
            [201],
            `receipt of ${receipt.key}`,
          );
          ctx.made();
        }
      }
    }

    // Saved views, personal or shared with this location (D42, D183).
    for (const view of stock.views ?? []) {
      const mine = (await get(view.by, '/api/v1/saved-views', 'saved views')) as {
        views: { name: string; sharedLocationId: string | null }[];
      };
      const wantShared = view.shared ? locationId : null;
      if (mine.views.some((v) => v.name === view.name && v.sharedLocationId === wantShared)) {
        continue;
      }
      // The search list's state (D205, @kept/shared SavedListQuery): each filter a list of
      // values; a personal view is kept to this location by its location filter.
      const tag = reg(regs.tags, view.tag, 'tag');
      const filters: Record<string, string[]> = {
        ...(view.query.state ? { state: [view.query.state] } : {}),
        ...(tag ? { tag: [tag] } : {}),
        ...(view.shared ? {} : { location: [locationId] }),
      };
      const query: Json = {
        ...(view.query.q ? { q: view.query.q } : {}),
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
      };
      await send(
        view.by,
        'POST',
        '/api/v1/saved-views',
        { name: view.name, surface: 'search', query, sharedLocationId: wantShared },
        [201],
        `saved view ${view.name}`,
      );
      ctx.made();
    }

    summaries.push({
      location: label,
      places: placeIds.size,
      things: stock.things.length,
    });
  }
  return summaries;
}

/** A generator that returns `code` first and random codes after (a taken code is retried). */
function firstThen(code: string): () => string {
  let first = true;
  return () => {
    if (!first) return randomShortCode();
    first = false;
    return code;
  };
}

/**
 * Gives a thing the board's code as its primary short ID. Every thing gets a random code when it
 * is made (things/service.ts createThing, D183), and no route chooses one before step 3's
 * labels, so this is a relabel as a pre-printed label would do it: the random code stays the
 * thing's (codes are never deleted or reissued, D112) but no longer primary, and the chosen code
 * becomes primary. Under the caller's row-level security (is_primary is kept_app's to update,
 * 0016), and audited as `thing.label`.
 */
async function relabelThing(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  locationId: string,
  thingId: string,
  code: string,
): Promise<string> {
  const { rows } = await client.query<{ code: string }>(
    `UPDATE public.short_ids SET is_primary = false
      WHERE thing_id = $1 AND is_primary AND state = 'assigned' RETURNING code`,
    [thingId],
  );
  const allocated = await allocateShortId(client, locationId, { thingId }, firstThen(code));
  await audited(tx, {
    locationId,
    actor: { type: 'user', id: scope.userId },
    action: 'thing.label',
    entity: { type: 'thing', id: thingId },
    rootThingId: thingId,
    before: { short_code: rows[0]?.code ?? null },
    after: { short_code: allocated },
    requestId: `seed-${newId()}`,
  });
  return allocated;
}
