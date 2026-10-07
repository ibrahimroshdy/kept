---
title: Mail, push and the calendar feed
description: Set up outgoing mail and web push for a Kept server, and what operators should know about the private calendar links people make.
---

Kept reaches people in three ways outside the app: **email**, **web push** to a browser or the
installed app, and a **calendar feed** their calendar app subscribes to. Everything also lands in
the in-app notification centre, which needs no setup. People choose what reaches them in
**Settings → Notifications** (Reminders and alerts → **Open**). This page is the operator's side.
Every variable is listed in the [configuration reference](/reference/configuration/).

## Mail

| Variable | What it does |
|---|---|
| `KEPT_SMTP_URL` | The SMTP server, as `smtp://` or `smtps://`, with credentials if it needs them: `smtps://user:password@mail.example.org:465`. |
| `KEPT_SMTP_FROM` | The From of every mail. Default: `Kept <no-reply@<your KEPT_PUBLIC_URL host>>`. Most providers send only as an address they have verified, so set it. |

With Compose, put both in `.env`; `compose.yaml` passes them to `kept` and `migrate`. With the
Helm chart, `smtp.existingSecret` names a Secret holding `KEPT_SMTP_URL`, and `smtp.from` sets the
sender. Kept opens one connection per mail; nodemailer's own URL options (such as `?pool=true`)
pass through the URL.

### When `KEPT_SMTP_URL` is unset

Mail is only logged as due: one warning per mail, `mail not sent: no mail transport is
configured`, naming the kind of mail and never the address, link or token. **Admin → Status**
shows **Mail: Not configured** and the notice **Mail isn't configured**. Without mail there are
no sign-in links, password resets, email invites or emailed alerts. Link invites and passwords
work without it, and reminders still reach people by push and in the app.

When mail is configured, an account whose address isn't verified can't add a passkey or an
authenticator app until it is.

### What Kept sends

Each mail goes out as text and HTML in the recipient's language (English, Arabic, French, German
or Italian; English when Kept doesn't know it). Links carry their token after `#`, so a mail
scanner or a server log never holds a usable one.

- **Signing in and the account**: sign-in links, password resets, confirming and verifying a new
  email address and a note to the old one, a note when someone tries to sign up with an address
  that already has an account, and a notice when a credential changes.
- **People and locations**: email invites; to a location's owner, each new member or managed
  account and each membership that reaches its end date.
- **Transparency**: when an instance admin (or `kept admin`) acts on someone's account; and to
  every active user when the instance's OIDC sign-in, its outgoing mail or its default AI provider
  changes.
- **Reminders**: an overdue item at once, the daily digest, a channel test, and a note when a
  person's own webhook keeps failing.
- **AI**: a monthly cap reaching 80% or 100%, and the optional monthly AI summary.
- **To instance admins**: admin alerts, at most once a day per alert
  ([the status page and alerts](/admin/observability/#the-status-page-and-alerts)).

### Changing the mail server

Kept compares the SMTP host and the sender with what it last saw each time it starts, never the
password. If either changed, the change is audited and every active user is told, by the new
route. The first start with mail configured only records it.

## Web push

Push needs **no keys from you**. On first start Kept generates a VAPID key pair and keeps it in
the database, the private key sealed with `KEPT_SECRET_KEY`. To bring your own pair, set both:

| Variable | What it does |
|---|---|
| `KEPT_VAPID_PUBLIC_KEY` | The public key: unpadded base64url of 65 bytes, as web-push's `generateVAPIDKeys()` writes it. |
| `KEPT_VAPID_PRIVATE_KEY` | Its private half (32 bytes, same encoding). Never logged. Setting one without the other stops Kept at start. |
| `KEPT_VAPID_SUBJECT` | Who push services may contact: an `https:` URL or a `mailto:` address. Default: `KEPT_PUBLIC_URL` when it is `https`, else `mailto:` the `KEPT_SMTP_FROM` address. |

Push is **unavailable** when:

- `KEPT_PUBLIC_URL` is plain `http` on anything but localhost: browsers subscribe only on a secure
  page. People see "Push needs HTTPS." ([HTTPS](/install/https/))
- there is no subject: no `KEPT_VAPID_SUBJECT`, no `https` public URL and no `KEPT_SMTP_FROM`.
  People see "Push isn't set up on this server."

Email and the notification centre still work either way.

People turn push on per device with **Enable** under **How Kept reaches you**, after the browser
asks. **On iPhone and iPad, notifications work only from the installed app**: Kept says so and
offers **How to install** ([the phone app](/users/phone-app/)).

What leaves the server: Kept sends each push over HTTPS to the push service the browser
subscribed with, so it needs outbound internet access; private and local addresses are refused.
A push carries a title, a line of text and a link, under 3 KB, never money or contact details.
The push service holds it for up to a day while a device is offline. A subscription the service
reports gone is deleted.

:::caution[Losing the key]
If the stored private key can't be opened, because the secret key it was sealed with is gone,
Kept makes a new pair and drops every push subscription. Nothing else is lost: people turn push on
again on each device. Keep [the recovery kit](/admin/recovery-kit/) and this never happens on a
restore or a [move](/admin/move-server/).
:::

## The calendar feed

Each person can make a private iCal link of what's due and what runs out, in **Settings →
Notifications → Calendar feed → Create a link**. There is nothing to configure on the server.

- **What it holds**: all-day events from a month back to 13 months ahead, across the person's
  locations: titles, place paths, location names and a link into Kept. Never money, secrets,
  notes or anyone's contact details. Only the kinds the person gets on some channel, and nothing
  from a part of Kept a location has turned off. Locations that require two-factor are left out.
- **The link**: `https://kept.example.org/cal/<token>.ics`, shown once. Kept stores only the
  token's SHA-256 and redacts it from request logs. It is built from `KEPT_PUBLIC_URL` when it is
  made, so a link made before an address change still points at the old address.
- **Who can read it**: anyone who has the link, with no sign-in. An unknown or revoked link, or one
  belonging to a disabled account, answers 404 without saying which. Each link may be fetched 60
  times a minute.
- **Revoking**: **Revoke** on the link ends it for good; calendars subscribed to it stop updating.
  The list keeps the revoked row and shows when each live link was last fetched. A person can
  hold at most 3 live links.

Google Calendar fetches the link from Google's servers, so there it works only when Kept can be
reached from the internet.
