import { longDay, REMINDER_COUNT, REMINDER_WORDS, type ReminderFacts } from '../notify/words.js';
import {
  type Message,
  type MessageContext,
  type NotifyTable,
  type Of,
  page,
} from './message-kit.js';
import type { MailLocale } from './messages.js';

// Step 4's mail (plan T15; D29, D30, D46, D122, D204; L113), in every language Kept mails in:
// a reminder sent at once, the day's digest, a membership that ended, a channel's test and a
// webhook that stopped answering. The reminder wording itself is notify/words.ts, which the push
// payload and the calendar feed share. Every reminder names the thing, its path, the location
// and the local date (L113); none carries money or anyone's contact details.

const SETTINGS = '/settings/me/notifications';

type Words = {
  where: string;
  open: string;
  openKept: string;
  digestSubject: (count: string, day: string) => string;
  digestIntro: (day: string) => string;
  reminderFootnote: (url: string) => string;
  digestFootnote: (url: string) => string;
  role: Record<'admin' | 'member' | 'viewer', string>;
  ended: {
    subject: (member: string, location: string) => string;
    body: (member: string, location: string, role: string, day: string) => string;
    footnote: string;
  };
  test: { subject: string; body: string; footnote: string };
  failing: {
    subject: string;
    body: (name: string) => string;
    next: string;
    action: string;
    footnote: string;
  };
};

