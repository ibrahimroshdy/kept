/**
 * Every step-6 assistant path the web app calls, from the step-6 plan's T13 route table, landing
 * in `apps/server/src/assistant/routes.ts` (T2's stub). A path the server names differently is
 * fixed here and nowhere else. T26's contract check reads `ASSISTANT_METHODS` against the
 * server's openapi.json, as earlier steps do with theirs. The AI status line the composer shows
 * is step 3's (`capturePaths.aiStatus`).
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const assistantPaths = {
  threads: `${V1}/assistant/threads`,
  thread: (id: string) => `${V1}/assistant/threads/${seg(id)}`,
  threadTurns: (id: string) => `${V1}/assistant/threads/${seg(id)}/turns`,
  turn: (id: string) => `${V1}/assistant/turns/${seg(id)}`,
  turnCancel: (id: string) => `${V1}/assistant/turns/${seg(id)}/cancel`,
  proposalsConfirm: `${V1}/assistant/proposals/confirm`,
  proposalsCancel: `${V1}/assistant/proposals/cancel`,
};

export const ASSISTANT_METHODS: Record<keyof typeof assistantPaths, readonly string[]> = {
  threads: ['GET', 'POST'],
  thread: ['GET', 'DELETE'],
  threadTurns: ['POST'],
  turn: ['GET'],
  turnCancel: ['POST'],
  proposalsConfirm: ['POST'],
  proposalsCancel: ['POST'],
};
