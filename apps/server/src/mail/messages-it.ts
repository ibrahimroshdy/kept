// Italian mail (D204). Same shape as the English table in messages.ts; keep them in step.
import type { SecurityEvent } from '../auth/security.js';
import type { AdminAction, AiCapFacts } from './mailer.js';
import {
  aiPage,
  type Chrome,
  type CoreTable,
  capFactsOf,
  day,
  diskFacts,
  type Message,
  type MessageContext,
  num,
  page,
  tokens,
} from './message-kit.js';

const IT_ROLE = { admin: 'amministratore', member: 'membro', viewer: 'visualizzatore' } as const;

const IT_NOT_YOU = 'Se non sei stato tu, reimposta subito la password dalla pagina di accesso.';

const IT_SECURITY: Record<SecurityEvent, (ctx: MessageContext) => Message> = {
  'passkey-added': () => ({
    subject: 'È stata aggiunta una passkey al tuo account Kept',
    paragraphs: [
      'Al tuo account Kept è stata aggiunta una nuova passkey e tutti gli altri dispositivi sono stati disconnessi.',
    ],
    footnote:
      'Se non sei stato tu, reimposta subito la password e rimuovi la passkey dalle impostazioni dell’account.',
  }),
  'two-factor-disabled': () => ({
    subject: 'La verifica in due passaggi è stata disattivata',
    paragraphs: [
      'La verifica in due passaggi è stata disattivata per il tuo account Kept e tutti gli altri dispositivi sono stati disconnessi.',
    ],
    footnote:
      'Se non sei stato tu, reimposta subito la password e riattiva la verifica in due passaggi.',
  }),
  'password-changed': () => ({
    subject: 'La password di Kept è stata modificata',
    paragraphs: [
      'La password del tuo account Kept è stata modificata e tutti gli altri dispositivi sono stati disconnessi.',
    ],
    footnote: IT_NOT_YOU,
  }),
  'unverified-account-reset': () => ({
    subject: 'Il tuo indirizzo email è confermato',
    paragraphs: [
      'La password di Kept è stata reimpostata da questa casella di posta: questo conferma che l’indirizzo email dell’account è tuo.',
      'L’indirizzo non era ancora stato confermato, quindi, nel caso in cui l’account l’abbia creato qualcun altro, abbiamo rimosso tutte le passkey, le impostazioni della verifica in due passaggi e i dispositivi connessi aggiunti finora.',
    ],
    footnote:
      'Accedi con la nuova password e, se la usi, configura di nuovo la verifica in due passaggi. Se non sei stato tu a reimpostare la password, reimpostala subito di nuovo.',
  }),
  'unverified-account-link': () => ({
    subject: 'Il tuo indirizzo email è confermato',
    paragraphs: [
      'Hai effettuato l’accesso a Kept con un link inviato a questa casella di posta: questo conferma che l’indirizzo email dell’account è tuo.',
      'L’indirizzo non era ancora stato confermato, quindi, nel caso in cui l’account l’abbia creato qualcun altro, abbiamo rimosso la password, le passkey, le impostazioni della verifica in due passaggi e tutti gli altri dispositivi connessi.',
    ],
    footnote:
      'Scegli una nuova password e, se la usi, configura di nuovo la verifica in due passaggi nelle impostazioni dell’account.',
  }),
};

