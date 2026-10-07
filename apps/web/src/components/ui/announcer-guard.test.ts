/**
 * The dangling announcer node (step-3 e2e, step-4 plan T28): React Aria's live announcer names a
 * pending button by id for 7 s; once the button is gone the node is an image without a name
 * (axe `role-img-alt`). The guard removes it as soon as its label is gone, and leaves the rest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { dropOrphans, guardAnnouncer } from './announcer-guard';

/** The announcer's DOM, as react-aria's LiveAnnouncer builds it, with one node naming `id`. */
function announcer(id: string) {
  const root = document.createElement('div');
  root.dataset.liveAnnouncer = 'true';
  const log = document.createElement('div');
  log.setAttribute('role', 'log');
  const node = document.createElement('div');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-labelledby', id);
  log.append(node);
  root.append(log);
  document.body.prepend(root);
  return node;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the announcer guard', () => {
  it('keeps a node while its button is there, and drops it once the button goes', async () => {
    const button = document.createElement('button');
    button.id = 'save-1';
    button.textContent = 'Save';
    document.body.append(button);
    const node = announcer('save-1');
    const stop = guardAnnouncer();
    expect(dropOrphans()).toBe(0);
    expect(node.isConnected).toBe(true);
    button.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(node.isConnected).toBe(false);
    stop();
  });

  it('leaves plain text announcements alone', () => {
    const root = document.createElement('div');
    root.dataset.liveAnnouncer = 'true';
    root.innerHTML = '<div role="log"><div>Moved to Garage</div></div>';
    document.body.append(root);
    expect(dropOrphans()).toBe(0);
    expect(root.textContent).toBe('Moved to Garage');
  });
});
