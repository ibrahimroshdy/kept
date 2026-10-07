/**
 * Mock handlers for templates and quick add (T19): account-level templates shared into chosen
 * locations; members there can use them; editing needs admin of every location they're shared
 * with (Q17); payloads never carry money or secrets (D177).
 */
import { accessOf, liveThing, newId } from '../../inventory/mock/db';
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
import { capturePaths as p } from '../paths';
import {
  type AccountTemplate,
  type CreateTemplateBody,
  type SaveAsTemplateBody,
  TEMPLATE_NAME_MAX,
  type TemplatePayload,
  type UpdateTemplateBody,
} from '../types';

/** Keys a template payload may hold (`templateSchema`). */
const PAYLOAD_KEYS = new Set<keyof TemplatePayload>([
  'name',
  'brandId',
  'model',
  'colour',
  'quantity',
  'tagIds',
  'aliases',
  'notes',
  'custom',
]);

export function templatesRoutes(state: MockState): MockRoute[] {
  const cap = () => state.capture;
  const access = () => accessOf(state);
  const nameOf = (id: string) => state.locations.find((l) => l.id === id)?.name ?? '';
  const public_ = ({
    accountId: _a,
    locations: _l,
    rowVersion: _r,
    ...t
  }: AccountTemplate & { accountId: string }) => t;
  const editable = (t: AccountTemplate) => t.locations.every((l) => access().isAdmin(l.id));
  const badPayload = (payload: TemplatePayload) =>
    Object.keys(payload).some((k) => !PAYLOAD_KEYS.has(k as keyof TemplatePayload));
  /** The server's `Text(80)`: trimmed, 1–80 characters (and the DB's `templates_name_chk`). */
  const badName = (name: string) => {
    const n = name.trim();
    return n.length === 0 || n.length > TEMPLATE_NAME_MAX
      ? err(400, 'validation', 'Check name: 1 to 80 characters.')
      : null;
  };

  return [
    route('GET', p.templates, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      if (!locationId || !access().canWrite(locationId)) return { items: [] };
      return {
        items: cap()
          .templates.filter((t) => t.locations.some((l) => l.id === locationId))
          .map(public_),
      };
    }),

    route('GET', p.accountTemplates(':accountId'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      return {
        items: cap()
          .templates.filter((t) => t.accountId === params.accountId && editable(t))
          .map(({ accountId: _a, ...t }) => t),
      };
    }),

    route('POST', p.accountTemplates(':accountId'), ({ params, body }) => {
      const b = body as CreateTemplateBody;
      const named = badName(b.name);
      if (named) return named;
      if (b.locationIds.length === 0) return err(400, 'validation', 'Share it with a location.');
      if (!b.locationIds.every((id) => access().isAdmin(id))) return forbidden();
      if (badPayload(b.payload))
        return err(400, 'validation', 'Templates never hold prices or secrets.');
      const created = {
        id: b.id ?? newId(),
        accountId: params.accountId ?? '',
        name: b.name,
        typeId: b.typeId ?? null,
        typeIcon: null,
        payload: b.payload,
        locations: b.locationIds.map((id) => ({ id, name: nameOf(id) })),
        rowVersion: 1,
      };
      cap().templates.push(created);
      return reply(201, created);
    }),

    route('PATCH', p.template(':id'), ({ params, body }) => {
      const t = cap().templates.find((x) => x.id === params.id);
      if (!t) return notFound();
      if (!editable(t)) return forbidden();
      const b = body as UpdateTemplateBody;
      const named = b.name === undefined ? null : badName(b.name);
      if (named) return named;
      if (b.payload && badPayload(b.payload))
        return err(400, 'validation', 'Templates never hold prices or secrets.');
      if (b.name !== undefined) t.name = b.name;
      if (b.payload) t.payload = b.payload;
      if (b.locationIds) t.locations = b.locationIds.map((id) => ({ id, name: nameOf(id) }));
      t.rowVersion += 1;
      return t;
    }),

    route('DELETE', p.template(':id'), ({ params }) => {
      const t = cap().templates.find((x) => x.id === params.id);
      if (!t) return notFound();
      if (!editable(t)) return forbidden();
      cap().templates = cap().templates.filter((x) => x.id !== t.id);
      return reply(204);
    }),

    route('POST', p.thingSaveAsTemplate(':id'), ({ params, body }) => {
      const thing = liveThing(state.inventory, params.id ?? null);
      if (!thing || !access().visible(thing.locationId)) return notFound();
      const b = body as SaveAsTemplateBody;
      const named = badName(b.name);
      if (named) return named;
      const created = {
        id: newId(),
        accountId: state.inventory.accountOf[thing.locationId] ?? '',
        name: b.name,
        typeId: thing.type?.id ?? null,
        typeIcon: thing.type?.icon ?? null,
        payload: {
          ...(thing.model ? { model: thing.model } : {}),
          ...(thing.colour ? { colour: thing.colour } : {}),
          ...(thing.notes ? { notes: thing.notes } : {}),
        },
        locations: b.locationIds.map((id) => ({ id, name: nameOf(id) })),
        rowVersion: 1,
      };
      cap().templates.push(created);
      return reply(201, created);
    }),
  ];
}
