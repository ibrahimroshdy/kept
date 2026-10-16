import {
  isAuditAction,
  LEGACY_AUDIT_ACTIONS,
  SUMMARY_LINES_INLINE,
  type SummaryKey,
  type SummaryLine,
  type SummaryLineKey,
} from '@kept/shared';
import type { RenderedAuditEvent } from '../audit/render.js';
import { arrangeLines, layoutOf, type NodeName } from './arrange.js';

// One line per history or activity row (plan T21; T27 decision; #140): a structured `summaryKey`
// with `summaryParams` that the web localises, and `summary`, the same sentence in English, as the
// fallback. It is built from the *rendered* event, after renderAudit() has redacted it, so it
// can never say more than the row it sits on: money and secrets never reach the params (the
// only diff values read are names, codes, counts and a stock use's service ids, all plain),
// and a move from a location the viewer can't see has no diff to read at all (D183).
//
// Params are data, never English: names as stored, and codes (`lifecycle: 'given_away'`) the web
// localises. Keys are `<entity>.<verb>` in the audit's own vocabulary (@kept/shared AUDIT_ACTIONS:
// every action the server writes has a sentence of its own, and ENGLISH below is typed by them, so
// a new action without one fails the typecheck), refined where the row says more than the action:
// `thing.move.in` / `thing.move.out` (a move across the edge of what the viewer can see),
// `<entity>.restore` for an undone trash, `undo` for any other undo, a capture that only added a
// photo, a report's kind, a busy arrangement (SUMMARY_REFINEMENTS). Only an action this build
// doesn't know (an imported history's, a newer server's) gets `event` with `{action}`.
//
// `summaryLines` (#140) say what the action covered, one sentence each: an arrangement's changes
// (history/arrange.ts), and the counts a report, a trash or an undone capture would otherwise show
// as raw fields ("12 things", "With photos").

export type SummaryParams = Record<string, string>;
/** A detail line with its English, the fallback for a client that doesn't know its key. */
export type RenderedLine = SummaryLine & { text: string };
export type Summary = {
  summaryKey: string;
  summaryParams: SummaryParams;
  summary: string;
  summaryLines?: RenderedLine[];
};

/** What the summary needs beyond the rendered event. */
export type SummaryContext = {
  /** The current name of what the event is about (the thing, the place, the registry row, the
   * location of a location's own event), or null when the viewer can't see it any more. */
  name: string | null;
  /** The event is a move out to a location the viewer can't see (crossingOf() = 'out'). */
  movedOut?: boolean;
  /** A `thing.stock_use` (D236): the current name of the thing or place the service was for. */
  service?: string | null;
  /** A `place.arrange`: what the reader may see of each node it touched. */
  nodes?: ReadonlyMap<string, NodeName>;
};

type Sentence = (p: SummaryParams) => string;

/** English plural: `#` is the count. */
const plural = (count: string | undefined, one: string, other: string) =>
  (Number(count) === 1 ? one : other).replaceAll('#', count ?? '0');

