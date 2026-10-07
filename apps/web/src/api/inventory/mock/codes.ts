/**
 * Mock handlers for own codes (D208, plan T17a; the server is apps/server/src/codes/). Codes live
 * in the capture state's `legacyCodes` (source `own`), so the mock scan resolves them like any
 * legacy code; a location's numbering and format rule, and its counters, in a table of their own
 * per mock state. Writes record undoable `thing.codes` / `place.codes` events, as the server does.
 *
 * The format rule here is a plain RegExp with a rough stand-in for the server's timed check: a
 * quantified group that is itself quantified (`(a+)+`) is refused as too slow.
 */
import { storedCodeOf } from '@kept/shared';
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
import {
  type CodeMismatch,
  type CodeTargetKind,
  codePaths as cp,
  type FormatRule,
  type OwnCodeSettings,
  type OwnCodeSettingsBody,
} from '../codes';
import { accessOf, recordEvent } from './db';

type Options = {
  numbering: boolean;
  prefix: string;
  pad: number;
  rule: FormatRule | null;
  rowVersion: number;
};

type CodeTables = { options: Map<string, Options>; counters: Map<string, number> };

const TABLES = new WeakMap<MockState, CodeTables>();

function tablesOf(state: MockState): CodeTables {
  let t = TABLES.get(state);
  if (!t) {
    t = { options: new Map(), counters: new Map() };
    TABLES.set(state, t);
  }
  return t;
}

/** As the server stores a code (@kept/shared storedCodeOf). */
export const storedCode = storedCodeOf;

const numbered = (prefix: string, pad: number, n: number) =>
  `${prefix}${String(n).padStart(pad, '0')}`;

