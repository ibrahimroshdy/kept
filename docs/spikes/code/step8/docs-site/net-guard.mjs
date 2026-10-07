// Spike D1: preload (NODE_OPTIONS=--import ./net-guard.mjs) that records every outbound network
// attempt the build makes. NET_GUARD=block refuses them all (an "offline" proxy: DNS fails and
// sockets to non-loopback hosts are refused), NET_GUARD=log only records. The list is written to
// NET_GUARD_OUT (JSON) when the process exits.
import dns from 'node:dns';
import { writeFileSync } from 'node:fs';
import net from 'node:net';

const mode = process.env.NET_GUARD ?? 'log';
const seen = [];
const local = (h) => !h || h === 'localhost' || h === '::1' || /^127\./.test(h) || h.startsWith('/');
const note = (kind, target) => {
  if (local(target)) return false;
  seen.push({ kind, target: String(target), pid: process.pid });
  return mode === 'block';
};

const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (note('dns', host)) {
    const cb = rest.at(-1);
    const err = Object.assign(new Error(`net-guard: blocked lookup ${host}`), { code: 'ENOTFOUND' });
    return process.nextTick(() => cb(err));
  }
  return origLookup.call(this, host, ...rest);
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  if (note('socket', o.path ?? `${o.host ?? 'localhost'}:${o.port}`)) {
    throw Object.assign(new Error('net-guard: blocked connect'), { code: 'ECONNREFUSED' });
  }
  return origConnect.apply(this, args);
};

const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (note('fetch', url.href) ) throw new TypeError(`net-guard: blocked fetch ${url.href}`);
  return origFetch(input, init);
};

process.on('exit', () => {
  if (process.env.NET_GUARD_OUT) {
    writeFileSync(`${process.env.NET_GUARD_OUT}.${process.pid}.json`, JSON.stringify(seen, null, 2));
  }
});
