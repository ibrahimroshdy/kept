// French mail (D204). Same shape as the English table in messages.ts; keep them in step.
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

// The whole phrase, not just the noun: « que » elides before a vowel (« en tant qu’administrateur »).
const FR_ROLE = {
  admin: 'en tant qu’administrateur',
  member: 'en tant que membre',
  viewer: 'en tant que lecteur',
} as const;

const FR_NOT_YOU =
  'Si vous n’êtes pas à l’origine de ce changement, réinitialisez dès maintenant votre mot de passe depuis la page de connexion.';

const FR_SECURITY: Record<SecurityEvent, (ctx: MessageContext) => Message> = {
  'passkey-added': () => ({
    subject: 'Une clé d’accès a été ajoutée à votre compte Kept',
    paragraphs: [
      'Une nouvelle clé d’accès a été ajoutée à votre compte Kept, et tous vos autres appareils ont été déconnectés.',
    ],
    footnote:
      'Si vous n’êtes pas à l’origine de cet ajout, réinitialisez dès maintenant votre mot de passe et supprimez la clé d’accès dans les paramètres de votre compte.',
  }),
  'two-factor-disabled': () => ({
    subject: 'La double authentification a été désactivée',
    paragraphs: [
      'La double authentification a été désactivée pour votre compte Kept, et tous vos autres appareils ont été déconnectés.',
    ],
    footnote:
      'Si vous n’êtes pas à l’origine de ce changement, réinitialisez dès maintenant votre mot de passe et réactivez la double authentification.',
  }),
  'password-changed': () => ({
    subject: 'Le mot de passe de votre compte Kept a été modifié',
    paragraphs: [
      'Le mot de passe de votre compte Kept a été modifié, et tous vos autres appareils ont été déconnectés.',
    ],
    footnote: FR_NOT_YOU,
  }),
  'unverified-account-reset': () => ({
    subject: 'Votre adresse e-mail est confirmée',
    paragraphs: [
      'Le mot de passe de votre compte Kept a été réinitialisé depuis cette boîte mail, ce qui confirme que l’adresse e-mail du compte est bien la vôtre.',
      'Cette adresse n’avait pas encore été confirmée. Au cas où quelqu’un d’autre aurait créé le compte, toutes les clés d’accès et tous les paramètres de double authentification ajoutés jusqu’ici ont été supprimés, et tous les appareils ont été déconnectés.',
    ],
    footnote:
      'Connectez-vous avec votre nouveau mot de passe, et configurez à nouveau la double authentification si vous l’utilisez. Si vous n’avez pas réinitialisé votre mot de passe, réinitialisez-le de nouveau dès maintenant.',
  }),
  'unverified-account-link': () => ({
    subject: 'Votre adresse e-mail est confirmée',
    paragraphs: [
      'Une connexion à Kept a eu lieu avec un lien envoyé à cette boîte mail, ce qui confirme que l’adresse e-mail du compte est bien la vôtre.',
      'Cette adresse n’avait pas encore été confirmée. Au cas où quelqu’un d’autre aurait créé le compte, son mot de passe, ses clés d’accès et ses paramètres de double authentification ont été supprimés, et tous les autres appareils ont été déconnectés.',
    ],
    footnote:
      'Choisissez un nouveau mot de passe dans les paramètres de votre compte, et configurez à nouveau la double authentification si vous l’utilisez.',
  }),
};

