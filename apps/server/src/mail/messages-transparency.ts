import type { ProviderKind } from '@kept/shared';
import {
  type Message,
  type MessageContext,
  type Of,
  page,
  type TransparencyTable,
} from './message-kit.js';
import type { MailLocale } from './messages.js';

// D180's configuration notices (step-6 plan T16; D204), in every language Kept mails in: every
// active user hears when the instance's OIDC sign-in, its outgoing mail (host and sender) or its
// default AI provider changes. Sent by the `transparency-notice` job (notices/transparency.ts),
// once per change. They name the new setting and nothing secret: never a client secret, a key or
// a mail password.

type Words = {
  oidcOn: { subject: (name: string) => string; body: (name: string) => string };
  oidcOff: { subject: string; body: string };
  oidcFootnote: string;
  smtp: { subject: (sender: string) => string; body: (sender: string) => string; footnote: string };
  ai: {
    subject: (provider: string) => string;
    body: (provider: string) => string;
    action: string;
    footnote: string;
  };
  providers: Record<ProviderKind, string>;
};

const NAMES = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
} as const;

const WORDS: Record<MailLocale, Words> = {
  en: {
    oidcOn: {
      subject: (name) => `Sign-in with ${name} changed on Kept`,
      body: (name) =>
        `The person who runs this Kept changed sign-in with ${name}. Your password, passkeys and email links work as before.`,
    },
    oidcOff: {
      subject: 'Sign-in with an outside account is off on Kept',
      body: 'The person who runs this Kept turned off sign-in with an outside account. Sign in with your password, a passkey or an email link.',
    },
    oidcFootnote:
      'Everyone with an account here is told when sign-in changes. If you didn’t expect it, ask the person who runs this Kept.',
    smtp: {
      subject: (sender) => `Kept now sends mail from ${sender}`,
      body: (sender) =>
        `The person who runs this Kept changed how it sends mail. Its mail now comes from ${sender}, as this message did.`,
      footnote:
        'Everyone with an account here is told when this changes. If a message that says it is from Kept comes from another address, don’t follow its links.',
    },
    ai: {
      subject: (provider) => `Kept’s default AI provider is now ${provider}`,
      body: (provider) =>
        `The person who runs this Kept changed its default AI provider to ${provider}. Where your locations use this Kept’s AI, what you send to the AI (photos, receipts and questions) now goes to ${provider}.`,
      action: 'Open AI settings',
      footnote:
        'AI settings show which provider each of your locations uses, and let an owner choose another.',
    },
    providers: { ...NAMES, openai_compatible: 'an OpenAI-compatible server' },
  },
  ar: {
    oidcOn: {
      subject: (name) => `تغيّر تسجيل الدخول عبر ${name} في Kept`,
      body: (name) =>
        `غيّر مسؤول هذا الـ Kept تسجيل الدخول عبر ${name}. كلمة المرور ومفاتيح المرور وروابط البريد تعمل كما كانت.`,
    },
    oidcOff: {
      subject: 'أُوقف تسجيل الدخول بحساب خارجي في Kept',
      body: 'أوقف مسؤول هذا الـ Kept تسجيل الدخول بحساب خارجي. سجّل الدخول بكلمة المرور أو بمفتاح مرور أو برابط في البريد.',
    },
    oidcFootnote:
      'يُبلَّغ كل من له حساب هنا حين يتغيّر تسجيل الدخول. إن لم تتوقّع هذا، فاسأل مسؤول هذا الـ Kept.',
    smtp: {
      subject: (sender) => `صار Kept يرسل البريد من ${sender}`,
      body: (sender) =>
        `غيّر مسؤول هذا الـ Kept طريقة إرسال البريد. صار بريده يأتي من ${sender}، كما جاءت هذه الرسالة.`,
      footnote:
        'يُبلَّغ كل من له حساب هنا حين يتغيّر هذا. إن جاءتك رسالة تقول إنها من Kept من عنوان آخر، فلا تفتح روابطها.',
    },
    ai: {
      subject: (provider) => `صار مزوّد الذكاء الاصطناعي الافتراضي في Kept هو ${provider}`,
      body: (provider) =>
        `غيّر مسؤول هذا الـ Kept مزوّد الذكاء الاصطناعي الافتراضي إلى ${provider}. حيث تستخدم مواقعك ذكاء هذا الـ Kept الاصطناعي، صار ما ترسله إليه (الصور والإيصالات والأسئلة) يذهب إلى ${provider}.`,
      action: 'افتح إعدادات الذكاء الاصطناعي',
      footnote:
        'تُظهر إعدادات الذكاء الاصطناعي المزوّد الذي يستخدمه كل موقع من مواقعك، ويختار فيها المالك غيره.',
    },
    providers: { ...NAMES, openai_compatible: 'خادم متوافق مع OpenAI' },
  },
  fr: {
    oidcOn: {
      subject: (name) => `La connexion avec ${name} a changé sur Kept`,
      body: (name) =>
        `La personne qui gère ce Kept a modifié la connexion avec ${name}. Votre mot de passe, vos clés d’accès et les liens par e-mail fonctionnent comme avant.`,
    },
    oidcOff: {
      subject: 'La connexion avec un compte externe est désactivée sur Kept',
      body: 'La personne qui gère ce Kept a désactivé la connexion avec un compte externe. Connectez-vous avec votre mot de passe, une clé d’accès ou un lien par e-mail.',
    },
    oidcFootnote:
      'Chaque personne ayant un compte ici est prévenue quand la connexion change. Si vous ne vous y attendiez pas, demandez à la personne qui gère ce Kept.',
    smtp: {
      subject: (sender) => `Kept envoie désormais ses e-mails depuis ${sender}`,
      body: (sender) =>
        `La personne qui gère ce Kept a modifié l’envoi des e-mails. Ils viennent désormais de ${sender}, comme ce message.`,
      footnote:
        'Chaque personne ayant un compte ici est prévenue de ce changement. Si un message se disant de Kept vient d’une autre adresse, n’ouvrez pas ses liens.',
    },
    ai: {
      subject: (provider) => `Le fournisseur d’IA par défaut de Kept est désormais ${provider}`,
      body: (provider) =>
        `La personne qui gère ce Kept a choisi ${provider} comme fournisseur d’IA par défaut. Là où vos lieux utilisent l’IA de ce Kept, ce que vous envoyez à l’IA (photos, reçus et questions) va désormais à ${provider}.`,
      action: 'Ouvrir les réglages d’IA',
      footnote:
        'Les réglages d’IA indiquent le fournisseur utilisé par chacun de vos lieux, et permettent au propriétaire d’en choisir un autre.',
    },
    providers: { ...NAMES, openai_compatible: 'un serveur compatible OpenAI' },
  },
  de: {
    oidcOn: {
      subject: (name) => `Die Anmeldung mit ${name} wurde bei Kept geändert`,
      body: (name) =>
        `Die Person, die dieses Kept betreibt, hat die Anmeldung mit ${name} geändert. Ihr Passwort, Ihre Passkeys und E-Mail-Links funktionieren wie bisher.`,
    },
    oidcOff: {
      subject: 'Die Anmeldung mit einem externen Konto ist bei Kept ausgeschaltet',
      body: 'Die Person, die dieses Kept betreibt, hat die Anmeldung mit einem externen Konto ausgeschaltet. Melden Sie sich mit Ihrem Passwort, einem Passkey oder einem E-Mail-Link an.',
    },
    oidcFootnote:
      'Alle mit einem Konto hier werden informiert, wenn sich die Anmeldung ändert. Wenn Sie das nicht erwartet haben, fragen Sie die Person, die dieses Kept betreibt.',
    smtp: {
      subject: (sender) => `Kept sendet E-Mails jetzt von ${sender}`,
      body: (sender) =>
        `Die Person, die dieses Kept betreibt, hat den E-Mail-Versand geändert. Die E-Mails kommen jetzt von ${sender}, wie diese Nachricht.`,
      footnote:
        'Alle mit einem Konto hier werden über diese Änderung informiert. Wenn eine Nachricht angeblich von Kept von einer anderen Adresse kommt, öffnen Sie ihre Links nicht.',
    },
    ai: {
      subject: (provider) => `Der Standard-KI-Anbieter von Kept ist jetzt ${provider}`,
      body: (provider) =>
        `Die Person, die dieses Kept betreibt, hat ${provider} als Standard-KI-Anbieter gewählt. Wo Ihre Orte die KI dieses Kept nutzen, geht das, was Sie an die KI senden (Fotos, Belege und Fragen), jetzt an ${provider}.`,
      action: 'KI-Einstellungen öffnen',
      footnote:
        'Die KI-Einstellungen zeigen, welchen Anbieter jeder Ihrer Orte nutzt, und dort kann der Eigentümer einen anderen wählen.',
    },
    providers: { ...NAMES, openai_compatible: 'ein OpenAI-kompatibler Server' },
  },
  it: {
    oidcOn: {
      subject: (name) => `L’accesso con ${name} è cambiato su Kept`,
      body: (name) =>
        `La persona che gestisce questo Kept ha modificato l’accesso con ${name}. La password, le passkey e i link via e-mail funzionano come prima.`,
    },
    oidcOff: {
      subject: 'L’accesso con un account esterno è disattivato su Kept',
      body: 'La persona che gestisce questo Kept ha disattivato l’accesso con un account esterno. Accedi con la password, una passkey o un link via e-mail.',
    },
    oidcFootnote:
      'Chiunque abbia un account qui viene avvisato quando l’accesso cambia. Se non te lo aspettavi, chiedi alla persona che gestisce questo Kept.',
    smtp: {
      subject: (sender) => `Kept ora invia le e-mail da ${sender}`,
      body: (sender) =>
        `La persona che gestisce questo Kept ha modificato l’invio delle e-mail. Ora arrivano da ${sender}, come questo messaggio.`,
      footnote:
        'Chiunque abbia un account qui viene avvisato di questo cambiamento. Se un messaggio che dice di venire da Kept arriva da un altro indirizzo, non aprirne i link.',
    },
    ai: {
      subject: (provider) => `Il fornitore di IA predefinito di Kept ora è ${provider}`,
      body: (provider) =>
        `La persona che gestisce questo Kept ha scelto ${provider} come fornitore di IA predefinito. Dove i tuoi luoghi usano l’IA di questo Kept, ciò che invii all’IA (foto, ricevute e domande) ora va a ${provider}.`,
      action: 'Apri le impostazioni IA',
      footnote:
        'Le impostazioni IA mostrano quale fornitore usa ciascuno dei tuoi luoghi, e lì il proprietario può sceglierne un altro.',
    },
    providers: { ...NAMES, openai_compatible: 'un server compatibile con OpenAI' },
  },
};