const WORDS: Record<MailLocale, Words> = {
  en: {
    where: 'Where',
    open: 'Open in Kept',
    openKept: 'Open Kept',
    digestSubject: (count, day) => `Kept: ${count} for ${day}`,
    digestIntro: (day) => `What’s due and expiring, as of ${day}:`,
    reminderFootnote: (url) =>
      `You get this because this kind of reminder is on for you. Change what you receive in Settings → Me → Notifications: ${url}`,
    digestFootnote: (url) =>
      `This digest comes once a day, at the time you chose. Change it in Settings → Me → Notifications: ${url}`,
    role: { admin: 'an admin', member: 'a member', viewer: 'a viewer' },
    ended: {
      subject: (member, location) => `${member} no longer has access to ${location}`,
      body: (member, location, role, day) =>
        `${member}’s access to ${location} as ${role} ended on ${day}, the end date set for it.`,
      footnote:
        'You get this as the owner. To give them access again, invite them from the location’s settings.',
    },
    test: {
      subject: 'Kept: a test notification',
      body: 'This is the test you sent from Settings → Me → Notifications. Reminders you choose to get by email arrive at this address.',
      footnote: 'Nothing else changed.',
    },
    failing: {
      subject: 'Kept: your webhook isn’t answering',
      body: (name) =>
        `Kept tried for about a day to deliver a reminder to your webhook ${name}, and it never answered, so reminders aren’t reaching it.`,
      next: 'Check that the address is right and the receiver is running, then send a test from Settings → Me → Notifications.',
      action: 'Open notification settings',
      footnote: 'Your other channels are unaffected.',
    },
  },
  ar: {
    where: 'المكان',
    open: 'فتح في Kept',
    openKept: 'فتح Kept',
    digestSubject: (count, day) => `Kept: ${count} ليوم ${day}`,
    digestIntro: (day) => `ما يستحق وما تقترب نهايته، حتى ${day}:`,
    reminderFootnote: (url) =>
      `يصلك هذا لأن هذا النوع من التذكيرات مفعّل لديك. يمكنك تغيير ما يصلك من الإعدادات ← أنا ← الإشعارات: ${url}`,
    digestFootnote: (url) =>
      `يصلك هذا الملخّص مرة واحدة في اليوم، في الوقت الذي اخترته. يمكنك تغييره من الإعدادات ← أنا ← الإشعارات: ${url}`,
    role: { admin: 'مشرف', member: 'عضو', viewer: 'مشاهد' },
    ended: {
      subject: (member, location) => `لم يعد ${member} قادرًا على الوصول إلى «${location}»`,
      body: (member, location, role, day) =>
        `انتهى وصول ${member} إلى «${location}» بصفة ${role} في ${day}، وهو تاريخ الانتهاء المحدّد له.`,
      footnote: 'يصلك هذا بصفتك المالك. لمنحه الوصول مجددًا، ادعُه من إعدادات المكان.',
    },
    test: {
      subject: 'Kept: إشعار تجريبي',
      body: 'هذا هو الإشعار التجريبي الذي أرسلته من الإعدادات ← أنا ← الإشعارات. ستصل إلى هذا العنوان التذكيرات التي تختار تلقّيها بالبريد الإلكتروني.',
      footnote: 'لم يتغيّر شيء آخر.',
    },
    failing: {
      subject: 'Kept: لا يستجيب الـwebhook الخاص بك',
      body: (name) =>
        `حاول Kept طوال يوم تقريبًا إيصال تذكير إلى الـwebhook ‏${name}، ولم يصله أي رد، لذا لا تصل إليه التذكيرات.`,
      next: 'تأكّد من صحة العنوان ومن أن المستقبِل يعمل، ثم أرسل إشعارًا تجريبيًا من الإعدادات ← أنا ← الإشعارات.',
      action: 'فتح إعدادات الإشعارات',
      footnote: 'قنواتك الأخرى لم تتأثر.',
    },
  },
  fr: {
    where: 'Où',
    open: 'Ouvrir dans Kept',
    openKept: 'Ouvrir Kept',
    digestSubject: (count, day) => `Kept : ${count} pour le ${day}`,
    digestIntro: (day) => `Ce qui arrive à échéance ou expire, au ${day} :`,
    reminderFootnote: (url) =>
      `Vous recevez ceci parce que ce type de rappel est activé pour vous. Modifiez ce que vous recevez dans Paramètres → Moi → Notifications : ${url}`,
    digestFootnote: (url) =>
      `Ce récapitulatif arrive une fois par jour, à l’heure que vous avez choisie. Modifiez-le dans Paramètres → Moi → Notifications : ${url}`,
    role: { admin: 'administrateur', member: 'membre', viewer: 'lecteur' },
    ended: {
      subject: (member, location) => `${member} n’a plus accès à ${location}`,
      body: (member, location, role, day) =>
        `L’accès de ${member} à ${location} en tant que ${role} a pris fin le ${day}, à la date de fin prévue.`,
      footnote:
        'Vous recevez ceci en tant que propriétaire. Pour lui redonner accès, invitez-le depuis les réglages du lieu.',
    },
    test: {
      subject: 'Kept : une notification de test',
      body: 'Voici le test envoyé depuis Paramètres → Moi → Notifications. Les rappels que vous choisissez de recevoir par e-mail arriveront à cette adresse.',
      footnote: 'Rien d’autre n’a changé.',
    },
    failing: {
      subject: 'Kept : votre webhook ne répond pas',
      body: (name) =>
        `Kept a essayé pendant environ une journée d’envoyer un rappel à votre webhook ${name}, sans jamais obtenir de réponse : les rappels ne lui parviennent pas.`,
      next: 'Vérifiez l’adresse et que le récepteur fonctionne, puis envoyez un test depuis Paramètres → Moi → Notifications.',
      action: 'Ouvrir les réglages des notifications',
      footnote: 'Vos autres canaux ne sont pas concernés.',
    },
  },
  de: {
    where: 'Wo',
    open: 'In Kept öffnen',
    openKept: 'Kept öffnen',
    digestSubject: (count, day) => `Kept: ${count} für den ${day}`,
    digestIntro: (day) => `Was fällig ist oder abläuft, Stand ${day}:`,
    reminderFootnote: (url) =>
      `Du erhältst das, weil diese Art Erinnerung für dich eingeschaltet ist. Ändere, was du erhältst, unter Einstellungen → Profil → Benachrichtigungen: ${url}`,
    digestFootnote: (url) =>
      `Diese Übersicht kommt einmal am Tag, zu der Uhrzeit, die du gewählt hast. Ändere sie unter Einstellungen → Profil → Benachrichtigungen: ${url}`,
    role: { admin: 'Admin', member: 'Mitglied', viewer: 'Betrachter' },
    ended: {
      subject: (member, location) => `${member} hat keinen Zugriff mehr auf „${location}“`,
      body: (member, location, role, day) =>
        `Der Zugriff von ${member} auf „${location}“ als ${role} endete am ${day}, dem dafür festgelegten Enddatum.`,
      footnote:
        'Du erhältst das als Eigentümer. Um wieder Zugriff zu geben, lade die Person in den Einstellungen des Standorts ein.',
    },
    test: {
      subject: 'Kept: eine Testbenachrichtigung',
      body: 'Das ist der Test, den du unter Einstellungen → Profil → Benachrichtigungen gesendet hast. Erinnerungen, die du per E-Mail erhalten willst, kommen an diese Adresse.',
      footnote: 'Sonst hat sich nichts geändert.',
    },
    failing: {
      subject: 'Kept: dein Webhook antwortet nicht',
      body: (name) =>
        `Kept hat etwa einen Tag lang versucht, eine Erinnerung an deinen Webhook ${name} zu senden, aber nie eine Antwort bekommen. Erinnerungen kommen dort also nicht an.`,
      next: 'Prüfe die Adresse und ob der Empfänger läuft, und sende dann einen Test unter Einstellungen → Profil → Benachrichtigungen.',
      action: 'Benachrichtigungseinstellungen öffnen',
      footnote: 'Deine anderen Kanäle sind nicht betroffen.',
    },
  },
  it: {
    where: 'Dove',
    open: 'Apri in Kept',
    openKept: 'Apri Kept',
    digestSubject: (count, day) => `Kept: ${count} per il ${day}`,
    digestIntro: (day) => `Cosa è in scadenza o scade, al ${day}:`,
    reminderFootnote: (url) =>
      `Ricevi questo messaggio perché questo tipo di promemoria è attivo per te. Cambia cosa ricevi in Impostazioni → Profilo → Notifiche: ${url}`,
    digestFootnote: (url) =>
      `Questo riepilogo arriva una volta al giorno, all’ora che hai scelto. Cambialo in Impostazioni → Profilo → Notifiche: ${url}`,
    role: { admin: 'amministratore', member: 'membro', viewer: 'lettore' },
    ended: {
      subject: (member, location) => `${member} non ha più accesso a ${location}`,
      body: (member, location, role, day) =>
        `L’accesso di ${member} a ${location} come ${role} è terminato il ${day}, alla data di fine prevista.`,
      footnote:
        'Ricevi questo messaggio in quanto proprietario. Per ridare accesso, invita la persona dalle impostazioni del luogo.',
    },
    test: {
      subject: 'Kept: una notifica di prova',
      body: 'Questa è la prova inviata da Impostazioni → Profilo → Notifiche. I promemoria che scegli di ricevere via email arriveranno a questo indirizzo.',
      footnote: 'Non è cambiato nient’altro.',
    },
    failing: {
      subject: 'Kept: il tuo webhook non risponde',
      body: (name) =>
        `Kept ha provato per circa un giorno a inviare un promemoria al tuo webhook ${name}, senza mai ricevere risposta: i promemoria non gli arrivano.`,
      next: 'Controlla che l’indirizzo sia giusto e che il ricevitore sia attivo, poi invia una prova da Impostazioni → Profilo → Notifiche.',
      action: 'Apri le impostazioni delle notifiche',
      footnote: 'Gli altri canali non sono interessati.',
    },
  },
};

