/**
 * React Aria's live announcer (react-aria's LiveAnnouncer) says a pending button's name by adding
 * `<div role="img" aria-labelledby="<button id>">` to its hidden log for 7 seconds. When the
 * button goes first (a sheet closes on save, a toast's action runs), the node points at nothing,
 * an image without a name: axe's `role-img-alt`, "serious" (found by the step-3 e2e right after
 * a toast; step-4 plan T28). It has been read out already, the moment it was added, so an orphan
 * is removed as soon as what it names is gone.
 *
 * `guardAnnouncer()` watches the document once and returns its own stop; the Toaster installs it.
 */
const ORPHANS = '[data-live-announcer] [role="img"][aria-labelledby]';

/** Removes every announcer node whose labels are all gone; returns how many. */
export function dropOrphans(root: Document = document): number {
  let dropped = 0;
  for (const node of root.querySelectorAll<HTMLElement>(ORPHANS)) {
    const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    if (ids.some((id) => root.getElementById(id))) continue;
    node.remove();
    dropped += 1;
  }
  return dropped;
}

export function guardAnnouncer(root: Document = document): () => void {
  if (typeof MutationObserver === 'undefined' || !root.body) return () => {};
  const observer = new MutationObserver((records) => {
    // Only removals can orphan a node, and only nodes added to the log can be orphans.
    if (records.some((r) => r.removedNodes.length || r.addedNodes.length)) dropOrphans(root);
  });
  observer.observe(root.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