/** English for every key. `{name}` is always set (a fallback noun when the name is unknown). */
const ENGLISH: Record<SummaryKey, Sentence> = {
  'thing.create': (p) => `Added ${p.name}`,
  'thing.update': (p) => `Edited ${p.name}`,
  'thing.retype': (p) => `Changed the type of ${p.name}`,
  'thing.lifecycle': (p) =>
    p.lifecycle ? `Marked ${p.name} as ${words(p.lifecycle)}` : `Changed the status of ${p.name}`,
  'thing.move': (p) => `Moved ${p.name}`,
  'thing.move.in': () => 'Moved in from another location',
  'thing.move.out': (p) => `Moved ${p.name} to another location`,
  'thing.trash': (p) => `Trashed ${p.name}`,
  'thing.restore': (p) => `Restored ${p.name}`,
  'thing.delete': (p) => `Deleted ${p.name} for good`,
  'thing.seen': (p) => `Saw ${p.name}`,
  'thing.not_here': (p) => `Marked ${p.name} as not here`,
  'thing.split': (p) => `Split ${p.name}`,
  'thing.duplicate': (p) => `Duplicated ${p.name}`,
  'thing.link': (p) => `Linked ${p.name}`,
  'thing.unlink': (p) => `Unlinked ${p.name}`,
  'thing.convert_to_place': (p) => `Turned ${p.name} into a place`,
  'thing.codes': (p) => `Changed the codes of ${p.name}`,
  'place.create': (p) => `Added ${p.name}`,
  'place.update': (p) => `Edited ${p.name}`,
  'place.move': (p) => `Moved ${p.name}`,
  'place.trash': (p) => `Trashed ${p.name}`,
  'place.restore': (p) => `Restored ${p.name}`,
  'place.delete': (p) => `Deleted ${p.name} for good`,
  'place.merge': (p) => `Merged ${p.name} into another place`,
  'place.convert_to_container': (p) => `Turned ${p.name} into a container`,
  'place.label': (p) => `Labelled ${p.name}`,
  'place.codes': (p) => `Changed the codes of ${p.name}`,
  // D236: a service line took the consumable off the shelf, or gave it back.
  'thing.stock_use': (p) => `Used ${p.name} in a service of ${p.service}`,
  'thing.stock_return': (p) => `Put ${p.name} back from a service of ${p.service}`,
  // 1.x (D237): an arrange session on the location map, about the location; its changes are lines.
  'place.arrange': () => 'Arranged the map',
  'place.arrange.many': (p) =>
    plural(p.count, 'Arranged the map: # change', 'Arranged the map: # changes'),
  'attachment.create': (p) => `Attached a file to ${p.name}`,
  'attachment.update': (p) => `Changed a file on ${p.name}`,
  'attachment.delete': (p) => `Removed a file from ${p.name}`,
  // A capture that added a photo to a thing that was already there, or named one without a photo.
  'thing.capture.attach': (p) => `Added a photo to ${p.name}`,
  'thing.capture.named': (p) => `Added ${p.name}`,
  'report.generate.condition': (p) => `Made a condition report for ${p.name}`,
  'report.generate.move': (p) => `Made a moving report for ${p.name}`,
  undo: (p) => `Undid a change to ${p.name}`,
  event: (p) => fallback(p.action ?? ''),
  'brand.create': () => 'Brand added',
  'brand.update': () => 'Brand changed',
  'brand.delete': () => 'Brand deleted',
  'brand.merge': () => 'Brand merged',
  'vendor.create': () => 'Vendor added',
  'vendor.update': () => 'Vendor changed',
  'vendor.delete': () => 'Vendor deleted',
  'vendor.merge': () => 'Vendor merged',
  'person.create': () => 'Person added',
  'person.update': () => 'Person changed',
  'person.delete': () => 'Person deleted',
  'person.merge': () => 'Person merged',
  'person.contact_update': () => 'Contact details changed',
  'tag.create': () => 'Tag added',
  'tag.update': () => 'Tag changed',
  'tag.delete': () => 'Tag deleted',
  'tag.merge': () => 'Tag merged',
  'type.create': () => 'Type added',
  'type.update': () => 'Type changed',
  'type.delete': () => 'Type deleted',
  'type.merge': () => 'Type merged',
  'type.customise': () => 'Type customised',
  'type_field.create': () => 'Field added',
  'type_field.update': () => 'Field changed',
  'type_field.archive': () => 'Field archived',
  'type_field.restore': () => 'Field restored',
  'place_kind.create': () => 'Place kind added',
  'place_kind.update': () => 'Place kind changed',
  'place_kind.customise': () => 'Place kind customised',
  'file.upload': () => 'File uploaded',
  'file.delete_original': () => 'Original file deleted',
  'purchase.create': () => 'Purchase added',
  'purchase.update': () => 'Purchase changed',
  'purchase.delete': () => 'Purchase deleted',
  'purchase_line.create': () => 'Purchase line added',
  'purchase_line.update': () => 'Purchase line changed',
  'purchase_line.delete': () => 'Purchase line deleted',
  'thing.purchase_link': () => 'Linked to a purchase',
  'thing.purchase_unlink': () => 'Unlinked from a purchase',
  'thing.label': () => 'Label assigned',
  'meter.create': () => 'Meter added',
  'meter.update': () => 'Meter changed',
  'meter.replaced': () => 'Meter replaced',
  'reading.create': () => 'Reading logged',
  'reading.update': () => 'Reading changed',
  'reading.accept': () => 'Reading kept',
  'reading.delete': () => 'Reading discarded',
  'saved_view.create': () => 'Saved view added',
  'location.create': () => 'Location created',
  'location.update': () => 'Location settings changed',
  'location.modules': () => 'What to track changed',
  'location.delete': () => 'Location deleted',
  'location.restore': () => 'Location restored',
  'invite.create': () => 'Invite created',
  'invite.update': () => 'Invite changed',
  'invite.revoke': () => 'Invite revoked',
  'member.join': () => 'Member joined',
  'member.leave': () => 'Member left',
  'member.update': () => "Member's role changed",
  'member.expire': () => 'Membership ended',
  'managed_account.create': () => 'Managed account created',
  'saved_view.update': () => 'Saved view changed',
  'saved_view.delete': () => 'Saved view deleted',
  'secret.set': () => 'Secret changed',
  'secret.clear': () => 'Secret cleared',
  'secret.reveal': () => 'Secret revealed',
  'secret.copied': () => 'Secret copied',
  'secret_policy.update': () => 'Secret policy changed',
  'warranty.create': () => 'Warranty added',
  'warranty.update': () => 'Warranty changed',
  'warranty.delete': () => 'Warranty removed',
  'claim.create': () => 'Claim opened',
  'claim.update': () => 'Claim changed',
  'claim.delete': () => 'Claim deleted',
  'valuation.create': () => 'Valuation added',
  'valuation.update': () => 'Valuation changed',
  'valuation.delete': () => 'Valuation deleted',
  'loan.create': () => 'Loan added',
  'loan.update': () => 'Loan changed',
  'loan.return': () => 'Loan returned',
  'loan.delete': () => 'Loan deleted',
  'schedule.create': () => 'Schedule added',
  'schedule.update': () => 'Schedule changed',
  'schedule.delete': () => 'Schedule deleted',
  'schedule.snooze': () => 'Schedule snoozed',
  'schedule.unsnooze': () => 'Snooze cleared',
  'schedule.skip': () => 'Next one skipped',
  'service_record.create': () => 'Service logged',
  'service_record.update': () => 'Service changed',
  'service_record.delete': () => 'Service deleted',
  'service_record.draft': () => 'Service draft started from an invoice',
  'service_record.confirm': () => 'Service logged',
  'meter.delete': () => 'Meter removed',
  'fuel.create': () => 'Fuel logged',
  'fuel.update': () => 'Fuel changed',
  'fuel.delete': () => 'Fuel deleted',
  'schedule.starter': () => 'Starter schedules added',
  'document.create': () => 'Document added',
  'document.update': () => 'Document changed',
  'document.renew': () => 'Document renewed',
  'document.delete': () => 'Document deleted',
  'incident.create': () => 'Incident recorded',
  'incident.update': () => 'Incident changed',
  'incident.things': () => "Incident's things changed",
  'incident.delete': () => 'Incident deleted',
  'fx_rate.set': () => 'Exchange rate set',
  'fx_rate.delete': () => 'Exchange rate deleted',
  'brand.logo_set': () => 'Brand logo changed',
  'brand.logo_remove': () => 'Brand logo removed',
  'thing.stock_rule': () => 'Minimum to keep changed',
  'type.field_convert': () => 'Field converted',
  'things.export_csv': () => 'List exported as a CSV',
  'file.import': () => 'File imported',
  'webhook.create': () => 'Webhook added',
  'webhook.update': () => 'Webhook changed',
  'webhook.delete': () => 'Webhook removed',
  'webhook.rotate_secret': () => 'Webhook secret replaced',
  'share_link.create': () => 'Share link made',
  'share_link.revoke': () => 'Share link revoked',
  'move.create': () => 'Move started',
  'move.update': () => 'Move changed',
  'move.delete': () => 'Move deleted',
  'move_box.create': () => 'Added to a move as a box',
  'move_box.update': () => 'Moving box changed',
  'move_box.unpack': () => 'Box unpacked',
  'move_box.delete': () => 'Taken out of a move',
  'paperless.connect': () => 'Paperless connected',
  'paperless.update': () => 'Paperless connection changed',
  'paperless.disconnect': () => 'Paperless disconnected',
  'paperless_link.create': () => 'Paperless document linked',
  'paperless_link.delete': () => 'Paperless document unlinked',
  'paperless_link.copy': () => 'Paperless document copied into Kept',
  'purchase.reextract': () => 'Receipt read again',
  'thing.enrich': () => 'Other names added',
  'import.enrich': () => 'Other names requested for an import',
  'import.homebox_connect': () => 'Connected to Homebox',
  'instance.setup': () => 'Kept set up',
  'instance.settings_update': () => 'Instance settings changed',
  'instance.backup': () => 'Backup made',
  'instance.backup_run': () => 'Backup started by hand',
  'instance.backup_settings': () => 'Backup settings changed',
  'instance.backup_test': () => 'Backup target tested',
  'instance.restore': () => 'Restored from a backup',
  'instance.export': () => 'Whole instance exported',
  'instance.downgrade_forced': () => 'Started on an older version anyway',
  'instance.rotate_key': () => 'Encryption key replaced',
  'instance.drop_key': () => 'Old encryption key removed',
  'instance.embeddings_source': () => 'Semantic search source changed',
  'instance.recovery_kit_download': () => 'Recovery kit downloaded',
  'instance.recovery_kit_acknowledge': () => 'Recovery kit noted as kept',
  'instance.update_check': () => 'Checked for updates',
  'instance.setup_code_reissue': () => 'New setup code issued',
  'instance.oidc_changed': () => 'OIDC sign-in settings changed',
  'instance.smtp_changed': () => 'Email settings changed',
  'attachment.create.photo': (p) => `Added a photo to ${p.name}`,
  'thing.capture': (p) => `Captured ${p.name} from a photo`,
  'thing.capture.reading': (p) => `Logged a reading of ${p.name} from a photo`,
  'thing.extract': (p) => `Filled in ${p.name} from a photo`,
  'thing.reextract': (p) => `Read the photo of ${p.name} again`,
  'thing.merge': (p) => `Merged a duplicate into ${p.name}`,
  'box.check': (p) => `Checked what is in ${p.name}`,
  'label.claim': (p) => `Gave ${p.name} a label`,
  'location.own_codes': (p) => `Changed how ${p.name} numbers its codes`,
  'location.transfer_ownership': (p) => `Handed ${p.name} to a new owner`,
  'report.generate': (p) => `Made an inventory report of ${p.name}`,
  'report.generate.insurance': (p) => `Made an insurance report for ${p.name}`,
  'report.generate.vehicle': (p) => `Made a vehicle history report for ${p.name}`,
  'account.deletion_cancel': () => 'Cancelled the account deletion',
  'account.deletion_request': () => 'Asked to delete the account',
  'account.email_change': () => 'Changed the account email',
  'admin.cli_reset_password': () => 'Reset a password from the command line',
  'admin.cli_user_disable': () => 'Turned off an account from the command line',
  'admin.cli_user_enable': () => 'Turned an account back on from the command line',
  'admin.currency_disable': () => 'Turned off a currency',
  'admin.currency_enable': () => 'Turned on a currency',
  'admin.instance_admin_grant': () => 'Made someone an instance admin',
  'admin.instance_admin_revoke': () => 'Removed an instance admin',
  'admin.job_discard': () => 'Discarded a failed job',
  'admin.job_retry': () => 'Retried a failed job',
  'admin.user_disable': () => 'Turned off an account',
  'admin.user_enable': () => 'Turned an account back on',
  'admin.user_reset_2fa': () => 'Reset someone’s two-step sign-in',
  'admin.user_sign_out_everywhere': () => 'Signed someone out everywhere',
  'ai.cap_clear': () => 'Removed the AI spending cap',
  'ai.cap_set': () => 'Set the AI spending cap',
  'ai.pause': () => 'Paused AI',
  'ai.resume': () => 'Resumed AI',
  'ai.price_prefill': () => 'Looked up AI prices',
  'ai.price_recost': () => 'Worked out AI costs again with new prices',
  'ai.price_remove': () => 'Removed an AI price',
  'ai.price_set': () => 'Set an AI price',
  'ai.provider_models': () => 'Listed an AI provider’s models',
  'ai.provider_remove': () => 'Removed an AI provider',
  'ai.provider_set': () => 'Set up an AI provider',
  'ai.provider_test': () => 'Tested an AI provider',
  'ai.usage_export': () => 'Exported AI usage',
  'instance.google_changed': () => 'Google sign-in settings changed',
  'managed_account.password_set': () => 'Set a managed account’s password',
  'managed_account.reset_code': () => 'Made a reset code for a managed account',
  'me.notification_preferences': () => 'Changed notification settings',
  'me.notifications': () => 'Changed which notifications arrive',
  'me.preferences': () => 'Changed preferences',
  'session.revoke': () => 'Signed out a session',
  'oauth.deny': () => 'Turned down an app’s request to connect',
  'oauth.grant': () => 'Let an app connect',
  'token.create': () => 'Made an access token',
  'token.revoke': () => 'Revoked an access token',
  'token.update': () => 'Changed an access token',
  'push_subscription.create': () => 'Turned on notifications on a device',
  'push_subscription.delete': () => 'Turned off notifications on a device',
  'push_subscription.update': () => 'Changed notifications on a device',
  'hint.dismiss': () => 'Dismissed a tip',
  'hint.restore': () => 'Brought back a tip',
  'hint.seen': () => 'Read a tip',
  'saved_view_prefs.update': () => 'Changed how a list shows',
  'member.remove': () => 'Removed a member',
  'member.recap': () => 'Changed when guest access ends',
  'member.owner_notified': () => 'Told the owner about a new guest',
  'mailbox.create': () => 'Set up the mailbox',
  'mailbox.update': () => 'Changed the mailbox',
  'mailbox.delete': () => 'Removed the mailbox',
  'channel.create': () => 'Added a notification channel',
  'channel.delete': () => 'Removed a notification channel',
  'calendar_feed.create': () => 'Made a calendar feed',
  'calendar_feed.revoke': () => 'Revoked a calendar feed',
  'capture.batch_undo': () => 'Undid a capture',
  'inbox.discard': () => 'Discarded a draft',
  'inbox.resolve': () => 'Dealt with an inbox item',
  'inbox.restore': () => 'Brought back an inbox item',
  'inbox.bulk': () => 'Changed several inbox items at once',
  'labels.printed': () => 'Printed labels',
  'purchase.capture': () => 'Captured a receipt',
  'purchase.confirm': () => 'Confirmed a receipt',
  'purchase.extract': () => 'Read a receipt',
  'reading.extract': () => 'Read a meter from a photo',
  'file.crop': () => 'Cropped a photo',
  'file.display_set': () => 'Changed the photo shown',
  'template.create': () => 'Added a template',
  'template.update': () => 'Changed a template',
  'template.delete': () => 'Deleted a template',
  'claim.status': () => 'Changed a claim’s status',
  'claim_pack.create': () => 'Made a claim pack',
  'claim_pack.link': () => 'Shared a claim pack link',
  'claim_pack.link_revoke': () => 'Revoked a claim pack link',
  'condition_report.create': () => 'Started a condition report',
  'condition_report.update': () => 'Changed a condition report',
  'condition_report.finish': () => 'Finished a condition report',
  'condition_report.delete': () => 'Deleted a condition report',
  'condition_room.create': () => 'Added a room to a condition report',
  'condition_room.update': () => 'Changed a room in a condition report',
  'condition_room.delete': () => 'Removed a room from a condition report',
  'export.create': () => 'Started an export',
  'export.cancel': () => 'Cancelled an export',
  'export.download': () => 'Downloaded an export',
  'export.secrets': () => 'Put secrets in an export',
  'import.create': () => 'Uploaded a file to import',
  'import.archive': () => 'Uploaded an archive to import',
  'import.inspect': () => 'Opened an archive to import',
  'import.passphrase': () => 'Entered an import’s passphrase',
  'import.target': () => 'Chose where an import goes',
  'import.choices': () => 'Changed an import’s choices',
  'import.check': () => 'Checked an import',
  'import.start': () => 'Started an import',
  'import.run': () => 'Ran an import',
  'import.cancel': () => 'Cancelled an import',
  'report.export_csv': () => 'Exported a report as a CSV',
  'report.schedule': () => 'Scheduled a report',
  'report.unschedule': () => 'Stopped a scheduled report',
  'label_batch.create': (p) => plural(p.count, 'Made # blank label', 'Made # blank labels'),
  'label_batch.create.things': (p) =>
    plural(p.count, 'Made labels for # thing', 'Made labels for # things'),
  'label_batch.create.places': (p) =>
    plural(p.count, 'Made labels for # place', 'Made labels for # places'),
};

