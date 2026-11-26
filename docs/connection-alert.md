# Connection alert

Meta can drop an app's access to an Instagram account without any error on
OpenReply's side: after Instagram was linked to or unlinked from Facebook, a
change in the business portfolio, the app removed under "Apps and websites",
or a password or security change. Webhooks then stop, every read of the
account fails, and nothing goes out. On 2026-11-25 that went unnoticed for
four hours: `/api/health` and the worker stayed green, and Settings still said
"Connected". The worker now checks the connection itself.

## The check

With every comment sweep (`COMMENT_POLL_INTERVAL_MS`), the worker reads each
account connected through your own Meta app once:
`/{ig-id}?fields=id,username` (`/me` for an Instagram Login token), also an
account without an active campaign. One small read per account and sweep.
Accounts connected through Zernio are not checked, and an account that is
paused for a Meta request limit is not read at all
([delivery retries](delivery-retries.md#metas-request-limits)).

| Answer | Counts as |
| --- | --- |
| Token error: 190, 102, 463, 467 | lost |
| Permission error: 10, 200–299 | lost |
| 100 with subcode 33 ("Object … does not exist, cannot be loaded due to missing permissions") | lost |
| A request limit (4, 17, 32, 613, 80002, 80006, 368), a network error or timeout, a 5xx, any other code | nothing: neither lost nor back |
| The read went through | ok |

Two lost answers at least one sweep interval apart open an incident; the
second may come a tenth of the interval early (at most five minutes), so timer
drift and the sweep right after a restart do not push it to the third check.
An incident is never opened while the account is paused. One answer that gets
through ends it, and so does a reconnect.

State on `InstagramAccount` (migration `20261126090000_instagram_connection_alert`):

| Column | Meaning |
| --- | --- |
| `connectionCheckFailedAt` | The first lost answer of the current run. |
| `connectionLostAt` | Open incident: since when, which is the time of that first lost answer. |
| `connectionLostReason` | `token`, `permission` or `missing`, with Meta's code: `missing (Meta 100/33)`. Never a token. |
| `connectionAlertSentAt` | When the last alert e-mail went out, for any incident of the account. |
| `connectionAlertCount` | E-mails for the open incident: 1 after the alert, 2 after the reminder. |
| `connectionRecoveredAt` | When the last incident ended. |
| `connectionCatchUpFrom` | The start of an ended incident whose missed comments are still to be caught up. Kept until the catch-up has run (`onIncidentEnded`, `lib/instagram/connection-state.ts`). |

## The e-mail

When an incident opens, every owner and admin of the workspace gets an e-mail
at the address they sign in with (members do not): since when, what it means
(no DMs for comments, no replies to button taps, no public replies), the usual
causes, and the three steps to reconnect with a link to
`{NEXTAUTH_URL}/settings`. If the connection is still lost 24 hours later, one
reminder follows. At most one e-mail per account in 24 hours, across
incidents. German when `DEFAULT_LOCALE=de` (times in Europe/Berlin), English
otherwise (times in UTC). Plain text and simple HTML, no tracking, no secrets.

The worker sends it through Resend's HTTP API (`RESEND_API_KEY`,
`EMAIL_FROM`), or through SMTP when `EMAIL_SERVER` is set, as the sign-in
e-mails do. Without those settings it records one WARNING per start in
Diagnostics and sends nothing; the alert then goes out with the first check
after the settings were added and the worker restarted.

Each e-mail is claimed on the account row before it is sent, so two checks at
once send it once. When Resend does not answer (a timeout, 429, 5xx) the claim
goes back and the next check sends again with the same `Idempotency-Key`, so
an e-mail that did go out is not sent twice. A refusal (any other 4xx) keeps
the claim, and Diagnostics shows why.

## The dashboard

- A banner above every dashboard page: "Instagram connection lost", since
  when, why, and "Reconnect" (members are asked to have an owner or admin
  reconnect). The banner comes with the dashboard's layout, so it appears and
  goes with a full page load; the reconnect ends with one.
- Settings shows the account as "Connection lost since …" instead of
  "Connected", with the reason and "Reconnect".
- Diagnostics lists the incident with the reason, Meta's code and whether the
  e-mail went out, and its timeline names the events in the reader's language.
- The Comments page reads nothing from Instagram while the connection is
  lost and refuses "Send DM" (`connection_lost`) until the account is
  reconnected ([manual send](manual-send.md)).
- `/api/health` reports `checks.instagram` with `"status": "degraded"` and
  the accounts. The HTTP status and the top-level `status` stay as before,
  so an external monitor does not flap with every incident.

## Reconnecting

Settings, "Reconnect" (or "Connect using your own Meta app"), log in with
Meta, choose the account and allow all permissions. The callback updates the
same account row and ends the incident at once; its start moves to
`connectionCatchUpFrom`. Without a reconnect the incident ends with the first
check that gets through. Comments from the meantime are found by the regular
comment sweep within its lookback (`COMMENT_POLL_LOOKBACK_HOURS`).
