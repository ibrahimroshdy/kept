/**
 * What feeds into Kept, and what Kept feeds: the landing page's integrations section
 * (components/landing/Integrations.astro), in English and Arabic.
 *
 * Only what exists. Each entry names the code that implements it (`code`, paths from the
 * repository root), checked when it was added; an entry whose code is gone must go too. `href`
 * is the docs page a person reads to set it up, without the locale: an Arabic page gets `/ar` in
 * front (a page not yet translated falls back to English there). The link check in the build
 * fails a page or heading that doesn't exist.
 *
 * No third-party logos: a neutral icon from the site's set (icons.ts) and the name in text.
 */
import type { IconName } from '../components/landing/icons';

interface Words {
  name: string;
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
          name: 'Spreadsheet (CSV)',
          body: 'One thing per row. Map the columns, check, then import.',
        },
        ar: { name: 'جدول بيانات (CSV)', body: 'شيء في كل صف. طابِق الأعمدة، وافحص، ثم استورد.' },
      },
      {
        id: 'homebox',
        icon: 'packageImport',
        href: '/users/import-export/#a-homebox-export',
        code: ['apps/server/src/imports/homebox/', 'apps/server/src/imports/archive.ts'],
        en: {
          name: 'Homebox',
          body: 'Its export ZIP, files included. Old Homebox labels still scan.',
        },
        ar: {
          name: 'Homebox',
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
          body: "A vehicle's fuel, service and odometer history, one CSV at a time.",
        },
        ar: { name: 'LubeLogger', body: 'سجل الوقود والصيانة والعدّاد لسيارة، ملف CSV في كل مرة.' },
      },
      {
        id: 'kept-export',
        icon: 'fileImport',
        href: '/users/import-export/#a-kept-export',
        code: ['apps/server/src/imports/kept/'],
        en: {
          name: 'Another Kept',
          body: 'A location exported from one Kept, imported into another.',
        },
        ar: { name: 'نسخة Kept أخرى', body: 'موقع مُصدَّر من Kept يُستورد في آخر.' },
      },
      {
        id: 'barcodes',
        icon: 'barcode',
        href: '/users/everyday-use/#short-ids-and-labels',
        code: ['apps/server/src/scan/barcode.ts'],
        en: {
          name: 'Product barcodes',
          body: 'Named from Open Food Facts, Open Products Facts or Open Beauty Facts, when the admin turns lookup on.',
        },
        ar: {
          name: 'الباركود',
          body: 'يُسمّى المنتج من Open Food Facts أو Open Products Facts أو Open Beauty Facts، إن فعّل المدير البحث.',
        },
      },
    ],
  },
  {
    id: 'capture',
    en: 'Capture',
    ar: 'الالتقاط',
    items: [
      {
        id: 'camera',
        icon: 'camera',
        href: '/users/phone-app/#camera-gallery-and-scanning',
        code: ['apps/server/src/capture/', 'apps/web/src/components/capture/'],
        en: {
          name: 'Camera',
          body: 'One photo per thing, straight into a room or box. Name it later.',
        },
        ar: { name: 'الكاميرا', body: 'صورة لكل شيء، مباشرةً إلى غرفة أو صندوق. والتسمية لاحقًا.' },
      },
      {
        id: 'email-in',
        icon: 'mail',
        href: '/users/everyday-use/#photos-receipts-manuals-and-warranties',
        code: ['apps/server/src/mailin/'],
        en: {
          name: 'Email-in (IMAP)',
          body: 'A mailbox folder you already have. Receipts that arrive become drafts.',
        },
        ar: {
          name: 'البريد الوارد (IMAP)',
          body: 'مجلد في بريد لديك. الإيصالات التي تصل تصبح مسودات.',
        },
      },
      {
        id: 'reading',
        icon: 'paperwork',
        href: '/users/ai-providers/#what-uses-ai-and-what-it-costs',
        code: ['apps/server/src/extraction/'],
        en: {
          name: 'Receipts and labels, read',
          body: 'With AI on: the purchase, the brand, model and serial, for you to accept.',
        },
        ar: {
          name: 'قراءة الإيصالات والملصقات',
          body: 'مع الذكاء الاصطناعي: الشراء والعلامة والطراز والرقم التسلسلي، لتقبلها أنت.',
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
        en: { name: 'Email', body: 'Reminders and a daily digest, over your own SMTP server.' },
        ar: { name: 'البريد الإلكتروني', body: 'التذكيرات وملخص يومي، عبر خادم SMTP خاص بك.' },
      },
      {
        id: 'web-push',
        icon: 'bell',
        href: '/admin/notifications/#web-push',
        code: ['apps/server/src/notify/push.ts', 'apps/server/src/notify/vapid.ts'],
        en: { name: 'Web push', body: 'On the phone and the desktop. No keys to set up.' },
        ar: { name: 'إشعارات الويب', body: 'على الهاتف والحاسوب. بلا مفاتيح تُعدّها.' },
      },
      {
        id: 'ntfy',
        icon: 'message',
        href: '/admin/notifications/#ntfy-and-telegram',
        code: ['apps/server/src/notify/relay.ts'],
        en: { name: 'ntfy', body: 'ntfy.sh or your own server, on a topic you choose.' },
        ar: { name: 'ntfy', body: 'ntfy.sh أو خادمك أنت، على موضوع تختاره.' },
      },
      {
        id: 'telegram',
        icon: 'send',
        href: '/admin/notifications/#ntfy-and-telegram',
        code: ['apps/server/src/notify/relay.ts'],
        en: { name: 'Telegram', body: 'Your own bot, to your chat.' },
        ar: { name: 'Telegram', body: 'بوتك أنت، إلى محادثتك.' },
      },
      {
        id: 'apprise',
        icon: 'speakerphone',
        href: '/admin/notifications/#apprise',
        code: ['apps/server/src/notify/senders.ts', 'apps/server/src/notify/channels.ts'],
        en: {
          name: 'Apprise',
          body: 'Discord, Slack, Matrix, Signal and more, through an Apprise server you run.',
        },
        ar: {
          name: 'Apprise',
          body: 'Discord وSlack وMatrix وSignal وغيرها، عبر خادم Apprise تشغّله.',
        },
      },
      {
        id: 'webhooks',
        icon: 'webhook',
        href: '/users/everyday-use/#reminders-and-notifications',
        code: ['apps/server/src/notify/webhook.ts', 'apps/server/src/webhooks/'],
        en: {
          name: 'Webhooks',
          body: 'Signed POSTs to your own scripts: reminders, and changes in a location.',
        },
        ar: {
          name: 'خطافات الويب',
          body: 'طلبات POST موقّعة إلى سكربتاتك: التذكيرات، والتغييرات في موقع.',
        },
      },
      {
        id: 'calendar',
        icon: 'calendar',
        href: '/admin/notifications/#the-calendar-feed',
        code: ['apps/server/src/calendar/'],
        en: { name: 'Calendar feed', body: "A private iCal link of what's due and what runs out." },
        ar: { name: 'رابط التقويم', body: 'رابط iCal خاص بما يحين موعده وما ينتهي.' },
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
        en: { name: 'Passkeys', body: 'Sign in with the phone or laptop you already unlock.' },
        ar: { name: 'مفاتيح المرور', body: 'ادخل بالهاتف أو الحاسوب الذي تفتحه أصلًا.' },
      },
      {
        id: 'two-factor',
        icon: 'shieldLock',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/auth.ts'],
        en: {
          name: 'Two-factor',
          body: 'An authenticator app or a passkey. A location can require it.',
        },
        ar: { name: 'التحقق بخطوتين', body: 'تطبيق مصادقة أو مفتاح مرور. ويمكن لموقع أن يشترطه.' },
      },
      {
        id: 'oidc',
        icon: 'login',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/oidc.ts'],
        en: {
          name: 'OIDC',
          body: 'Your own identity provider. New people still come in by invite or an allowed domain.',
        },
        ar: { name: 'OIDC', body: 'مزوّد الهوية الخاص بك. ويدخل الجدد بدعوة أو بنطاق مسموح.' },
      },
      {
        id: 'google',
        icon: 'login',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/google.ts'],
        en: {
          name: 'Google',
          body: 'For invited people and accounts that linked it. Never open sign-up.',
        },
        ar: { name: 'Google', body: 'للمدعوّين وللحسابات التي ربطته. بلا تسجيل مفتوح.' },
      },
    ],
  },
  {
    id: 'ai',
    en: 'AI and agents',
    ar: 'الذكاء الاصطناعي والوكلاء',
    items: [
      {
        id: 'providers',
        icon: 'ai',
        href: '/users/ai-providers/#providers',
        code: ['packages/shared/src/ai.ts', 'apps/server/src/ai/providers.ts'],
        en: {
          name: 'AI providers',
          body: 'Groq, OpenAI, Anthropic, Google, OpenRouter, or any OpenAI-compatible server. Your key, or none.',
        },
        ar: {
          name: 'مزوّدو الذكاء الاصطناعي',
          body: 'Groq وOpenAI وAnthropic وGoogle وOpenRouter، أو أي خادم متوافق مع OpenAI. مفتاحك أنت، أو لا شيء.',
        },
      },
      {
        id: 'ollama',
        icon: 'server',
        href: '/admin/ollama/',
        code: ['apps/server/src/ai/providers.ts', 'compose.yaml'],
        en: {
          name: 'Ollama',
          body: "A local model on your own machine, from Compose's ollama profile.",
        },
        ar: { name: 'Ollama', body: 'نموذج محلي على جهازك، من ملف التعريف ollama في Compose.' },
      },
      {
        id: 'assistant',
        icon: 'robot',
        href: '/users/ai-providers/',
        code: ['apps/server/src/assistant/'],
        en: {
          name: 'Assistant',
          body: 'Ask where something is. Answers cite the things; changes wait for you.',
        },
        ar: { name: 'المساعد', body: 'اسأل أين شيء ما. الأجوبة تذكر الأشياء، والتغييرات تنتظرك.' },
      },
      {
        id: 'mcp',
        icon: 'mcp',
        href: '/users/mcp-clients/',
        code: ['apps/server/src/mcp/', 'apps/server/src/oauth/', 'packages/mcp/'],
        en: {
          name: 'MCP server',
          body: 'Claude and other AI apps, with a personal token or OAuth, limited to the locations you pick.',
        },
        ar: {
          name: 'خادم MCP',
          body: 'Claude وتطبيقات الذكاء الاصطناعي الأخرى، برمز شخصي أو OAuth، في المواقع التي تختارها فقط.',
        },
      },
      {
        id: 'api',
        icon: 'api',
        href: '/developers/api/',
        code: ['apps/server/src/http/', 'apps/docs/scripts/openapi.ts'],
        en: { name: 'HTTP API', body: 'Documented with OpenAPI, for your own scripts.' },
        ar: { name: 'واجهة HTTP', body: 'موثّقة بـ OpenAPI، لسكربتاتك.' },
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
        code: ['apps/server/src/labels/', 'apps/server/src/codes/'],
        en: {
          name: 'Labels and QR codes',
          body: 'A4 sheets, Letter (Avery 5160 layout) and label-printer rolls.',
        },
        ar: {
          name: 'الملصقات ورموز QR',
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
          body: 'A box, a room or a search, read-only, for someone without an account.',
        },
        ar: { name: 'روابط المشاركة', body: 'صندوق أو غرفة أو بحث، للقراءة فقط، لمن لا حساب له.' },
      },
      {
        id: 'reports',
        icon: 'pdf',
        href: '/users/everyday-use/#reports-the-inventory-insurance-and-claims',
        code: ['apps/server/src/reports/'],
        en: {
          name: 'PDF reports',
          body: 'The inventory and the insurance report, emailed when ready. The inventory weekly or monthly too.',
        },
        ar: {
          name: 'تقارير PDF',
          body: 'الجرد وتقرير التأمين، بالبريد حين يجهزان. والجرد كل أسبوع أو شهر أيضًا.',
        },
      },
      {
        id: 'claim-pack',
        icon: 'insurance',
        href: '/users/everyday-use/#reports-the-inventory-insurance-and-claims',
        code: ['apps/server/src/incidents/claim-pack.ts'],
        en: {
          name: 'Claim pack',
          body: 'One ZIP for the insurer: the report, receipts, photos and serials.',
        },
        ar: {
          name: 'حزمة المطالبة',
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
          body: 'A whole location as a ZIP, with a copy you can read without Kept.',
        },
        ar: { name: 'التصدير', body: 'موقع كامل في ملف ZIP، مع نسخة تقرؤها من دون Kept.' },
      },
    ],
  },
];
