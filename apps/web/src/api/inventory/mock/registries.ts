/**
 * Mock handlers for accounts, types, place kinds, brands, vendors, people, tags and currencies
 * (tasks 11 and 12), as task 28's screens use them.
 *
 * Roles follow the server's rule for account registries: `:accountId` must be visible (404
 * otherwise); managing (types, place kinds, rename, merge, delete) needs owner or admin in some
 * location of the account (`canManage`); a member may add people, vendors and tags inline; a
 * viewer changes nothing (403). Secret fields and their policies are the account owner's (D177).
 *
 * Types are stored resolved, as the server sends them: a type's `fields` are its parent chain's
 * (`via: 'inherited'`), its own, then its field groups' (`via: 'group'`, Q4). `resolved()`
 * rebuilds that after any change, and a key defined twice (D92) or a parent cycle is a 409 whose
 * `reason` says which (a contract question for task 11).
 */
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { inventoryPaths as p, type RegistryPathKind } from '../paths';
import type {
  Capability,
  CreatePlaceKindBody,
  CreateTypeBody,
  CreateTypeFieldBody,
  PersonContact,
  PlaceKindNode,
  RegistryItem,
  ResolvedField,
  SecretPolicy,
  TypeDetail,
  TypeImpact,
  UpdateCurrencyBody,
  UpdatePlaceKindBody,
  UpdateTypeBody,
  UpdateTypeFieldBody,
} from '../types';
import { fold, matches, newId, now, paginate, roleIn, versionError } from './db';

const KINDS: RegistryPathKind[] = ['brands', 'vendors', 'people', 'tags'];
const DEFAULT_CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'EGP'];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

const nameOf = (item: RegistryItem[RegistryPathKind]) =>
  'displayName' in item ? item.displayName : item.name;

/** Trigram-ish similarity for the D11 duplicate hint: shared character bigrams. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const f = ` ${fold(s)} `;
    const out = new Set<string>();
    for (let i = 0; i < f.length - 1; i++) out.add(f.slice(i, i + 2));
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  const shared = [...x].filter((g) => y.has(g)).length;
  return shared / Math.max(1, new Set([...x, ...y]).size);
}

/** A type as the mock keeps it: the response shape plus its owner (null for a built-in). */
type StoredType = TypeDetail & { ownerAccountId?: string | null };

const strip = ({ ownerAccountId: _o, ...t }: StoredType): TypeDetail => t;

class Redefined extends Error {
  constructor(readonly key: string) {
    super(key);
  }
}

