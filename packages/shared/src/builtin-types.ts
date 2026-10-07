/**
 * The built-in type library (D154, with D192's Device field group; engineering spec §7.9).
 * Read-only templates: `kept migrate` upserts them by `key` (`types.builtin_key`, stable), and
 * "Customise" copies one into an account (D92). Capabilities and fields are inherited down the
 * tree; a field group (Q4) is a built-in with `isFieldGroup`, referenced from `groups` and resolved
 * alongside inheritance. No field key may be redefined anywhere along a type's chain or groups.
 *
 * Icons are `lucide:<name>` or `tabler:<name>` (D98), each checked against lucide-react 1.48.0 and
 * @tabler/icons 3.48.0. Lucide's `vault` is a safe, so the safe needs no custom icon.
 */

import type { Capability, FieldKind } from './inventory.js';

export type Names = { readonly en: string; readonly ar: string };

export type FieldDef = {
  readonly key: string;
  readonly kind: FieldKind;
  readonly names: Names;
  /** The unit shown next to a number (never converted: D113). */
  readonly unit?: string;
  /** The choices of a select or multi_select. */
  readonly options?: readonly string[];
  /** Stored in the encrypted secrets store, never in `custom` (Q3, D154). */
  readonly secret?: boolean;
  /** Holds a list of values (D192: Wi-Fi and Ethernet MAC addresses). */
  readonly repeatable?: boolean;
};

export type DefaultMeter = { readonly kind: 'distance' | 'hours'; readonly unit: string };

export type BuiltinType = {
  readonly key: string;
  readonly parent?: string;
  readonly icon: string;
  /** Capabilities this type adds; its children inherit them. */
  readonly capabilities: readonly Capability[];
  /** The meter a new thing of this type starts with. `null` cancels an inherited one. */
  readonly defaultMeter?: DefaultMeter | null;
  /** Field groups (keys of `isFieldGroup` entries) whose fields this type carries. */
  readonly groups?: readonly string[];
  /** A field group, not a type a thing can have (Q4). */
  readonly isFieldGroup?: boolean;
  readonly names: Names;
  readonly fields: readonly FieldDef[];
};

const text = (key: string, en: string, ar: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  kind: 'text',
  names: { en, ar },
  ...extra,
});
const num = (key: string, en: string, ar: string, unit: string): FieldDef => ({
  key,
  kind: 'number',
  names: { en, ar },
  unit,
});

const DEVICE = ['device'] as const;

