/** D193: over plain HTTP the camera, install, push notifications and location don't work. */
export function servedOverHttp(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'http:';
}
