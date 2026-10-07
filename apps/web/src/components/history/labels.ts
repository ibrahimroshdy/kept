/**
 * Words for a rendered audit diff: field keys as the server's `renderAudit` names them (the
 * table's columns, `custom.<key>` for custom fields, D110) and the enum values that appear in
 * them. An unknown key is shown as itself, made readable ("insured_value" → "Insured value"):
 * a field the client doesn't know yet still says what changed.
 */
import { useLingui } from '@lingui/react/macro';
import type { HistoryEvent, RenderedChange } from '@/api/inventory/types';
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
 * `summaryKey` and `summaryParams` (apps/server/src/history/summary.ts). A key this build
 * doesn't know falls back to the server's English `summary`. The name in it is wrapped in FSI…PDI
 * (see `isolate`); EventRow renders those as <bdi> and strips them from accessible names.
 */
export function useSummary() {
  const { t } = useLingui();
  const words = useValueWords();
  // The server's stand-in nouns when the name isn't visible to the reader.
  const nouns: Record<string, string> = {
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
  return (e: Pick<HistoryEvent, 'summaryKey' | 'summaryParams' | 'summary'>) => {
    const raw = e.summaryParams.name ?? '';
    const name = nouns[raw] ?? isolate(raw);
    switch (e.summaryKey) {
      case 'thing.create':
      case 'place.create':
        return t`Added ${name}`;
      case 'thing.update':
      case 'place.update':
        return t`Edited ${name}`;
      case 'thing.retype':
        return t`Changed the type of ${name}`;
      case 'thing.lifecycle': {
        // The stored code (`given_away`), left out when the row shows no lifecycle change.
        const code = e.summaryParams.lifecycle;
        if (!code) return t`Changed the status of ${name}`;
        const status = words('lifecycle', code).toLocaleLowerCase();
        return t`Marked ${name} as ${status}`;
      }
      case 'thing.move':
      case 'place.move':
        return t`Moved ${name}`;
      case 'thing.move.in':
        return t`Moved in from another location`;
      case 'thing.move.out':
        return t`Moved ${name} to another location`;
      case 'thing.trash':
      case 'place.trash':
        return t`Trashed ${name}`;
      case 'thing.restore':
      case 'place.restore':
        return t`Restored ${name}`;
      case 'thing.delete':
      case 'place.delete':
        return t`Deleted ${name} for good`;
      case 'thing.seen':
        return t`Saw ${name}`;
      case 'thing.not_here':
        return t`Marked ${name} as not here`;
      case 'thing.split':
        return t`Split ${name}`;
      case 'thing.duplicate':
        return t`Duplicated ${name}`;
      case 'thing.link':
        return t`Linked ${name}`;
      case 'thing.unlink':
        return t`Unlinked ${name}`;
      case 'thing.convert_to_place':
        return t`Turned ${name} into a place`;
      case 'thing.codes':
      case 'place.codes':
        return t`Changed the codes of ${name}`;
      case 'place.merge':
        return t`Merged ${name} into another place`;
      case 'place.convert_to_container':
        return t`Turned ${name} into a container`;
      case 'place.label':
        return t`Labelled ${name}`;
      case 'attachment.create':
        return t`Attached a file to ${name}`;
      case 'attachment.update':
        return t`Changed a file on ${name}`;
      case 'attachment.delete':
        return t`Removed a file from ${name}`;
      case 'undo':
        return t`Undid a change to ${name}`;
      case 'event':
        return eventSentence(e.summaryParams.action ?? '') ?? e.summary;
      default:
        return e.summary;
    }
  };

  /** The events without a sentence of their own that step 2 writes. */
  function eventSentence(action: string): string | null {
    const known: Record<string, string> = {
      'brand.create': t`Brand added`,
      'brand.update': t`Brand changed`,
      'brand.delete': t`Brand deleted`,
      'brand.merge': t`Brand merged`,
      'vendor.create': t`Vendor added`,
      'vendor.update': t`Vendor changed`,
      'vendor.delete': t`Vendor deleted`,
      'vendor.merge': t`Vendor merged`,
      'person.create': t`Person added`,
      'person.update': t`Person changed`,
      'person.delete': t`Person deleted`,
      'person.merge': t`Person merged`,
      'person.contact_update': t`Contact details changed`,
      'tag.create': t`Tag added`,
      'tag.update': t`Tag changed`,
      'tag.delete': t`Tag deleted`,
      'tag.merge': t`Tag merged`,
      'type.create': t`Type added`,
      'type.update': t`Type changed`,
      'type.delete': t`Type deleted`,
      'type.merge': t`Type merged`,
      'type.customise': t`Type customised`,
      'type_field.create': t`Field added`,
      'type_field.update': t`Field changed`,
      'type_field.archive': t`Field archived`,
      'type_field.restore': t`Field restored`,
      'place_kind.create': t`Place kind added`,
      'place_kind.update': t`Place kind changed`,
      'place_kind.customise': t`Place kind customised`,
      'file.upload': t`File uploaded`,
      'file.delete_original': t`Original file deleted`,
      'purchase.create': t`Purchase added`,
      'purchase.update': t`Purchase changed`,
      'purchase.delete': t`Purchase deleted`,
      'purchase_line.create': t`Purchase line added`,
      'purchase_line.update': t`Purchase line changed`,
      'purchase_line.delete': t`Purchase line deleted`,
      'thing.purchase_link': t`Linked to a purchase`,
      'thing.purchase_unlink': t`Unlinked from a purchase`,
      'thing.label': t`Label assigned`,
      'meter.create': t`Meter added`,
      'meter.update': t`Meter changed`,
      'meter.replaced': t`Meter replaced`,
      'reading.create': t`Reading logged`,
      'reading.update': t`Reading changed`,
      'reading.accept': t`Reading kept`,
      'reading.delete': t`Reading discarded`,
      'saved_view.create': t`Saved view added`,
      'location.create': t`Location created`,
      'location.update': t`Location settings changed`,
      'location.modules': t`What to track changed`,
      'location.delete': t`Location deleted`,
      'location.restore': t`Location restored`,
      'invite.create': t`Invite created`,
      'invite.update': t`Invite changed`,
      'invite.revoke': t`Invite revoked`,
      'member.join': t`Member joined`,
      'member.leave': t`Member left`,
      'member.update': t`Member's role changed`,
      'member.expire': t`Membership ended`,
      'managed_account.create': t`Managed account created`,
      'saved_view.update': t`Saved view changed`,
      'saved_view.delete': t`Saved view deleted`,
      'secret.set': t`Secret changed`,
      'secret.clear': t`Secret cleared`,
      'secret.reveal': t`Secret revealed`,
      'secret.copied': t`Secret copied`,
      'secret_policy.update': t`Secret policy changed`,
      // Step 4 (T29).
      'warranty.create': t`Warranty added`,
      'warranty.update': t`Warranty changed`,
      'warranty.delete': t`Warranty removed`,
      'claim.create': t`Claim opened`,
      'claim.update': t`Claim changed`,
      'claim.delete': t`Claim deleted`,
      'valuation.create': t`Valuation added`,
      'valuation.update': t`Valuation changed`,
      'valuation.delete': t`Valuation deleted`,
      'loan.create': t`Loan added`,
      'loan.update': t`Loan changed`,
      'loan.return': t`Loan returned`,
      'loan.delete': t`Loan deleted`,
      'schedule.create': t`Schedule added`,
      'schedule.update': t`Schedule changed`,
      'schedule.delete': t`Schedule deleted`,
      'schedule.snooze': t`Schedule snoozed`,
      'schedule.unsnooze': t`Snooze cleared`,
      'schedule.skip': t`Next one skipped`,
      'service_record.create': t`Service logged`,
      'service_record.update': t`Service changed`,
      'service_record.delete': t`Service deleted`,
      // Step 5 (T20): an invoice attached first makes a draft; saving it confirms it.
      'service_record.draft': t`Service draft started from an invoice`,
      'service_record.confirm': t`Service logged`,
      'meter.delete': t`Meter removed`,
      'fuel.create': t`Fuel logged`,
      'fuel.update': t`Fuel changed`,
      'fuel.delete': t`Fuel deleted`,
      'schedule.starter': t`Starter schedules added`,
      'document.create': t`Document added`,
      'document.update': t`Document changed`,
      'document.renew': t`Document renewed`,
      'document.delete': t`Document deleted`,
      'incident.create': t`Incident recorded`,
      'incident.update': t`Incident changed`,
      'incident.things': t`Incident's things changed`,
      'incident.delete': t`Incident deleted`,
      'fx_rate.set': t`Exchange rate set`,
      'fx_rate.delete': t`Exchange rate deleted`,
      'brand.logo_set': t`Brand logo changed`,
      'brand.logo_remove': t`Brand logo removed`,
      // Step 7 (T17, T18, T16, T8): a consumable's minimum, a field converted, a list exported
      // as a CSV, and a file an archive import brought in.
      'thing.stock_rule': t`Minimum to keep changed`,
      'type.field_convert': t`Field converted`,
      'things.export_csv': t`List exported as a CSV`,
      'file.import': t`File imported`,
      // Step 6: location webhooks and reading a receipt again; step 7: other names from AI and
      // Homebox; step 8: the instance's own events (backups, keys, updates, setup).
      'webhook.create': t`Webhook added`,
      'webhook.update': t`Webhook changed`,
      'webhook.delete': t`Webhook removed`,
      'webhook.rotate_secret': t`Webhook secret replaced`,
      'purchase.reextract': t`Receipt read again`,
      'thing.enrich': t`Other names added`,
      'import.enrich': t`Other names requested for an import`,
      'import.homebox_connect': t`Connected to Homebox`,
      'instance.setup': t`Kept set up`,
      'instance.settings_update': t`Instance settings changed`,
      'instance.backup': t`Backup made`,
      'instance.backup_run': t`Backup started by hand`,
      'instance.backup_settings': t`Backup settings changed`,
      'instance.backup_test': t`Backup target tested`,
      'instance.restore': t`Restored from a backup`,
      'instance.export': t`Whole instance exported`,
      'instance.downgrade_forced': t`Started on an older version anyway`,
      'instance.rotate_key': t`Encryption key replaced`,
      'instance.drop_key': t`Old encryption key removed`,
      'instance.embeddings_source': t`Semantic search source changed`,
      'instance.recovery_kit_download': t`Recovery kit downloaded`,
      'instance.recovery_kit_acknowledge': t`Recovery kit noted as kept`,
      'instance.update_check': t`Checked for updates`,
      'instance.setup_code_reissue': t`New setup code issued`,
      'instance.oidc_changed': t`OIDC sign-in settings changed`,
      'instance.smtp_changed': t`Email settings changed`,
    };
    return known[action] ?? null;
  }
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