const FR_ADMIN: Record<AdminAction, (locationName: string) => Message> = {
  disabled: () => ({
    subject: 'Votre compte Kept a été désactivé',
    paragraphs: [
      'Un administrateur de cette instance de Kept a désactivé votre compte. Vous ne pourrez plus vous connecter tant qu’il n’aura pas été réactivé.',
    ],
  }),
  enabled: () => ({
    subject: 'Votre compte Kept a été réactivé',
    paragraphs: [
      'Un administrateur a réactivé votre compte. Vous pouvez vous connecter comme avant.',
    ],
  }),
  'two-factor-reset': () => ({
    subject: 'La double authentification de votre compte a été réinitialisée',
    paragraphs: [
      'Un administrateur a retiré la double authentification de votre compte et l’a déconnecté de tous les appareils, en général parce que vous avez perdu votre application d’authentification.',
      'Configurez à nouveau la double authentification dans les paramètres de votre compte.',
    ],
  }),
  'signed-out-everywhere': () => ({
    subject: 'Votre compte Kept a été déconnecté partout',
    paragraphs: [
      'Un administrateur a déconnecté votre compte de tous vos appareils. Reconnectez-vous pour continuer.',
    ],
  }),
  'instance-admin-granted': () => ({
    subject: 'Vous avez désormais les droits d’administrateur sur cette instance de Kept',
    paragraphs: [
      'Les droits d’administrateur de l’instance vous ont été accordés : vous pouvez maintenant gérer les utilisateurs et les paramètres de cette instance de Kept.',
    ],
  }),
  'instance-admin-revoked': () => ({
    subject: 'Vous n’avez plus les droits d’administrateur sur cette instance de Kept',
    paragraphs: [
      'Vos droits d’administrateur de l’instance vous ont été retirés. Vos propres lieux et tout ce qu’ils contiennent restent inchangés.',
    ],
  }),
  'password-reset-issued': () => ({
    subject: 'Une réinitialisation du mot de passe a été émise pour votre compte',
    paragraphs: [
      'La personne qui gère cette instance de Kept a émis une réinitialisation de mot de passe à usage unique pour votre compte, et l’a déconnecté de tous les appareils.',
      'Elle vous communiquera le code qui vous permettra de choisir un nouveau mot de passe.',
    ],
  }),
  'location-ownership-received': (name) => ({
    subject: `Vous êtes maintenant propriétaire de « ${name} »`,
    paragraphs: [
      `La personne qui gère cette instance de Kept vous a transféré la propriété de « ${name} ».`,
    ],
  }),
  'location-ownership-moved': (name) => ({
    subject: `« ${name} » a un nouveau propriétaire`,
    paragraphs: [
      `La personne qui gère cette instance de Kept a transféré « ${name} » à un nouveau propriétaire. Vous y restez ${FR_ROLE.admin}.`,
    ],
  }),
};

// Plafonds d’IA (D206).
function frCapOf(c: AiCapFacts): string {
  switch (c.scope) {
    case 'location':
      return `le plafond d’IA de « ${c.target} »`;
    case 'member':
      return c.target ? `le plafond d’IA de ${c.target}` : 'le plafond d’IA d’une personne';
    case 'account':
      return 'le plafond d’IA de votre compte';
    case 'user':
      return 'votre plafond d’IA personnel';
    case 'instance':
      return 'le plafond d’IA de ce serveur';
    case 'instance_account':
      return c.target
        ? `l’allocation de ${c.target} sur la clé d’IA de ce serveur`
        : 'l’allocation sur la clé d’IA de ce serveur';
  }
}
const frUsed = (c: AiCapFacts) =>
  c.unit === 'money'
    ? `${c.used} ${c.currency} sur ${c.limit} ${c.currency}`
    : `${tokens('fr', c.used)} jetons sur ${tokens('fr', c.limit)}`;

function frCap(level: 80 | 100, c: AiCapFacts, ctx: MessageContext, footnote: string): Message {
  const cap = frCapOf(c);
  if (level === 80) {
    return {
      subject: `Kept : 80 % de ${cap} utilisés ce mois-ci`,
      paragraphs: [
        `${capitalise(cap)} en est à ${frUsed(c)} depuis le début du mois.`,
        'Une fois le plafond atteint, l’IA est suspendue jusqu’au 1er du mois suivant. Les captures sont toujours enregistrées, et leurs photos seront lues à la reprise.',
      ],
      action: { label: 'Ouvrir les réglages de l’IA', url: aiPage(ctx, c.scope) },
      footnote,
    };
  }
  return {
    subject: `Kept : IA suspendue jusqu’au ${day(c.pausedUntil)}`,
    paragraphs: [
      `${capitalise(cap)} est atteint : ${frUsed(c)} ce mois-ci.`,
      `L’IA est suspendue jusqu’au ${day(c.pausedUntil)}. Les captures sont toujours enregistrées, et leurs photos seront lues à la reprise. Pour reprendre plus tôt, relevez ou supprimez le plafond.`,
    ],
    action: { label: 'Reprendre maintenant', url: aiPage(ctx, c.scope) },
    footnote,
  };
}

