import { registerHooks } from 'node:module';

// Preloaded first by observability.test.ts's child: records every module URL the process
// resolves, so the test can say which packages loaded.
const resolved = new Set<string>();
(globalThis as { __keptResolved?: Set<string> }).__keptResolved = resolved;
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    resolved.add(result.url);
    return result;
  },
});
