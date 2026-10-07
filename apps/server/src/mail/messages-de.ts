// German mail (D204). Same shape as the English table in messages.ts; keep them in step.
import type { SecurityEvent } from '../auth/security.js';
import type { AdminAction, AiCapFacts } from './mailer.js';
import {
  aiPage,
  type Chrome,
  type CoreTable,
  capFactsOf,
  capitalise,
  day,
  diskFacts,
  type Message,
  type MessageContext,
  num,
  page,
  tokens,
} from './message-kit.js';

const DE_ROLE = { admin: 'Admin', member: 'Mitglied', viewer: 'Betrachter' } as const;

const DE_NOT_YOU =
  'Falls du das nicht warst, setze dein Passwort jetzt über die Anmeldeseite zurück.';

const DE_SECURITY: Record<SecurityEvent, (ctx: MessageContext) => Message> = {
  'passkey-added': () => ({
    subject: 'Deinem Kept-Konto wurde ein Passkey hinzugefügt',
    paragraphs: [
      'Deinem Kept-Konto wurde ein neuer Passkey hinzugefügt, und alle anderen Geräte wurden abgemeldet.',
    ],
    footnote:
      'Falls du das nicht warst, setze jetzt dein Passwort zurück und entferne den Passkey in deinen Kontoeinstellungen.',
  }),
  'two-factor-disabled': () => ({
    subject: 'Die Zwei-Faktor-Anmeldung wurde ausgeschaltet',
    paragraphs: [
      'Die Zwei-Faktor-Authentifizierung für dein Kept-Konto wurde ausgeschaltet, und alle anderen Geräte wurden abgemeldet.',
    ],
    footnote:
      'Falls du das nicht warst, setze jetzt dein Passwort zurück und schalte die Zwei-Faktor-Authentifizierung wieder ein.',
  }),
  'password-changed': () => ({
    subject: 'Dein Kept-Passwort wurde geändert',
    paragraphs: [
      'Das Passwort deines Kept-Kontos wurde geändert, und alle anderen Geräte wurden abgemeldet.',
    ],
    footnote: DE_NOT_YOU,
  }),
  'unverified-account-reset': () => ({
    subject: 'Deine E-Mail-Adresse ist bestätigt',
    paragraphs: [
      'Dein Kept-Passwort wurde über dieses Postfach zurückgesetzt. Damit ist bestätigt, dass die E-Mail-Adresse des Kontos dir gehört.',
      'Die Adresse war bisher nicht bestätigt. Für den Fall, dass jemand anderes das Konto eingerichtet hat, wurden deshalb alle bisher hinzugefügten Passkeys, Zwei-Faktor-Einstellungen und angemeldeten Geräte entfernt.',
    ],
    footnote:
      'Melde dich mit deinem neuen Passwort an und richte die Zwei-Faktor-Authentifizierung wieder ein, falls du sie nutzt. Falls du dein Passwort nicht zurückgesetzt hast, setze es jetzt noch einmal zurück.',
  }),
  'unverified-account-link': () => ({
    subject: 'Deine E-Mail-Adresse ist bestätigt',
    paragraphs: [
      'Du hast dich mit einem Link, der an dieses Postfach gesendet wurde, bei Kept angemeldet. Damit ist bestätigt, dass die E-Mail-Adresse des Kontos dir gehört.',
      'Die Adresse war bisher nicht bestätigt. Für den Fall, dass jemand anderes das Konto eingerichtet hat, wurden deshalb sein Passwort, seine Passkeys, seine Zwei-Faktor-Einstellungen und alle anderen angemeldeten Geräte entfernt.',
    ],
    footnote:
      'Wähle in deinen Kontoeinstellungen ein neues Passwort und richte die Zwei-Faktor-Authentifizierung wieder ein, falls du sie nutzt.',
  }),
};

