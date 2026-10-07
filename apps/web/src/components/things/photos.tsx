/**
 * The header's photo carousel (screens §5 Thing detail: "the photo, swipe through photos").
 * One photo at a time with "1 / 4", Previous and Next buttons, arrow keys, and a swipe on touch.
 * In Arabic the buttons and the swipe mirror. Without photos it shows the type's icon, and a
 * writer gets "Add photo". A HEIC photo has no preview yet (D36): it says so, never an error.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import type { AttachmentView } from '@/api/inventory/types';
import { ChevronEndIcon, ChevronStartIcon } from '@/components/icons';
import { TypeIcon } from '@/components/type-icon';
import { useFormat } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { useThingCtx } from './context';
import { UploadButton } from './upload';

export function PhotoCarousel({ className }: { className?: string }) {
  const { thing, can, refresh } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const { locale } = usePrefs();
  const photos = thing.photos;
  const [index, setIndex] = useState(0);
  const i = Math.min(index, Math.max(0, photos.length - 1));
  const touch = useRef<number | null>(null);
  const go = (delta: number) =>
    setIndex((n) => Math.max(0, Math.min(photos.length - 1, n + delta)));
  const rtl = locale === 'ar';

  return (
    <div className={cn('grid gap-2', className)}>
      <section
        aria-roledescription={t`carousel`}
        aria-label={t`Photos`}
        tabIndex={photos.length > 1 ? 0 : -1}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') go(rtl ? 1 : -1);
          if (e.key === 'ArrowRight') go(rtl ? -1 : 1);
        }}
        onTouchStart={(e) => {
          touch.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          const start = touch.current;
          const end = e.changedTouches[0]?.clientX;
          touch.current = null;
          if (start === null || end === undefined || Math.abs(end - start) < 40) return;
          const forward = end < start ? !rtl : rtl;
          go(forward ? 1 : -1);
        }}
        className={cn(
          'relative grid place-items-center overflow-hidden rounded-[10px] bg-sunken outline-none focus-visible:outline-2 focus-visible:outline-info',
          photos.length ? 'aspect-[4/3] max-h-80 md:aspect-square md:max-h-none' : 'h-32 md:h-40',
        )}
      >
        {photos.length === 0 ? (
          <TypeIcon icon={thing.type?.icon} className="size-14 text-ink-3" />
        ) : (
          <Slide
            photo={photos[i] as AttachmentView}
            label={t`Photo ${fmt.num(i + 1)} of ${fmt.num(photos.length)}`}
          />
        )}
        {photos.length > 1 ? (
          <>
            <span
              aria-hidden="true"
              className="absolute end-2 bottom-2 rounded-full bg-black/55 px-2 py-0.5 text-[12px] text-white tabular-nums"
            >
              {fmt.num(i + 1)} / {fmt.num(photos.length)}
            </span>
            <button
              type="button"
              aria-label={t`Previous photo`}
              disabled={i === 0}
              onClick={() => go(-1)}
              className="absolute start-1 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white outline-none disabled:opacity-0 focus-visible:outline-2 focus-visible:outline-info"
            >
              <ChevronStartIcon />
            </button>
            <button
              type="button"
              aria-label={t`Next photo`}
              disabled={i === photos.length - 1}
              onClick={() => go(1)}
              className="absolute end-1 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white outline-none disabled:opacity-0 focus-visible:outline-2 focus-visible:outline-info"
            >
              <ChevronEndIcon />
            </button>
          </>
        ) : null}
      </section>
      {can('attachments.add') ? (
        <UploadButton
          locationId={thing.locationId}
          subject={{ thingId: thing.id }}
          attachAs="photo"
          accept={['image/*']}
          label={photos.length ? t`Add a photo` : t`Add the first photo`}
          onUploaded={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function Slide({ photo, label }: { photo: AttachmentView; label: string }) {
  const src = photo.file?.displayUrl ?? photo.file?.thumbUrl ?? null;
  if (!src)
    return (
      <div className="grid justify-items-center gap-1 px-4 text-center text-small text-ink-2">
        <span className="font-semibold text-ink">
          <Trans>Preview unavailable</Trans>
        </span>
        <span>
          <Trans>The original is kept. This format can't be previewed yet.</Trans>
        </span>
      </div>
    );
  return <img src={src} alt={label} className="size-full object-cover" />;
}
