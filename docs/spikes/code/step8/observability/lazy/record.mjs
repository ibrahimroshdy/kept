// Records every module URL Node resolves (module.registerHooks, Node 24), for the module-graph check.
import { registerHooks } from 'node:module';
globalThis.__keptLoaded = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    globalThis.__keptLoaded.add(r.url);
    return r;
  },
});
