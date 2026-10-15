/**
 * What feeds into Kept, and what Kept feeds, in English and Arabic. The one source for both places
 * that show it:
 *
 * - the landing page's wall (components/landing/Integrations.astro): each entry's `name` as a chip,
 *   grouped, linking to its entry on the integrations page;
 * - the integrations page (`/integrations/`, components/landing/IntegrationList.astro): a heading
 *   per group (the page's table of contents, src/route-data.ts), and per entry its `title` as a
 *   heading (the words a search would use: "Homebox import"), its `body`, and a link to the page
 *   that sets it up. The entry's `id` is its heading's anchor, so the wall can link to it.
 *
 * Only what exists. Each entry names the code that implements it (`code`, paths from the
 * repository root), checked when it was added and again on 2026-10-15; an entry whose code is gone
 * must go too. `href` is the docs page a person reads to set it up, without the locale: an Arabic
 * page gets `/ar` in front (a page not yet translated falls back to English there).
 *
 * No third-party logos: a neutral icon from the site's set (icons.ts) and the name in text.
 */
import type { IconName } from '../components/landing/icons';

interface Words {
  /** Short, for the landing page's chip. */
  name: string;
  /** The heading on the integrations page; `name` when it says enough. */
  title?: string;
  /** One or two fragments: what it does, from the user's side. */
  body: string;
}

export interface Integration {
  id: string;
  icon: IconName;
  href: string;
  code: string[];
  en: Words;
  ar: Words;
}

export interface IntegrationGroup {
  id: string;
  en: string;
  ar: string;
  items: Integration[];
}

