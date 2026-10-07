/**
 * Links into Capture from elsewhere (routes/_app/capture.tsx reads them).
 *
 * `captureLabelSearch(thingId)`: LABEL mode on that thing, every LABEL shot attached to it
 * (`attachToThingId`) in its location, so the server reads it there (step 5: a vehicle's
 * registration card becomes a suggested document, T10/T22). Use it as
 * `<Link to="/capture" search={captureLabelSearch(id)}>` or `navigate({to: '/capture', search})`;
 * `captureLabelHref(thingId)` is the same as a plain URL.
 */
export const captureLabelSearch = (thingId: string) => ({ label: thingId });

export const captureLabelHref = (thingId: string) =>
  `/capture?label=${encodeURIComponent(thingId)}`;
