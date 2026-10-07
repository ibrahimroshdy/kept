// SPIKE (step 3, T0, V17). Registration through @serwist/window 9.5.12 (dist/index.d.mts:
// `new Serwist(scriptURL, registerOptions)`, `register()`, `messageSkipWaiting()`, events
// `waiting` / `controlling`). apply.sh appends `import './spike-register';` to src/main.tsx.
import { Serwist } from '@serwist/window';

declare global {
  interface Window {
    __spikeSw?: { waiting: number; controlling: number; registered: boolean; error?: string };
    __spikeSkipWaiting?: () => void;
  }
}

const state = { waiting: 0, controlling: 0, registered: false } as NonNullable<Window['__spikeSw']>;
window.__spikeSw = state;

if ('serviceWorker' in navigator) {
  const sw = new Serwist('/sw.js', { scope: '/', type: 'classic' });
  sw.addEventListener('waiting', () => {
    state.waiting += 1;
  });
  sw.addEventListener('controlling', () => {
    state.controlling += 1;
  });
  window.__spikeSkipWaiting = () => sw.messageSkipWaiting();
  sw.register()
    .then(() => {
      state.registered = true;
    })
    .catch((e: unknown) => {
      state.error = String(e);
    });
}
