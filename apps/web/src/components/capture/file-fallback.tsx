/**
 * When the camera can't open (screens §4, §5 "HTTP or camera denied"; D31): the reason in plain
 * words, how to allow it where that's the problem, and the file picker, which always works: the
 * phone's own camera app, or photos already taken. Captures still go into the queue as usual.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { CameraProblem } from '@/camera/session';
import { CameraIcon, GalleryIcon } from '@/components/icons';
import { FilePick } from './gallery-import';

const btn =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-4 font-semibold text-[14px] [&_svg]:size-5';

export function FileFallback({
  problem,
  onFiles,
}: {
  problem: CameraProblem;
  onFiles: (files: File[], fromCamera: boolean) => void;
}) {
  const { t } = useLingui();
  const reason =
    problem === 'insecure'
      ? t`The camera needs a secure (HTTPS) address, and this page doesn't have one. Your admin can put Kept on HTTPS.`
      : problem === 'denied'
        ? t`Camera access is off for Kept.`
        : problem === 'no_camera'
          ? t`This device has no camera Kept can use.`
          : problem === 'busy'
            ? t`Another app is using the camera. Close it, then come back.`
            : t`This browser can't open the camera here.`;
  return (
    <div className="grid content-center gap-3 p-4 text-[#F2EFE9]">
      <h2 className="m-0 font-semibold text-[18px]">
        <Trans>Kept can't use the camera</Trans>
      </h2>
      <p className="m-0 text-[#BDB7AC] text-[14px]">{reason}</p>
      {problem === 'denied' ? (
        <details className="rounded-xl border border-[#34302A] bg-[#1E1C19] p-3 text-[13.5px]">
          <summary className="min-h-8 cursor-pointer font-semibold outline-none focus-visible:outline-2 focus-visible:outline-[#F2EFE9]">
            <Trans>How to allow it</Trans>
          </summary>
          <ul className="m-0 mt-2 grid gap-1.5 ps-5 text-[#BDB7AC]">
            <li>
              <Trans>iPhone: Settings › Safari › Camera › Allow, then reopen Kept.</Trans>
            </li>
            <li>
              <Trans>
                Android: tap the icon beside the address, then Permissions › Camera › Allow.
              </Trans>
            </li>
            <li>
              <Trans>A computer: the camera icon in the address bar, then Allow.</Trans>
            </li>
          </ul>
        </details>
      ) : null}
      <p className="m-0 text-[#BDB7AC] text-[14px]">
        <Trans>
          You can still take photos with your phone's camera app, or pick ones you have.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        <FilePick
          camera
          onFiles={(f) => onFiles(f, true)}
          className={`${btn} bg-amber text-amber-ink`}
        >
          <CameraIcon />
          {t`Take a photo`}
        </FilePick>
        <FilePick
          multiple
          onFiles={(f) => onFiles(f, false)}
          className={`${btn} border border-[#4A463F] text-[#F2EFE9]`}
        >
          <GalleryIcon />
          {t`Choose photos`}
        </FilePick>
      </div>
    </div>
  );
}
