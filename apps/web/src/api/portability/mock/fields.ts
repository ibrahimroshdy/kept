/**
 * Mock handlers for field conversion (T18; D172, D177; Q20): to or from secret, or to another
 * kind, always through a preview of counts per location, never a value. The account owner only
 * (403 for anyone else who sees the type). A conversion moves every value it can and sends the
 * rest to the thing's notes; it isn't undoable.
 *
 * Values come from the things holding the field in `custom`, plus the seeded values of the AA
 * batteries' Size field (./state.ts), which sit in Home and Garage.
 */
import {
  type ConvertFieldBody,
  canConvertKind,
  canConvertSecret,
  type FieldKind,
} from '@kept/shared';
import { versionError } from '../../inventory/mock/db';
import type { ResolvedField, TypeDetail } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { portabilityPaths as p } from '../paths';
import type { ConvertPreview, ConvertResult } from '../types';
import { pt } from './state';

const FITS: Partial<Record<FieldKind, RegExp>> = {
  number: /^-?\d+(?:\.\d+)?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  url: /^https?:\/\/\S+$/,
};

export function fieldRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const findField = (id: string): { type: TypeDetail; field: ResolvedField } | undefined => {
    for (const type of inv().types) {
      const field = type.fields.find((f) => f.id === id);
      if (field) return { type, field };
    }
    return undefined;
  };
  /** Owner of the account the type lives in: owner of one of its locations. */
  const ownsAccount = () =>
    state.locations.some(
      (l) => l.role === 'owner' && l.kind !== 'personal' && inv().accountOf[l.id] !== undefined,
    );
  const valuesByLocation = (field: ResolvedField): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    const seeded = pt(state).fieldValues[field.id] ?? {};
    for (const [loc, values] of Object.entries(seeded)) out.set(loc, [...values]);
    for (const t of inv().things) {
      if (t.deletedAt || t.type?.id !== field.source.typeId) continue;
      const v = t.custom[field.key];
      if (v === undefined || v === null || v === '') continue;
      out.set(t.locationId, [...(out.get(t.locationId) ?? []), String(v)]);
    }
    return out;
  };
  /** 400 for a conversion the field can't take; null when it can. */
  const refused = (field: ResolvedField, b: ConvertFieldBody) => {
    if ('toSecret' in b) {
      if (!canConvertSecret(field.kind) || b.toSecret === field.secret)
        return err(
          400,
          'field_convert_blocked',
          "A field of this kind can't be converted to that one.",
        );
      return null;
    }
    if (!canConvertKind(field.kind, b.kind))
      return err(
        400,
        'field_convert_blocked',
        "A field of this kind can't be converted to that one.",
      );
    return null;
  };
  const preview = (field: ResolvedField, b: ConvertFieldBody): ConvertPreview => {
    const fits = 'toSecret' in b || b.kind === 'text' ? null : FITS[b.kind];
    const options = 'kind' in b ? b.options : undefined;
    const locations: ConvertPreview['locations'] = [];
    for (const [id, values] of valuesByLocation(field)) {
      const convertible = values.filter((v) =>
        options ? options.includes(v) : fits ? fits.test(v.trim()) : true,
      ).length;
      locations.push({
        id,
        name: state.locations.find((l) => l.id === id)?.name ?? null,
        values: values.length,
        convertible,
        toNotes: values.length - convertible,
      });
    }
    return { locations, total: locations.reduce((n, l) => n + l.values, 0) };
  };
  const gate = (id: string | undefined) => {
    const hit = findField(id ?? '');
    if (!hit) return { error: notFound() };
    if (!ownsAccount()) return { error: forbidden() };
    return { hit };
  };

  return [
    route('POST', p.typeFieldConvertPreview(':id'), ({ params, body }) => {
      const g = gate(params.id);
      if (g.error) return g.error;
      const b = body as ConvertFieldBody;
      return refused(g.hit.field, b) ?? preview(g.hit.field, b);
    }),

    route('POST', p.typeFieldConvert(':id'), ({ params, body, headers }) => {
      const g = gate(params.id);
      if (g.error) return g.error;
      const { field } = g.hit;
      const b = body as ConvertFieldBody;
      const no = refused(field, b);
      if (no) return no;
      const stale = versionError(headers, field);
      if (stale) return reply(stale.status, stale.body);
      if ('toSecret' in b && b.toSecret && state.me.instance.recoveryKitAcknowledged === false)
        return err(409, 'recovery_kit_required', 'Save the recovery kit first.');
      const shown = preview(field, b);
      const mutable = field as { -readonly [K in keyof ResolvedField]: ResolvedField[K] };
      if ('toSecret' in b) mutable.secret = b.toSecret;
      else {
        mutable.kind = b.kind;
        if (b.options) mutable.options = b.options;
        if (b.unit !== undefined) mutable.unit = b.unit;
      }
      mutable.rowVersion += 1;
      const result: ConvertResult = {
        converted: shown.locations.reduce((n, l) => n + l.convertible, 0),
        toNotes: shown.locations.reduce((n, l) => n + l.toNotes, 0),
      };
      return result;
    }),
  ];
}
