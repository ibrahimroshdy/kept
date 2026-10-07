/**
 * Per-location roles and the role matrix, transcribed from product design §7.1 (all rows, not
 * only those step 1 uses). Each action's comment quotes the §7.1 row it comes from. A row whose
 * cells qualify a verb for one role ("create", "add, edit own", "own, read-only") is split into
 * one action per verb; cells the boolean can't carry are recorded in QUALIFIERS, and the two
 * conditional cells (money for viewers, secret reveal) are resolved by `can()`'s context.
 *
 * roles.test.ts holds a verbatim copy of the §7.1 table and fails when the spec changes.
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const O = ['owner'] as const;
const OA = ['owner', 'admin'] as const;
const OAM = ['owner', 'admin', 'member'] as const;
const ALL = ROLES;

export const MATRIX = Object.freeze({
  // "See things, places, photos, history, activity feed (redacted per D110)"
  'content.view': ALL,
  // "Add, edit, move, lend and borrow things; log readings, services and fuel"
  'things.edit': OAM,
  // "Manage schedules; open and update claims"
  'schedules-claims.manage': OAM,
  // "Print labels; claim blank labels; box check"
  'labels.use': OAM,
  // "Mark seen / not here"
  'things.mark-seen': OAM,
  // "Use AI capture (spends the location owner's budget, D121)"
  'ai.capture': OAM,
  // "Ask the assistant (read-only for viewers; spends budget)": viewer "✓ read-only"
  'assistant.ask': ALL,
  // "Create people and vendors inline (D11)"
  'people-vendors.create-inline': OAM,
  // "Edit, merge, delete people, vendors, brands; create and edit types and templates"
  'registries-types.manage': OA,
  // "Trash things (undoable); restore from trash"
  'things.trash': OAM,
  // "Delete permanently"
  'things.delete-permanently': OA,
  // "Tags: create · edit and delete": member "create"
  'tags.create': OAM,
  'tags.edit-delete': OA,
  // "Readings, services, fuel: add · edit or delete others'": member "add, edit own"
  'logs.add': OAM,
  'logs.edit-own': OAM,
  'logs.edit-delete-others': OA,
  // "Meters: add or change"
  'meters.manage': OA,
  // "Attachments: add · delete": member "add, delete own"
  'attachments.add': OAM,
  'attachments.delete-own': OAM,
  'attachments.delete-any': OA,
  // "Shared saved views"
  'saved-views.share': OAM,
  // "Webhooks"
  'webhooks.manage': OA,
  // "Incidents; claim packs (D158)"
  'incidents.manage': OA,
  // "Reveal a secret field": "per the field's policy (D116); admins and above by default".
  // This is the default; the field's policy widens it (see CanContext.secretRevealRoles).
  'secrets.reveal': OA,
  // "Set a secret field's policy; convert a field to or from secret": "owner only (D177)"
  'secrets.set-policy': O,
  // "See money": viewer "only if the location allows (D13)" (see CanContext).
  'money.view': OAM,
  // "Export the location; import into it"
  'location.export-import': OA,
  // "Create share links"
  'share-links.create': OA,
  // "Invite and remove members and viewers; change their roles and expiry"
  'members.manage': OA,
  // "Promote, demote or remove admins (D48)"
  'admins.manage': O,
  // "Location settings and modules"
  'location.settings': OA,
  // "API/MCP tokens for this location": member "own, up to own role"; viewer "own, read-only"
  'tokens.manage-own': ALL,
  'tokens.manage-all': OA,
  // "Require two-factor for the location; grant support access (D71)"
  'location.security': O,
  // "Transfer or delete the location; billing"
  'location.transfer-delete': O,
} as const satisfies Record<string, readonly Role[]>);

export type Action = keyof typeof MATRIX;
export const ACTIONS = Object.freeze(Object.keys(MATRIX) as Action[]);

export type Qualifier = 'read-only' | 'up-to-own-role';

/** Cell text a yes/no can't carry: the caller must enforce these on top of `can()`. */
export const QUALIFIERS: Readonly<Partial<Record<Action, Partial<Record<Role, Qualifier>>>>> =
  Object.freeze({
    // "✓ read-only": a viewer's assistant may not write.
    'assistant.ask': { viewer: 'read-only' },
    // "own, up to own role" / "own, read-only" (D63: a token never exceeds its creator's role).
    'tokens.manage-own': { member: 'up-to-own-role', viewer: 'read-only' },
  });

export type CanContext = {
  /** The location's "viewers may see money" toggle (D13, D110). Default: off. */
  moneyVisibleToViewers?: boolean;
  /**
   * Roles a secret field's policy adds to the admin+ default (D116). The policy only widens;
   * named people on a policy are checked by the caller, not here.
   */
  secretRevealRoles?: readonly Role[];
};

/** Whether `role` may perform `action` in a location. Unknown roles and actions are denied. */
export function can(role: Role, action: Action, ctx: CanContext = {}): boolean {
  if (!Object.hasOwn(MATRIX, action)) return false;
  const allowed: readonly Role[] = MATRIX[action];
  if (allowed.includes(role)) return true;
  if (action === 'money.view') return role === 'viewer' && ctx.moneyVisibleToViewers === true;
  if (action === 'secrets.reveal') return ctx.secretRevealRoles?.includes(role) ?? false;
  return false;
}
