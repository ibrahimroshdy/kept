---
title: Behind a reverse proxy
description: The settings that matter when Kept sits behind nginx, Traefik, Caddy or another proxy - trusted addresses, upload sizes, and which hostname to use.
sidebar:
  order: 3
---

Kept listens on port 8080 and speaks plain HTTP; the proxy in front of it terminates TLS. Point the
proxy at port 8080, set `KEPT_PUBLIC_URL` to the address people open, and check the three things
below. Compose's own [Caddy profile](/install/https/#composes-caddy-profile) already does all three.

## Trust the proxy, and only the proxy

Kept rate-limits sign-in, setup codes and other sensitive requests **per client address**. Behind a
proxy, the client's address arrives in `X-Forwarded-For`, which anyone can write. Kept believes it
only from the addresses in `KEPT_TRUSTED_PROXIES`:

```sh
KEPT_TRUSTED_PROXIES=10.0.0.5            # one proxy
KEPT_TRUSTED_PROXIES=10.0.0.5,10.0.1.0/24  # several, or a range
```

Kept walks `X-Forwarded-For` from the right and stops at the first address it doesn't trust: that is
the client. Empty (the default), the socket's address is the client. List the proxy's address as
Kept sees it (on Docker's network, the proxy container's address, not the host's), and nothing
that a stranger could send requests from.

### The setup lockout

Wrong setup codes lock out the address that sent them for a while, and many wrong codes lock out
the whole instance. If the proxy isn't in `KEPT_TRUSTED_PROXIES`, every visitor shares the proxy's
address, so one person's guesses lock everyone out. `kept admin setup-code` issues a new code and
lifts the instance-wide lockout, but not a per-address one: that one ends on its own.

## Let uploads through

The proxy must accept a request body at least as large as Kept does, and should not buffer uploads
it doesn't need to:

| Upload | Kept's limit |
|---|---|
| A photo, receipt or document | `KEPT_MAX_FILE_MB`, 25 MB by default; streamed, refused with 413 before it is read when too large |
| A CSV import | 8 MB |

Most proxies' default is smaller (nginx's `client_max_body_size`, for instance); raise it to at
least `KEPT_MAX_FILE_MB`. Timeouts should allow a large upload over a slow phone connection.

## Give Kept its own hostname

Serve Kept on a hostname whose parent domain has no sites you don't control, or on a domain of its
own. Over HTTPS Kept's session cookie is `__Secure-` prefixed, which still lets a page on a
**sibling** subdomain (`other.example.org` beside `kept.example.org`) set a cookie for
`example.org` that browsers also send to Kept. A sibling run by someone else could use that to
fixate a session. Your own other services on sibling subdomains are fine.