export const BUILTIN_TYPES: readonly BuiltinType[] = Object.freeze([
  {
    key: 'device',
    isFieldGroup: true,
    icon: 'lucide:cpu',
    capabilities: [],
    names: { en: 'Device', ar: 'بيانات الجهاز' },
    fields: [
      text('os', 'Operating system', 'نظام التشغيل'),
      text('os_version', 'OS version', 'إصدار نظام التشغيل'),
      text('firmware', 'Firmware', 'البرنامج الثابت'),
      text('mac_address', 'MAC address', 'عنوان MAC', { repeatable: true }),
      text('linked_account', 'Linked account or login', 'الحساب المرتبط', { secret: true }),
    ],
  },
  {
    key: 'furniture',
    icon: 'lucide:sofa',
    capabilities: [],
    names: { en: 'Furniture', ar: 'أثاث' },
    fields: [text('material', 'Material', 'الخامة'), text('dimensions', 'Dimensions', 'الأبعاد')],
  },
  {
    key: 'appliance',
    icon: 'lucide:refrigerator',
    capabilities: ['warranty', 'serialized'],
    names: { en: 'Appliance', ar: 'جهاز منزلي' },
    fields: [],
  },
  {
    key: 'large_appliance',
    parent: 'appliance',
    icon: 'lucide:washing-machine',
    capabilities: [],
    names: { en: 'Large appliance', ar: 'جهاز منزلي كبير' },
    fields: [],
  },
  {
    key: 'small_appliance',
    parent: 'appliance',
    icon: 'lucide:microwave',
    capabilities: [],
    names: { en: 'Small appliance', ar: 'جهاز منزلي صغير' },
    fields: [],
  },
  {
    key: 'electronics',
    icon: 'lucide:monitor-smartphone',
    capabilities: ['warranty', 'serialized'],
    names: { en: 'Electronics', ar: 'إلكترونيات' },
    fields: [],
  },
  {
    key: 'phone',
    parent: 'electronics',
    icon: 'lucide:smartphone',
    capabilities: [],
    groups: DEVICE,
    names: { en: 'Phone', ar: 'هاتف' },
    fields: [
      text('imei', 'IMEI', 'رقم IMEI'),
      text('imei_2', 'Second IMEI', 'رقم IMEI الثاني'),
      text('storage', 'Storage', 'سعة التخزين'),
    ],
  },
  {
    key: 'tablet',
    parent: 'electronics',
    icon: 'lucide:tablet',
    capabilities: [],
    groups: DEVICE,
    names: { en: 'Tablet', ar: 'جهاز لوحي' },
    fields: [text('imei', 'IMEI', 'رقم IMEI')],
  },
  {
    key: 'computer',
    parent: 'electronics',
    icon: 'lucide:laptop',
    capabilities: [],
    groups: DEVICE,
    names: { en: 'Computer', ar: 'كمبيوتر' },
    fields: [
      text('cpu', 'CPU', 'المعالج'),
      text('ram', 'RAM', 'الذاكرة العشوائية'),
      text('storage', 'Storage', 'سعة التخزين'),
      text('licence_key', 'Licence key', 'مفتاح الترخيص', { secret: true }),
    ],
  },
  {
    key: 'tv_display',
    parent: 'electronics',
    icon: 'lucide:tv',
    capabilities: [],
    groups: DEVICE,
    names: { en: 'TV / display', ar: 'تلفزيون / شاشة' },
    fields: [num('screen_size', 'Screen size', 'حجم الشاشة', 'in')],
  },
  {
    key: 'network_device',
    parent: 'electronics',
    icon: 'lucide:router',
    capabilities: [],
    groups: DEVICE,
    names: { en: 'Network device', ar: 'جهاز شبكة' },
    fields: [text('wifi_password', 'Wi-Fi password', 'كلمة مرور Wi-Fi', { secret: true })],
  },
  {
    key: 'camera',
    parent: 'electronics',
    icon: 'lucide:camera',
    capabilities: [],
    names: { en: 'Camera', ar: 'كاميرا' },
    fields: [],
  },
  {
    key: 'console',
    parent: 'electronics',
    icon: 'lucide:gamepad-2',
    capabilities: [],
    names: { en: 'Console', ar: 'جهاز ألعاب' },
    fields: [],
  },
  {
    key: 'cable',
    icon: 'lucide:cable',
    capabilities: ['consumable'],
    names: { en: 'Cable', ar: 'كابل' },
    fields: [
      text('connector_a', 'Connector A', 'الموصل (أ)'),
      text('connector_b', 'Connector B', 'الموصل (ب)'),
      num('length', 'Length', 'الطول', 'm'),
    ],
  },
  {
    key: 'charger',
    icon: 'lucide:plug-zap',
    capabilities: [],
    names: { en: 'Charger / power', ar: 'شاحن / مصدر طاقة' },
    fields: [num('wattage', 'Wattage', 'القدرة', 'W'), text('connector', 'Connector', 'الموصل')],
  },
  {
    key: 'tool',
    icon: 'lucide:wrench',
    capabilities: ['warranty', 'serialized'],
    names: { en: 'Tool', ar: 'أداة' },
    fields: [],
  },
  {
    key: 'power_tool',
    parent: 'tool',
    icon: 'lucide:drill',
    capabilities: [],
    names: { en: 'Power tool', ar: 'أداة كهربائية' },
    fields: [
      num('voltage', 'Voltage', 'الجهد', 'V'),
      text('battery_platform', 'Battery platform', 'نظام البطارية'),
    ],
  },
  {
    key: 'box_bin',
    icon: 'lucide:package',
    capabilities: ['container'],
    names: { en: 'Box / bin', ar: 'صندوق / حاوية' },
    fields: [],
  },
  {
    key: 'safe',
    icon: 'lucide:vault',
    capabilities: ['container', 'serialized'],
    names: { en: 'Safe', ar: 'خزنة' },
    fields: [text('combination', 'Combination', 'الرقم السري', { secret: true })],
  },
  {
    key: 'vehicle',
    icon: 'lucide:car-front',
    capabilities: ['container', 'metered', 'warranty', 'serialized'],
    defaultMeter: { kind: 'distance', unit: 'km' },
    names: { en: 'Vehicle', ar: 'مركبة' },
    fields: [text('vin', 'VIN', 'رقم الشاسيه')],
  },
  {
    key: 'car',
    parent: 'vehicle',
    icon: 'lucide:car',
    capabilities: [],
    names: { en: 'Car', ar: 'سيارة' },
    fields: [text('plate', 'Licence plate', 'رقم اللوحة')],
  },
  {
    key: 'motorbike',
    parent: 'vehicle',
    icon: 'lucide:motorbike',
    capabilities: [],
    names: { en: 'Motorbike', ar: 'دراجة نارية' },
    fields: [],
  },
  {
    key: 'bicycle',
    parent: 'vehicle',
    icon: 'lucide:bike',
    capabilities: [],
    defaultMeter: null,
    names: { en: 'Bicycle', ar: 'دراجة هوائية' },
    fields: [text('frame_number', 'Frame number', 'رقم الهيكل')],
  },
  {
    key: 'generator',
    parent: 'vehicle',
    icon: 'tabler:engine',
    capabilities: [],
    defaultMeter: { kind: 'hours', unit: 'h' },
    names: { en: 'Generator', ar: 'مولد كهربائي' },
    fields: [],
  },
  {
    key: 'safety_equipment',
    icon: 'lucide:hard-hat',
    capabilities: ['expires'],
    names: { en: 'Safety equipment', ar: 'معدات السلامة' },
    fields: [],
  },
  {
    key: 'fire_extinguisher',
    parent: 'safety_equipment',
    icon: 'lucide:fire-extinguisher',
    capabilities: [],
    names: { en: 'Fire extinguisher', ar: 'طفاية حريق' },
    fields: [],
  },
  {
    key: 'first_aid_kit',
    parent: 'safety_equipment',
    icon: 'lucide:briefcase-medical',
    capabilities: [],
    names: { en: 'First-aid kit', ar: 'حقيبة إسعافات أولية' },
    fields: [],
  },
  {
    key: 'smoke_detector',
    parent: 'safety_equipment',
    icon: 'lucide:alarm-smoke',
    capabilities: [],
    names: { en: 'Smoke detector', ar: 'كاشف دخان' },
    fields: [],
  },
  {
    key: 'child_car_seat',
    icon: 'lucide:baby',
    capabilities: ['serialized', 'expires'],
    names: { en: 'Child car seat', ar: 'كرسي سيارة للأطفال' },
    fields: [],
  },
  {
    key: 'valuables',
    icon: 'lucide:gem',
    capabilities: ['warranty'],
    names: { en: 'Valuables', ar: 'مقتنيات ثمينة' },
    fields: [
      {
        key: 'appraisal_value',
        kind: 'money',
        names: { en: 'Appraisal value', ar: 'قيمة التثمين' },
      },
      { key: 'appraisal_date', kind: 'date', names: { en: 'Appraisal date', ar: 'تاريخ التثمين' } },
    ],
  },
  {
    key: 'collectible',
    icon: 'lucide:trophy',
    capabilities: [],
    names: { en: 'Collectible', ar: 'مقتنيات للهواة' },
    fields: [
      text('edition', 'Edition', 'الإصدار'),
      text('condition_grade', 'Condition grade', 'درجة الحالة'),
      text('provenance_notes', 'Provenance notes', 'ملاحظات المصدر'),
    ],
  },
  {
    key: 'consumables',
    icon: 'lucide:shopping-basket',
    capabilities: ['consumable'],
    names: { en: 'Consumables', ar: 'مواد استهلاكية' },
    fields: [],
  },
  {
    key: 'batteries',
    parent: 'consumables',
    icon: 'lucide:battery-full',
    capabilities: [],
    names: { en: 'Batteries', ar: 'بطاريات' },
    fields: [text('size', 'Size', 'المقاس'), text('chemistry', 'Chemistry', 'النوع الكيميائي')],
  },
  {
    key: 'filters',
    parent: 'consumables',
    icon: 'lucide:funnel',
    capabilities: [],
    names: { en: 'Filters', ar: 'فلاتر' },
    fields: [text('fits', 'Fits', 'يناسب')],
  },
] satisfies BuiltinType[]);

