/**
 * Try Kept (D246) has no server to hand out files: a link to one of Kept's own file URLs (`/f/…`,
 * an export's download; `/x/…`, a claim pack's link) says so in a toast instead of opening the
 * docs site's 404 page.
 */
import { t } from '@lingui/core/macro';
import { toast } from '@/components/ui/toast';

/** Says that downloads are off here. */
export function downloadsAreOff(): void {
  toast({ title: t`Downloads are off in this demo.` });
}

/** One of Kept's own file URLs on this page's origin. */
export function isServerFile(href: string, origin: string = location.origin): boolean {
  try {
    const url = new URL(href, origin);
    return (
      url.origin === origin && (url.pathname.startsWith('/f/') || url.pathname.startsWith('/x/'))
    );
  } catch {
    return false;
  }
}

/** Catches every click on such a link, in the capture phase, before the browser follows it. */
export function guardServerFiles(doc: Document = document, origin?: string): () => void {
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a[href]');
    if (!a || !isServerFile(a.getAttribute('href') ?? '', origin)) return;
    e.preventDefault();
    e.stopPropagation();
    downloadsAreOff();
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}