/** English for every detail line. */
const LINE_ENGLISH: Record<SummaryLineKey, Sentence> = {
  'line.things': (p) => plural(p.count, '# thing', '# things'),
  'line.inside': (p) => plural(p.count, 'With # thing inside', 'With # things inside'),
  'line.moved_out': (p) => plural(p.count, '# thing taken out first', '# things taken out first'),
  'line.photos': () => 'With photos',
  'map.put.room': (p) => `Put ${p.name} on the map in ${p.room}`,
  'map.put': (p) => `Put ${p.name} on the map`,
  'map.remove': (p) => `Took ${p.name} off the map`,
  'map.on': (p) => `Put ${p.name} on ${p.host}`,
  'map.off': (p) => `Took ${p.name} off ${p.host}`,
  'map.move': (p) => `Moved ${p.name}`,
  'map.turn': (p) => `Turned ${p.name}`,
  'map.shape': (p) => `Changed the shape of ${p.name}: ${p.from} → ${p.to}`,
  'map.resize': (p) => `Resized ${p.name}`,
  'map.kind': (p) => `Changed the kind of ${p.name}: ${p.from} → ${p.to}`,
  'map.floor': (p) => `Changed the floor of ${p.name}: ${p.from} → ${p.to}`,
};

/** "Brand added": the English for an action this build doesn't know. */
function fallback(action: string): string {
  const dot = action.indexOf('.');
  const entity = words(dot < 0 ? action : action.slice(0, dot));
  const verb = dot < 0 ? '' : action.slice(dot + 1);
  const said = verb ? words(verb) : 'changed';
  const subject = entity ? entity[0]?.toUpperCase() + entity.slice(1) : 'Something';
  return `${subject} ${said}`;
}