const BY_KEY: ReadonlyMap<string, BuiltinType> = new Map(BUILTIN_TYPES.map((t) => [t.key, t]));

export function builtinType(key: string): BuiltinType | undefined {
  return BY_KEY.get(key);
}

/** The built-in field groups, by key. */
export const BUILTIN_FIELD_GROUPS: ReadonlyMap<string, BuiltinType> = new Map(
  BUILTIN_TYPES.filter((t) => t.isFieldGroup).map((t) => [t.key, t]),
);

/**
 * `key`'s ancestry, root first and `key` last. Throws on an unknown key or a cycle, so a
 * malformed library fails loudly in tests rather than looping.
 */
export function builtinTypeChain(key: string): BuiltinType[] {
  const chain: BuiltinType[] = [];
  const seen = new Set<string>();
  for (let k: string | undefined = key; k !== undefined; k = chain[0]?.parent) {
    if (seen.has(k)) throw new Error(`type cycle at ${k}`);
    seen.add(k);
    const t = BY_KEY.get(k);
    if (!t) throw new Error(`unknown built-in type ${k}`);
    chain.unshift(t);
  }
  return chain;
}

type ChainLink = { readonly capabilities: readonly Capability[] };

/** The union of capabilities along a chain (root first), in order of first appearance. */
export function resolveCapabilities(chain: readonly ChainLink[]): Capability[] {
  return [...new Set(chain.flatMap((t) => t.capabilities))];
}

/** The nearest `defaultMeter` along a chain (root first); `null` when cancelled or never set. */
export function resolveDefaultMeter(
  chain: readonly { readonly defaultMeter?: DefaultMeter | null }[],
): DefaultMeter | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]?.defaultMeter;
    if (m !== undefined) return m;
  }
  return null;
}
