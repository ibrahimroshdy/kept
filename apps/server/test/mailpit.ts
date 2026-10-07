// Mailpit, the dev SMTP catcher (compose.dev.yaml: SMTP on 1025, HTTP API on 8025), for tests
// that send real mail. Its search API (`/api/v1/search?query=to:<address>`) and message API
// (`/api/v1/message/<ID>`) are the ones its own web UI calls.

export const MAILPIT_SMTP_URL = 'smtp://localhost:1025';
const API = 'http://localhost:8025/api/v1';

export type MailpitSummary = { ID: string; Subject: string; To: { Address: string }[] };
export type MailpitMessage = {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
  To: { Address: string }[];
  Text: string;
  HTML: string;
};

export async function mailpitSearch(to: string): Promise<MailpitSummary[]> {
  const res = await fetch(`${API}/search?query=${encodeURIComponent(`to:${to}`)}`);
  if (!res.ok) throw new Error(`Mailpit search answered ${res.status}`);
  return ((await res.json()) as { messages: MailpitSummary[] }).messages;
}

export async function mailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${API}/message/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Mailpit message answered ${res.status}`);
  return (await res.json()) as MailpitMessage;
}

/** Waits until `count` messages to `to` have arrived, and returns them in full, oldest first. */
export async function mailpitWait(to: string, count = 1, ms = 10_000): Promise<MailpitMessage[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await mailpitSearch(to);
    if (found.length >= count) {
      const full = await Promise.all(found.map((m) => mailpitMessage(m.ID)));
      return full.reverse();
    }
    if (Date.now() > deadline) {
      throw new Error(`Mailpit has ${found.length} of ${count} messages to ${to}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