export function registriesRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const types = () => inv().types as StoredType[];
  const visibleAccount = (id: string | null | undefined) => inv().accounts.find((a) => a.id === id);
  const typeById = (id: string | null | undefined) => types().find((t) => t.id === id);
  const isBuiltinOriginal = (t: StoredType) => t.builtinKey !== null && t.copiedFromId === null;
  /** Built-ins have no owner; the fixture's custom types are the first (own) account's. */
  const ownerOf = (t: StoredType) =>
    t.ownerAccountId !== undefined
      ? t.ownerAccountId
      : isBuiltinOriginal(t)
        ? null
        : (inv().accounts[0]?.id ?? null);
  const typesFor = (accountId: string) =>
    types().filter((t) => {
      const owner = ownerOf(t);
      return owner === null || owner === accountId;
    });

  /** The caller's highest role across the account's visible locations. */
  const accountRole = (accountId: string | null | undefined) => {
    const account = visibleAccount(accountId);
    if (!account) return null;
    if (account.isOwn) return 'owner' as const;
    if (account.canManage) return 'admin' as const;
    const roles = Object.entries(inv().accountOf)
      .filter(([, a]) => a === account.id)
      .map(([loc]) => roleIn(state.locations, loc));
    return roles.some((r) => r === 'member' || r === 'admin' || r === 'owner')
      ? ('member' as const)
      : ('viewer' as const);
  };
  const canManage = (accountId: string | null | undefined) => {
    const r = accountRole(accountId);
    return r === 'owner' || r === 'admin';
  };
  /** The account a type belongs to, for the permission checks (a built-in: the caller's own). */
  const typeAccount = (t: StoredType) => ownerOf(t) ?? inv().accounts[0]?.id ?? null;

  const descendantsOf = (id: string): StoredType[] => {
    const out: StoredType[] = [];
    const walk = (pid: string) => {
      for (const c of types().filter((x) => x.parentId === pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  };

  const own = (t: StoredType) =>
    t.fields.filter((f) => f.source.typeId === t.id && f.source.via === 'own');

  /** The type's resolved fields and capabilities, from its chain and groups (no writes). */
  function resolved(
    t: StoredType,
    patch: { parentId?: string | null; fieldGroups?: string[]; capabilities?: Capability[] } = {},
    extraOwn: ResolvedField[] = [],
  ): { fields: ResolvedField[]; resolvedCapabilities: Capability[] } {
    const parentId = patch.parentId !== undefined ? patch.parentId : t.parentId;
    const groups = patch.fieldGroups ?? t.fieldGroups;
    const caps = patch.capabilities ?? t.capabilities;
    const parent = typeById(parentId);
    const up = parent
      ? resolved(parent)
      : { fields: [] as ResolvedField[], resolvedCapabilities: [] as Capability[] };
    const fields: ResolvedField[] = up.fields.map((f) => ({
      ...f,
      source: { typeId: f.source.typeId, via: f.source.via === 'group' ? 'group' : 'inherited' },
    }));
    const seen = new Set(fields.map((f) => f.key));
    const add = (f: ResolvedField) => {
      if (seen.has(f.key)) throw new Redefined(f.key);
      seen.add(f.key);
      fields.push(f);
    };
    for (const f of [...own(t), ...extraOwn]) add(f);
    const groupCaps: Capability[] = [];
    for (const gid of groups) {
      const g = typeById(gid);
      if (!g) continue;
      if (up.fields.some((f) => f.source.typeId === g.id)) continue;
      groupCaps.push(...g.capabilities);
      for (const f of own(g)) add({ ...f, source: { typeId: g.id, via: 'group' } });
    }
    return {
      fields,
      resolvedCapabilities: [...new Set([...up.resolvedCapabilities, ...caps, ...groupCaps])],
    };
  }

  /** Re-resolve a type and everything under it after a change. */
  function refresh(t: StoredType) {
    for (const x of [t, ...descendantsOf(t.id)]) Object.assign(x, resolved(x));
  }

  const conflict = (reason: 'cycle' | 'field_redefined' | 'builtin', extra = {}) =>
    reason === 'cycle'
      ? err(
          409,
          'conflict',
          'A type cannot be inside itself.',
          'Pick a parent outside this branch.',
          { reason },
        )
      : reason === 'builtin'
        ? err(
            409,
            'conflict',
            'Built-in types are customised first.',
            'Use Customise to make an editable copy.',
            { reason },
          )
        : err(
            409,
            'conflict',
            'That field key is already used by this type, one it inherits from, or one below it.',
            'Pick another key.',
            { reason, ...extra },
          );

  /** Visible locations of an account, for the impact preview. */
  const locationsOf = (accountId: string) =>
    state.locations.filter((l) => inv().accountOf[l.id] === accountId);

  const kindAccount = (kind: PlaceKindNode) =>
    Object.entries(inv().placeKinds).find(([, list]) => list.includes(kind))?.[0] ?? null;

  const fieldById = (id: string | undefined) => {
    for (const t of types()) {
      const f = own(t).find((x) => x.id === id);
      if (f) return { account: typeAccount(t), type: t as StoredType | undefined, field: f };
    }
    for (const kinds of Object.values(inv().placeKinds))
      for (const k of kinds) {
        const f = k.fields.find((x) => x.id === id);
        if (f) return { account: kindAccount(k), type: undefined, field: f };
      }
    return undefined;
  };

  const contacts = new Map<string, PersonContact>();
  const firstPerson = inv().people[0];
  if (firstPerson)
    contacts.set(firstPerson.id, {
      phone: '+20 100 555 0199',
      email: 'alfred@example.com',
      notes: null,
    });
  const policies = new Map<string, SecretPolicy>();

  function newField(ownerId: string, b: CreateTypeFieldBody, sort: number): ResolvedField {
    return {
      id: newId(),
      key: b.key,
      label: b.label,
      labelKey: null,
      kind: b.kind,
      unit: b.unit ?? null,
      options: b.options ?? null,
      repeatable: b.repeatable ?? false,
      required: b.required ?? false,
      secret: b.secret ?? false,
      sort,
      archivedAt: null,
      source: { typeId: ownerId, via: 'own' },
      rowVersion: 1,
    };
  }

  /** The body checks every field creation shares (types and place kinds). */
  function fieldBodyError(b: CreateTypeFieldBody, accountId: string | null) {
    if (!KEY.test(b.key ?? ''))
      return err(400, 'validation', 'A key is a lower-case word: letters, digits and _.');
    if (!b.label?.trim()) return err(400, 'validation', 'A field needs a label.');
    if (b.secret && b.kind !== 'text')
      return err(400, 'validation', 'Only a text field can be secret.');
    if (b.secret && accountRole(accountId) !== 'owner')
      return err(403, 'forbidden', 'Only the account owner makes a field secret.');
    return null;
  }

  const allKinds = () => Object.values(inv().placeKinds).flat();
  /** A built-in kind: no owner. The account's copy of one keeps `builtinKey` (T28 decision 7). */
  const isKindOriginal = (k: PlaceKindNode) => k.ownerAccountId === null;

  return [
    route('GET', p.accounts, () => sessionGate(state) ?? { accounts: inv().accounts }),

    // ----- types -----
    route('GET', p.accountTypes(':accountId'), ({ params, query }) => {
      if (!visibleAccount(params.accountId)) return notFound();
      const withArchived = query.get('includeArchived') === 'true';
      return {
        types: typesFor(params.accountId ?? '')
          .filter((t) => withArchived || !t.archivedAt)
          .map(({ fields: _f, ownerAccountId: _o, ...node }) => node),
      };
    }),
    route('GET', p.type(':id'), ({ params }) => {
      const t = typeById(params.id);
      return t ? strip(t) : notFound();
    }),
    route('POST', p.accountTypes(':accountId'), ({ params, body }) => {
      const account = visibleAccount(params.accountId);
      if (!account) return notFound();
      if (!canManage(account.id)) return forbidden();
      const b = body as CreateTypeBody;
      if (!b.name?.trim()) return err(400, 'validation', 'A type needs a name.');
      const created: StoredType = {
        id: b.id ?? newId(),
        parentId: b.parentId,
        builtinKey: null,
        name: b.name.trim(),
        icon: b.icon,
        colour: b.colour ?? null,
        capabilities: b.capabilities,
        resolvedCapabilities: [],
        isFieldGroup: false,
        fieldGroups: b.fieldGroups ?? [],
        copiedFromId: null,
        inUse: 0,
        rowVersion: 1,
        fields: [],
        ownerAccountId: account.id,
      };
      try {
        Object.assign(created, resolved(created));
      } catch (e) {
        if (e instanceof Redefined) return conflict('field_redefined', { key: e.key });
        throw e;
      }
      types().push(created);
      return reply(201, strip(created));
    }),
    route('PATCH', p.type(':id'), ({ params, body, headers }) => {
      const t = typeById(params.id);
      if (!t) return notFound();
      if (!canManage(typeAccount(t))) return forbidden();
      if (isBuiltinOriginal(t)) return conflict('builtin');
      const b = body as UpdateTypeBody;
      const stale = versionError(headers, t, Object.keys(b));
      if (stale) return reply(stale.status, stale.body);
      if (b.parentId) {
        let cur = typeById(b.parentId);
        while (cur) {
          if (cur.id === t.id) return conflict('cycle');
          cur = typeById(cur.parentId);
        }
      }
      try {
        resolved(t, b);
      } catch (e) {
        if (e instanceof Redefined) return conflict('field_redefined', { key: e.key });
        throw e;
      }
      Object.assign(t, b);
      if (b.name !== undefined) t.name = b.name.trim();
      t.rowVersion += 1;
      try {
        refresh(t);
      } catch (e) {
        if (e instanceof Redefined) return conflict('field_redefined', { key: e.key });
        throw e;
      }
      return strip(t);
    }),
    route('POST', p.typePreview(':id'), ({ params, body }) => {
      const t = typeById(params.id);
      if (!t) return notFound();
      const b = (body ?? {}) as UpdateTypeBody;
      const account = typeAccount(t) ?? '';
      const tree = [t, ...descendantsOf(t.id)];
      const ids = new Set(tree.map((x) => x.id));
      let fieldsToArchive: string[] = [];
      try {
        const after = new Set(resolved(t, b).fields.map((f) => f.key));
        fieldsToArchive = t.fields
          .filter((f) => !after.has(f.key) && !f.archivedAt)
          .map((f) => f.key);
      } catch {
        // The PATCH refuses it with the reason; the preview just can't list the fields.
      }
      const impact: TypeImpact = {
        descendants: descendantsOf(t.id).map((x) => ({
          id: x.id,
          name: x.name,
          builtinKey: x.builtinKey,
        })),
        perLocation: locationsOf(account).map((l) => ({
          locationId: l.id,
          name: l.name,
          things: inv().things.filter(
            (x) => x.locationId === l.id && x.type && ids.has(x.type.id) && !x.deletedAt,
          ).length,
        })),
        // The fixture household: Ibrahim's account has one location he can't see (D123).
        hiddenLocations: account === inv().accounts[0]?.id ? 1 : 0,
        fieldsToArchive,
      };
      return impact;
    }),
    route('POST', p.typeFields(':id'), ({ params, body }) => {
      const t = typeById(params.id);
      if (!t) return notFound();
      const account = typeAccount(t);
      if (!canManage(account)) return forbidden();
      if (isBuiltinOriginal(t)) return conflict('builtin');
      const b = body as CreateTypeFieldBody;
      const bad = fieldBodyError(b, account);
      if (bad) return bad;
      const created = newField(t.id, b, t.fields.length + 1);
      try {
        resolved(t, {}, [created]);
        for (const d of descendantsOf(t.id))
          if (d.fields.some((f) => f.key === b.key)) throw new Redefined(b.key);
      } catch (e) {
        if (e instanceof Redefined) return conflict('field_redefined', { key: e.key });
        throw e;
      }
      t.fields.push(created);
      t.rowVersion += 1;
      refresh(t);
      return reply(201, created);
    }),
    route('PATCH', p.typeField(':id'), ({ params, body, headers }) => {
      const found = fieldById(params.id);
      if (!found) return notFound();
      if (!canManage(found.account)) return forbidden();
      const f = found.field;
      const b = body as UpdateTypeFieldBody;
      if (headers['if-match'] !== undefined) {
        const stale = versionError(headers, { rowVersion: f.rowVersion ?? 1 }, Object.keys(b));
        if (stale) return reply(stale.status, stale.body);
      }
      if (b.label !== undefined) f.label = b.label;
      if (b.unit !== undefined) f.unit = b.unit;
      if (b.options !== undefined) f.options = b.options;
      if (b.required !== undefined) f.required = b.required;
      if (b.sort !== undefined) f.sort = b.sort;
      f.rowVersion = (f.rowVersion ?? 1) + 1;
      if (found.type) refresh(found.type);
      return f;
    }),
    ...(['archive', 'restore'] as const).map((op) =>
      route(
        'POST',
        op === 'archive' ? p.typeFieldArchive(':id') : p.typeFieldRestore(':id'),
        ({ params }) => {
          const found = fieldById(params.id);
          if (!found) return notFound();
          if (!canManage(found.account)) return forbidden();
          found.field.archivedAt = op === 'archive' ? now() : null;
          if (found.type) refresh(found.type);
          return reply(204);
        },
      ),
    ),
    route('POST', p.typeCustomise(':id'), ({ params, body }) => {
      const t = typeById(params.id);
      if (!t) return notFound();
      const { accountId } = (body ?? {}) as { accountId?: string };
      if (!visibleAccount(accountId)) return notFound();
      if (!canManage(accountId)) return forbidden();
      if (!isBuiltinOriginal(t) || t.isFieldGroup)
        return err(409, 'conflict', 'Only a built-in type is customised.');
      const existing = types().find((x) => x.copiedFromId === t.id && ownerOf(x) === accountId);
      if (existing) return { typeId: existing.id };
      // Q13b: the built-in subtree is copied, so the account's descendants inherit its edits.
      const map = new Map<string, string>();
      const subtree = [t, ...descendantsOf(t.id).filter(isBuiltinOriginal)];
      for (const src of subtree) map.set(src.id, newId());
      const locs = new Set(
        Object.entries(inv().accountOf)
          .filter(([, a]) => a === accountId)
          .map(([l]) => l),
      );
      for (const src of subtree) {
        const id = map.get(src.id) as string;
        const copy: StoredType = {
          ...structuredClone(strip(src)),
          id,
          parentId: map.get(src.parentId ?? '') ?? src.parentId,
          copiedFromId: src.id,
          inUse: 0,
          rowVersion: 1,
          ownerAccountId: accountId ?? null,
        };
        copy.fields = own(src).map((f) => ({
          ...f,
          id: newId(),
          source: { typeId: id, via: 'own' as const },
        }));
        types().push(copy);
        // The account's things move onto the copy (kept.customise_type repoints them).
        for (const th of inv().things)
          if (th.type?.id === src.id && locs.has(th.locationId)) {
            th.type = { ...th.type, id };
            copy.inUse += 1;
          }
      }
      for (const src of subtree) {
        const copy = typeById(map.get(src.id));
        if (copy) Object.assign(copy, resolved(copy));
      }
      return { typeId: map.get(t.id) };
    }),
    route('POST', p.typeMergeInto(':id'), ({ params, body }) => {
      const t = typeById(params.id);
      const target = typeById((body as { targetId?: string } | undefined)?.targetId);
      if (!t || !target) return notFound();
      if (!canManage(typeAccount(t))) return forbidden();
      if (isBuiltinOriginal(t)) return conflict('builtin');
      if (t.id === target.id || descendantsOf(t.id).some((d) => d.id === target.id))
        return conflict('cycle');
      let repointed = 0;
      for (const th of inv().things)
        if (th.type?.id === t.id) {
          th.type = {
            id: target.id,
            icon: target.icon,
            name: target.name,
            builtinKey: target.builtinKey,
          };
          repointed += 1;
        }
      for (const c of types().filter((x) => x.parentId === t.id)) c.parentId = target.id;
      target.inUse += repointed;
      inv().types = types().filter((x) => x.id !== t.id);
      refresh(target);
      return { repointed };
    }),
    route('DELETE', p.type(':id'), ({ params }) => {
      const t = typeById(params.id);
      if (!t) return notFound();
      if (!canManage(typeAccount(t))) return forbidden();
      if (isBuiltinOriginal(t)) return conflict('builtin');
      const used = inv().things.some((x) => x.type?.id === t.id && !x.deletedAt);
      if (used || t.inUse > 0 || types().some((x) => x.parentId === t.id))
        return err(409, 'in_use', 'This type is in use.', 'Move its things and child types first.');
      inv().types = types().filter((x) => x.id !== t.id);
      return reply(204);
    }),

    // ----- place kinds (D160) -----
    route('GET', p.accountPlaceKinds(':accountId'), ({ params }) => {
      const kinds = inv().placeKinds[params.accountId ?? ''];
      return kinds ? { placeKinds: kinds } : notFound();
    }),
    route('POST', p.accountPlaceKinds(':accountId'), ({ params, body }) => {
      const kinds = inv().placeKinds[params.accountId ?? ''];
      if (!kinds) return notFound();
      if (!canManage(params.accountId)) return forbidden();
      const b = body as CreatePlaceKindBody;
      if (!b.name?.trim()) return err(400, 'validation', 'A kind needs a name.');
      if (!KEY.test(b.key ?? '')) return err(400, 'validation', 'That key is not valid.');
      const same = kinds.find((k) => k.key === b.key);
      if (same)
        return err(409, 'conflict', 'That kind already exists.', undefined, {
          existingId: same.id,
        });
      const created: PlaceKindNode = {
        id: b.id ?? newId(),
        key: b.key,
        builtinKey: null,
        ownerAccountId: params.accountId ?? null,
        name: b.name.trim(),
        icon: b.icon,
        fields: [],
        rowVersion: 1,
      };
      kinds.push(created);
      return reply(201, created);
    }),
    // Idempotent: the account's copy of a built-in kind, standing in for it (T28 decision 7).
    route('POST', p.placeKindCustomise(':accountId', ':builtinKey'), ({ params }) => {
      const kinds = inv().placeKinds[params.accountId ?? ''];
      if (!kinds) return notFound();
      if (!canManage(params.accountId)) return forbidden();
      const at = kinds.findIndex((k) => k.builtinKey === params.builtinKey);
      const found = kinds[at];
      if (!found) return notFound();
      if (!isKindOriginal(found)) return { placeKindId: found.id };
      const copy: PlaceKindNode = {
        ...structuredClone(found),
        id: newId(),
        ownerAccountId: params.accountId ?? null,
        rowVersion: 1,
      };
      copy.fields = copy.fields.map((f) => ({
        ...f,
        id: newId(),
        source: { ...f.source, typeId: copy.id },
      }));
      kinds.splice(at, 1, copy);
      return { placeKindId: copy.id };
    }),
    route('PATCH', p.placeKind(':id'), ({ params, body, headers }) => {
      const kind = allKinds().find((k) => k.id === params.id);
      if (!kind) return notFound();
      if (!canManage(kindAccount(kind))) return forbidden();
      if (isKindOriginal(kind)) return conflict('builtin');
      const b = body as UpdatePlaceKindBody;
      const stale = versionError(headers, kind, Object.keys(b));
      if (stale) return reply(stale.status, stale.body);
      if (b.name !== undefined) kind.name = b.name.trim();
      if (b.icon !== undefined) kind.icon = b.icon;
      kind.rowVersion += 1;
      return kind;
    }),
    route('POST', p.placeKindFields(':id'), ({ params, body }) => {
      const kind = allKinds().find((k) => k.id === params.id);
      if (!kind) return notFound();
      const account = kindAccount(kind);
      if (!canManage(account)) return forbidden();
      if (isKindOriginal(kind)) return conflict('builtin');
      const b = body as CreateTypeFieldBody;
      const bad = fieldBodyError(b, account);
      if (bad) return bad;
      if (kind.fields.some((f) => f.key === b.key))
        return conflict('field_redefined', { key: b.key });
      const created = newField(kind.id, b, kind.fields.length + 1);
      kind.fields.push(created);
      kind.rowVersion += 1;
      return reply(201, created);
    }),

    // ----- brands, vendors, people, tags -----
    ...KINDS.flatMap((kind) => {
      const all = () => inv()[kind] as RegistryItem[typeof kind][];
      const find = (id: string | undefined) => all().find((x) => x.id === id);
      const setAll = (rows: { id: string }[]) => {
        (inv() as unknown as Record<string, { id: string }[]>)[kind] = rows;
      };
      /** Things that point at an item: what "in use" means for a delete, and what a merge moves. */
      const users = (id: string) =>
        inv().things.filter((t) =>
          kind === 'brands'
            ? t.brand?.id === id
            : kind === 'people'
              ? t.belongsTo?.id === id
              : kind === 'tags'
                ? t.tags.some((g) => g.id === id)
                : t.purchase?.vendor?.id === id,
        );
      return [
        route('GET', p.accountRegistry(':accountId', kind), ({ params, query }) => {
          if (!visibleAccount(params.accountId)) return notFound();
          const q = query.get('q') ?? '';
          const items = all()
            .filter((x) => x.ownerAccountId === params.accountId || x.ownerAccountId === null)
            .filter((x) => !q || matches(nameOf(x), q))
            .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
          return paginate(items, query);
        }),
        route('GET', p.registryItem(kind, ':id'), ({ params }) => {
          const item = find(params.id);
          if (!item || (item.ownerAccountId !== null && !visibleAccount(item.ownerAccountId)))
            return notFound();
          return item;
        }),
        route('POST', p.accountRegistry(':accountId', kind), ({ params, body }) => {
          const accountId = params.accountId ?? '';
          const role = accountRole(accountId);
          if (!role) return notFound();
          const allowed =
            kind === 'brands' ? role === 'owner' || role === 'admin' : role !== 'viewer';
          if (!allowed) return forbidden();
          const b = body as { id?: string; name?: string; displayName?: string };
          const name = (b.displayName ?? b.name ?? '').trim();
          if (!name) return err(400, 'validation', 'A name is needed.');
          const mine = all().filter(
            (x) => x.ownerAccountId === accountId || x.ownerAccountId === null,
          );
          const exact = mine.find((x) => fold(nameOf(x)) === fold(name));
          if (exact && (kind === 'brands' || kind === 'tags'))
            return err(409, 'conflict', 'That conflicts with the current state.', undefined, {
              existingId: exact.id,
            });
          const base = { id: b.id ?? newId(), ownerAccountId: accountId, rowVersion: 1 };
          const blank =
            kind === 'people'
              ? { ...base, displayName: name, userId: null }
              : kind === 'vendors'
                ? { ...base, name, kind: 'store', address: null, phone: null, website: null }
                : kind === 'brands'
                  ? {
                      ...base,
                      name,
                      website: null,
                      supportPhone: null,
                      claimUrl: null,
                      defaultWarrantyMonths: null,
                    }
                  : { ...base, name, colour: null };
          const item = {
            ...blank,
            ...(b as object),
            id: base.id,
            ...(kind === 'people' ? { displayName: name } : { name }),
          } as RegistryItem[typeof kind];
          const possibleDuplicates = mine
            .map((x) => ({ id: x.id, name: nameOf(x), similarity: similarity(nameOf(x), name) }))
            .filter((x) => x.similarity > 0.5)
            .sort((a, b) => b.similarity - a.similarity);
          (all() as unknown[]).push(item);
          return reply(201, { item, possibleDuplicates });
        }),
        route('PATCH', p.registryItem(kind, ':id'), ({ params, body, headers }) => {
          const item = find(params.id);
          if (!item) return notFound();
          if (item.ownerAccountId === null) return conflict('builtin');
          if (!canManage(item.ownerAccountId)) return forbidden();
          const b = body as Record<string, unknown>;
          const stale = versionError(headers, item, Object.keys(b));
          if (stale) return reply(stale.status, stale.body);
          const nextName = (b.displayName ?? b.name) as string | undefined;
          if (nextName !== undefined) {
            const clash = all().find(
              (x) =>
                x.id !== item.id &&
                (x.ownerAccountId === item.ownerAccountId || x.ownerAccountId === null) &&
                fold(nameOf(x)) === fold(nextName),
            );
            if (clash && (kind === 'brands' || kind === 'tags'))
              return err(409, 'conflict', 'That name is taken.', undefined, {
                existingId: clash.id,
              });
          }
          Object.assign(item, b);
          item.rowVersion += 1;
          // Things carry the name in their refs.
          for (const t of users(item.id)) {
            if (kind === 'brands' && t.brand) t.brand = { id: item.id, name: nameOf(item) };
            if (kind === 'people' && t.belongsTo)
              t.belongsTo = { id: item.id, displayName: nameOf(item) };
          }
          return item;
        }),
        route('POST', p.registryMergeInto(kind, ':id'), ({ params, body }) => {
          const item = find(params.id);
          const target = find((body as { targetId?: string } | undefined)?.targetId);
          if (!item || !target) return notFound();
          if (item.id === target.id)
            return err(400, 'validation', 'Pick a different one to merge into.');
          if (item.ownerAccountId === null) return conflict('builtin');
          if (!canManage(item.ownerAccountId)) return forbidden();
          const moved = users(item.id);
          for (const t of moved) {
            if (kind === 'brands') t.brand = { id: target.id, name: nameOf(target) };
            if (kind === 'people') t.belongsTo = { id: target.id, displayName: nameOf(target) };
            if (kind === 'tags')
              t.tags = [
                ...t.tags.filter((g) => g.id !== item.id && g.id !== target.id),
                {
                  id: target.id,
                  name: nameOf(target),
                  colour: (target as { colour?: string | null }).colour ?? null,
                },
              ];
            if (kind === 'vendors' && t.purchase)
              t.purchase.vendor = { id: target.id, name: nameOf(target) };
          }
          setAll(all().filter((x) => x.id !== item.id));
          return { repointed: moved.length };
        }),
        route('DELETE', p.registryItem(kind, ':id'), ({ params }) => {
          const item = find(params.id);
          if (!item) return notFound();
          if (item.ownerAccountId === null) return conflict('builtin');
          if (!canManage(item.ownerAccountId)) return forbidden();
          if (users(item.id).some((t) => !t.deletedAt))
            return err(409, 'in_use', 'This is still used.', 'Merge it into another instead.');
          setAll(all().filter((x) => x.id !== params.id));
          return reply(204);
        }),
      ];
    }),

    // ----- a person's contact details (D177: 404 unless you may see them) -----
    route('GET', p.personContact(':id'), ({ params }) => {
      const person = inv().people.find((x) => x.id === params.id);
      if (!person || !canManage(person.ownerAccountId)) return notFound();
      // No details yet is 200 with every field null, not 404 (T11).
      return contacts.get(person.id) ?? { phone: null, email: null, notes: null };
    }),
    route('PUT', p.personContact(':id'), ({ params, body }) => {
      const person = inv().people.find((x) => x.id === params.id);
      if (!person || !canManage(person.ownerAccountId)) return notFound();
      const b = body as PersonContact;
      const next = { phone: b.phone ?? null, email: b.email ?? null, notes: b.notes ?? null };
      contacts.set(person.id, next);
      return next;
    }),

    // ----- secret-field policies (owner only, D177) -----
    route('GET', p.secretPolicy(':locationId', ':fieldId'), ({ params }) => {
      if (roleIn(state.locations, params.locationId ?? '') !== 'owner') return notFound();
      return (
        policies.get(`${params.locationId}:${params.fieldId}`) ?? {
          revealRoles: ['owner', 'admin'],
          revealUserIds: [],
          aiAllowed: false,
        }
      );
    }),
    route('PUT', p.secretPolicy(':locationId', ':fieldId'), ({ params, body }) => {
      if (roleIn(state.locations, params.locationId ?? '') !== 'owner') return forbidden();
      const b = body as SecretPolicy;
      const next: SecretPolicy = {
        revealRoles: [...new Set([...b.revealRoles, 'owner' as const])],
        revealUserIds: b.revealUserIds ?? [],
        aiAllowed: b.aiAllowed,
      };
      policies.set(`${params.locationId}:${params.fieldId}`, next);
      return next;
    }),

    // ----- currencies (task 12, D168) -----
    route('GET', p.currencies, ({ query }) => {
      const all = query.get('all') === '1' && state.me.user.instanceAdmin;
      const used = new Set(state.locations.map((l) => l.currency));
      return {
        currencies: inv()
          .currencies.filter((c) => all || c.enabled)
          .map((c) => (all ? { ...c, inUse: used.has(c.code) } : c)),
      };
    }),
    route('PATCH', p.adminCurrency(':code'), ({ params, body }) => {
      if (!state.me.user.instanceAdmin) return forbidden();
      const c = inv().currencies.find((x) => x.code === params.code);
      if (!c) return notFound();
      const b = body as UpdateCurrencyBody;
      const isDefault = DEFAULT_CURRENCIES.includes(c.code);
      const inUse = state.locations.some((l) => l.currency === c.code);
      if (!b.enabled && (isDefault || inUse))
        return err(
          409,
          'conflict',
          'That conflicts with the current state.',
          isDefault
            ? 'USD, CAD, GBP, EUR and EGP always stay on.'
            : 'A location uses this currency, so it stays on.',
          { reason: isDefault ? 'default' : 'in_use' },
        );
      c.enabled = b.enabled;
      return c;
    }),
  ];
}
