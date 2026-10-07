import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflate } from 'node:zlib';

// Hand-made PDFs for the PDF text tests (T21): the smallest documents that exercise the reader,
// written here rather than committed as binaries. Offsets are computed, so every xref is valid.

/** A PDF of `objects` (object 1 must be the catalog), with a trailer and a valid xref table. */
export function pdfOf(objects: (string | Buffer)[], trailerExtra = ''): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = chunks[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(part);
    length += part.length;
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) tail += `${String(at).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(chunks);
}

const pdfString = (line: string) => line.replace(/[()\\]/g, '\\$&');

/** A text PDF: one page per entry, each line written with Helvetica (Latin-1 text only). */
export function textPdf(pages: readonly (readonly string[])[]): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: string[] = [];
  for (const lines of pages) {
    const content = `BT /F1 10 Tf 12 TL 36 756 Td ${lines.map((l) => `(${pdfString(l)}) '`).join(' ')} ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
    const contents = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`,
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  return pdfOf(objects);
}

/** A PDF whose one page has no text layer: what a scanner makes, minus the picture. */
export function scannedPdf(): Buffer {
  return pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ]);
}

/**
 * A PDF encrypted with a password (the standard handler, revision 2): its /U doesn't answer to
 * the empty password, so a reader without the password can't open it.
 */
export function encryptedPdf(): Buffer {
  const hex32 = (byte: string) => `<${byte.repeat(32)}>`;
  return pdfOf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      `<< /Filter /Standard /V 1 /R 2 /O ${hex32('4b')} /U ${hex32('5a')} /P -4 >>`,
    ],
    `/Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] `,
  );
}

/** A page whose content stream inflates from a small file into `mb` MB of blanks. Deflated as a
 * stream, so the test never holds the inflated size itself. */
export async function flateBombPdf(mb: number): Promise<Buffer> {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  const out: Buffer[] = [];
  const deflate = createDeflate({ level: 9 });
  deflate.on('data', (c: Buffer) => out.push(c));
  await pipeline(
    Readable.from(
      (function* () {
        for (let i = 0; i < mb; i++) yield chunk;
      })(),
    ),
    deflate,
  );
  const deflated = Buffer.concat(out);
  return pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    Buffer.concat([
      Buffer.from(`<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      deflated,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  ]);
}