const IT_ADMIN: Record<AdminAction, (locationName: string) => Message> = {
  disabled: () => ({
    subject: 'Il tuo account Kept è stato disattivato',
    paragraphs: [
      'Un amministratore di questa istanza di Kept ha disattivato il tuo account. Non potrai accedere finché non verrà riattivato.',
    ],
  }),
  enabled: () => ({
    subject: 'Il tuo account Kept è stato riattivato',
    paragraphs: ['Un amministratore ha riattivato il tuo account. Puoi accedere come prima.'],
  }),
  'two-factor-reset': () => ({
    subject: 'La verifica in due passaggi del tuo account è stata reimpostata',
    paragraphs: [
      'Un amministratore ha rimosso la verifica in due passaggi dal tuo account e l’ha disconnesso ovunque, di solito perché hai perso l’app di autenticazione.',
      'Configura di nuovo la verifica in due passaggi nelle impostazioni dell’account.',
    ],
  }),
  'signed-out-everywhere': () => ({
    subject: 'Sei stato disconnesso da Kept ovunque',
    paragraphs: [
      'Un amministratore ha disconnesso il tuo account da tutti i dispositivi. Accedi di nuovo per continuare.',
    ],
  }),
  'instance-admin-granted': () => ({
    subject: 'Ora sei amministratore di questa istanza di Kept',
    paragraphs: [
      'Sei stato nominato amministratore dell’istanza: ora puoi gestire gli utenti e le impostazioni di questa istanza di Kept.',
    ],
  }),
  'instance-admin-revoked': () => ({
    subject: 'Non sei più amministratore di questa istanza di Kept',
    paragraphs: [
      'I tuoi diritti di amministratore dell’istanza sono stati rimossi. I tuoi luoghi e tutto ciò che contengono restano invariati.',
    ],
  }),
  'password-reset-issued': () => ({
    subject: 'È stata emessa una reimpostazione della password per il tuo account',
    paragraphs: [
      'Chi gestisce questa istanza di Kept ha emesso una reimpostazione della password monouso per il tuo account e l’ha disconnesso ovunque.',
      'Ti darà il codice con cui scegliere una nuova password.',
    ],
  }),
  'location-ownership-received': (name) => ({
    subject: `Ora sei il proprietario di «${name}»`,
    paragraphs: [`Chi gestisce questa istanza di Kept ti ha reso proprietario di «${name}».`],
  }),
  'location-ownership-moved': (name) => ({
    subject: `«${name}» ha un nuovo proprietario`,
    paragraphs: [
      `Chi gestisce questa istanza di Kept ha trasferito «${name}» a un nuovo proprietario. Tu ne resti membro come amministratore.`,
    ],
  }),
};

// Limiti di IA (D206).
function itCapOf(c: AiCapFacts): string {
  switch (c.scope) {
    case 'location':
      return `il limite di IA di «${c.target}»`;
    case 'member':
      return c.target ? `il limite di IA di ${c.target}` : 'il limite di IA di una persona';
    case 'account':
      return 'il limite di IA del tuo account';
    case 'user':
      return 'il tuo limite personale di IA';
    case 'instance':
      return 'il limite di IA di questo server';
    case 'instance_account':
      return c.target
        ? `la quota di ${c.target} sulla chiave di IA di questo server`
        : 'la quota sulla chiave di IA di questo server';
  }
}
const itUsed = (c: AiCapFacts) =>
  c.unit === 'money'
    ? `${c.used} ${c.currency} su ${c.limit} ${c.currency}`
    : `${tokens('it', c.used)} token su ${tokens('it', c.limit)}`;

function itCap(level: 80 | 100, c: AiCapFacts, ctx: MessageContext, footnote: string): Message {
  const cap = itCapOf(c);
  if (level === 80) {
    return {
      subject: 'Kept: usato l’80% di un limite di IA questo mese',
      paragraphs: [
        `Finora questo mese, per ${cap}: ${itUsed(c)}.`,
        'Al raggiungimento del limite l’IA si ferma fino al 1° del mese successivo. Le acquisizioni vengono comunque salvate e le loro foto saranno lette alla ripresa.',
      ],
      action: { label: 'Apri le impostazioni dell’IA', url: aiPage(ctx, c.scope) },
      footnote,
    };
  }
  return {
    subject: `Kept: IA in pausa fino al ${day(c.pausedUntil)}`,
    paragraphs: [
      `Raggiunto ${cap}: ${itUsed(c)} questo mese.`,
      `L’IA è in pausa fino al ${day(c.pausedUntil)}. Le acquisizioni vengono comunque salvate e le loro foto saranno lette alla ripresa. Per riprendere prima, alza o rimuovi il limite.`,
    ],
    action: { label: 'Riprendi ora', url: aiPage(ctx, c.scope) },
    footnote,
  };
}

