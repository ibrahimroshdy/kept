import type { IncomingMessage } from 'node:http';
import pino, { type DestinationStream, type Logger } from 'pino';
import pretty from 'pino-pretty';
import type { Env } from '../config/env.js';
import { safeErrorForLog } from './errors.js';

// pino JSON logs with request ids, never secrets or argument values (D81). Tokens in URLs are
// redacted (D181): the magic-link and invite tokens travel in the #fragment, which never reaches
// the server, but a query-string token from an older link or a client bug must not be logged,
// nor the invite token the web page puts in the preview and accept paths.

const SENSITIVE_PARAM = /token|secret|password|passwd|code|key|signature|sig|auth/i;

/** Paths that carry a token as a segment: the invite preview and accept routes (task 20), a
 * signed file URL, whose whole path is its token (Q16; security review #11), a claim pack's
 * download link (step 4, T18: `/x/<token>`) and a calendar feed (T17: `/cal/<token>.ics`). */
const TOKEN_PATH = /^(\/api\/v1\/invites\/|\/f\/|\/x\/|\/cal\/)[^/?#]+/;

/** The URL with every sensitive query parameter's value, and a token path segment, replaced. */
export function redactUrl(raw: string): string {
  const url = raw.replace(TOKEN_PATH, '$1[redacted]');
  const q = url.indexOf('?');
  if (q === -1) return url;
  const query = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {}
      return eq !== -1 && SENSITIVE_PARAM.test(decoded) ? `${name}=[redacted]` : pair;
    })
    .join('&');
  return `${url.slice(0, q)}?${query}`;
}

type FastifyLikeRequest = IncomingMessage & { ip?: string; routeOptions?: { url?: string } };

export const serializers = {
  req(req: FastifyLikeRequest) {
    return {
      method: req.method,
      url: redactUrl(req.url ?? ''),
      remoteAddress: req.ip ?? req.socket?.remoteAddress,
    };
  },
  err: safeErrorForLog,
};

export type LoggerEnv = Pick<Env, 'KEPT_LOG_LEVEL' | 'KEPT_LOG_FORMAT'>;

/** The process logger. `destination` is for tests; otherwise stdout (json) or pino-pretty. */
export function createLogger(env: LoggerEnv, destination?: DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level: env.KEPT_LOG_LEVEL,
    serializers,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
  };
  const stream =
    destination ?? (env.KEPT_LOG_FORMAT === 'pretty' ? pretty({ colorize: false }) : undefined);
  return stream ? pino(options, stream) : pino(options);
}