export const FR: CoreTable = {
  'magic-link': (m) => ({
    subject: 'Votre lien de connexion à Kept',
    paragraphs: [
      'Utilisez ce lien pour vous connecter à Kept. Il ne fonctionne qu’une fois, dans les 15 prochaines minutes.',
    ],
    action: { label: 'Se connecter', url: m.url },
    footnote:
      'Si vous n’avez pas demandé à vous connecter, ignorez cet e-mail. Personne ne peut se connecter sans ce lien.',
  }),
  'password-reset': (m) => ({
    subject: 'Réinitialisez votre mot de passe Kept',
    paragraphs: [
      'Quelqu’un a demandé à réinitialiser le mot de passe de ce compte Kept. Utilisez ce lien pour en choisir un nouveau. Il ne fonctionne qu’une fois, dans l’heure qui suit.',
    ],
    action: { label: 'Choisir un nouveau mot de passe', url: m.url },
    footnote:
      'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.',
  }),
  'email-change-confirm': (m) => ({
    subject: 'Confirmez votre nouvelle adresse e-mail',
    paragraphs: [
      `Une personne connectée à votre compte Kept a demandé à le transférer vers ${m.newEmail}. Si c’est bien vous, confirmez-le avec ce lien dans l’heure qui suit.`,
    ],
    action: { label: 'Confirmer le changement', url: m.url },
    footnote:
      'Si ce n’est pas vous, n’utilisez pas ce lien : votre compte reste associé à cette adresse. Il serait prudent de changer votre mot de passe.',
  }),
  'email-change-verify': (m) => ({
    subject: 'Vérifiez votre adresse e-mail pour Kept',
    paragraphs: [
      'Utilisez ce lien pour finaliser le transfert de votre compte Kept vers cette adresse.',
    ],
    action: { label: 'Vérifier cette adresse', url: m.url },
    footnote:
      'Si vous ne vous attendiez pas à cet e-mail, ignorez-le : rien ne change tant que le lien n’est pas utilisé.',
  }),
  'email-changed': (m) => ({
    subject: 'L’adresse e-mail de votre compte Kept a été modifiée',
    paragraphs: [
      `Votre compte Kept utilise désormais ${m.newEmail}. Cette adresse-ci ne reçoit plus ses e-mails.`,
    ],
    footnote:
      'Si vous n’êtes pas à l’origine de ce changement, contactez la personne qui gère votre instance de Kept.',
  }),
  invite: (m) => ({
    subject: m.inviterName
      ? `${m.inviterName} vous invite à rejoindre « ${m.locationName} » sur Kept`
      : `Invitation à rejoindre « ${m.locationName} » sur Kept`,
    paragraphs: [
      m.inviterName
        ? `${m.inviterName} vous invite à rejoindre « ${m.locationName} » ${FR_ROLE[m.role]}.`
        : `Vous avez reçu une invitation à rejoindre « ${m.locationName} » ${FR_ROLE[m.role]}.`,
      'Kept vous aide à suivre les objets que vous possédez, l’endroit où ils se trouvent et les échéances qui les concernent.',
    ],
    action: { label: 'Accepter l’invitation', url: m.url },
    footnote:
      'Si vous ne vous attendiez pas à cette invitation, ignorez-la : rien ne se passe tant que vous ne l’acceptez pas.',
  }),
  'sign-up-existing': (_m, ctx) => ({
    subject: 'Tentative d’inscription avec votre adresse e-mail',
    paragraphs: [
      'Quelqu’un a essayé de créer un compte Kept avec cette adresse, qui en a déjà un. Aucun nouveau compte n’a été créé.',
      'Si c’était vous, connectez-vous plutôt. Si vous avez oublié votre mot de passe, vous pouvez le réinitialiser depuis la page de connexion.',
    ],
    action: { label: 'Se connecter', url: page(ctx, '/signin') },
    footnote: 'Si ce n’était pas vous, vous n’avez rien à faire.',
  }),
  'security-notice': (m, ctx) => FR_SECURITY[m.event](ctx),
  'admin-action': (m) => ({
    ...FR_ADMIN[m.action](m.locationName ?? ''),
    footnote: 'Ceci est une notification automatique concernant votre compte.',
  }),
  'owner-new-member': (m) => ({
    subject: `${m.memberName} a rejoint « ${m.locationName} »`,
    paragraphs: [
      m.managed
        ? `${m.memberName} fait désormais partie de « ${m.locationName} » ${FR_ROLE[m.role]}, avec un compte géré.`
        : `${m.memberName} a désormais accès à « ${m.locationName} » ${FR_ROLE[m.role]}.`,
    ],
    footnote:
      'Vous recevez cet e-mail en tant que propriétaire, pour chaque nouveau membre. Vous pouvez modifier ou retirer des membres dans les paramètres du lieu.',
  }),
  'ai-cap': (m, ctx) =>
    frCap(
      m.level,
      m.cap,
      ctx,
      'Vous recevez cet e-mail parce que vous avez fixé ce plafond ou qu’il couvre votre activité. Il est envoyé une fois par mois.',
    ),
  'admin-alert': (m, ctx) => {
    const footnote =
      'Vous recevez cet e-mail en tant qu’administrateur de cette instance de Kept. Il est envoyé au plus une fois par jour tant que le problème persiste.';
    if (m.alert === 'ai_instance_cap_warning' || m.alert === 'ai_instance_cap_reached') {
      const c = capFactsOf(m.details);
      if (c) return frCap(m.alert === 'ai_instance_cap_warning' ? 80 : 100, c, ctx, footnote);
    }
    if (m.alert === 'ai_instance_key_rejected') {
      return {
        subject: 'Kept : la clé d’IA du serveur a été refusée',
        paragraphs: [
          `${String(m.details.provider ?? 'Le fournisseur')} a refusé la clé d’IA de ce serveur : le travail d’IA payé par cette clé est en attente.`,
          'Remplacez la clé dans les réglages d’IA de l’administration. Le travail en attente reprend dès qu’une nouvelle clé est enregistrée.',
        ],
        action: { label: 'Ouvrir les réglages de l’IA', url: page(ctx, '/admin/ai') },
        footnote,
      };
    }
    if (m.alert === 'failed_jobs_rising') {
      return {
        subject: 'Kept : des tâches en arrière-plan échouent',
        paragraphs: [
          `${num(m.details.failedLastHour)} tâches en arrière-plan ont échoué au cours de la dernière heure.`,
          'La liste des tâches en échec indique ce qui a échoué et pourquoi ; vous pouvez de là les relancer ou les supprimer.',
        ],
        action: { label: 'Ouvrir les tâches en échec', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'backup_failed') {
      return {
        subject: 'Kept : la sauvegarde nocturne a échoué',
        paragraphs: [
          `La sauvegarde nocturne n’a pas abouti : ${String(m.details.error ?? '')}`,
          m.details.lastOk
            ? `La dernière sauvegarde réussie s’est terminée le ${day(m.details.lastOk)}. Tant qu’aucune ne réussit, rien de ce qui a été enregistré depuis n’est sauvegardé.`
            : 'Aucune sauvegarde n’a encore réussi : rien dans cette instance de Kept n’est sauvegardé.',
        ],
        action: { label: 'Ouvrir la page d’état', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'backup_stale') {
      return {
        subject: 'Kept : aucune sauvegarde depuis plus de 36 heures',
        paragraphs: [
          m.details.lastOkAt
            ? `La dernière sauvegarde réussie s’est terminée le ${day(m.details.lastOkAt)}. Kept sauvegarde chaque nuit : la sauvegarde nocturne ne fonctionne donc plus.`
            : 'Les sauvegardes sont configurées, mais aucune ne s’est encore terminée.',
          'La page des sauvegardes liste chaque exécution et la raison de son échec. Si le processus d’arrière-plan de Kept ne tourne pas, redémarrez-le.',
        ],
        action: { label: 'Ouvrir les sauvegardes', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'disk_space_low') {
      const d = diskFacts(m.details, true);
      return {
        subject: d.backup
          ? 'Kept : le disque des sauvegardes est presque plein'
          : 'Kept : le disque des données est presque plein',
        paragraphs: [
          `Il est plein à ${d.percent} %, et il reste ${d.gb} Go.`,
          d.backup
            ? 'Une fois plein, la sauvegarde nocturne échoue. Libérez de la place, utilisez un disque plus grand ou gardez moins de sauvegardes dans les paramètres des sauvegardes.'
            : 'Une fois plein, Kept ne peut plus enregistrer de nouvelles photos ni de nouveaux documents, et sa base de données peut s’arrêter. Libérez de la place ou utilisez un disque plus grand.',
        ],
        action: { label: 'Ouvrir la page d’état', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'bucket_versioning_off') {
      return {
        subject: 'Kept : le versionnage est désactivé sur le bucket des fichiers',
        paragraphs: [
          'Kept conserve ses fichiers dans un bucket S3, et la sauvegarde nocturne les y laisse. Le versionnage est désactivé sur ce bucket : un fichier supprimé ou écrasé par erreur, ou par quelqu’un qui détient sa clé, ne peut pas être récupéré.',
          'Activez le versionnage du bucket chez votre fournisseur de stockage. Ce message cesse dès que la sauvegarde suivante le trouve activé.',
        ],
        action: { label: 'Ouvrir la page d’état', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'restore_drill_due') {
      return {
        subject: 'Kept : il est temps de faire un exercice de restauration',
        paragraphs: [
          m.details.lastDrillAt
            ? `Le dernier exercice de restauration date du ${day(m.details.lastDrillAt)}, il y a plus de 30 jours.`
            : 'Aucun exercice de restauration n’a encore été fait.',
          'Un exercice restaure la dernière sauvegarde dans une base de données temporaire et vérifie chaque table : vous savez ainsi que les sauvegardes peuvent vraiment être restaurées. Lancez `kept admin backup drill` comme l’indique le guide de restauration.',
        ],
        action: { label: 'Ouvrir les sauvegardes', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'backup_suspicious_size') {
      return {
        subject: 'Kept : la dernière sauvegarde semble trop petite',
        paragraphs: [
          'La dernière sauvegarde est bien plus petite que la dernière sauvegarde réussie. Kept l’a gardée, mais n’a supprimé aucune sauvegarde plus ancienne : les bonnes restent.',
          'Si beaucoup de choses ont été supprimées volontairement, tout va bien et les prochaines sauvegardes effaceront ce message. Sinon, cherchez ce qui a changé avant de restaurer quoi que ce soit.',
        ],
        action: { label: 'Ouvrir les sauvegardes', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'webhook_failing') {
      return {
        subject: 'Kept : le webhook d’un lieu échoue sans cesse',
        paragraphs: [
          `Un webhook configuré dans l’un des lieux de ce Kept a échoué à chaque envoi depuis le ${day(m.details.since)} ; Kept l’a donc marqué en échec.`,
          'Kept continue d’essayer à chaque nouvel événement. Les propriétaires et administrateurs du lieu le voient, et peuvent le corriger ou le supprimer, dans Paramètres du lieu → Webhooks.',
        ],
        action: { label: 'Ouvrir la page d’état', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'reminders_not_scanned') {
      return {
        subject: 'Kept : les rappels ne partent plus',
        paragraphs: [
          m.details.lastOkAt
            ? `Kept a vérifié les rappels à échéance pour la dernière fois le ${day(m.details.lastOkAt)}, il y a plus de 2 heures. Tant qu’il ne l’aura pas refait, personne ne recevra de nouveaux rappels.`
            : 'Kept n’a encore terminé aucune vérification des rappels à échéance : personne ne reçoit de rappels.',
          'Cette vérification a lieu toutes les 15 minutes dans le processus d’arrière-plan de Kept. La liste des tâches en échec indique pourquoi elle s’est arrêtée ; si ce processus ne tourne pas, redémarrez-le.',
        ],
        action: { label: 'Ouvrir les tâches en échec', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'llm_default_partition') {
      return {
        subject: 'Kept : des enregistrements d’appels d’IA demandent votre attention',
        paragraphs: [
          `${num(m.details.rows)} enregistrements d’appels d’IA (du ${day(m.details.oldest)} au ${day(m.details.newest)}) ont été enregistrés en dehors de leur partition mensuelle.`,
          'Kept ne peut pas créer la partition de ce mois tant qu’ils n’y ont pas été déplacés, et la tâche nocturne de maintenance de l’IA continuera donc d’échouer. Ce déplacement est une opération sur la base de données, à confier à la personne qui gère cette instance de Kept.',
        ],
        action: { label: 'Ouvrir la page d’état', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    return {
      subject: 'Kept : des événements d’audit demandent votre attention',
      paragraphs: [
        `${num(m.details.rows)} événements d’audit (du ${day(m.details.oldest)} au ${day(m.details.newest)}) ont été enregistrés en dehors de leur partition mensuelle.`,
        'Kept ne peut pas créer la partition de ce mois tant qu’ils n’y ont pas été déplacés, et la tâche de maintenance nocturne continuera donc d’échouer. Ce déplacement est une opération sur la base de données, à confier à la personne qui gère cette instance de Kept.',
      ],
      action: { label: 'Ouvrir la page d’état', url: page(ctx, '/admin/status') },
      footnote,
    };
  },
};

export const FR_CHROME: Chrome = {
  dir: 'ltr',
  linkFallback: 'Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :',
  sentBy: (host) => `Envoyé par Kept depuis ${host}.`,
};