function compile(pattern: string): RegExp | 'invalid' | 'slow' {
  try {
    new RegExp(pattern, 'iu');
  } catch {
    return 'invalid';
  }
  if (/\([^()]*[+*][^()]*\)[+*{]/.test(pattern)) return 'slow';
  return new RegExp(`^(?:${pattern})$`, 'iu');
}

const matches = (rule: FormatRule, code: string) => {
  const re = compile(rule.pattern);
  return re instanceof RegExp && re.test(code);
};

export function codesRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const cap = () => state.capture;
  const access = () => accessOf(state);
  const tables = () => tablesOf(state);

  const optionsOf = (locationId: string): Options =>
    tables().options.get(locationId) ?? {
      numbering: false,
      prefix: '',
      pad: 4,
      rule: null,
      rowVersion: 0,
    };

  const view = (locationId: string): OwnCodeSettings => {
    const o = optionsOf(locationId);
    const last = tables().counters.get(`${locationId}:${o.prefix}`) ?? 0;
    return {
      locationId,
      numbering: {
        enabled: o.numbering,
        prefix: o.prefix,
        pad: o.pad,
        next: numbered(o.prefix, o.pad, last + 1),
      },
      rule: o.rule,
      rowVersion: o.rowVersion,
    };
  };

  /** The live thing or place, and its location. */
  const targetOf = (kind: CodeTargetKind, id: string) => {
    if (kind === 'thing') {
      const t = inv().things.find((x) => x.id === id && !x.deletedAt);
      return t ? { locationId: t.locationId, name: t.name ?? '' } : null;
    }
    const p = inv().places.find((x) => x.id === id && !x.deletedAt);
    return p ? { locationId: p.locationId, name: p.name } : null;
  };

  const ownOf = (kind: CodeTargetKind, id: string) =>
    cap()
      .legacyCodes.filter((c) => c.source === 'own' && c.target.kind === kind && c.target.id === id)
      .map((c) => c.code)
      .sort();

  const takenIn = (locationId: string, code: string) =>
    cap().legacyCodes.find((c) => c.locationId === locationId && c.code === code);

  const record = (
    kind: CodeTargetKind,
    id: string,
    target: { locationId: string; name: string },
    before: string[],
  ) => {
    const after = ownOf(kind, id);
    recordEvent(inv(), state.me.user, {
      action: `${kind}.codes`,
      entity: { type: kind, id },
      locationId: target.locationId,
      name: target.name,
      diff: { own_codes: { before, after, class: 'plain' } },
      undo: () => {
        cap().legacyCodes = cap().legacyCodes.filter(
          (c) => !(c.source === 'own' && c.target.kind === kind && c.target.id === id),
        );
        for (const code of before)
          cap().legacyCodes.push({
            locationId: target.locationId,
            source: 'own',
            code,
            target: { kind, id },
          });
      },
    });
  };

  const nextCode = (locationId: string): string | null => {
    const o = optionsOf(locationId);
    if (!o.numbering) return null;
    const key = `${locationId}:${o.prefix}`;
    for (;;) {
      const n = (tables().counters.get(key) ?? 0) + 1;
      tables().counters.set(key, n);
      const code = numbered(o.prefix, o.pad, n);
      if (!takenIn(locationId, code)) return code;
    }
  };

  /** 400 or 409 for `code` in `locationId`, or null when it may be added. */
  const refusal = (locationId: string, code: string) => {
    if (!code || code.length > 100) return err(400, 'validation', 'Check body.code.');
    const rule = optionsOf(locationId).rule;
    if (rule && !matches(rule, code))
      return err(400, 'validation', 'Invalid.', rule.message, {
        rule: { message: rule.message, example: rule.example },
        reason: 'mismatch',
      });
    const taken = takenIn(locationId, code);
    if (taken)
      return err(409, 'conflict', 'Conflict.', `${code} is already on something else here.`, {
        taken: taken.target,
      });
    return null;
  };

  const routesFor = (kind: CodeTargetKind): MockRoute[] => [
    route('GET', cp.codes(kind, ':id'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const id = params.id ?? '';
      const target = targetOf(kind, id);
      if (!target || !access().visible(target.locationId)) return notFound();
      const codes = cap()
        .legacyCodes.filter((c) => c.target.kind === kind && c.target.id === id)
        .sort((a, b) =>
          a.source === b.source
            ? a.code.localeCompare(b.code)
            : a.source === 'own'
              ? -1
              : b.source === 'own'
                ? 1
                : a.source.localeCompare(b.source),
        )
        .map((c) => ({ code: c.code, source: c.source, sourceCollection: '' }));
      return { codes };
    }),

    route('POST', cp.codes(kind, ':id'), ({ params, body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const id = params.id ?? '';
      const target = targetOf(kind, id);
      if (!target || !access().visible(target.locationId)) return notFound();
      if (!access().canWrite(target.locationId)) return forbidden();
      const b = body as { code?: string; next?: true };
      let code: string;
      if (b.next) {
        const next = nextCode(target.locationId);
        if (!next)
          return err(409, 'conflict', 'Conflict.', "This location doesn't number its codes.");
        code = next;
      } else {
        code = storedCode(b.code ?? '');
        const refused = refusal(target.locationId, code);
        if (refused) return refused;
      }
      const before = ownOf(kind, id);
      cap().legacyCodes.push({
        locationId: target.locationId,
        source: 'own',
        code,
        target: { kind, id },
      });
      record(kind, id, target, before);
      return reply(201, { code });
    }),

    route('PUT', cp.code(kind, ':id', ':code'), ({ params, body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const id = params.id ?? '';
      const target = targetOf(kind, id);
      if (!target || !access().visible(target.locationId)) return notFound();
      if (!access().canWrite(target.locationId)) return forbidden();
      const old = storedCode(params.code ?? '');
      const row = cap().legacyCodes.find(
        (c) => c.source === 'own' && c.target.id === id && c.code === old,
      );
      if (!row) return notFound();
      const code = storedCode((body as { code?: string }).code ?? '');
      if (code === old) return { code };
      const refused = refusal(target.locationId, code);
      if (refused) return refused;
      const before = ownOf(kind, id);
      row.code = code;
      record(kind, id, target, before);
      return { code };
    }),

    route('DELETE', cp.code(kind, ':id', ':code'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const id = params.id ?? '';
      const target = targetOf(kind, id);
      if (!target || !access().visible(target.locationId)) return notFound();
      if (!access().canWrite(target.locationId)) return forbidden();
      const code = storedCode(params.code ?? '');
      const before = ownOf(kind, id);
      if (!before.includes(code)) return notFound();
      cap().legacyCodes = cap().legacyCodes.filter(
        (c) => !(c.source === 'own' && c.target.id === id && c.code === code),
      );
      record(kind, id, target, before);
      return reply(204);
    }),
  ];

  return [
    ...routesFor('thing'),
    ...routesFor('place'),

    route('GET', cp.settings(':locationId'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = params.locationId ?? '';
      if (!access().visible(locationId)) return notFound();
      return view(locationId);
    }),

    route('PUT', cp.settings(':locationId'), ({ params, body, headers }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = params.locationId ?? '';
      if (!access().visible(locationId)) return notFound();
      if (!access().isAdmin(locationId)) return forbidden();
      const current = optionsOf(locationId);
      if (Number(headers['if-match']) !== current.rowVersion)
        return err(412, 'precondition_failed', 'Changed.', 'Reload to see the latest version.', {
          conflicts: ['numbering', 'rule'],
          row_version: current.rowVersion,
        });
      const b = body as OwnCodeSettingsBody;
      const prefix = storedCode(b.numbering.prefix);
      if (b.rule) {
        const re = compile(b.rule.pattern);
        if (re === 'invalid')
          return err(
            400,
            'validation',
            'Invalid.',
            "The pattern isn't a regular expression Kept can read.",
            {
              reason: 'invalid',
            },
          );
        if (re === 'slow')
          return err(400, 'validation', 'Invalid.', 'The pattern is too slow to check.', {
            reason: 'slow',
          });
        if (!re.test(storedCode(b.rule.example)))
          return err(400, 'validation', 'Invalid.', "The example doesn't match the pattern.", {
            reason: 'example',
          });
        if (b.numbering.enabled) {
          const last = tables().counters.get(`${locationId}:${prefix}`) ?? 0;
          const next = numbered(prefix, b.numbering.pad, last + 1);
          if (!re.test(next))
            return err(
              400,
              'validation',
              'Invalid.',
              `The numbering's next code, ${next}, doesn't match the format rule.`,
              {
                reason: 'numbering',
                next,
              },
            );
        }
      }
      tables().options.set(locationId, {
        numbering: b.numbering.enabled,
        prefix,
        pad: b.numbering.pad,
        rule: b.rule
          ? {
              pattern: b.rule.pattern,
              message: b.rule.message.trim(),
              example: b.rule.example.trim(),
            }
          : null,
        rowVersion: current.rowVersion + 1,
      });
      return view(locationId);
    }),

    route('GET', cp.mismatches(':locationId'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = params.locationId ?? '';
      if (!access().visible(locationId)) return notFound();
      const rule = optionsOf(locationId).rule;
      if (!rule) return { rule: null, items: [] };
      const items: CodeMismatch[] = [];
      for (const c of cap().legacyCodes) {
        if (c.locationId !== locationId || c.source !== 'own' || matches(rule, c.code)) continue;
        const target = targetOf(c.target.kind, c.target.id);
        if (!target) continue;
        items.push({
          code: c.code,
          kind: c.target.kind,
          id: c.target.id,
          name: target.name,
          reason: 'mismatch',
        });
      }
      items.sort((a, b) => a.code.localeCompare(b.code));
      return { rule, items };
    }),
  ];
}
