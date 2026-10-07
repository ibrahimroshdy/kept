import {
  type Envelope,
  fit,
  isToolName,
  ok,
  TOOL_DEFS,
  type ToolError,
  type ToolName,
  toolError,
} from '@kept/mcp';
import { can, type ModuleId, type Role } from '@kept/shared';
import type pg from 'pg';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import { AppError } from '../http/errors.js';
import { dbProviderResolved, locationModuleSet } from '../http/modules.js';
import { callerMembership } from '../locations/access.js';
import { handlerOf } from './registry.js';
import type {
  Handler,
  Op,
  ReachableLocation,
  ToolContext,
  ToolPrincipal,
  ToolVia,
} from './types.js';

// runTool(): the one way a tool runs, for the assistant (T13) and MCP (T11), step-6 plan T9.
//
// 1. The tool exists and has a handler (a contract whose service isn't built yet has none, Q10),
//    and its input parses against TOOL_DEFS: anything else is `{error, hint}`, never a throw.
// 2. A read principal never runs a write tool (`token_scope`).
// 3. In one withScope() transaction as the principal: the target location is resolved (the
//    argument, else the row the input addresses, else the only reachable one, D179), and
//    checked **on every call** (D113, D180): the principal is a member there, the door's module
//    is on (`ai_assistant` for the assistant, `mcp` for MCP), the tool's own module is on, and
//    their role allows the handler's action. A location that fails any of these is
//    `tool_unavailable`, the same answer for each, so nothing tells an outsider which modules a
//    location has.
// 4. The handler calls the route's own operation (Q1), which re-checks what it always checks.
// 5. The answer is fit() under 8 KB, with `as_of` and a cursor that resumes inside a shortened
//    page.

/** The module a door needs in a location (D191: tools follow the location's modules). */
export const DOOR_MODULE: Readonly<Record<ToolVia, ModuleId>> = {
  assistant: 'ai_assistant',
  mcp: 'mcp',
};

const UNAVAILABLE_HINT = 'Call capabilities to see the tools you can use in each location.';

/** Thrown inside a handler to answer `{error, hint}` as is. */
export class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    readonly hint: string,
  ) {
    super(code);
    this.name = 'ToolRefusal';
  }
}

export const unavailable = () => new ToolRefusal('tool_unavailable', UNAVAILABLE_HINT);

/**
 * The RLS scope a principal runs as. A token principal (MCP, T11) sets `app.token_id` beside
 * `app.user_id` (db/scope.ts): the location functions then intersect the creator's memberships
 * with the token's locations, and a read token writes nowhere (0070), evaluated on every call
 * (D180). Its writes audit as the token (audit/actor.ts).
 */
export function principalScope(principal: ToolPrincipal): Scope {
  return principal.tokenId !== undefined
    ? { userId: principal.userId, mfa: principal.mfa, tokenId: principal.tokenId }
    : { userId: principal.userId, mfa: principal.mfa };
}

/** The tools `principal` may call in a location where they have `role` and `modules` are on. */
export function toolsIn(
  principal: ToolPrincipal,
  via: ToolVia,
  role: Role,
  modules: ReadonlySet<ModuleId>,
): ToolName[] {
  if (!modules.has(DOOR_MODULE[via])) return [];
  const out: ToolName[] = [];
  for (const name of Object.keys(TOOL_DEFS) as ToolName[]) {
    const def = TOOL_DEFS[name];
    const handler = handlerOf(name) as Handler<ToolName> | undefined;
    if (!handler) continue;
    if (def.module && !modules.has(def.module)) continue;
    if (def.scope === 'write' && principal.scope !== 'write') continue;
    if (!can(role, handler.action)) continue;
    out.push(name);
  }
  return out;
}

/** A location the caller reaches, with their role and its effective modules; null when they
 * can't see it. Read in the caller's transaction. */
export async function reachable(
  tx: Tx,
  client: pg.ClientBase,
  locationId: string,
  providerResolved = dbProviderResolved,
): Promise<ReachableLocation | null> {
  const me = await callerMembership(client, locationId);
  if (!me) return null;
  const { rows } = await client.query<{ name: string; timezone: string }>(
    'SELECT name, timezone FROM public.locations WHERE id = $1 AND deleted_at IS NULL',
    [locationId],
  );
  const loc = rows[0];
  if (!loc) return null;
  const modules = await locationModuleSet(tx, locationId, providerResolved);
  if (!modules) return null;
  return { id: locationId, name: loc.name, timeZone: loc.timezone, role: me.role, modules };
}

