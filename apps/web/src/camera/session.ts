/**
 * The capture camera (D34; plan T25, Q20): the back camera, asked for 4K so the browser gives
 * the best it has, kept open for the whole session. Every reason it can't open has a name, so
 * the screen can say which ("Kept can't use the camera": screens §5, D31) and offer the file
 * picker instead, which always works.
 *
 * Needs HTTPS (or localhost): `navigator.mediaDevices` doesn't exist on a plain-HTTP page.
 */

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
};

export type CameraProblem =
  /** Plain HTTP: no camera API at all (D31). */
  | 'insecure'
  /** This browser has no `getUserMedia`. */
  | 'unsupported'
  /** The person, or the browser's settings, said no. */
  | 'denied'
  /** No camera on this device. */
  | 'no_camera'
  /** Another app holds the camera. */
  | 'busy'
  | 'failed';

export type MediaAccess = Pick<MediaDevices, 'getUserMedia'>;

export type CameraEnv = {
  secure: boolean;
  media: MediaAccess | null;
};

/** The page's own environment. */
export function cameraEnv(): CameraEnv {
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  // Undefined on a plain-HTTP page, although the DOM types say it is always there.
  const devices =
    typeof navigator !== 'undefined'
      ? (navigator.mediaDevices as MediaDevices | undefined)
      : undefined;
  const media = typeof devices?.getUserMedia === 'function' ? devices : null;
  return { secure, media };
}

/** A problem known before asking: over HTTP, or no camera API. */
export function problemUpfront(env: CameraEnv): CameraProblem | null {
  if (!env.secure) return 'insecure';
  if (!env.media) return 'unsupported';
  return null;
}

/** A `getUserMedia` rejection, by its DOMException name. */
export function classifyCameraError(e: unknown): CameraProblem {
  const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return 'denied';
  if (
    name === 'NotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'DevicesNotFoundError'
  )
    return 'no_camera';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
    return 'busy';
  return 'failed';
}

export type OpenCamera =
  | { ok: true; stream: MediaStream; stop: () => void }
  | { ok: false; problem: CameraProblem };

export async function openCamera(env: CameraEnv = cameraEnv()): Promise<OpenCamera> {
  const upfront = problemUpfront(env);
  if (upfront || !env.media) return { ok: false, problem: upfront ?? 'unsupported' };
  try {
    const stream = await env.media.getUserMedia(CAMERA_CONSTRAINTS);
    return {
      ok: true,
      stream,
      stop: () => {
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch (e) {
    return { ok: false, problem: classifyCameraError(e) };
  }
}
