---
title: Put Kept on HTTPS
description: Why Kept wants HTTPS, and how to get it - Compose's Caddy profile, Tailscale, NetBird, Twingate, Cloudflare Tunnel or your own proxy.
sidebar:
  order: 2
---

Kept works over plain HTTP, but a phone treats a plain-HTTP address as unsafe, and several things
stop working:

- **the camera** (Kept falls back to a file picker),
- **installing Kept** to the home screen, and working offline from it,
- **push notifications**,
- **location**.

`localhost` counts as safe; a LAN address over HTTP does not. With an `https:` `KEPT_PUBLIC_URL`,
Kept also marks its cookies `Secure` and sends HSTS.

Some things Kept refuses outright while `KEPT_PUBLIC_URL` is `http:`, even on `localhost`, because
they hand out or change a secret: showing a secret value, starting an export, making an access
token, connecting an app with OAuth, downloading the recovery kit, and changing or testing the
backup settings. Sessions are also shorter over HTTP. While Kept is served over HTTP, the Get
started checklist on Home puts "Put Kept on HTTPS" first.

Whichever way you choose, set `KEPT_PUBLIC_URL` to the `https://` address people will open, and
restart Kept.

## Compose's Caddy profile

For a domain name that points at this machine, with ports 80 and 443 reachable from the internet
(Caddy proves the domain to Let's Encrypt or ZeroSSL over them):

```sh
# in .env
KEPT_DOMAIN=kept.example.org
KEPT_PUBLIC_URL=https://kept.example.org
```

```sh
docker compose --profile https up -d
```

Caddy gets and renews the certificate and forwards everything to Kept. Compose gives Caddy a fixed
address on its own network and passes that address to Kept as `KEPT_TRUSTED_PROXIES`, so Kept
believes Caddy's `X-Forwarded-For` and nothing else's. You can then bind plain HTTP to loopback
only, with `KEPT_HTTP_PORT=127.0.0.1:8080`.

If `172.29.72.0/24` clashes with your LAN, change the network's subnet, its `ip_range`, Caddy's
`ipv4_address` and `KEPT_TRUSTED_PROXIES` together in `compose.yaml`.

## Tailscale

For a Kept that only your own devices reach, with no port open to the internet: on the machine
running Kept, with HTTPS certificates enabled for your tailnet,

```sh
tailscale serve --bg 8080
```

serves Kept at `https://<machine>.<tailnet>.ts.net` with a real certificate, to any device on the
tailnet. Set `KEPT_PUBLIC_URL` to that address.

Tailscale's proxy runs on the same machine and connects to Kept from `127.0.0.1`; Kept sees every
request as coming from there unless you trust it. On a single-household instance that only
matters for [the setup lockout](/install/reverse-proxy/#the-setup-lockout).

## NetBird

NetBird's reverse proxy gives a peer's port a public `https://` address with a certificate:

```sh
netbird expose 8080
```

It prints the address. Set `KEPT_PUBLIC_URL` to it (or to your own domain, with
`--with-custom-domain kept.example.org`, set up in NetBird first). The address is public unless
you choose **NetBird-Only Access** for the service in the dashboard, which limits it to your peers.
An account admin turns on **Peer Expose** under Settings → Clients first.

## Twingate

Twingate makes Kept reachable to your devices without opening a port, but the certificate is
yours: give Kept a hostname on a domain you own (`kept.example.org`), get a certificate for it with
a DNS challenge (Caddy, Traefik or cert-manager can), and add that hostname as a Twingate resource.
Set `KEPT_PUBLIC_URL` to `https://kept.example.org`.

## Cloudflare Tunnel

For a public address with no open port. Cloudflare serves the hostname over HTTPS and forwards to
Kept through `cloudflared`:

```sh
cloudflared tunnel login
cloudflared tunnel create kept
cloudflared tunnel route dns kept kept.example.org
cloudflared tunnel run kept
```

with `~/.cloudflared/config.yml`:

```yaml
tunnel: kept
credentials-file: <home>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: kept.example.org
    service: http://localhost:8080
  - service: http_status:404
```

Set `KEPT_PUBLIC_URL` to `https://kept.example.org`. Cloudflare Access can put a sign-in in front
of it. A public address is also what a web app such as claude.ai needs to
[connect to Kept's MCP server](/users/mcp-clients/#connect-as-a-connector-oauth).

`cloudflared`, like the other tunnels here, reaches Kept from the same machine; trust it as in
[reverse proxies](/install/reverse-proxy/#trust-the-proxy-and-only-the-proxy).

## Your own reverse proxy

Any proxy that terminates TLS and forwards to port 8080 works. Read
[reverse proxies](/install/reverse-proxy/) for the three settings that matter.

## A certificate only your devices trust

On a LAN with no domain, mkcert can make a certificate
for the machine's address, served through any TLS proxy. Every phone must then trust mkcert's root
certificate; on an iPhone that means installing it as a profile and turning on full trust in
Settings → General → About → Certificate Trust Settings. Tailscale is usually less work.
