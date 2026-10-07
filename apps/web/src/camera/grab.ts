/**
 * The shutter (D34; plan T25, Q20): the video's current frame, drawn at the track's full
 * resolution, then kept the way the mode says (image.ts). The session stays open, so the next
 * shot is instant.
 */
import type { CaptureMode } from '@kept/shared';
import { type CapturedImage, type Drawable, fromFrame } from './image';

/** The frame on screen now, at the video's own resolution; null before the first frame. */
export function currentFrame(video: HTMLVideoElement): Drawable | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  return { source: video, width: video.videoWidth, height: video.videoHeight };
}

/** Whether the video shows a frame yet: the shutter waits for it (the stream alone isn't one). */
export function hasFrame(video: HTMLVideoElement): boolean {
  return currentFrame(video) !== null;
}

export async function grabFrame(
  video: HTMLVideoElement,
  mode: CaptureMode,
): Promise<CapturedImage | null> {
  const frame = currentFrame(video);
  return frame ? fromFrame(frame, mode) : null;
}
