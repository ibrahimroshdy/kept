/**
 * Spike S6.1, side measurement: what a per-request factory costs when it registers ~25 tools with
 * zod input and output schemas (T11 builds a fresh McpServer per POST /mcp).
 * Run: node --import tsx factory-cost.spike.ts
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

const input = z.object({
  location_id: z.string().uuid().optional(),
  q: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});
const output = z.object({
  data: z.array(z.object({ id: z.string(), short_code: z.string(), path: z.array(z.string()), untrusted: z.object({ name: z.string() }) })),
  as_of: z.string(),
  next_cursor: z.string().optional(),
});
function build() {
  const s = new McpServer({ name: 'kept', version: '0' });
  for (let i = 0; i < 25; i++) {
    s.registerTool(`tool_${i}`, { description: 'x', inputSchema: input, outputSchema: output }, async () => ({ content: [] }));
  }
  return s;
}
for (let i = 0; i < 50; i++) build();
const n = 500;
const times: number[] = [];
for (let i = 0; i < n; i++) {
  const t = performance.now();
  build();
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const q = (p: number) => times[Math.floor((n - 1) * p)]?.toFixed(3);
console.log(JSON.stringify({ tools: 25, runs: n, p50_ms: q(0.5), p95_ms: q(0.95), max_ms: q(1) }));