const DE_ADMIN: Record<AdminAction, (locationName: string) => Message> = {
  disabled: () => ({
    subject: 'Dein Kept-Konto wurde deaktiviert',
    paragraphs: [
      'Ein Admin dieser Kept-Instanz hat dein Konto deaktiviert. Du kannst dich erst wieder anmelden, wenn es wieder aktiviert ist.',
    ],
  }),
  enabled: () => ({
    subject: 'Dein Kept-Konto wurde wieder aktiviert',
    paragraphs: ['Ein Admin hat dein Konto wieder aktiviert. Du kannst dich wie gewohnt anmelden.'],
  }),
  'two-factor-reset': () => ({
    subject: 'Die Zwei-Faktor-Anmeldung für dein Konto wurde zurückgesetzt',
    paragraphs: [
      'Ein Admin hat die Zwei-Faktor-Authentifizierung von deinem Konto entfernt und es überall abgemeldet, meist weil deine Authenticator-App verloren gegangen ist.',
      'Richte die Zwei-Faktor-Authentifizierung in deinen Kontoeinstellungen wieder ein.',
    ],
  }),
  'signed-out-everywhere': () => ({
    subject: 'Du wurdest überall von Kept abgemeldet',
    paragraphs: [
      'Ein Admin hat dein Konto auf allen Geräten abgemeldet. Melde dich erneut an, um weiterzumachen.',
    ],
  }),
  'instance-admin-granted': () => ({
    subject: 'Du bist jetzt Admin dieser Kept-Instanz',
    paragraphs: [
      'Du wurdest zum Instanz-Admin ernannt: Du kannst jetzt die Nutzer und Einstellungen dieser Kept-Instanz verwalten.',
    ],
  }),
  'instance-admin-revoked': () => ({
    subject: 'Du bist nicht mehr Admin dieser Kept-Instanz',
    paragraphs: [
      'Deine Rechte als Instanz-Admin wurden entfernt. Deine eigenen Standorte und alles darin bleiben unverändert.',
    ],
  }),
  'password-reset-issued': () => ({
    subject: 'Für dein Konto wurde ein Passwort-Reset ausgestellt',
    paragraphs: [
      'Die Person, die diese Kept-Instanz betreibt, hat für dein Konto ein einmaliges Zurücksetzen des Passworts ausgestellt und es überall abgemeldet.',
      'Sie gibt dir den Code, mit dem du ein neues Passwort wählen kannst.',
    ],
  }),
  'location-ownership-received': (name) => ({
    subject: `Du bist jetzt Eigentümer von „${name}“`,
    paragraphs: [
      `Die Person, die diese Kept-Instanz betreibt, hat dich zum Eigentümer von „${name}“ gemacht.`,
    ],
  }),
  'location-ownership-moved': (name) => ({
    subject: `„${name}“ hat einen neuen Eigentümer`,
    paragraphs: [
      `Die Person, die diese Kept-Instanz betreibt, hat „${name}“ an einen neuen Eigentümer übertragen. Du bleibst dort Admin.`,
    ],
  }),
};

// KI-Limits (D206).
function deCapOf(c: AiCapFacts): string {
  switch (c.scope) {
    case 'location':
      return `das KI-Limit von „${c.target}“`;
    case 'member':
      return c.target ? `das KI-Limit von ${c.target}` : 'das KI-Limit einer Person';
    case 'account':
      return 'das KI-Limit deines Kontos';
    case 'user':
      return 'dein persönliches KI-Limit';
    case 'instance':
      return 'das KI-Limit dieses Servers';
    case 'instance_account':
      return c.target
        ? `das Kontingent von ${c.target} für den KI-Schlüssel dieses Servers`
        : 'das Kontingent für den KI-Schlüssel dieses Servers';
  }
}
const deUsed = (c: AiCapFacts) =>
  c.unit === 'money'
    ? `${c.used} ${c.currency} von ${c.limit} ${c.currency}`
    : `${tokens('de', c.used)} von ${tokens('de', c.limit)} Tokens`;

