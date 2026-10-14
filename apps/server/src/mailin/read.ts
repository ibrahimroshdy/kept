import { convert } from 'html-to-text';
import { simpleParser } from 'mailparser';

// What an emailed receipt is made of (1.4, D231): its sender, subject and date, and either its
// receipt files (the photos and PDFs attached to it) or, when it has none, its body as text, which
// the job keeps as a one-page PDF (reports/template/email.typ). Nothing here trusts the mail: the
// From address is only a filter (it can be forged), the files are sniffed again when they are
// ingested, and the text reaches the model as data (the receipt prompt's rules).

/** The most files one message gives a receipt (a capture takes 20). */
export const MAX_FILES = 10;
/** An inline logo or a tracking pixel is not a receipt: images below this are skipped. */
export const MIN_IMAGE_BYTES = 4096;
/** The most body text kept as a page. */
export const MAX_TEXT = 20_000;
/** A body shorter than this ("Sent from my phone") is not a receipt. */
export const MIN_TEXT = 40;

export type MailFile = { bytes: Buffer; contentType: string; filename: string | null };
export type Paragraph = { text: string; rtl: boolean };

export type ReadMail = {
  from: string | null;
  subject: string | null;
  date: Date | null;
  files: MailFile[];
  /** The body, when no file was attached; null when there is nothing worth keeping. */
  body: Paragraph[] | null;
};

const RECEIPT_TYPE = /^(image\/(jpeg|png|webp|heic|heif|avif|gif)|application\/pdf)$/;

/** Whether a paragraph reads right to left: its first strong letter is Arabic or Hebrew. */
export function isRtl(text: string): boolean {
  const m = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]|[֐-ࣿיִ-﷿ﹰ-﻿]/.exec(text);
  return !!m && /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(m[0]);
}

/** The body's text as paragraphs: blank lines split them, runs of spaces collapse. */
export function paragraphsOf(text: string): Paragraph[] {
  return text
    .slice(0, MAX_TEXT)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .map((p) => ({ text: p, rtl: isRtl(p) }));
}

const clip = (s: string | undefined | null, n: number) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, n) : null;
};

export async function readMail(raw: Buffer): Promise<ReadMail> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const from = mail.from?.value[0]?.address?.toLowerCase().slice(0, 254) ?? null;
  const files: MailFile[] = [];
  for (const a of mail.attachments) {
    if (files.length >= MAX_FILES) break;
    const type = a.contentType.toLowerCase();
    // A picture the HTML shows (a logo, a banner) is `related`, or named by a `cid:` in it; it
    // isn't the receipt.
    const cid = a.cid ?? a.contentId?.replace(/^<|>$/g, '');
    const shown = !!cid && typeof mail.html === 'string' && mail.html.includes(`cid:${cid}`);
    if (a.related || shown || !RECEIPT_TYPE.test(type)) continue;
    if (type.startsWith('image/') && a.size < MIN_IMAGE_BYTES) continue;
    files.push({ bytes: a.content, contentType: type, filename: clip(a.filename, 200) });
  }
  let body: Paragraph[] | null = null;
  if (files.length === 0) {
    // mailparser makes text of HTML only when it is the root part or sits beside a text part; an
    // HTML receipt inside multipart/related (with its logo) has none, so it is converted here.
    let text = (mail.text ?? '').trim();
    if (!text && typeof mail.html === 'string') {
      text = convert(mail.html, {
        wordwrap: false,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'a', options: { ignoreHref: true } },
        ],
      }).trim();
    }
    if (text.length >= MIN_TEXT) body = paragraphsOf(text);
  }
  return {
    from,
    subject: clip(mail.subject, 200),
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    files,
    body: body && body.length > 0 ? body : null,
  };
}