function table(locale: MailLocale): TransparencyTable {
  const t = WORDS[locale];
  return {
    'oidc-changed': (m: Of<'oidc-changed'>): Message =>
      m.name
        ? {
            subject: t.oidcOn.subject(m.name),
            paragraphs: [t.oidcOn.body(m.name)],
            footnote: t.oidcFootnote,
          }
        : { subject: t.oidcOff.subject, paragraphs: [t.oidcOff.body], footnote: t.oidcFootnote },
    'smtp-changed': (m: Of<'smtp-changed'>): Message => ({
      subject: t.smtp.subject(m.sender),
      paragraphs: [t.smtp.body(m.sender)],
      footnote: t.smtp.footnote,
    }),
    'ai-provider-changed': (m: Of<'ai-provider-changed'>, ctx: MessageContext): Message => {
      const provider = t.providers[m.provider];
      return {
        subject: t.ai.subject(provider),
        paragraphs: [t.ai.body(provider)],
        action: { label: t.ai.action, url: page(ctx, '/settings/ai') },
        footnote: t.ai.footnote,
      };
    },
  };
}

export const TRANSPARENCY_MESSAGES: Record<MailLocale, TransparencyTable> = {
  en: table('en'),
  ar: table('ar'),
  fr: table('fr'),
  de: table('de'),
  it: table('it'),
};
