/**
 * An uploaded original (a receipt, a manual, a place's attachment) handed to the person, on every
 * platform. Originals stay `Content-Disposition: attachment` (D157: they aren't re-encoded
 * images), and an installed iPhone or iPad app does nothing with an attachment link. So there,
 * the press shares the file instead (lib/files.ts): the file is fetched ahead, through a fresh
 * signed link, so the press opens the share sheet in its own turn, as iOS requires. Where the
 * share sheet can't take it, the press says so. Everywhere else the press opens the link, as
 * before. A display or thumb rendition is an inline JPEG and opens anywhere.
 *
 * A button that takes the handle's `ref` is fetched ahead only once it comes near the screen, so a
 * long list (the paperwork library) doesn't pull every original on it; one that doesn't is
 * fetched on mount. A press before that starts it.
 */
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import type { FileVariant } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { toast } from '@/components/ui/toast';
import { canShareType, downloadsWork, shareFiles } from '@/lib/files';

/** The server's own extensions for a download's name (apps/server/src/files/views.ts). */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** The shared file's name: made from the role and the id, never from anything a user typed. */
export function originalName(fileId: string, mime: string, role = 'file'): string {
  return `kept-${role}-${fileId.slice(0, 8)}.${EXTENSIONS[mime] ?? 'bin'}`;
}

export type OriginalFile = {
  fileId: string;
  mime: string;
  /** The attachment's role (receipt, manual…), for the shared file's name. */
  role?: string;
  /** For a receipt after a move (`?thingId=`). */
  thingId?: string;
  variant: FileVariant;
};

export type OriginalHandle = {
  /** 'share' on the installed iPhone app for an original; 'open' everywhere else. */
  mode: 'open' | 'share';
  /** Share mode, while the file is on its way. */
  pending: boolean;
  press: () => void;
  /** Share mode: put on the button to fetch ahead only once it's near the screen. */
  ref?: (el: Element | null) => void;
};

/** One file's Open, or, on the installed iPhone app, its Share. `null` for none (a link). */
export function useOriginalFile(f: OriginalFile | null): OriginalHandle {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [sharing, setSharing] = useState(false);
  const shareMode = !!f && f.variant === 'original' && !downloadsWork();
  const name = f ? originalName(f.fileId, f.mime, f.role) : '';
  const [shareable] = useState(() => shareMode && canShareType(name, f?.mime ?? ''));
  const watch = shareMode && shareable;
  // Near the screen, or no way to tell (no IntersectionObserver, or no button took the ref).
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const observed = useRef(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (el: Element | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el || !watch || typeof IntersectionObserver === 'undefined') return;
      observed.current = true;
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          setNear(true);
          io.disconnect();
        },
        { rootMargin: '200px' },
      );
      io.observe(el);
      observer.current = io;
    },
    [watch],
  );
  useEffect(() => {
    if (watch && !observed.current) setNear(true);
    return () => observer.current?.disconnect();
  }, [watch]);
  const file = useQuery({
    // The name is in the key: one file can be a receipt here and a manual there.
    queryKey: ['files', 'original', f?.fileId ?? '', f?.thingId ?? '', name],
    queryFn: async () => {
      if (!f) throw new Error('no file');
      const { url } = await inventoryApi.fileUrl(f.fileId, 'original', f.thingId);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new File([await res.blob()], name, { type: f.mime });
    },
    enabled: watch && near,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: 1,
  });

  const open = async () => {
    if (!f) return;
    try {
      const u = await inventoryApi.fileUrl(f.fileId, f.variant, f.thingId);
      window.open(u.url, '_blank', 'noopener');
    } catch (e) {
      toast({ title: t`Couldn't open it`, description: errorText(e), tone: 'danger' });
    }
  };

  const share = async () => {
    if (!shareable) {
      toast({
        tone: 'danger',
        title: t`This file can't be shared from the installed app`,
        description: t`Open Kept in Safari to download it.`,
      });
      return;
    }
    if (file.error) {
      toast({ tone: 'danger', title: t`Couldn't get the file ready. Try again.` });
      void file.refetch();
      return;
    }
    if (!file.data) {
      setNear(true);
      toast({ title: t`The file is still on its way. Try again in a moment.` });
      return;
    }
    setSharing(true);
    const how = await shareFiles([file.data]);
    setSharing(false);
    if (how === 'refused') toast({ tone: 'danger', title: t`Couldn't share the file. Try again.` });
  };

  if (!shareMode) return { mode: 'open', pending: false, press: () => void open() };
  return {
    mode: 'share',
    pending: sharing || (shareable && near && file.isPending),
    press: () => void share(),
    ref,
  };
}
