// SPIKE (step 5, T0, V38). Throwaway. The page a vehicle's Costs tab would be: a scrolling `main`
// with pull to refresh attached (the app's attachPull, copied), and the charts loaded lazily.
//   ?lang=ar|en        Arabic RTL with Eastern digits, or English
//   ?variant=visx      the visx charts (default)
//   ?variant=scale     the fail path: hand-drawn SVG with @visx/scale only (built for its size)
//   ?naive=1           visx's own tick-label anchors, to show what RTL does to them
import { lazy, StrictMode, Suspense, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { attachPull } from './pull';

const q = new URLSearchParams(location.search);
const lang = q.get('lang') === 'ar' ? 'ar' : 'en';
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

const Charts = lazy(() => import('./charts'));
const ScaleOnly = lazy(() => import('./scale-only'));

declare global {
  interface Window {
    __pulls: number[];
    __released: boolean[];
  }
}
window.__pulls = [];
window.__released = [];

function App() {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    return attachPull(el, {
      canArm: () => true,
      scrollTop: () => document.scrollingElement?.scrollTop ?? 0,
      onPull: (d) => window.__pulls.push(d),
      onRelease: (r) => window.__released.push(r),
    });
  }, []);
  return (
    <main ref={main}>
      <h1 style={{ fontSize: 20 }}>{lang === 'ar' ? 'التكاليف' : 'Costs'}</h1>
      <Suspense fallback={<p>…</p>}>
        {q.get('variant') === 'scale' ? <ScaleOnly lang={lang} /> : <Charts lang={lang} />}
      </Suspense>
    </main>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