/** The noun for something whose name the viewer can't see (or that has none). */
const NOUNS: Record<string, string> = {
  thing: 'a thing',
  place: 'a place',
  attachment: 'a thing',
  type: 'a type',
  type_field: 'a field',
  place_kind: 'a place kind',
  brand: 'a brand',
  vendor: 'a vendor',
  person: 'a person',
  tag: 'a tag',
  location: 'the location',
  report: 'the location',
};

const words = (value: string) => value.replaceAll('_', ' ');

type Plain = { before: unknown; after: unknown; class: 'plain' };

function plainOf(event: RenderedAuditEvent, field: string): Plain | null {
  const change = event.diff?.[field];
  return change && change.class === 'plain' && 'before' in change ? (change as Plain) : null;
}

const afterOf = (event: RenderedAuditEvent, field: string) => plainOf(event, field)?.after;

const REPORT_KINDS: Record<string, SummaryKey> = {
  insurance: 'report.generate.insurance',
  vehicle_history: 'report.generate.vehicle',
  condition: 'report.generate.condition',
  move: 'report.generate.move',
};

/** The key of an event: its action, refined as the row says. */
function keyOf(event: RenderedAuditEvent, ctx: SummaryContext): SummaryKey {
  const { action } = event;
  if (event.movedInFromElsewhere) return 'thing.move.in';
  if (action === 'thing.move' && ctx.movedOut) return 'thing.move.out';
  const [entity] = action.split('.');
  // An undone trash writes the trash action again, with deleted_at going back to null.
  if (action.endsWith('.trash') && event.undo_of) {
    const deleted = plainOf(event, 'deleted_at');
    if (deleted && deleted.after === null && (entity === 'thing' || entity === 'place')) {
      return `${entity}.restore`;
    }
  }
  if (event.undo_of) return 'undo';
  switch (action) {
    // D236: the stock went back up (the line shrank or went, the service was deleted or undone).
    case 'thing.stock_use': {
      const q = plainOf(event, 'quantity');
      return q && Number(q.after) > Number(q.before) ? 'thing.stock_return' : action;
    }
    case 'thing.capture': {
      if (event.diff?.reading_id || event.diff?.meter_id) return 'thing.capture.reading';
      // A photo added to a thing that was there already: the row has no thing of its own.
      if (event.diff?.attachment_ids && !event.diff?.name) return 'thing.capture.attach';
      const files = afterOf(event, 'file_ids');
      return Array.isArray(files) && files.length === 0 ? 'thing.capture.named' : action;
    }
    case 'attachment.create':
      return afterOf(event, 'role') === 'photo' ? 'attachment.create.photo' : action;
    case 'report.generate':
      return REPORT_KINDS[String(afterOf(event, 'kind'))] ?? action;
    case 'label_batch.create': {
      const kind = afterOf(event, 'kind');
      return kind === 'things'
        ? 'label_batch.create.things'
        : kind === 'places'
          ? 'label_batch.create.places'
          : action;
    }
    default:
      return isAuditAction(action) || LEGACY.has(action) ? (action as SummaryKey) : 'event';
  }
}

