/**
 * Words for a rendered audit diff: field keys as the server's `renderAudit` names them (the
 * table's columns, `custom.<key>` for custom fields, D110) and the enum values that appear in
 * them. An unknown key is shown as itself, made readable ("insured_value" → "Insured value"):
 * a field the client doesn't know yet still says what changed.
 */
import { SUMMARY_KEYS, type SummaryKey, type SummaryLineKey } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { HistoryEvent, RenderedChange, SummaryLineView } from '@/api/inventory/types';
import { useClaimStatusLabels } from '@/components/claims/labels';
import { useDocumentKindLabels } from '@/components/documents/labels';
import {
  useRoleLabels as useAttachmentRoleLabels,
  useLinkKindLabels,
  useReviewReasonLabels,
} from '@/components/things/labels';
import { useFieldLabel as useTypeFieldLabel } from '@/components/things/names';
import { useWarrantyKindLabels } from '@/components/warranties/labels';
import { isolate } from '@/lib/bidi';
import { useModelNames, useRoomKindNames, useSurfaceNames } from '@/map/labels';

/** "custom.insured_value" → "Insured value"; "safe_code" → "Safe code". */
export function readableKey(key: string): string {
  const bare = key.startsWith('custom.') ? key.slice('custom.'.length) : key;
  const words = bare.replace(/[_.-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function useFieldLabel() {
  const { t } = useLingui();
  const typeField = useTypeFieldLabel();
  const labels: Record<string, string> = {
    name: t`Name`,
    type_id: t`Type`,
    quantity: t`Quantity`,
    // Step 7 (T17): a consumable's "keep at least".
    minQuantity: t`Keep at least`,
    brand_id: t`Brand`,
    model: t`Model`,
    serial: t`Serial number`,
    barcode: t`Barcode`,
    colour: t`Colour`,
    condition: t`Condition`,
    notes: t`Notes`,
    aliases: t`Also called`,
    tag_ids: t`Tags`,
    tags: t`Tags`,
    belongs_to_person_id: t`Belongs to`,
    manual_url: t`Manual`,
    expires_on: t`Expires`,
    expiry_lead_days: t`Remind before expiry`,
    lifecycle: t`Status`,
    ended_on: t`Ended on`,
    ended_price: t`Price when it ended`,
    ended_currency: t`Currency`,
    ended_to: t`Ended with`,
    ended_notes: t`Notes on ending`,
    acquired_from: t`Acquired from`,
    provenance_notes: t`Where it came from`,
    location_uncertain: t`Not sure where`,
    place_id: t`Place`,
    container_id: t`Container`,
    parent_id: t`Inside`,
    kind_key: t`Kind`,
    icon: t`Icon`,
    sort: t`Order`,
    review_state: t`Review`,
    // Purchases, registries, files, meters and saved views (their audit rows' columns).
    purchased_on: t`Bought on`,
    total: t`Total`,
    tax: t`Tax`,
    currency: t`Currency`,
    unit_price: t`Unit price`,
    description: t`Description`,
    display_name: t`Name`,
    website: t`Website`,
    address: t`Address`,
    phone: t`Phone`,
    support_phone: t`Support phone`,
    claim_url: t`Warranty claims page`,
    default_warranty_months: t`Default warranty (months)`,
    kind: t`Kind`,
    role: t`Role`,
    mime: t`File type`,
    bytes: t`Size`,
    class: t`Kind of file`,
    value: t`Reading`,
    taken_at: t`Taken`,
    source: t`Source`,
    state: t`Review`,
    // A reading's review reason (step 3; UI step-4 review L10), in the Meters tab's words.
    review_reason: t`Why it needs a look`,
    note: t`Note`,
    // A field's label (type_field.label), not a printed label.
    label: t({ message: 'Label', context: 'field name' }),
    unit: t`Unit`,
    options: t`Choices`,
    required: t`Required`,
    max_per_day: t`Most per day`,
    offset: t`Offset`,
    shared: t`Shared`,
    query: t`Search`,
    last_seen_at: t`Last seen`,
    converted_from: t`Made from`,
    converted_to: t`Turned into`,
    discarded: t`Removed with it`,
    short_code: t`Label ID`,
    own_codes: t`Your codes`,
    // Step 4's records (T29): warranties, claims, valuations, loans, schedules, services,
    // documents and incidents.
    provider: t`Provider`,
    starts_on: t`Starts`,
    ends_on: t`Ends on`,
    term_months: t`Term (months)`,
    lifetime: t`Lifetime`,
    registered: t`Registered with the maker`,
    registration_deadline: t`Register by`,
    claim_contact: t`Claim contact`,
    opened_on: t`Opened on`,
    reference: t`Reference`,
    status: t`Status`,
    cost: t`Cost`,
    covered_amount: t`Covered`,
    closed_on: t`Closed on`,
    valued_on: t`Valued on`,
    direction: t`Direction`,
    started_at: t`Since`,
    due_on: t`Due on`,
    returned_at: t`Returned`,
    lead_days: t`Days of notice`,
    lead_units: t`Notice on the meter`,
    every_months: t`Every (months)`,
    every_units: t`Every (on the meter)`,
    base_on: t`Counted from`,
    base_value: t`Counted from the reading`,
    snoozed_until: t`Snoozed until`,
    snoozed_until_value: t`Snoozed until the reading`,
    skip_next: t`Skip the next one`,
    active: t`Active`,
    serviced_on: t`Done on`,
    reading_value: t`Reading`,
    title: t`Title`,
    occurred_on: t`Happened on`,
    police_reference: t`Police reference`,
    insurer_reference: t`Insurer reference`,
    // Step 5 (UI step-5 review M8): a document's issue date, a fill, and starter schedules.
    issued_on: t`Issued on`,
    amount: t`Amount`,
    is_full: t`Full tank`,
    missed_before: t`Missed a fill-up before it`,
    names: t`Schedules`,
  };
  // A valuation's `value` is money, not a meter's reading.
  const byEntity: Record<string, Record<string, string>> = { valuation: { value: t`Value` } };
  /**
   * A diff key's label. `custom.<key>` carries the field's own label, or the built-in's
   * `labelKey` (T27 decision), translated from the shared library.
   */
  return (key: string, change?: Pick<RenderedChange, 'label' | 'labelKey'>, entity?: string) => {
    if (change?.label) return change.label;
    if (change?.labelKey)
      return typeField({ label: null, labelKey: change.labelKey, key: change.labelKey });
    return (entity ? byEntity[entity]?.[key] : undefined) ?? labels[key] ?? readableKey(key);
  };
}

// The isolate marks (FSI…PDI) live in @/lib/bidi, shared with the loan lines (UI step-4 review L9).
export { FSI, PDI, plainText } from '@/lib/bidi';

/**
 * The summary line of a history or activity row in the reader's language, from the server's
 * `summaryKey` and `summaryParams` (apps/server/src/history/summary.ts). Every key the server
 * sends has a sentence here (#140: the map is typed by @kept/shared's SUMMARY_KEYS, so a new
 * action without one fails the typecheck); only a key this build doesn't know falls back to the
 * server's English `summary`. The name in it is wrapped in FSI…PDI (see `isolate`); EventRow
 * renders those as <bdi> and strips them from accessible names.
 */
export function useSummary() {
  const { t } = useLingui();
  const words = useValueWords();
  const nouns = useNouns();
  /** What a stock use was for: its name, or the server's noun when the reader can't see it. */
  const serviceName = (raw: string | undefined) => nouns[raw ?? ''] ?? isolate(raw ?? '');
  return (e: Pick<HistoryEvent, 'summaryKey' | 'summaryParams' | 'summary'>) => {
    const p = e.summaryParams;
    const raw = p.name ?? '';
    const name = nouns[raw] ?? isolate(raw);
    // An older server sends `event` with the action for what it had no sentence for.
    const key = e.summaryKey === 'event' ? (p.action ?? '') : e.summaryKey;
    if (!isSummaryKey(key) || key === 'event') return e.summary;
    if (key === 'thing.lifecycle') {
      // The stored code (`given_away`), left out when the row shows no lifecycle change.
      const code = p.lifecycle;
      if (!code) return t`Changed the status of ${name}`;
      const status = words('lifecycle', code).toLocaleLowerCase();
      return t`Marked ${name} as ${status}`;
    }
    const service = serviceName(p.service);
    const count = Number(p.count ?? 0);
    return sentences({ name, service, count })[key]();
  };

  /** Every key's sentence, built lazily: only the one asked for is translated. */
  function sentences({
    name,
    service,
    count,
  }: Vars): Record<Exclude<SummaryKey, 'event' | 'thing.lifecycle'>, () => string> {
    return {
      'thing.create': () => t`Added ${name}`,
      'place.create': () => t`Added ${name}`,
      'thing.update': () => t`Edited ${name}`,
      'place.update': () => t`Edited ${name}`,
      'thing.retype': () => t`Changed the type of ${name}`,
      'thing.move': () => t`Moved ${name}`,
      'place.move': () => t`Moved ${name}`,
      'thing.move.in': () => t`Moved in from another location`,
      'thing.move.out': () => t`Moved ${name} to another location`,
      'thing.trash': () => t`Trashed ${name}`,
      'place.trash': () => t`Trashed ${name}`,
      'thing.restore': () => t`Restored ${name}`,
      'place.restore': () => t`Restored ${name}`,
      'thing.delete': () => t`Deleted ${name} for good`,
      'place.delete': () => t`Deleted ${name} for good`,
      'thing.seen': () => t`Saw ${name}`,
      'thing.not_here': () => t`Marked ${name} as not here`,
      'thing.split': () => t`Split ${name}`,
      'thing.duplicate': () => t`Duplicated ${name}`,
      'thing.link': () => t`Linked ${name}`,
      'thing.unlink': () => t`Unlinked ${name}`,
      'thing.convert_to_place': () => t`Turned ${name} into a place`,
      'thing.codes': () => t`Changed the codes of ${name}`,
      'place.codes': () => t`Changed the codes of ${name}`,
      'place.merge': () => t`Merged ${name} into another place`,
      'place.convert_to_container': () => t`Turned ${name} into a container`,
      'place.label': () => t`Labelled ${name}`,
      'attachment.create': () => t`Attached a file to ${name}`,
      'attachment.update': () => t`Changed a file on ${name}`,
      'attachment.delete': () => t`Removed a file from ${name}`,
      'thing.stock_use': () => t`Used ${name} in a service of ${service}`,
      'thing.stock_return': () => t`Put ${name} back from a service of ${service}`,
      undo: () => t`Undid a change to ${name}`,
      'thing.capture.attach': () => t`Added a photo to ${name}`,
      'thing.capture.named': () => t`Added ${name}`,
      // Step 2 onwards: what used to fall back to the action's words.
      'brand.create': () => t`Brand added`,
      'brand.update': () => t`Brand changed`,
      'brand.delete': () => t`Brand deleted`,
      'brand.merge': () => t`Brand merged`,
      'vendor.create': () => t`Vendor added`,
      'vendor.update': () => t`Vendor changed`,
      'vendor.delete': () => t`Vendor deleted`,
      'vendor.merge': () => t`Vendor merged`,
      'person.create': () => t`Person added`,
      'person.update': () => t`Person changed`,
      'person.delete': () => t`Person deleted`,
      'person.merge': () => t`Person merged`,
      'person.contact_update': () => t`Contact details changed`,
      'tag.create': () => t`Tag added`,
      'tag.update': () => t`Tag changed`,
      'tag.delete': () => t`Tag deleted`,
      'tag.merge': () => t`Tag merged`,
      'type.create': () => t`Type added`,
      'type.update': () => t`Type changed`,
      'type.delete': () => t`Type deleted`,
      'type.merge': () => t`Type merged`,
      'type.customise': () => t`Type customised`,
      'type_field.create': () => t`Field added`,
      'type_field.update': () => t`Field changed`,
      'type_field.archive': () => t`Field archived`,
      'type_field.restore': () => t`Field restored`,
      'place_kind.create': () => t`Place kind added`,
      'place_kind.update': () => t`Place kind changed`,
      'place_kind.customise': () => t`Place kind customised`,
      'file.upload': () => t`File uploaded`,
      'file.delete_original': () => t`Original file deleted`,
      'purchase.create': () => t`Purchase added`,
      'purchase.update': () => t`Purchase changed`,
      'purchase.delete': () => t`Purchase deleted`,
      'purchase_line.create': () => t`Purchase line added`,
      'purchase_line.update': () => t`Purchase line changed`,
      'purchase_line.delete': () => t`Purchase line deleted`,
      'thing.purchase_link': () => t`Linked to a purchase`,
      'thing.purchase_unlink': () => t`Unlinked from a purchase`,
      'thing.label': () => t`Label assigned`,
      'meter.create': () => t`Meter added`,
      'meter.update': () => t`Meter changed`,
      'meter.replaced': () => t`Meter replaced`,
      'reading.create': () => t`Reading logged`,
      'reading.update': () => t`Reading changed`,
      'reading.accept': () => t`Reading kept`,
      'reading.delete': () => t`Reading discarded`,
      'saved_view.create': () => t`Saved view added`,
      'location.create': () => t`Location created`,
      'location.update': () => t`Location settings changed`,
      'location.modules': () => t`What to track changed`,
      'location.delete': () => t`Location deleted`,
      'location.restore': () => t`Location restored`,
      'invite.create': () => t`Invite created`,
      'invite.update': () => t`Invite changed`,
      'invite.revoke': () => t`Invite revoked`,
      'member.join': () => t`Member joined`,
      'member.leave': () => t`Member left`,
      'member.update': () => t`Member's role changed`,
      'member.expire': () => t`Membership ended`,
      'managed_account.create': () => t`Managed account created`,
      'saved_view.update': () => t`Saved view changed`,
      'saved_view.delete': () => t`Saved view deleted`,
      'secret.set': () => t`Secret changed`,
      'secret.clear': () => t`Secret cleared`,
      'secret.reveal': () => t`Secret revealed`,
      'secret.copied': () => t`Secret copied`,
      'secret_policy.update': () => t`Secret policy changed`,
      'warranty.create': () => t`Warranty added`,
      'warranty.update': () => t`Warranty changed`,
      'warranty.delete': () => t`Warranty removed`,
      'claim.create': () => t`Claim opened`,
      'claim.update': () => t`Claim changed`,
      'claim.delete': () => t`Claim deleted`,
      'valuation.create': () => t`Valuation added`,
      'valuation.update': () => t`Valuation changed`,
      'valuation.delete': () => t`Valuation deleted`,
      'loan.create': () => t`Loan added`,
      'loan.update': () => t`Loan changed`,
      'loan.return': () => t`Loan returned`,
      'loan.delete': () => t`Loan deleted`,
      'schedule.create': () => t`Schedule added`,
      'schedule.update': () => t`Schedule changed`,
      'schedule.delete': () => t`Schedule deleted`,
      'schedule.snooze': () => t`Schedule snoozed`,
      'schedule.unsnooze': () => t`Snooze cleared`,
      'schedule.skip': () => t`Next one skipped`,
      'service_record.create': () => t`Service logged`,
      'service_record.update': () => t`Service changed`,
      'service_record.delete': () => t`Service deleted`,
      'service_record.draft': () => t`Service draft started from an invoice`,
      'service_record.confirm': () => t`Service logged`,
      'meter.delete': () => t`Meter removed`,
      'fuel.create': () => t`Fuel logged`,
      'fuel.update': () => t`Fuel changed`,
      'fuel.delete': () => t`Fuel deleted`,
      'schedule.starter': () => t`Starter schedules added`,
      'document.create': () => t`Document added`,
      'document.update': () => t`Document changed`,
      'document.renew': () => t`Document renewed`,
      'document.delete': () => t`Document deleted`,
      'incident.create': () => t`Incident recorded`,
      'incident.update': () => t`Incident changed`,
      'incident.things': () => t`Incident's things changed`,
      'incident.delete': () => t`Incident deleted`,
      'fx_rate.set': () => t`Exchange rate set`,
      'fx_rate.delete': () => t`Exchange rate deleted`,
      'brand.logo_set': () => t`Brand logo changed`,
      'brand.logo_remove': () => t`Brand logo removed`,
      'thing.stock_rule': () => t`Minimum to keep changed`,
      'type.field_convert': () => t`Field converted`,
      'things.export_csv': () => t`List exported as a CSV`,
      'file.import': () => t`File imported`,
      'webhook.create': () => t`Webhook added`,
      'webhook.update': () => t`Webhook changed`,
      'webhook.delete': () => t`Webhook removed`,
      'webhook.rotate_secret': () => t`Webhook secret replaced`,
      'share_link.create': () => t`Share link made`,
      'share_link.revoke': () => t`Share link revoked`,
      'move.create': () => t`Move started`,
      'move.update': () => t`Move changed`,
      'move.delete': () => t`Move deleted`,
      'move_box.create': () => t`Added to a move as a box`,
      'move_box.update': () => t`Moving box changed`,
      'move_box.unpack': () => t`Box unpacked`,
      'move_box.delete': () => t`Taken out of a move`,
      'paperless.connect': () => t`Paperless connected`,
      'paperless.update': () => t`Paperless connection changed`,
      'paperless.disconnect': () => t`Paperless disconnected`,
      'paperless_link.create': () => t`Paperless document linked`,
      'paperless_link.delete': () => t`Paperless document unlinked`,
      'paperless_link.copy': () => t`Paperless document copied into Kept`,
      'purchase.reextract': () => t`Receipt read again`,
      'thing.enrich': () => t`Other names added`,
      'import.enrich': () => t`Other names requested for an import`,
      'import.homebox_connect': () => t`Connected to Homebox`,
      'instance.setup': () => t`Kept set up`,
      'instance.settings_update': () => t`Instance settings changed`,
      'instance.backup': () => t`Backup made`,
      'instance.backup_run': () => t`Backup started by hand`,
      'instance.backup_settings': () => t`Backup settings changed`,
      'instance.backup_test': () => t`Backup target tested`,
      'instance.restore': () => t`Restored from a backup`,
      'instance.export': () => t`Whole instance exported`,
      'instance.downgrade_forced': () => t`Started on an older version anyway`,
      'instance.rotate_key': () => t`Encryption key replaced`,
      'instance.drop_key': () => t`Old encryption key removed`,
      'instance.embeddings_source': () => t`Semantic search source changed`,
      'instance.recovery_kit_download': () => t`Recovery kit downloaded`,
      'instance.recovery_kit_acknowledge': () => t`Recovery kit noted as kept`,
      'instance.update_check': () => t`Checked for updates`,
      'instance.setup_code_reissue': () => t`New setup code issued`,
      'instance.oidc_changed': () => t`OIDC sign-in settings changed`,
      'instance.smtp_changed': () => t`Email settings changed`,
      // #140: a sentence for every other action, and the refinements.
      'attachment.create.photo': () => t`Added a photo to ${name}`,
      'thing.capture': () => t`Captured ${name} from a photo`,
      'thing.capture.reading': () => t`Logged a reading of ${name} from a photo`,
      'thing.extract': () => t`Filled in ${name} from a photo`,
      'thing.reextract': () => t`Read the photo of ${name} again`,
      'thing.merge': () => t`Merged a duplicate into ${name}`,
      'place.arrange': () => t`Arranged the map`,
      'box.check': () => t`Checked what is in ${name}`,
      'label.claim': () => t`Gave ${name} a label`,
      'location.own_codes': () => t`Changed how ${name} numbers its codes`,
      'location.transfer_ownership': () => t`Handed ${name} to a new owner`,
      'report.generate': () => t`Made an inventory report of ${name}`,
      'report.generate.insurance': () => t`Made an insurance report for ${name}`,
      'report.generate.vehicle': () => t`Made a vehicle history report for ${name}`,
      'account.deletion_cancel': () => t`Cancelled the account deletion`,
      'account.deletion_request': () => t`Asked to delete the account`,
      'account.email_change': () => t`Changed the account email`,
      'admin.cli_reset_password': () => t`Reset a password from the command line`,
      'admin.cli_user_disable': () => t`Turned off an account from the command line`,
      'admin.cli_user_enable': () => t`Turned an account back on from the command line`,
      'admin.currency_disable': () => t`Turned off a currency`,
      'admin.currency_enable': () => t`Turned on a currency`,
      'admin.instance_admin_grant': () => t`Made someone an instance admin`,
      'admin.instance_admin_revoke': () => t`Removed an instance admin`,
      'admin.job_discard': () => t`Discarded a failed job`,
      'admin.job_retry': () => t`Retried a failed job`,
      'admin.user_disable': () => t`Turned off an account`,
      'admin.user_enable': () => t`Turned an account back on`,
      'admin.user_reset_2fa': () => t`Reset someone’s two-step sign-in`,
      'admin.user_sign_out_everywhere': () => t`Signed someone out everywhere`,
      'ai.cap_clear': () => t`Removed the AI spending cap`,
      'ai.cap_set': () => t`Set the AI spending cap`,
      'ai.pause': () => t`Paused AI`,
      'ai.resume': () => t`Resumed AI`,
      'ai.price_prefill': () => t`Looked up AI prices`,
      'ai.price_recost': () => t`Worked out AI costs again with new prices`,
      'ai.price_remove': () => t`Removed an AI price`,
      'ai.price_set': () => t`Set an AI price`,
      'ai.provider_models': () => t`Listed an AI provider’s models`,
      'ai.provider_remove': () => t`Removed an AI provider`,
      'ai.provider_set': () => t`Set up an AI provider`,
      'ai.provider_test': () => t`Tested an AI provider`,
      'ai.usage_export': () => t`Exported AI usage`,
      'instance.google_changed': () => t`Google sign-in settings changed`,
      'managed_account.password_set': () => t`Set a managed account’s password`,
      'managed_account.reset_code': () => t`Made a reset code for a managed account`,
      'me.notification_preferences': () => t`Changed notification settings`,
      'me.notifications': () => t`Changed which notifications arrive`,
      'me.preferences': () => t`Changed preferences`,
      'session.revoke': () => t`Signed out a session`,
      'oauth.deny': () => t`Turned down an app’s request to connect`,
      'oauth.grant': () => t`Let an app connect`,
      'token.create': () => t`Made an access token`,
      'token.revoke': () => t`Revoked an access token`,
      'token.update': () => t`Changed an access token`,
      'push_subscription.create': () => t`Turned on notifications on a device`,
      'push_subscription.delete': () => t`Turned off notifications on a device`,
      'push_subscription.update': () => t`Changed notifications on a device`,
      'hint.dismiss': () => t`Dismissed a tip`,
      'hint.restore': () => t`Brought back a tip`,
      'hint.seen': () => t`Read a tip`,
      'saved_view_prefs.update': () => t`Changed how a list shows`,
      'member.remove': () => t`Removed a member`,
      'member.recap': () => t`Changed when guest access ends`,
      'member.owner_notified': () => t`Told the owner about a new guest`,
      'mailbox.create': () => t`Set up the mailbox`,
      'mailbox.update': () => t`Changed the mailbox`,
      'mailbox.delete': () => t`Removed the mailbox`,
      'channel.create': () => t`Added a notification channel`,
      'channel.delete': () => t`Removed a notification channel`,
      'calendar_feed.create': () => t`Made a calendar feed`,
      'calendar_feed.revoke': () => t`Revoked a calendar feed`,
      'capture.batch_undo': () => t`Undid a capture`,
      'inbox.discard': () => t`Discarded a draft`,
      'inbox.resolve': () => t`Dealt with an inbox item`,
      'inbox.restore': () => t`Brought back an inbox item`,
      'inbox.bulk': () => t`Changed several inbox items at once`,
      'labels.printed': () => t`Printed labels`,
      'purchase.capture': () => t`Captured a receipt`,
      'purchase.confirm': () => t`Confirmed a receipt`,
      'purchase.extract': () => t`Read a receipt`,
      'reading.extract': () => t`Read a meter from a photo`,
      'file.crop': () => t`Cropped a photo`,
      'file.display_set': () => t`Changed the photo shown`,
      'template.create': () => t`Added a template`,
      'template.update': () => t`Changed a template`,
      'template.delete': () => t`Deleted a template`,
      'claim.status': () => t`Changed a claim’s status`,
      'claim_pack.create': () => t`Made a claim pack`,
      'claim_pack.link': () => t`Shared a claim pack link`,
      'claim_pack.link_revoke': () => t`Revoked a claim pack link`,
      'condition_report.create': () => t`Started a condition report`,
      'condition_report.update': () => t`Changed a condition report`,
      'condition_report.finish': () => t`Finished a condition report`,
      'condition_report.delete': () => t`Deleted a condition report`,
      'condition_room.create': () => t`Added a room to a condition report`,
      'condition_room.update': () => t`Changed a room in a condition report`,
      'condition_room.delete': () => t`Removed a room from a condition report`,
      'export.create': () => t`Started an export`,
      'export.cancel': () => t`Cancelled an export`,
      'export.download': () => t`Downloaded an export`,
      'export.secrets': () => t`Put secrets in an export`,
      'import.create': () => t`Uploaded a file to import`,
      'import.archive': () => t`Uploaded an archive to import`,
      'import.inspect': () => t`Opened an archive to import`,
      'import.passphrase': () => t`Entered an import’s passphrase`,
      'import.target': () => t`Chose where an import goes`,
      'import.choices': () => t`Changed an import’s choices`,
      'import.check': () => t`Checked an import`,
      'import.start': () => t`Started an import`,
      'import.run': () => t`Ran an import`,
      'import.cancel': () => t`Cancelled an import`,
      'report.export_csv': () => t`Exported a report as a CSV`,
      'report.schedule': () => t`Scheduled a report`,
      'report.unschedule': () => t`Stopped a scheduled report`,
      'report.generate.condition': () => t`Made a condition report for ${name}`,
      'report.generate.move': () => t`Made a moving report for ${name}`,
      'label_batch.create': () =>
        plural(count, { one: 'Made # blank label', other: 'Made # blank labels' }),
      'label_batch.create.things': () =>
        plural(count, { one: 'Made labels for # thing', other: 'Made labels for # things' }),
      'label_batch.create.places': () =>
        plural(count, { one: 'Made labels for # place', other: 'Made labels for # places' }),
      'place.arrange.many': () =>
        plural(count, { one: 'Arranged the map: # change', other: 'Arranged the map: # changes' }),
    };
  }
}

type Vars = { name: string; service: string; count: number };

const KEYS: ReadonlySet<string> = new Set(SUMMARY_KEYS);
const isSummaryKey = (key: string): key is SummaryKey => KEYS.has(key);

/** The server's stand-in nouns when the name isn't visible to the reader. */
function useNouns(): Record<string, string> {
  const { t } = useLingui();
  return {
    'a thing': t`a thing`,
    'a place': t`a place`,
    'a type': t`a type`,
    'a field': t`a field`,
    'a place kind': t`a place kind`,
    'a brand': t`a brand`,
    'a vendor': t`a vendor`,
    'a person': t`a person`,
    'a tag': t`a tag`,
    'the location': t`the location`,
    something: t`something`,
  };
}

/**
 * A row's detail lines (#140) in the reader's language: an arrangement's changes and what a
 * report or a trash covered. Names are isolated like the summary's; a map shape, room kind or
 * floor arrives as its code and is said in the map's own words. A line this build doesn't know
 * shows the server's English.
 */
export function useSummaryLine() {
  const { t } = useLingui();
  const nouns = useNouns();
  const vocab: Record<string, Record<string, string>> = {
    model: useModelNames(),
    kind: useRoomKindNames(),
    surface: useSurfaceNames(),
  };
  return (line: SummaryLineView) => {
    const p = line.params;
    const named = (raw: string | undefined) => nouns[raw ?? ''] ?? isolate(raw ?? '');
    const said = (code: string | undefined) =>
      (p.vocab ? vocab[p.vocab]?.[code ?? ''] : undefined) ?? code ?? '';
    const name = named(p.name);
    const host = named(p.host);
    const room = named(p.room);
    const from = said(p.from);
    const to = said(p.to);
    const count = Number(p.count ?? 0);
    const all: Record<SummaryLineKey, () => string> = {
      'line.things': () => plural(count, { one: '# thing', other: '# things' }),
      'line.inside': () =>
        plural(count, { one: 'With # thing inside', other: 'With # things inside' }),
      'line.moved_out': () =>
        plural(count, { one: '# thing taken out first', other: '# things taken out first' }),
      'line.photos': () => t`With photos`,
      'map.put.room': () => t`Put ${name} on the map in ${room}`,
      'map.put': () => t`Put ${name} on the map`,
      'map.remove': () => t`Took ${name} off the map`,
      'map.on': () => t`Put ${name} on ${host}`,
      'map.off': () => t`Took ${name} off ${host}`,
      'map.move': () => t`Moved ${name}`,
      'map.turn': () => t`Turned ${name}`,
      'map.shape': () => t`Changed the shape of ${name}: ${from} → ${to}`,
      'map.resize': () => t`Resized ${name}`,
      'map.kind': () => t`Changed the kind of ${name}: ${from} → ${to}`,
      'map.floor': () => t`Changed the floor of ${name}: ${from} → ${to}`,
    };
    return (all as Record<string, (() => string) | undefined>)[line.key]?.() ?? line.text;
  };
}

/** Lifecycle and condition values (D119, Q10) as words; anything else as it is. */
export function useValueWords() {
  const { t } = useLingui();
  const words: Record<string, string> = {
    in_use: t`In use`,
    sold: t`Sold`,
    given_away: t`Given away`,
    lost: t`Lost`,
    disposed: t`Disposed of`,
    stolen: t`Stolen`,
    destroyed: t`Destroyed`,
    returned_to_owner: t`Returned to its owner`,
    new: t`New`,
    good: t`Good`,
    fair: t`Fair`,
    poor: t`Poor`,
    broken: t`Broken`,
    draft: t`Draft`,
    confirmed: t`Confirmed`,
  };
  const kinds: Record<string, string> = { thing: t`a thing`, place: t`a place` };
  const roles = useAttachmentRoleLabels() as Record<string, string>;
  // A link's kind (`accessory_of`) in words, as the Links section says it.
  const links = useLinkKindLabels() as Record<string, { from: string }>;
  const states: Record<string, string> = { accepted: t`Kept`, needs_review: t`Needs review` };
  const reasons = useReviewReasonLabels() as Record<string, string>;
  // Step 4 (T29): a claim's status, a loan's direction, a valuation's source, a record's kind.
  const claimStatus = useClaimStatusLabels() as Record<string, string>;
  const warrantyKinds = useWarrantyKindLabels() as Record<string, string>;
  const documentKinds = useDocumentKindLabels() as Record<string, string>;
  const byEntity: Record<string, Record<string, Record<string, string>>> = {
    claim: { status: claimStatus },
    loan: { direction: { out: t`Lent`, in: t`Borrowed` } },
    valuation: {
      source: {
        purchase: t`Purchase price`,
        appraisal: t`Appraisal`,
        estimate: t`Estimate`,
        insurer: t`Insurer's value`,
      },
    },
    warranty: { kind: warrantyKinds },
    document: { kind: documentKinds },
    incident: {
      kind: {
        burglary: t`Burglary`,
        fire: t`Fire`,
        flood: t`Flood`,
        loss: t({ message: 'Loss', context: 'incident kind' }),
        other: t({ message: 'Other', context: 'incident kind' }),
      },
    },
  };
  return (key: string, value: string, entity?: string) =>
    (entity ? byEntity[entity]?.[key]?.[value] : undefined) ??
    (key === 'lifecycle' || key === 'condition' || key === 'review_state'
      ? (words[value] ?? value)
      : key === 'role'
        ? (roles[value] ?? value)
        : key === 'state'
          ? (states[value] ?? value)
          : key === 'review_reason'
            ? (reasons[value] ?? value)
            : key === 'converted_from' || key === 'converted_to'
              ? (kinds[value] ?? value)
              : key === 'kind' && links[value]
                ? links[value].from
                : value);
}