/** Every location the caller reaches, in name order. */
export async function reachableAll(
  tx: Tx,
  client: pg.ClientBase,
  providerResolved = dbProviderResolved,
): Promise<ReachableLocation[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT l.id FROM public.locations l
      WHERE l.id IN (SELECT v.id FROM kept.visible_location_ids() AS v(id))
        AND l.deleted_at IS NULL
      ORDER BY lower(l.name), l.id`,
  );
  const out: ReachableLocation[] = [];
  for (const { id } of rows) {
    const r = await reachable(tx, client, id, providerResolved);
    if (r) out.push(r);
  }
  return out;
}

/** The tools a principal may call per reachable location (MCP's factory, T11; the assistant's
 * step, T13). `locationIds` narrows to those (a thread's candidates); unknown ones are left
 * out. */
export async function toolsFor(
  ctx: Pick<ToolContext, 'deps' | 'principal' | 'via'>,
  locationIds?: readonly string[],
): Promise<{ location: ReachableLocation; tools: ToolName[] }[]> {
  const scope = principalScope(ctx.principal);
  const resolver = ctx.deps.providerResolved ?? dbProviderResolved;
  return withScope(ctx.deps.pools.app, scope, async (tx, client) => {
    const all = await reachableAll(tx, client, resolver);
    const wanted = locationIds ? new Set(locationIds.map((id) => id.toLowerCase())) : null;
    return all
      .filter((l) => !wanted || wanted.has(l.id))
      .map((location) => ({
        location,
        tools: toolsIn(ctx.principal, ctx.via, location.role, location.modules),
      }));
  });
}

/** The first issue of a failed parse, as the hint (the path, never the value). */
function parseHint(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'Check the input against the tool’s schema.';
  const path = issue.path.map(String).join('.');
  return path ? `Check ${path}: ${issue.message}` : issue.message;
}

function refusalOf(err: unknown): ToolError | null {
  if (err instanceof ToolRefusal) return toolError(err.code, err.hint);
  if (err instanceof AppError) {
    // A module that is off answers the same as an unknown location (D113).
    if (err.code === 'module_off') return toolError('tool_unavailable', UNAVAILABLE_HINT);
    return toolError(err.code, err.hint ?? err.message);
  }
  return null;
}

type LocationInput = { location_id?: string | undefined };

/** Runs one tool call for `ctx.principal` and answers its envelope. Never throws for a refusal;
 * an unexpected error is logged and answered as `internal`. */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<Envelope<unknown>> {
  if (!isToolName(name)) return toolError('tool_unavailable', UNAVAILABLE_HINT);
  const handler = handlerOf(name) as Handler<ToolName> | undefined;
  if (!handler) return toolError('tool_unavailable', UNAVAILABLE_HINT);
  const def = TOOL_DEFS[name];
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) return toolError('validation', parseHint(parsed.error));
  const input = parsed.data as never;
  if (def.scope === 'write' && ctx.principal.scope !== 'write') {
    return toolError('token_scope', 'This connection is read-only.');
  }
  const now = ctx.now ?? (() => new Date());
  const resolver = ctx.deps.providerResolved ?? dbProviderResolved;
  const base = (ctx.deps.baseUrl ?? '').replace(/\/+$/, '');
  try {
    const scope = principalScope(ctx.principal);
    // Semantic search's query embedding (T14), before the transaction: no model call runs inside
    // one (D166). Over the asked location, else every visible one; search() filters the rest.
    const meaningOf = handler.meaning as ((i: unknown) => string | undefined) | undefined;
    const asked0 = (input as LocationInput).location_id?.toLowerCase();
    const semantic =
      meaningOf && ctx.deps.semantic
        ? await ctx.deps
            .semantic(scope, meaningOf(input), asked0 ? { locationIds: [asked0] } : null)
            .catch((err: unknown) => {
              // Meaning is a bonus: its trouble leaves the call on keywords, never failing it.
              ctx.deps.log?.error({ err, tool: name }, 'query embedding failed');
              return null;
            })
        : null;
    const result = await withScope(ctx.deps.pools.app, scope, async (tx, client) => {
      const eligible = (l: ReachableLocation): boolean =>
        toolsIn(ctx.principal, ctx.via, l.role, l.modules).includes(name);
      /** A location that fails eligible(): a 403 when the caller sees it with the tool's
       * modules on (their role can't, as the routes answer), else unavailable. */
      const refuse = (l: ReachableLocation) =>
        l.modules.has(DOOR_MODULE[ctx.via]) && (!def.module || l.modules.has(def.module))
          ? new AppError('forbidden', 403, 'Your role here can’t do that.')
          : unavailable();

      const asked = (input as LocationInput).location_id?.toLowerCase();
      let location: ReachableLocation | null = null;
      let locations: ReachableLocation[] = [];
      if (asked) {
        const l = await reachable(tx, client, asked, resolver);
        if (!l) throw unavailable();
        if (!eligible(l)) throw refuse(l);
        location = l;
        locations = [l];
      } else {
        const subject = handler.subjectLocation
          ? await handler.subjectLocation(client, input)
          : null;
        if (subject) {
          const l = await reachable(tx, client, subject, resolver);
          if (!l) throw unavailable();
          if (!eligible(l)) throw refuse(l);
          location = l;
          locations = [l];
        } else {
          const all = (await reachableAll(tx, client, resolver)).filter(eligible);
          if (handler.global) {
            locations = all;
          } else if (all.length === 1) {
            location = all[0] as ReachableLocation;
            locations = [location];
          } else if (all.length === 0) {
            throw unavailable();
          } else {
            throw new ToolRefusal(
              'validation',
              'Pass location_id: you can reach several locations (list_locations lists them).',
            );
          }
        }
      }
      ctx.onLocations?.(locations.map((l) => l.id));
      const op: Op = {
        tx,
        client,
        scope,
        requestId: ctx.requestId,
        jobs: ctx.deps.jobs,
        files: ctx.deps.files,
        principal: ctx.principal,
        via: ctx.via,
        locale: ctx.locale,
        ifMatch: ctx.ifMatch,
        location,
        locations,
        link: (path) => `${base}${path}`,
        semantic,
      };
      return handler.run(op, input);
    });
    const envelope = ok(result.data, now(), result.nextCursor ?? undefined);
    return fit(envelope, result.cursorAt ? { cursorAt: result.cursorAt } : {});
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return refusal;
    ctx.deps.log?.error({ err, tool: name, requestId: ctx.requestId }, 'tool failed');
    return toolError('internal', 'Something went wrong in Kept; try again.');
  }
}
