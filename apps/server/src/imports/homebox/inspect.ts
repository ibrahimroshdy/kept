import { HB_FIELD_KIND, type HomeboxFieldKind } from '@kept/shared';
import type { HomeboxInspect, HomeboxMappingHints } from '../archive-types.js';
import { type HomeboxData, isLocation, seededUnused } from './read.js';

// What POST /imports/:id/inspect answers for a Homebox export (plan T8, T19): the collection's id
// (the manifest's groupId), when it was exported, its counts, and the mapping hints the choices
// step needs: the entity types things use (with how many), the custom fields by name (with their
// kind and how many items carry them), how many items are insured, and the seeded places and
// tags that are empty and unused. Names and counts only, never a value. The ZIP holds no
// collection name, currency, members or Homebox version (H1): those come from the optional
// connection (T11), or stay unknown.

export function inspectHomebox(data: HomeboxData, sourceVersion: string | null): HomeboxInspect {
  const entities = [...data.entities.values()];
  const items = entities.filter((e) => !isLocation(data, e));

  const typeItems = new Map<string, number>();
  for (const e of items) {
    typeItems.set(e.entity_type_entities, (typeItems.get(e.entity_type_entities) ?? 0) + 1);
  }
  const types = [...data.types.values()]
    .filter((t) => !t.is_location)
    .map((t) => ({ id: t.id, name: t.name, items: typeItems.get(t.id) ?? 0 }));

  // A field name with more than one kind is offered once, as its most common kind.
  const byName = new Map<string, { kinds: Map<HomeboxFieldKind, number>; entities: Set<string> }>();
  for (const f of data.fields) {
    if (!data.entities.has(f.entity_fields)) continue;
    const name = f.name.trim();
    if (!name) continue;
    const seen = byName.get(name) ?? { kinds: new Map(), entities: new Set<string>() };
    seen.kinds.set(f.type, (seen.kinds.get(f.type) ?? 0) + 1);
    seen.entities.add(f.entity_fields);
    byName.set(name, seen);
  }
  const fields = [...byName].map(([name, seen]) => {
    const kind = [...seen.kinds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'text';
    return { name, kind, items: seen.entities.size };
  });

  const seeded = seededUnused(data);
  const mapping: HomeboxMappingHints = {
    types,
    fields: fields.filter((f) => f.kind in HB_FIELD_KIND),
    insuredItems: items.filter((e) => e.insured).length,
    seededUnused: {
      places: [...seeded.places].map((id) => data.entities.get(id)?.name ?? '').filter(Boolean),
      tags: [...seeded.tags].map((id) => data.tags.get(id)?.name ?? '').filter(Boolean),
    },
  };

  return {
    source: 'homebox_zip',
    sourceVersion,
    collections: [
      {
        id: data.manifest.groupId,
        counts: {
          entities: entities.length,
          locations: entities.length - items.length,
          attachments: data.attachments.filter((a) => a.type !== 'thumbnail').length,
          maintenance: data.maintenance.length,
          tags: data.tags.size,
          types: data.types.size,
        },
        exportedAt: new Date(data.manifest.exportedAt).toISOString(),
        mapping,
      },
    ],
  };
}