/** The headline and the "where" line of one reminder, in `locale`. */
// ---------------------------------------------------------------------------------------------
// The AI monthly summary (product design §8a: "AI in September: 312 calls, 0.8M tokens, ≈ USD
// 1.12"), with the words the web's AI usage page uses for calls and tokens.
// ---------------------------------------------------------------------------------------------

type SummaryWords = {
  subject: (month: string) => string;
  line: (month: string, calls: string, tokens: string, cost: string | null) => string;
  unknown: (n: string) => string;
  action: string;
  footnote: string;
};

const SUMMARY: Record<MailLocale, SummaryWords> = {
  en: {
    subject: (month) => `Kept: AI in ${month}`,
    line: (month, calls, tokens, cost) =>
      `AI in ${month}: ${calls} calls, ${tokens} tokens${cost ? `, ≈ ${cost}` : ''}.`,
    unknown: (n) => `${n} of the calls had no price, so the cost leaves them out.`,
    action: 'Open AI usage',
    footnote:
      'You get this once a month for the AI your account or your own key paid for. Turn it off in Settings → Me → Notifications.',
  },
  ar: {
    subject: (month) => `Kept: الذكاء الاصطناعي في ${month}`,
    line: (month, calls, tokens, cost) =>
      `الذكاء الاصطناعي في ${month}: الاستدعاءات ${calls}، والرموز ${tokens}${cost ? `، والتكلفة ≈ ${cost}` : ''}.`,
    unknown: (n) => `لم يكن لـ ${n} من الاستدعاءات سعر، لذا لا تشملها التكلفة.`,
    action: 'فتح استخدام الذكاء الاصطناعي',
    footnote:
      'تصلك هذه الرسالة مرة في الشهر عن الذكاء الاصطناعي الذي دفع حسابك أو مفتاحك الخاص تكلفته. يمكنك إيقافها من الإعدادات ← أنا ← الإشعارات.',
  },
  fr: {
    subject: (month) => `Kept : l’IA en ${month}`,
    line: (month, calls, tokens, cost) =>
      `L’IA en ${month} : ${calls} appels, ${tokens} jetons${cost ? `, ≈ ${cost}` : ''}.`,
    unknown: (n) => `${n} appels n’avaient pas de prix : le coût ne les inclut pas.`,
    action: 'Ouvrir l’utilisation de l’IA',
    footnote:
      'Vous recevez ce message une fois par mois pour l’IA payée par votre compte ou votre propre clé. Désactivez-le dans Paramètres → Moi → Notifications.',
  },
  de: {
    subject: (month) => `Kept: KI im ${month}`,
    line: (month, calls, tokens, cost) =>
      `KI im ${month}: ${calls} Aufrufe, ${tokens} Tokens${cost ? `, ≈ ${cost}` : ''}.`,
    unknown: (n) => `${n} Aufrufe hatten keinen Preis, die Kosten enthalten sie nicht.`,
    action: 'KI-Nutzung öffnen',
    footnote:
      'Du erhältst das einmal im Monat für die KI, die dein Konto oder dein eigener Schlüssel bezahlt hat. Schalte es unter Einstellungen → Profil → Benachrichtigungen aus.',
  },
  it: {
    subject: (month) => `Kept: l’IA a ${month}`,
    line: (month, calls, tokens, cost) =>
      `L’IA a ${month}: ${calls} chiamate, ${tokens} token${cost ? `, ≈ ${cost}` : ''}.`,
    unknown: (n) => `${n} chiamate non avevano un prezzo, quindi il costo non le conta.`,
    action: 'Apri l’utilizzo dell’IA',
    footnote:
      'Ricevi questo messaggio una volta al mese per l’IA pagata dal tuo account o dalla tua chiave. Disattivalo in Impostazioni → Profilo → Notifiche.',
  },
};