const LEGACY: ReadonlySet<string> = new Set(LEGACY_AUDIT_ACTIONS);

const countOf = (value: unknown): number | null =>
  Array.isArray(value) ? value.length : typeof value === 'number' ? value : null;

/** What a report, a trash or an undone capture covered, in words (the raw fields stay hidden). */
export function linesOf(event: RenderedAuditEvent): SummaryLine[] {
  const out: SummaryLine[] = [];
  const count = (key: SummaryLineKey, n: number | null) => {
    if (n && n > 0) out.push({ key, params: { count: String(n) } });
  };
  switch (event.action) {
    case 'report.generate': {
      const filters = afterOf(event, 'filters') as Record<string, unknown> | null | undefined;
      count('line.things', countOf(filters?.thingIds));
      const include = afterOf(event, 'include') as Record<string, unknown> | null | undefined;
      if (include?.photos === true) out.push({ key: 'line.photos', params: {} });
      break;
    }
    case 'place.trash': {
      const trashed = countOf(afterOf(event, 'trashed'));
      // The place itself is one of them.
      count('line.inside', trashed === null ? null : trashed - 1);
      count('line.moved_out', countOf(afterOf(event, 'moved')));
      break;
    }
    case 'capture.batch_undo':
      count('line.things', countOf(afterOf(event, 'trashed') ?? afterOf(event, 'restored')));
      break;
    default:
      break;
  }
  return out;
}

