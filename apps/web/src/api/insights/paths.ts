/**
 * Insights' path (1.x, D234; `apps/server/src/insights/routes.ts`). A path the server names
 * differently is fixed here and nowhere else.
 */

const V1 = '/api/v1';

export const insightsPaths = {
  insights: `${V1}/insights`,
};

export const INSIGHTS_METHODS: Record<keyof typeof insightsPaths, readonly string[]> = {
  insights: ['GET'],
};