function deCap(level: 80 | 100, c: AiCapFacts, ctx: MessageContext, footnote: string): Message {
  const cap = deCapOf(c);
  if (level === 80) {
    return {
      subject: 'Kept: 80 % eines KI-Limits in diesem Monat verbraucht',
      paragraphs: [
        `${capitalise(cap)} steht in diesem Monat bisher bei ${deUsed(c)}.`,
        'Ist das Limit erreicht, pausiert die KI bis zum 1. des nächsten Monats. Erfassungen werden weiter gespeichert, und ihre Fotos werden gelesen, sobald die KI weiterläuft.',
      ],
      action: { label: 'KI-Einstellungen öffnen', url: aiPage(ctx, c.scope) },
      footnote,
    };
  }
  return {
    subject: `Kept: KI pausiert bis ${day(c.pausedUntil)}`,
    paragraphs: [
      `${capitalise(cap)} ist erreicht: ${deUsed(c)} in diesem Monat.`,
      `Die KI pausiert bis ${day(c.pausedUntil)}. Erfassungen werden weiter gespeichert, und ihre Fotos werden gelesen, sobald sie weiterläuft. Um früher fortzufahren, erhöhe oder entferne das Limit.`,
    ],
    action: { label: 'Jetzt fortsetzen', url: aiPage(ctx, c.scope) },
    footnote,
  };
}