export const integrationGroups: IntegrationGroup[] = [
  {
    id: 'bring-in',
    en: 'Bring things in',
    ar: 'أدخِل ما لديك',
    items: [
      {
        id: 'csv',
        icon: 'table',
        href: '/users/import-export/#a-spreadsheet-csv',
        code: ['apps/server/src/imports/csv.ts', 'apps/server/src/imports/routes.ts'],
        en: {
          name: 'CSV',
          title: 'Spreadsheet (CSV) import',
          body: 'One thing per row. Map the columns, check, then import.',
        },
        ar: {
          name: 'CSV',
          title: 'استيراد جدول بيانات (CSV)',
          body: 'شيء في كل صف. طابِق الأعمدة، وافحص، ثم استورد.',
        },
      },
      {
        id: 'homebox',
        icon: 'packageImport',
        href: '/users/import-export/#a-homebox-export',
        code: ['apps/server/src/imports/homebox/', 'apps/server/src/imports/archive.ts'],
        en: {
          name: 'Homebox',
          title: 'Homebox import',
          body: 'Its export ZIP, files included. Old Homebox labels still scan.',
        },
        ar: {
          name: 'Homebox',
          title: 'الاستيراد من Homebox',
          body: 'ملف التصدير ZIP بملفاته. وملصقات Homebox القديمة تُمسح كما هي.',
        },
      },
      {
        id: 'lubelogger',
        icon: 'vehicle',
        href: '/users/import-export/#a-vehicles-lubelogger-history',
        code: ['apps/server/src/imports/lubelogger.ts'],
        en: {
          name: 'LubeLogger',
          title: 'LubeLogger import',
          body: "A vehicle's fuel, service and odometer history. One CSV at a time.",
        },
        ar: {
          name: 'LubeLogger',
          title: 'الاستيراد من LubeLogger',
          body: 'سجل الوقود والصيانة والعدّاد لسيارة. ملف CSV في كل مرة.',
        },
      },
      {
        id: 'kept-export',
        icon: 'fileImport',
        href: '/users/import-export/#a-kept-export',
        code: ['apps/server/src/imports/kept/'],
        en: {
          name: 'Another Kept',
          title: 'Import from another Kept',
          body: 'A location exported from one Kept, imported into another.',
        },
        ar: {
          name: 'نسخة Kept أخرى',
          title: 'الاستيراد من نسخة Kept أخرى',
          body: 'موقع مُصدَّر من Kept يُستورد في آخر.',
        },
      },
      {
        id: 'barcodes',
        icon: 'barcode',
        href: '/users/everyday-use/#short-ids-and-labels',
        code: ['apps/server/src/scan/barcode.ts'],
        en: {
          name: 'Barcodes',
          title: 'Product barcode lookup',
          body: 'Named from Open Food Facts, Open Products Facts or Open Beauty Facts. Off until an admin turns it on.',
        },
        ar: {
          name: 'الباركود',
          title: 'البحث بباركود المنتج',
          body: 'يُسمّى المنتج من Open Food Facts أو Open Products Facts أو Open Beauty Facts. مُعطّل حتى يفعّله المدير.',
        },
      },
      {
        id: 'camera',
        icon: 'camera',
        href: '/users/phone-app/#camera-gallery-and-scanning',
        code: ['apps/server/src/capture/', 'apps/web/src/components/capture/'],
        en: {
          name: 'Camera',
          title: 'Camera capture',
          body: 'One photo per thing, straight into a room or box. Name it later.',
        },
        ar: {
          name: 'الكاميرا',
          title: 'الالتقاط بالكاميرا',
          body: 'صورة لكل شيء، مباشرةً إلى غرفة أو صندوق. والتسمية لاحقًا.',
        },
      },
      {
        id: 'email-in',
        icon: 'mail',
        href: '/users/everyday-use/#photos-receipts-manuals-and-warranties',
        code: ['apps/server/src/mailin/'],
        en: {
          name: 'Email-in',
          title: 'Email-in (IMAP)',
          body: 'A mailbox folder you already have. Receipts that arrive become drafts.',
        },
        ar: {
          name: 'البريد الوارد',
          title: 'البريد الوارد (IMAP)',
          body: 'مجلد في بريد لديك. الإيصالات التي تصل تصبح مسودات.',
        },
      },
      {
        id: 'reading',
        icon: 'paperwork',
        href: '/users/ai-providers/#what-uses-ai-and-what-it-costs',
        code: ['apps/server/src/extraction/'],
        en: {
          name: 'Receipt reading',
          title: 'Receipts and labels, read by AI',
          body: 'With AI on: the purchase, the brand, model and serial. You accept them.',
        },
        ar: {
          name: 'قراءة الإيصالات',
          title: 'قراءة الإيصالات والملصقات بالذكاء الاصطناعي',
          body: 'مع الذكاء الاصطناعي: الشراء والعلامة والطراز والرقم التسلسلي. وأنت تقبلها.',
        },
      },
    ],
  },
  {
    id: 'get-told',
    en: 'Get told',
    ar: 'التنبيهات',
    items: [
      {
        id: 'email',
        icon: 'mail',
        href: '/admin/notifications/#mail',
        code: ['apps/server/src/notify/senders.ts', 'apps/server/src/mail/'],
        en: {
          name: 'Email',
          title: 'Email notifications (SMTP)',
          body: 'Reminders and a daily digest. Over your own SMTP server.',
        },
        ar: {
          name: 'البريد الإلكتروني',
          title: 'التنبيهات بالبريد الإلكتروني (SMTP)',
          body: 'التذكيرات وملخص يومي. عبر خادم SMTP خاص بك.',
        },
      },
      {
        id: 'web-push',
        icon: 'bell',
        href: '/admin/notifications/#web-push',
        code: ['apps/server/src/notify/push.ts', 'apps/server/src/notify/vapid.ts'],
        en: {
          name: 'Web push',
          title: 'Web push notifications',
          body: 'On the phone and the desktop. No keys to set up.',
        },
        ar: {
          name: 'إشعارات الويب',
          body: 'على الهاتف والحاسوب. بلا مفاتيح تُعدّها.',
        },
      },
      {
        id: 'ntfy',
        icon: 'message',
        href: '/admin/notifications/#ntfy-and-telegram',
        code: ['apps/server/src/notify/relay.ts'],
        en: {
          name: 'ntfy',
          title: 'ntfy notifications',
          body: 'ntfy.sh or your own server, on a topic you choose.',
        },
        ar: {
          name: 'ntfy',
          title: 'التنبيهات عبر ntfy',
          body: 'ntfy.sh أو خادمك أنت، على موضوع تختاره.',
        },
      },
      {
        id: 'telegram',
        icon: 'send',
        href: '/admin/notifications/#ntfy-and-telegram',
        code: ['apps/server/src/notify/relay.ts'],
        en: {
          name: 'Telegram',
          title: 'Telegram notifications',
          body: 'Your own bot, to your chat.',
        },
        ar: { name: 'Telegram', title: 'التنبيهات عبر Telegram', body: 'بوتك أنت، إلى محادثتك.' },
      },
      {
        id: 'apprise',
        icon: 'speakerphone',
        href: '/admin/notifications/#apprise',
        code: ['apps/server/src/notify/senders.ts', 'apps/server/src/notify/channels.ts'],
        en: {
          name: 'Apprise',
          title: 'Apprise: Discord, Slack, Matrix, Signal',
          body: 'Discord, Slack, Matrix, Signal and more. Through an Apprise server you run.',
        },
        ar: {
          name: 'Apprise',
          title: 'Apprise: Discord وSlack وMatrix وSignal',
          body: 'Discord وSlack وMatrix وSignal وغيرها. عبر خادم Apprise تشغّله.',
        },
      },
      {
        id: 'calendar',
        icon: 'calendar',
        href: '/admin/notifications/#the-calendar-feed',
        code: ['apps/server/src/calendar/'],
        en: {
          name: 'Calendar feed',
          title: 'Calendar feed (iCal)',
          body: "A private iCal link. What's due, what runs out.",
        },
        ar: {
          name: 'رابط التقويم',
          title: 'رابط التقويم (iCal)',
          body: 'رابط iCal خاص. ما يحين موعده، وما ينتهي.',
        },
      },
    ],
  },
  {
    id: 'sign-in',
    en: 'Sign in',
    ar: 'تسجيل الدخول',
    items: [
      {
        id: 'passkeys',
        icon: 'fingerprint',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/auth.ts'],
        en: { name: 'Passkeys', body: 'The phone or laptop you already unlock.' },
        ar: { name: 'مفاتيح المرور', body: 'الهاتف أو الحاسوب الذي تفتحه أصلًا.' },
      },
      {
        id: 'two-factor',
        icon: 'shieldLock',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/auth.ts'],
        en: {
          name: 'Two-factor',
          title: 'Two-factor authentication',
          body: 'An authenticator app or a passkey. A location can require it.',
        },
        ar: {
          name: 'التحقق بخطوتين',
          body: 'تطبيق مصادقة أو مفتاح مرور. ويمكن لموقع أن يشترطه.',
        },
      },
      {
        id: 'oidc',
        icon: 'login',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/oidc.ts'],
        en: {
          name: 'OIDC',
          title: 'OIDC single sign-on',
          body: 'Your own identity provider. New people still need an invite or an allowed domain.',
        },
        ar: {
          name: 'OIDC',
          title: 'الدخول الموحّد عبر OIDC',
          body: 'مزوّد الهوية الخاص بك. ويدخل الجدد بدعوة أو بنطاق مسموح.',
        },
      },
      {
        id: 'google',
        icon: 'login',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/google.ts'],
        en: {
          name: 'Google',
          title: 'Sign in with Google',
          body: 'For invited people and accounts that linked it. Never open sign-up.',
        },
        ar: {
          name: 'Google',
          title: 'الدخول بحساب Google',
          body: 'للمدعوّين وللحسابات التي ربطته. بلا تسجيل مفتوح.',
        },
      },
    ],
  },
  {
    id: 'ai',
    en: 'AI and automation',
    ar: 'الذكاء الاصطناعي والأتمتة',
    items: [
      {
        id: 'providers',
        icon: 'ai',
        href: '/users/ai-providers/#providers',
        code: ['packages/shared/src/ai.ts', 'apps/server/src/ai/providers.ts'],
        en: {
          name: 'AI providers',
          title: 'AI providers: OpenAI, Anthropic, Google, Groq, OpenRouter',
          body: 'Or any OpenAI-compatible server. Your key, or none.',
        },
        ar: {
          name: 'مزوّدو الذكاء الاصطناعي',
          title: 'مزوّدو الذكاء الاصطناعي: OpenAI وAnthropic وGoogle وGroq وOpenRouter',
          body: 'أو أي خادم متوافق مع OpenAI. مفتاحك أنت، أو لا شيء.',
        },
      },
      {
        id: 'ollama',
        icon: 'server',
        href: '/admin/ollama/',
        code: ['apps/server/src/ai/providers.ts', 'compose.yaml'],
        en: {
          name: 'Ollama',
          title: 'Ollama (local AI)',
          body: "A local model on your own machine. Compose's ollama profile.",
        },
        ar: {
          name: 'Ollama',
          title: 'Ollama (ذكاء اصطناعي محلي)',
          body: 'نموذج محلي على جهازك. ملف التعريف ollama في Compose.',
        },
      },
      {
        id: 'assistant',
        icon: 'robot',
        href: '/users/ai-providers/',
        code: ['apps/server/src/assistant/'],
        en: {
          name: 'Assistant',
          title: 'AI assistant',
          body: 'Ask where something is. Answers cite the things; changes wait for you.',
        },
        ar: {
          name: 'المساعد',
          title: 'مساعد الذكاء الاصطناعي',
          body: 'اسأل أين شيء ما. الأجوبة تذكر الأشياء، والتغييرات تنتظرك.',
        },
      },
      {
        id: 'mcp',
        icon: 'mcp',
        href: '/users/mcp-clients/',
        code: ['apps/server/src/mcp/', 'apps/server/src/oauth/', 'packages/mcp/'],
        en: {
          name: 'MCP server',
          body: 'Claude and other AI apps. A personal token or OAuth, limited to the locations you pick.',
        },
        ar: {
          name: 'خادم MCP',
          body: 'Claude وتطبيقات الذكاء الاصطناعي الأخرى. برمز شخصي أو OAuth، في المواقع التي تختارها فقط.',
        },
      },
      {
        id: 'api',
        icon: 'api',
        href: '/developers/api/',
        code: ['apps/server/src/http/', 'apps/docs/scripts/openapi.ts'],
        en: {
          name: 'HTTP API',
          title: 'HTTP API (OpenAPI)',
          body: 'Documented with OpenAPI. For your own scripts.',
        },
        ar: {
          name: 'واجهة HTTP',
          title: 'واجهة HTTP (OpenAPI)',
          body: 'موثّقة بـ OpenAPI. لسكربتاتك.',
        },
      },
      {
        id: 'home-assistant',
        icon: 'places',
        href: '/users/home-assistant/',
        // The integration itself is its own repository (kept-homeassistant); this is Kept's side.
        code: ['apps/server/src/home/summary.ts', 'apps/server/src/tokens/access.ts'],
        en: {
          name: 'Home Assistant',
          body: "Overdue, due and expiring per location, each vehicle's next service. Odometer readings sent back.",
        },
        ar: {
          name: 'Home Assistant',
          body: 'المتأخر والمستحق وما ينتهي قريبًا لكل موقع، وموعد الصيانة التالية لكل مركبة. وقراءات العدّاد تُرسَل إلى Kept.',
        },
      },
      {
        id: 'dashboards',
        icon: 'insights',
        href: '/users/dashboards/',
        code: ['apps/server/src/home/summary.ts'],
        en: {
          name: 'Dashboards',
          title: 'Dashboards: Homepage, Glance, Homarr',
          body: 'What needs you, as a widget. One call, a read-only token.',
        },
        ar: {
          name: 'لوحات المعلومات',
          title: 'لوحات المعلومات: Homepage وGlance وHomarr',
          body: 'ما يحتاج إليك، في أداة على اللوحة. طلب واحد، برمز للقراءة فقط.',
        },
      },
      {
        id: 'webhooks',
        icon: 'webhook',
        href: '/users/everyday-use/#reminders-and-notifications',
        code: ['apps/server/src/notify/webhook.ts', 'apps/server/src/webhooks/'],
        en: {
          name: 'Webhooks',
          body: 'Signed POSTs to your own scripts. Reminders, and changes in a location.',
        },
        ar: {
          name: 'خطافات الويب',
          body: 'طلبات POST موقّعة إلى سكربتاتك. التذكيرات، والتغييرات في موقع.',
        },
      },
    ],
  },
  {
    id: 'share-print',
    en: 'Share and print',
    ar: 'المشاركة والطباعة',
    items: [
      {
        id: 'labels',
        icon: 'qrcode',
        href: '/users/everyday-use/#short-ids-and-labels',
        code: [
          'apps/server/src/labels/',
          'apps/server/src/codes/',
          'packages/shared/src/label-stocks.ts',
        ],
        en: {
          name: 'QR labels',
          title: 'Labels and QR codes',
          body: 'A4 sheets, Letter (Avery 5160 layout), label-printer rolls.',
        },
        ar: {
          name: 'ملصقات QR',
          title: 'الملصقات ورموز QR',
          body: 'أوراق A4 وLetter (بتخطيط Avery 5160) ولفّات طابعات الملصقات.',
        },
      },
      {
        id: 'share-links',
        icon: 'share',
        href: '/users/everyday-use/#sharing-a-location',
        code: ['apps/server/src/sharelinks/'],
        en: {
          name: 'Share links',
          title: 'Read-only share links',
          body: 'A box, a room or a search. For someone without an account.',
        },
        ar: {
          name: 'روابط المشاركة',
          title: 'روابط مشاركة للقراءة فقط',
          body: 'صندوق أو غرفة أو بحث. لمن لا حساب له.',
        },
      },
      {
        id: 'reports',
        icon: 'pdf',
        href: '/users/everyday-use/#reports-the-inventory-insurance-and-claims',
        code: ['apps/server/src/reports/'],
        en: {
          name: 'PDF reports',
          title: 'Inventory and insurance reports (PDF)',
          body: 'Emailed when ready. The inventory weekly or monthly too.',
        },
        ar: {
          name: 'تقارير PDF',
          title: 'تقارير الجرد والتأمين (PDF)',
          body: 'بالبريد حين تجهز. والجرد كل أسبوع أو شهر أيضًا.',
        },
      },
      {
        id: 'claim-pack',
        icon: 'insurance',
        href: '/users/everyday-use/#reports-the-inventory-insurance-and-claims',
        code: ['apps/server/src/incidents/claim-pack.ts'],
        en: {
          name: 'Claim pack',
          title: 'Insurance claim pack',
          body: 'One ZIP for the insurer: the report, receipts, photos, serials.',
        },
        ar: {
          name: 'حزمة المطالبة',
          title: 'حزمة مطالبة التأمين',
          body: 'ملف ZIP واحد لشركة التأمين: التقرير والإيصالات والصور والأرقام التسلسلية.',
        },
      },
      {
        id: 'export',
        icon: 'backup',
        href: '/users/import-export/#exporting',
        code: ['apps/server/src/exports/'],
        en: {
          name: 'Export',
          title: 'Export a location',
          body: 'A whole location as a ZIP. With a copy you can read without Kept.',
        },
        ar: {
          name: 'التصدير',
          title: 'تصدير موقع',
          body: 'موقع كامل في ملف ZIP. مع نسخة تقرؤها من دون Kept.',
        },
      },
    ],
  },
];

/** Every entry, in the groups' order. */
export const integrations: Integration[] = integrationGroups.flatMap((group) => group.items);
