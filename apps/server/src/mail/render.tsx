import { renderToStaticMarkup } from 'react-dom/server';
import { CHROME, type Chrome, type MailLocale, type Message } from './messages.js';

// A mail's two parts (D81: templates rendered from React). The HTML is one small React tree
// rendered to static markup, which escapes every name a person chose (a location, an inviter),
// so none of it can become markup in someone's inbox. Inline styles only: mail clients ignore
// stylesheets. The plain-text part carries the same words, and the link spelled out.

export type RenderedMail = { subject: string; text: string; html: string };

const FONT =
  "-apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic', Arial, sans-serif";

function Mail({ message, chrome, host }: { message: Message; chrome: Chrome; host: string }) {
  const align = chrome.dir === 'rtl' ? 'right' : 'left';
  return (
    <div
      dir={chrome.dir}
      style={{
        fontFamily: FONT,
        fontSize: '16px',
        lineHeight: '1.5',
        color: '#1c1b19',
        background: '#f6f4ef',
        padding: '24px 16px',
        textAlign: align,
      }}
    >
      <div
        style={{
          maxWidth: '560px',
          margin: '0 auto',
          background: '#ffffff',
          borderRadius: '8px',
          padding: '24px',
        }}
      >
        <p style={{ margin: '0 0 16px', fontWeight: 700, letterSpacing: '0.02em' }}>Kept</p>
        {message.paragraphs.map((text) => (
          <p key={text} style={{ margin: '0 0 16px' }}>
            {text}
          </p>
        ))}
        {message.action ? (
          <>
            <p style={{ margin: '24px 0' }}>
              <a
                href={message.action.url}
                style={{
                  display: 'inline-block',
                  background: '#1c1b19',
                  color: '#ffffff',
                  textDecoration: 'none',
                  padding: '12px 20px',
                  borderRadius: '6px',
                  fontWeight: 600,
                }}
              >
                {message.action.label}
              </a>
            </p>
            <p style={{ margin: '0 0 16px', fontSize: '13px', color: '#5c5a55' }}>
              {chrome.linkFallback}
              <br />
              <span dir="ltr" style={{ wordBreak: 'break-all' }}>
                {message.action.url}
              </span>
            </p>
          </>
        ) : null}
        {message.footnote ? (
          <p style={{ margin: '16px 0 0', fontSize: '13px', color: '#5c5a55' }}>
            {message.footnote}
          </p>
        ) : null}
      </div>
      <p
        style={{
          maxWidth: '560px',
          margin: '12px auto 0',
          fontSize: '12px',
          color: '#8a8780',
        }}
      >
        {chrome.sentBy(host)}
      </p>
    </div>
  );
}

function text(message: Message, chrome: Chrome, host: string): string {
  const parts = [...message.paragraphs];
  if (message.action) parts.push(`${message.action.label}:\n${message.action.url}`);
  if (message.footnote) parts.push(message.footnote);
  parts.push(`-- \n${chrome.sentBy(host)}`);
  return `${parts.join('\n\n')}\n`;
}

/** The subject, text and HTML of a message, in its language's direction. */
export function renderMail(message: Message, locale: MailLocale, publicUrl: string): RenderedMail {
  const chrome = CHROME[locale];
  const host = new URL(publicUrl).host;
  const body = renderToStaticMarkup(<Mail message={message} chrome={chrome} host={host} />);
  const html =
    `<!doctype html><html lang="${locale}" dir="${chrome.dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="margin:0">${body}</body></html>`;
  return { subject: message.subject, text: text(message, chrome, host), html };
}