function rendered(lines: readonly SummaryLine[]): RenderedLine[] {
  return lines.map((l) => ({ ...l, text: LINE_ENGLISH[l.key](l.params) }));
}

export function summarise(event: RenderedAuditEvent, ctx: SummaryContext): Summary {
  let key = keyOf(event, ctx);
  const params: SummaryParams = {};
  let lines: SummaryLine[] = [];
  if (event.action === 'place.arrange') {
    const layout = event.diff?.layout;
    if (layout && 'before' in layout) {
      lines = arrangeLines(
        layoutOf(layout.before) ?? [],
        layoutOf(layout.after) ?? [],
        ctx.nodes ?? new Map(),
      );
    }
    if (key === 'place.arrange' && lines.length > SUMMARY_LINES_INLINE) {
      key = 'place.arrange.many';
      params.count = String(lines.length);
    }
  } else {
    lines = linesOf(event);
  }
  if (key === 'event') {
    params.action = event.action;
  } else if (key !== 'thing.move.in') {
    const entity = event.entity.type;
    const fromDiff = plainOf(event, 'name');
    const diffName = [fromDiff?.after, fromDiff?.before].find(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    params.name = ctx.name ?? diffName ?? NOUNS[entity] ?? 'something';
    if (key === 'thing.stock_use' || key === 'thing.stock_return') {
      // The service's subject: its name (a noun when the reader can't see it), and its id for the
      // link, read from the rendered diff (plain ids, never money).
      const thing = afterOf(event, 'service_thing_id');
      const place = afterOf(event, 'service_place_id');
      params.service = ctx.service ?? (typeof place === 'string' ? 'a place' : 'a thing');
      if (typeof thing === 'string') params.serviceThingId = thing;
      else if (typeof place === 'string') params.servicePlaceId = place;
    }
    if (key === 'thing.lifecycle') {
      // The stored code (`given_away`), never English: the web says it in the reader's language.
      // Left out when the row shows no lifecycle change.
      const lifecycle = afterOf(event, 'lifecycle');
      if (typeof lifecycle === 'string') params.lifecycle = lifecycle;
    }
    if (key.startsWith('label_batch.create')) {
      params.count = String(countOf(afterOf(event, 'code_count')) ?? 0);
    }
  }
  return {
    summaryKey: key,
    summaryParams: params,
    summary: ENGLISH[key](params),
    ...(lines.length ? { summaryLines: rendered(lines) } : {}),
  };
}

/** The English of `key` with `params`: for the completeness test, and nothing else. */
export function englishOf(key: SummaryKey, params: SummaryParams): string {
  return ENGLISH[key](params);
}