export const DE: CoreTable = {
  'magic-link': (m) => ({
    subject: 'Dein Kept-Anmeldelink',
    paragraphs: [
      'Melde dich mit diesem Link bei Kept an. Er funktioniert einmal, innerhalb der nächsten 15 Minuten.',
    ],
    action: { label: 'Anmelden', url: m.url },
    footnote:
      'Falls du dich nicht anmelden wolltest, ignoriere diese E-Mail. Ohne den Link kann sich niemand anmelden.',
  }),
  'password-reset': (m) => ({
    subject: 'Kept-Passwort zurücksetzen',
    paragraphs: [
      'Jemand möchte das Passwort dieses Kept-Kontos zurücksetzen. Über diesen Link kannst du ein neues wählen. Er funktioniert einmal, innerhalb der nächsten Stunde.',
    ],
    action: { label: 'Neues Passwort wählen', url: m.url },
    footnote: 'Falls du das nicht warst, ignoriere diese E-Mail: Dein Passwort bleibt, wie es ist.',
  }),
  'email-change-confirm': (m) => ({
    subject: 'Neue E-Mail-Adresse bestätigen',
    paragraphs: [
      `Jemand, der in deinem Kept-Konto angemeldet ist, möchte es auf ${m.newEmail} umstellen. Falls du das warst, bestätige es innerhalb der nächsten Stunde mit diesem Link.`,
    ],
    action: { label: 'Änderung bestätigen', url: m.url },
    footnote:
      'Falls du es nicht warst, verwende den Link nicht: Dein Konto bleibt bei dieser Adresse. Vielleicht solltest du dein Passwort ändern.',
  }),
  'email-change-verify': (m) => ({
    subject: 'Bestätige deine E-Mail-Adresse für Kept',
    paragraphs: ['Mit diesem Link schließt du den Umzug deines Kept-Kontos auf diese Adresse ab.'],
    action: { label: 'Adresse bestätigen', url: m.url },
    footnote:
      'Falls du das nicht erwartet hast, ignoriere diese E-Mail: Solange der Link nicht verwendet wird, ändert sich nichts.',
  }),
  'email-changed': (m) => ({
    subject: 'Deine Kept-E-Mail-Adresse wurde geändert',
    paragraphs: [
      `Dein Kept-Konto verwendet jetzt ${m.newEmail}. An diese Adresse gehen keine E-Mails des Kontos mehr.`,
    ],
    footnote:
      'Falls du diese Änderung nicht vorgenommen hast, wende dich an die Person, die deine Kept-Instanz betreibt.',
  }),
  invite: (m) => ({
    subject: m.inviterName
      ? `${m.inviterName} hat dich zu „${m.locationName}“ auf Kept eingeladen`
      : `Du bist zu „${m.locationName}“ auf Kept eingeladen`,
    paragraphs: [
      m.inviterName
        ? `${m.inviterName} hat dich eingeladen, „${m.locationName}“ als ${DE_ROLE[m.role]} beizutreten.`
        : `Du bist eingeladen, „${m.locationName}“ als ${DE_ROLE[m.role]} beizutreten.`,
      'Kept behält den Überblick über die Gegenstände, die du besitzt: wo sie sind und was für sie ansteht.',
    ],
    action: { label: 'Einladung annehmen', url: m.url },
    footnote:
      'Falls du das nicht erwartet hast, ignoriere diese E-Mail: Solange du nicht annimmst, passiert nichts.',
  }),
  'sign-up-existing': (_m, ctx) => ({
    subject: 'Jemand wollte sich mit deiner E-Mail-Adresse registrieren',
    paragraphs: [
      'Jemand hat versucht, mit dieser Adresse ein Kept-Konto zu erstellen, aber es gibt bereits eines. Es wurde kein neues Konto angelegt.',
      'Falls du das warst, melde dich stattdessen an. Wenn du dein Passwort vergessen hast, kannst du es auf der Anmeldeseite zurücksetzen.',
    ],
    action: { label: 'Anmelden', url: page(ctx, '/signin') },
    footnote: 'Falls du es nicht warst, musst du nichts tun.',
  }),
  'security-notice': (m, ctx) => DE_SECURITY[m.event](ctx),
  'admin-action': (m) => ({
    ...DE_ADMIN[m.action](m.locationName ?? ''),
    footnote: 'Dies ist eine automatische Benachrichtigung zu deinem Konto.',
  }),
  'owner-new-member': (m) => ({
    subject: `${m.memberName} ist „${m.locationName}“ beigetreten`,
    paragraphs: [
      m.managed
        ? `${m.memberName} wurde „${m.locationName}“ als verwaltetes Konto mit der Rolle ${DE_ROLE[m.role]} hinzugefügt.`
        : `${m.memberName} hat jetzt als ${DE_ROLE[m.role]} Zugriff auf „${m.locationName}“.`,
    ],
    footnote:
      'Du erhältst diese E-Mail als Eigentümer bei jedem neuen Mitglied. In den Einstellungen des Standorts kannst du Mitglieder ändern oder entfernen.',
  }),
  'ai-cap': (m, ctx) =>
    deCap(
      m.level,
      m.cap,
      ctx,
      'Du erhältst diese E-Mail, weil du dieses Limit festgelegt hast oder es deine Nutzung betrifft. Sie wird einmal im Monat gesendet.',
    ),
  'admin-alert': (m, ctx) => {
    const footnote =
      'Du erhältst diese E-Mail als Admin dieser Kept-Instanz. Sie wird höchstens einmal am Tag gesendet, solange das Problem besteht.';
    if (m.alert === 'ai_instance_cap_warning' || m.alert === 'ai_instance_cap_reached') {
      const c = capFactsOf(m.details);
      if (c) return deCap(m.alert === 'ai_instance_cap_warning' ? 80 : 100, c, ctx, footnote);
    }
    if (m.alert === 'ai_instance_key_rejected') {
      return {
        subject: 'Kept: Der KI-Schlüssel des Servers wurde abgelehnt',
        paragraphs: [
          `${String(m.details.provider ?? 'Der Anbieter')} hat den KI-Schlüssel dieses Servers abgelehnt, deshalb wartet die KI-Arbeit, die dieser Schlüssel bezahlt.`,
          'Ersetze den Schlüssel in den KI-Einstellungen der Administration. Wartende Arbeit läuft weiter, sobald ein neuer Schlüssel gespeichert ist.',
        ],
        action: { label: 'KI-Einstellungen öffnen', url: page(ctx, '/admin/ai') },
        footnote,
      };
    }
    if (m.alert === 'failed_jobs_rising') {
      return {
        subject: 'Kept: Hintergrund-Jobs schlagen fehl',
        paragraphs: [
          `${num(m.details.failedLastHour)} Hintergrund-Jobs sind in der letzten Stunde fehlgeschlagen.`,
          'Die Liste der fehlgeschlagenen Jobs zeigt, was fehlgeschlagen ist und warum. Dort kannst du sie erneut ausführen oder verwerfen.',
        ],
        action: { label: 'Fehlgeschlagene Jobs öffnen', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'backup_failed') {
      return {
        subject: 'Kept: Die nächtliche Sicherung ist fehlgeschlagen',
        paragraphs: [
          `Die nächtliche Sicherung wurde nicht abgeschlossen: ${String(m.details.error ?? '')}`,
          m.details.lastOk
            ? `Die letzte erfolgreiche Sicherung wurde am ${day(m.details.lastOk)} abgeschlossen. Bis wieder eine gelingt, ist nichts gesichert, was seitdem gespeichert wurde.`
            : 'Bisher ist noch keine Sicherung gelungen, daher ist nichts in dieser Kept-Instanz gesichert.',
        ],
        action: { label: 'Statusseite öffnen', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'backup_stale') {
      return {
        subject: 'Kept: Seit über 36 Stunden keine Sicherung',
        paragraphs: [
          m.details.lastOkAt
            ? `Die letzte erfolgreiche Sicherung wurde am ${day(m.details.lastOkAt)} abgeschlossen. Kept sichert jede Nacht, die nächtliche Sicherung funktioniert also nicht mehr.`
            : 'Sicherungen sind eingerichtet, aber noch keine wurde abgeschlossen.',
          'Die Seite „Sicherungen“ listet jeden Lauf und warum er fehlgeschlagen ist. Läuft der Hintergrunddienst von Kept nicht, starte ihn neu.',
        ],
        action: { label: 'Sicherungen öffnen', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'disk_space_low') {
      const d = diskFacts(m.details, true);
      return {
        subject: d.backup
          ? 'Kept: Das Sicherungslaufwerk ist fast voll'
          : 'Kept: Das Datenlaufwerk ist fast voll',
        paragraphs: [
          `Es ist zu ${d.percent} % voll, ${d.gb} GB sind noch frei.`,
          d.backup
            ? 'Ist es voll, schlägt die nächtliche Sicherung fehl. Schaffe Platz, nimm ein größeres Laufwerk oder behalte in den Sicherungseinstellungen weniger Sicherungen.'
            : 'Ist es voll, kann Kept keine neuen Fotos oder Dokumente speichern, und seine Datenbank kann anhalten. Schaffe Platz oder nimm ein größeres Laufwerk.',
        ],
        action: { label: 'Statusseite öffnen', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'bucket_versioning_off') {
      return {
        subject: 'Kept: Die Versionierung des Datei-Buckets ist aus',
        paragraphs: [
          'Kept speichert seine Dateien in einem S3-Bucket, und die nächtliche Sicherung lässt sie dort. Die Versionierung dieses Buckets ist aus, daher lässt sich eine Datei, die versehentlich oder von jemandem mit seinem Schlüssel gelöscht oder überschrieben wurde, nicht zurückholen.',
          'Schalte die Versionierung des Buckets bei deinem Speicheranbieter ein. Diese Meldung endet, sobald die nächste Sicherung sie eingeschaltet vorfindet.',
        ],
        action: { label: 'Statusseite öffnen', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'restore_drill_due') {
      return {
        subject: 'Kept: Zeit für eine Wiederherstellungsprobe',
        paragraphs: [
          m.details.lastDrillAt
            ? `Die letzte Wiederherstellungsprobe war am ${day(m.details.lastDrillAt)}, vor mehr als 30 Tagen.`
            : 'Es wurde noch keine Wiederherstellungsprobe gemacht.',
          'Eine Probe stellt die neueste Sicherung in eine Testdatenbank wieder her und prüft jede Tabelle, damit du weißt, dass sich die Sicherungen wirklich wiederherstellen lassen. Führe `kept admin backup drill` aus, wie die Wiederherstellungsanleitung zeigt.',
        ],
        action: { label: 'Sicherungen öffnen', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'backup_suspicious_size') {
      return {
        subject: 'Kept: Die neueste Sicherung wirkt zu klein',
        paragraphs: [
          'Die neueste Sicherung ist viel kleiner als die letzte erfolgreiche. Kept hat sie behalten, aber keine ältere Sicherung entfernt, die guten bleiben also erhalten.',
          'Wurde absichtlich viel gelöscht, ist alles in Ordnung, und die nächsten Sicherungen heben diese Meldung auf. Wenn nicht, finde heraus, was sich geändert hat, bevor du etwas wiederherstellst.',
        ],
        action: { label: 'Sicherungen öffnen', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'webhook_failing') {
      return {
        subject: 'Kept: Ein Webhook eines Standorts schlägt immer wieder fehl',
        paragraphs: [
          `Ein Webhook, der an einem Standort dieses Kept eingerichtet ist, ist seit ${day(m.details.since)} bei jeder Zustellung fehlgeschlagen, deshalb hat Kept ihn als fehlerhaft markiert.`,
          'Kept versucht es bei jedem neuen Ereignis weiter. Die Eigentümer und Admins des Standorts sehen ihn unter Standorteinstellungen → Webhooks und können ihn dort reparieren oder entfernen.',
        ],
        action: { label: 'Statusseite öffnen', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'reminders_not_scanned') {
      return {
        subject: 'Kept: Erinnerungen werden nicht mehr verschickt',
        paragraphs: [
          m.details.lastOkAt
            ? `Kept hat zuletzt am ${day(m.details.lastOkAt)} nach fälligen Erinnerungen gesehen, vor mehr als 2 Stunden. Bis zur nächsten Prüfung bekommt niemand neue Erinnerungen.`
            : 'Kept hat noch keine einzige Prüfung auf fällige Erinnerungen abgeschlossen, deshalb bekommt niemand Erinnerungen.',
          'Die Prüfung läuft alle 15 Minuten im Hintergrundprozess von Kept. Die Liste der fehlgeschlagenen Jobs zeigt, warum sie stehen geblieben ist; läuft der Hintergrundprozess nicht, starten Sie ihn neu.',
        ],
        action: { label: 'Fehlgeschlagene Jobs öffnen', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'llm_default_partition') {
      return {
        subject: 'Kept: KI-Aufrufprotokolle brauchen Aufmerksamkeit',
        paragraphs: [
          `${num(m.details.rows)} KI-Aufrufprotokolle (${day(m.details.oldest)} bis ${day(m.details.newest)}) wurden außerhalb ihrer Monatspartition gespeichert.`,
          'Kept kann die Partition für diesen Monat erst anlegen, wenn sie dorthin verschoben wurden. Bis dahin schlägt der nächtliche KI-Wartungsjob weiter fehl. Das Verschieben ist eine Datenbankaufgabe für die Person, die diese Kept-Instanz betreibt.',
        ],
        action: { label: 'Statusseite öffnen', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    return {
      subject: 'Kept: Audit-Ereignisse brauchen Aufmerksamkeit',
      paragraphs: [
        `${num(m.details.rows)} Audit-Ereignisse (${day(m.details.oldest)} bis ${day(m.details.newest)}) wurden außerhalb ihrer Monatspartition gespeichert.`,
        'Kept kann die Partition für diesen Monat erst anlegen, wenn sie dorthin verschoben wurden. Bis dahin schlägt der nächtliche Wartungsjob weiter fehl. Das Verschieben ist eine Datenbankaufgabe für die Person, die diese Kept-Instanz betreibt.',
      ],
      action: { label: 'Statusseite öffnen', url: page(ctx, '/admin/status') },
      footnote,
    };
  },
};

export const DE_CHROME: Chrome = {
  dir: 'ltr',
  linkFallback: 'Falls der Button nicht funktioniert, kopiere diese Adresse in deinen Browser:',
  sentBy: (host) => `Gesendet von Kept unter ${host}.`,
};
