import {
  isToolError,
  SERVER_INSTRUCTIONS,
  TOOL_DEFS,
  type ToolName,
  toolError,
  VOCABULARY,
  VOCABULARY_RESOURCE,
} from '@kept/mcp';
import { KEPT_VERSION, newId } from '@kept/shared';
import {
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
} from '@modelcontextprotocol/server';
import type pg from 'pg';
import { tokenRateHit } from '../tokens/rate.js';
import { runTool, toolsFor } from '../tools/context.js';
import type { ToolDeps, ToolPrincipal } from '../tools/types.js';
import { principalOf } from './auth.js';

// The MCP server (step-6 plan T11; D58, D63, D113, D124, D128, D172, D179; screens §8).
//
// createMcpHandler(factory): stateless (D63), one fresh McpServer per HTTP request (spike S6.1:
// ~1 ms for 25 tools). The factory reads the verified AuthInfo and registers **only** the tools
// that token may call in its locations (toolsFor(), tools/context.ts): a write tool for a write
// token where its role and the modules allow it, never a tool of a module that is off. Each
// callback calls runTool(), which checks all of that again per call (D180) and answers Kept's
// envelope; a refusal comes back as `isError` with `{error, hint}` for the model to read.
//
// Answers carry the envelope once, as text (≤ 8 KB, T1's fit()): no `outputSchema` and no
// `structuredContent`, which would send every answer twice (spike S6.1 finding 4). The zod output
// schemas stay the contract the tests check.
//
// `legacy: 'stateless'` (plan Q9): the SDK's own client still opens with the 2025 handshake by
// default (S6.1 finding 6), so 2025-era clients are served statelessly until V15 shows the real
// clients speak 2026-07-28.

export const MCP_BODY_LIMIT = 1_048_576;

export type McpServerDeps = {
  tools: ToolDeps;
  /** kept_app, for the per-token limiter (T10's, D63: the same one as the API). */
  pool: pg.Pool;
};

const text = (value: unknown): CallToolResult['content'] => [
  { type: 'text', text: JSON.stringify(value) },
];

/** One tool call as MCP answers it: rate-limited by the tool's scope, then runTool(). */
async function callTool(
  deps: McpServerDeps,
  principal: ToolPrincipal,
  name: ToolName,
  args: unknown,
): Promise<CallToolResult> {
  if (principal.tokenId) {
    const rate = await tokenRateHit(deps.pool, principal.tokenId, TOOL_DEFS[name].scope);
    if (!rate.ok) {
      return {
        content: text(
          toolError('rate_limited', `Too many calls; try again in ${rate.retryAfter} s.`),
        ),
        isError: true,
      };
    }
  }
  const envelope = await runTool(
    { deps: deps.tools, principal, locale: 'en', requestId: newId(), via: 'mcp' },
    name,
    args,
  );
  return isToolError(envelope)
    ? { content: text(envelope), isError: true }
    : { content: text(envelope) };
}

/** The factory: a server for this request's principal, with its tools only. */
export function mcpFactory(deps: McpServerDeps) {
  return async (ctx: McpRequestContext): Promise<McpServer> => {
    const server = new McpServer(
      { name: 'Kept', version: KEPT_VERSION },
      { instructions: SERVER_INSTRUCTIONS.en },
    );
    server.registerResource(
      VOCABULARY_RESOURCE.name,
      VOCABULARY_RESOURCE.uri,
      { title: VOCABULARY_RESOURCE.title, mimeType: VOCABULARY_RESOURCE.mimeType },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: VOCABULARY_RESOURCE.mimeType, text: VOCABULARY.en }],
      }),
    );
    const principal = principalOf(ctx.authInfo);
    // The route verified the token before the handler ran; without one, nothing is offered.
    if (!principal) return server;
    const reach = await toolsFor({ deps: deps.tools, principal, via: 'mcp' });
    const names = new Set(reach.flatMap((r) => r.tools));
    for (const name of Object.keys(TOOL_DEFS) as ToolName[]) {
      if (!names.has(name)) continue;
      const def = TOOL_DEFS[name];
      server.registerTool(
        name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.input,
          annotations: { ...def.annotations, title: def.title },
        },
        (args: unknown) => callTool(deps, principal, name, args),
      );
    }
    return server;
  };
}

export function mcpHandler(deps: McpServerDeps, onerror?: (err: Error) => void): McpHttpHandler {
  return createMcpHandler(mcpFactory(deps), {
    legacy: 'stateless',
    responseMode: 'json',
    maxRequestBodySize: MCP_BODY_LIMIT,
    ...(onerror ? { onerror } : {}),
  });
}
