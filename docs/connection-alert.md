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
| `connectionCatchUpFrom` | The start of an ended incident whose missed comments are still to be caught up. Kept until the catch-up has run (see below). |

The catch-up adds four more (migration `20261126120000_connection_catch_up`):

| Column | Meaning |
| --- | --- |
| `connectionCatchUpClaimedAt` | The lease of the catch-up run that reads right now, renewed while it reads. |
| `connectionCatchUpProgress` | How far a catch-up that stopped early got, so the next run goes on there. |
| `connectionCatchUpResult` | The last finished catch-up: comments queued, comments answered by hand, what was skipped. |
| `connectionAllClearDueAt` | The all-clear e-mail of the last catch-up is still to go out. |

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
  After the incident it shows the catch-up while it runs and for 7 days
  after: how many comments get their DM, and the comments answered by hand.
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
check that gets through. Either way the catch-up of the comments of the
meantime starts right away.

## The catch-up

When an incident ends, the worker runs the queue job
`catchup_<account>_<start>` (`lib/instagram/connection-catch-up.ts`). The
check that ends the incident, the reconnect callback and the worker's sweep
all ask for it under that id, so it is queued once while it waits or runs.

- It reads the account's posts (`/media`, newest first, at most 300) and,
  for every post an active campaign covers that has comments, the comments
  newest first, 50 per page, until they are older than the incident's start
  minus 45 minutes; at most 500 pages in all. A campaign's own post that is
  older than the newest 300, and the ads made from it, are read too. Older
  posts, posts the page cap left out and posts whose comments Meta would not
  give are logged in Diagnostics and named in the all-clear.
- A comment gets its DM queued when it was made since that time and within
  Instagram's 7 days for a private reply, is not the account's own, matches
  an active campaign the way the sweep and the worker match (keywords as
  whole words unless the campaign allows partial matches, the question
  filter, a campaign bound to the post before an any-post campaign) and has
  no DmLog row. It is the ordinary comment job `recover_<ig>_<comment>`
  (`source: "RECOVERY"`), oldest first, the first right away and then one
  every 20 seconds, so a long outage never bursts into Meta's limit. Every
  claim of a comment's DM holds for it (one private reply per comment). At
  most 1,000 per catch-up.
- A matching comment the account already answered by hand gets no DM: the
  owner may have sent the guide by hand. It is listed in the all-clear
  e-mail and in Diagnostics with the author, the text, the time and a link to
  the post, and the Comments page can send it ([manual send](manual-send.md)).
- Meta's limits: nothing is read while the account is paused for a request
  limit. A pause, a request limit on a read, Meta reporting 60 % of a limit
  in a response's usage header, or a worker shutting down stops the run where
  it is: how far it got is kept (`connectionCatchUpProgress`) and a delayed
  job goes on from there (after the pause, 20 minutes after a limit, 15 after
  the usage brake, a minute after a shutdown). The reads are two seconds
  apart. Meta refusing three posts of the list in a row counts as a lost
  connection: the run stops and reads them again later. After 24 hours of
  trying it ends with what it has.
- Once per incident: the run holds a lease on the account row; a second run
  stands back and looks again when the lease would run out (10 minutes, for
  a worker that died). The end is one conditional update that sets
  `connectionCatchUpFrom` back to null with the result, so a reconnect and a
  check that end the incident at the same moment lead to one catch-up. One
  more incident that ends while a catch-up is owed is caught up with it, from
  the earlier start.
- While the catch-up runs, and until the last DM it queued has run, the
  regular comment sweep leaves the account alone (at most 30 hours after the
  incident ended): it would queue the same comments again, all at once.
- With every sweep the worker asks again for a catch-up that is owed but
  neither running nor queued for later (its request was lost, or the worker
  restarted), and sends an all-clear e-mail that is still owed.

## The all-clear e-mail

When the catch-up has finished, every owner and admin gets "Instagram
connection is back" ("Instagram-Verbindung wieder da" in German): how long
the connection was lost, how many comments of that time get their DM now,
the comments they answered by hand with author, text, time and the post, a
link to `{NEXTAUTH_URL}/comments` where "Send DM" sends one of them, and what
the catch-up left out. Same recipients, transport, settings and language as
the alert (`lib/ops/connection-all-clear.ts`). Claimed before it is sent; no
answer gives it back for the next sweep with the same `Idempotency-Key`, a
refusal keeps it taken. Without e-mail settings or recipients it stays owed.
After 24 hours, or once the connection is lost again, it is dropped.
Diagnostics shows the last catch-up for 7 days either way.