export const IT: CoreTable = {
  'magic-link': (m) => ({
    subject: 'Il tuo link di accesso a Kept',
    paragraphs: [
      'Usa questo link per accedere a Kept. Funziona una sola volta, entro i prossimi 15 minuti.',
    ],
    action: { label: 'Accedi', url: m.url },
    footnote:
      'Se non hai chiesto di accedere, ignora questa email. Nessuno può accedere senza il link.',
  }),
  'password-reset': (m) => ({
    subject: 'Reimposta la password di Kept',
    paragraphs: [
      'Qualcuno ha chiesto di reimpostare la password di questo account Kept. Usa questo link per sceglierne una nuova. Funziona una sola volta, entro la prossima ora.',
    ],
    action: { label: 'Scegli una nuova password', url: m.url },
    footnote: 'Se non sei stato tu, ignora questa email: la tua password resta invariata.',
  }),
  'email-change-confirm': (m) => ({
    subject: 'Conferma il nuovo indirizzo email',
    paragraphs: [
      `Qualcuno che ha effettuato l’accesso al tuo account Kept ha chiesto di spostarlo su ${m.newEmail}. Se sei stato tu, conferma con questo link entro la prossima ora.`,
    ],
    action: { label: 'Conferma la modifica', url: m.url },
    footnote:
      'Se non sei stato tu, non usare il link: il tuo account resta su questo indirizzo. Potresti voler cambiare la password.',
  }),
  'email-change-verify': (m) => ({
    subject: 'Verifica il tuo indirizzo email per Kept',
    paragraphs: [
      'Usa questo link per completare lo spostamento del tuo account Kept su questo indirizzo.',
    ],
    action: { label: 'Verifica questo indirizzo', url: m.url },
    footnote:
      'Se non te lo aspettavi, ignora questa email: non cambia nulla finché il link non viene usato.',
  }),
  'email-changed': (m) => ({
    subject: 'L’indirizzo email di Kept è stato modificato',
    paragraphs: [
      `Il tuo account Kept ora usa ${m.newEmail}. Questo indirizzo non riceverà più le sue email.`,
    ],
    footnote: 'Se non hai fatto tu questa modifica, contatta chi gestisce la tua istanza di Kept.',
  }),
  invite: (m) => ({
    subject: m.inviterName
      ? `${m.inviterName} ti ha invitato in «${m.locationName}» su Kept`
      : `Sei invitato in «${m.locationName}» su Kept`,
    paragraphs: [
      m.inviterName
        ? `${m.inviterName} ti ha invitato a unirti a «${m.locationName}» come ${IT_ROLE[m.role]}.`
        : `Sei invitato a unirti a «${m.locationName}» come ${IT_ROLE[m.role]}.`,
      'Kept tiene traccia degli oggetti che possiedi, di dove si trovano e delle loro scadenze.',
    ],
    action: { label: 'Accetta l’invito', url: m.url },
    footnote: 'Se non te lo aspettavi, ignora questa email: non succede nulla se non accetti.',
  }),
  'sign-up-existing': (_m, ctx) => ({
    subject: 'Qualcuno ha provato a registrarsi con il tuo indirizzo email',
    paragraphs: [
      'Qualcuno ha provato a creare un account Kept con questo indirizzo, che ne ha già uno. Non è stato creato nessun nuovo account.',
      'Se sei stato tu, accedi invece di registrarti. Se hai dimenticato la password, puoi reimpostarla dalla pagina di accesso.',
    ],
    action: { label: 'Accedi', url: page(ctx, '/signin') },
    footnote: 'Se non sei stato tu, non devi fare nulla.',
  }),
  'security-notice': (m, ctx) => IT_SECURITY[m.event](ctx),
  'admin-action': (m) => ({
    ...IT_ADMIN[m.action](m.locationName ?? ''),
    footnote: 'Questo è un avviso automatico sul tuo account.',
  }),
  'owner-new-member': (m) => ({
    subject: `${m.memberName} si è unito a «${m.locationName}»`,
    paragraphs: [
      m.managed
        ? `${m.memberName} è stato aggiunto a «${m.locationName}» come account gestito, con il ruolo di ${IT_ROLE[m.role]}.`
        : `${m.memberName} ora ha accesso a «${m.locationName}» come ${IT_ROLE[m.role]}.`,
    ],
    footnote:
      'Ricevi questo avviso in quanto proprietario, per ogni nuovo membro. Puoi modificare o rimuovere i membri nelle impostazioni del luogo.',
  }),
  'ai-cap': (m, ctx) =>
    itCap(
      m.level,
      m.cap,
      ctx,
      'Ricevi questa e-mail perché hai impostato questo limite o perché riguarda la tua attività. Viene inviata una volta al mese.',
    ),
  'admin-alert': (m, ctx) => {
    const footnote =
      'Ricevi questo avviso in quanto amministratore di questa istanza di Kept. Viene inviato al massimo una volta al giorno finché il problema persiste.';
    if (m.alert === 'ai_instance_cap_warning' || m.alert === 'ai_instance_cap_reached') {
      const c = capFactsOf(m.details);
      if (c) return itCap(m.alert === 'ai_instance_cap_warning' ? 80 : 100, c, ctx, footnote);
    }
    if (m.alert === 'ai_instance_key_rejected') {
      return {
        subject: 'Kept: la chiave di IA del server è stata rifiutata',
        paragraphs: [
          `${String(m.details.provider ?? 'Il fornitore')} ha rifiutato la chiave di IA di questo server: il lavoro di IA pagato con questa chiave è in attesa.`,
          'Sostituisci la chiave nelle impostazioni di IA dell’amministrazione. Il lavoro in attesa riprende appena viene salvata una nuova chiave.',
        ],
        action: { label: 'Apri le impostazioni dell’IA', url: page(ctx, '/admin/ai') },
        footnote,
      };
    }
    if (m.alert === 'failed_jobs_rising') {
      return {
        subject: 'Kept: alcuni job in background non vanno a buon fine',
        paragraphs: [
          `Nell’ultima ora ${num(m.details.failedLastHour)} job in background non sono andati a buon fine.`,
          'L’elenco dei job non riusciti mostra cosa non ha funzionato e perché; da lì puoi riprovarli o scartarli.',
        ],
        action: { label: 'Apri i job non riusciti', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'backup_failed') {
      return {
        subject: 'Kept: il backup notturno non è riuscito',
        paragraphs: [
          `Il backup notturno non è stato completato: ${String(m.details.error ?? '')}`,
          m.details.lastOk
            ? `L’ultimo backup riuscito è terminato il ${day(m.details.lastOk)}. Finché non ne riesce uno nuovo, nulla di ciò che è stato salvato da allora è in un backup.`
            : 'Nessun backup è ancora riuscito, quindi nulla in questa istanza di Kept è protetto da un backup.',
        ],
        action: { label: 'Apri la pagina di stato', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'backup_stale') {
      return {
        subject: 'Kept: nessun backup da più di 36 ore',
        paragraphs: [
          m.details.lastOkAt
            ? `L’ultimo backup riuscito è terminato il ${day(m.details.lastOkAt)}. Kept fa un backup ogni notte, quindi il backup notturno ha smesso di funzionare.`
            : 'I backup sono configurati, ma nessuno è ancora terminato.',
          'La pagina dei backup elenca ogni esecuzione e il motivo per cui non è riuscita. Se il processo in background di Kept non è attivo, riavvialo.',
        ],
        action: { label: 'Apri i backup', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'disk_space_low') {
      const d = diskFacts(m.details, true);
      return {
        subject: d.backup
          ? 'Kept: il disco dei backup è quasi pieno'
          : 'Kept: il disco dei dati è quasi pieno',
        paragraphs: [
          `È pieno al ${d.percent}%, con ${d.gb} GB liberi.`,
          d.backup
            ? 'Quando si riempie, il backup notturno non riesce. Libera spazio, usa un disco più grande o conserva meno backup nelle impostazioni dei backup.'
            : 'Quando si riempie, Kept non può salvare nuove foto o documenti e il suo database può fermarsi. Libera spazio o usa un disco più grande.',
        ],
        action: { label: 'Apri la pagina di stato', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'bucket_versioning_off') {
      return {
        subject: 'Kept: il versioning del bucket dei file è disattivato',
        paragraphs: [
          'Kept conserva i suoi file in un bucket S3, e il backup notturno li lascia lì. Il versioning di quel bucket è disattivato, quindi un file eliminato o sovrascritto per errore, o da chi ne ha la chiave, non si può recuperare.',
          'Attiva il versioning del bucket presso il tuo fornitore di storage. Questo messaggio smette quando il backup successivo lo trova attivo.',
        ],
        action: { label: 'Apri la pagina di stato', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'restore_drill_due') {
      return {
        subject: 'Kept: è ora di una prova di ripristino',
        paragraphs: [
          m.details.lastDrillAt
            ? `L’ultima prova di ripristino è stata il ${day(m.details.lastDrillAt)}, più di 30 giorni fa.`
            : 'Non è ancora stata fatta nessuna prova di ripristino.',
          'Una prova ripristina l’ultimo backup in un database temporaneo e controlla ogni tabella, così sai che i backup si possono davvero ripristinare. Esegui `kept admin backup drill` come indica la guida al ripristino.',
        ],
        action: { label: 'Apri i backup', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'backup_suspicious_size') {
      return {
        subject: 'Kept: l’ultimo backup sembra troppo piccolo',
        paragraphs: [
          'L’ultimo backup è molto più piccolo dell’ultimo riuscito. Kept l’ha tenuto, ma non ha eliminato nessun backup più vecchio, quindi quelli buoni restano.',
          'Se è stato eliminato molto di proposito, va tutto bene e i prossimi backup fanno sparire questo avviso. Altrimenti, scopri cosa è cambiato prima di ripristinare qualcosa.',
        ],
        action: { label: 'Apri i backup', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'webhook_failing') {
      return {
        subject: 'Kept: il webhook di un luogo continua a non riuscire',
        paragraphs: [
          `Un webhook configurato in uno dei luoghi di questo Kept non è riuscito a consegnare nulla dal ${day(m.details.since)}, quindi Kept lo ha segnato come non funzionante.`,
          'Kept continua a riprovare a ogni nuovo evento. I proprietari e gli amministratori del luogo lo vedono, e possono correggerlo o rimuoverlo, in Impostazioni del luogo → Webhook.',
        ],
        action: { label: 'Apri la pagina di stato', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'reminders_not_scanned') {
      return {
        subject: 'Kept: i promemoria non vengono più inviati',
        paragraphs: [
          m.details.lastOkAt
            ? `Kept ha controllato i promemoria in scadenza l’ultima volta il ${day(m.details.lastOkAt)}, più di 2 ore fa. Finché non li controlla di nuovo, nessuno riceve nuovi promemoria.`
            : 'Kept non ha ancora completato nessun controllo dei promemoria in scadenza, quindi nessuno riceve promemoria.',
          'Il controllo viene eseguito ogni 15 minuti dal processo in background di Kept. L’elenco dei job non riusciti mostra perché si è fermato; se il processo in background non è in esecuzione, riavvialo.',
        ],
        action: { label: 'Apri i job non riusciti', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'llm_default_partition') {
      return {
        subject: 'Kept: alcuni registri delle chiamate all’IA richiedono attenzione',
        paragraphs: [
          `${num(m.details.rows)} registri delle chiamate all’IA (dal ${day(m.details.oldest)} al ${day(m.details.newest)}) sono stati salvati fuori dalla loro partizione mensile.`,
          'Kept non può creare la partizione di quel mese finché non vengono spostati al suo interno, quindi il job notturno di manutenzione dell’IA continuerà a non riuscire. Spostarli è un intervento sul database che spetta a chi gestisce questa istanza di Kept.',
        ],
        action: { label: 'Apri la pagina di stato', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    return {
      subject: 'Kept: alcuni eventi di audit richiedono attenzione',
      paragraphs: [
        `${num(m.details.rows)} eventi di audit (dal ${day(m.details.oldest)} al ${day(m.details.newest)}) sono stati salvati fuori dalla loro partizione mensile.`,
        'Kept non può creare la partizione di quel mese finché non vengono spostati al suo interno, quindi il job di manutenzione notturno continuerà a non riuscire. Spostarli è un intervento sul database che spetta a chi gestisce questa istanza di Kept.',
      ],
      action: { label: 'Apri la pagina di stato', url: page(ctx, '/admin/status') },
      footnote,
    };
  },
};

export const IT_CHROME: Chrome = {
  dir: 'ltr',
  linkFallback: 'Se il pulsante non funziona, copia questo indirizzo nel browser:',
  sentBy: (host) => `Inviato da Kept su ${host}.`,
};