/** "September 2026" in `tag`, from YYYY-MM. */
function monthName(tag: string, month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return month;
  return new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    d,
  );
}

function summary(locale: MailLocale, m: Of<'ai-summary'>, ctx: MessageContext): Message {
  const w = SUMMARY[locale];
  const tag = REMINDER_WORDS[locale].tag;
  const n = (v: number | string) => new Intl.NumberFormat(tag).format(Number(v) || 0);
  const money = new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const cost = m.cost.length
    ? m.cost.map((c) => `${c.currency} ${money.format(Number(c.amount) || 0)}`).join(' + ')
    : null;
  const month = monthName(tag, m.month);
  return {
    subject: w.subject(month),
    paragraphs: [
      w.line(month, n(m.calls), n(m.tokens), cost),
      ...(m.unknownCostCalls > 0 ? [w.unknown(n(m.unknownCostCalls))] : []),
    ],
    action: { label: w.action, url: page(ctx, '/settings/ai/usage') },
    footnote: w.footnote,
  };
}

function lines(locale: MailLocale, f: ReminderFacts): { headline: string; where: string } {
  const w = REMINDER_WORDS[locale];
  return { headline: w.headline(f), where: `${WORDS[locale].where}: ${w.where(f)}` };
}

function table(locale: MailLocale): NotifyTable {
  const t = WORDS[locale];
  const tag = REMINDER_WORDS[locale].tag;
  return {
    reminder: (m, ctx: MessageContext): Message => {
      const { headline, where } = lines(locale, m.item);
      return {
        subject: headline,
        paragraphs: [`${headline}.`, where],
        action: { label: t.open, url: page(ctx, m.item.link) },
        footnote: t.reminderFootnote(page(ctx, SETTINGS)),
      };
    },
    'reminder-digest': (m, ctx) => {
      const day = longDay(tag, m.day);
      return {
        subject: t.digestSubject(REMINDER_COUNT[locale](m.items.length), day),
        paragraphs: [
          t.digestIntro(day),
          ...m.items.map((f) => {
            const { headline, where } = lines(locale, f);
            return `${headline}. ${where}. ${page(ctx, f.link)}`;
          }),
        ],
        action: { label: t.openKept, url: page(ctx, '/') },
        footnote: t.digestFootnote(page(ctx, SETTINGS)),
      };
    },
    'membership-ended': (m) => ({
      subject: t.ended.subject(m.memberName, m.locationName),
      paragraphs: [
        t.ended.body(m.memberName, m.locationName, t.role[m.role], longDay(tag, m.endedOn)),
      ],
      footnote: t.ended.footnote,
    }),
    'channel-test': (_m, ctx) => ({
      subject: t.test.subject,
      paragraphs: [t.test.body],
      action: { label: t.failing.action, url: page(ctx, SETTINGS) },
      footnote: t.test.footnote,
    }),
    'ai-summary': (m, ctx) => summary(locale, m, ctx),
    'channel-failing': (m, ctx) => ({
      subject: t.failing.subject,
      paragraphs: [t.failing.body(m.label ?? m.host ?? ''), t.failing.next],
      action: { label: t.failing.action, url: page(ctx, SETTINGS) },
      footnote: t.failing.footnote,
    }),
  };
}

export const NOTIFY_MESSAGES: Record<MailLocale, NotifyTable> = {
  en: table('en'),
  ar: table('ar'),
  fr: table('fr'),
  de: table('de'),
  it: table('it'),
};
