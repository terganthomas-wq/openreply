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

The alert after an all-clear adds two more (migration `20261126180000_connection_alert_rearm`):

| Column | Meaning |
| --- | --- |
| `connectionAllClearSentAt` | When the last all-clear e-mail reached at least one owner or admin. |
| `connectionAlertRearmedAt` | When an alert went out inside the 24 hours of the last warning, because an all-clear had come after it. |

## The e-mail

When an incident opens, every owner and admin of the workspace gets an e-mail
at the address they sign in with (members do not): since when, what it means
(no DMs for comments, no replies to button taps, no public replies), the usual
causes, and the three steps to reconnect with a link to
`{NEXTAUTH_URL}/settings`. If the connection is still lost 24 hours later, one
reminder follows, and no further reminder. At most one warning e-mail per
account in 24 hours, across incidents; the all-clear after the catch-up comes
on top. One exception: when the all-clear went out after the last warning
(the owners were told the connection is back), a new incident gets its alert
at once, or their last e-mail would say "back" while nothing goes out. That
happens at most once per 24 hours (`connectionAlertRearmedAt`), so a flapping
connection cannot loop alert, all-clear, alert. German when
`DEFAULT_LOCALE=de` (times in Europe/Berlin), English otherwise (times in
UTC). Plain text and simple HTML, no tracking, no secrets.

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
Meta, choose the account (and, if it is linked to a Facebook Page, that Page
too) and allow all permissions. The callback updates the
same account row and ends the incident at once; its start moves to
`connectionCatchUpFrom`. Without a reconnect the incident ends with the first
check that gets through. Either way the catch-up of the comments of the
meantime starts right away.

An Instagram account linked to a Facebook Page gets its messaging webhooks
(button taps, DMs, read receipts) only while the app also has that Page.
Without it comments still arrive, but nothing after the first DM does, and
no check reports it. The login configuration therefore needs the asset type
Pages and the permissions `pages_show_list` and `pages_read_engagement`.

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
  no DmLog row that settles it (its DM went out or may have, another
  campaign answers it, the plan limit stopped it, or three attempts are used;
  a row that only waits, or failed with attempts left, is queued again). It
  is the ordinary comment job `recover_<ig>_<comment>` (`source:
  "RECOVERY"`), oldest first, the first right away and then one every 2.5
  minutes (`CATCH_UP_SPACING_MS`, 24 an hour: on 2026-11-21 about 25 private
  replies and 50 conversation reads in one hour ran into Meta's app limit).
  Each job takes a slot of the account's catch-up pace in Redis
  (`lib/queue/send-pacing.ts`). Every claim of a comment's DM holds for it
  (one private reply per comment, across campaigns: the claim and the look
  at the other campaigns' rows in one transaction, under a lock on the
  comment). At most 500 per catch-up, about 21 hours of DMs.
- Its jobs keep that pace when they cannot send yet. One that meets an R1
  pause runs its copy in the pace's next free slot after the pause, behind
  the jobs already planned, not in the minute after it. One that finds Meta
  reporting 60 % of a request limit in the last five minutes waits, without a
  claim and without using an attempt, for a slot at least 15 minutes later
  (`recover_<ig>_<comment>_wait_<n>`, at most four times; then it is sent).
  And none sends while the account's connection is lost again: the DM waits
  (PENDING, no attempt) for the catch-up of that incident, the sweep or "Send
  DM". A send Meta refuses for the account (a token or permission error, the
  account not found) after the check saw it refused once gives its claim
  back without counting it.
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
- While the catch-up runs, and until the last DM it queued has run (the last
  slot of its pace, copies included), the regular comment sweep leaves the
  account alone (at most 30 hours after the incident ended): it would queue
  the same comments again, all at once.
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

## Messages not arriving (A2)

On 2026-11-25/26, after the Instagram account was linked to a Facebook Page,
Meta kept delivering comment webhooks but no messaging webhooks at all for 21
hours: no button taps, no DMs, no read receipts. Every opening DM went out,
every tap on its button was lost, and the connection check above stayed
green, as the account and its comments could be read. The worker now notices
this too (`lib/instagram/messaging-silence-check.ts`), from the database
alone, without a single Meta call.

### The signal

With every comment sweep, for each account connected through your own Meta
app, the worker reads:

- the opening DMs the account sent: `SENT` DmLog rows of a comment (not the
  `reveal:` and `dm:` rows that a tap or a DM keyword brought), whose
  delivery is confirmed, of campaigns whose DM has a button (an opening DM
  with its text and button label), with their send time;
- the inbound messaging events that arrived for the account: WebhookEvent
  rows whose payload has, for the account, a button tap (`postback`), a DM
  that is not an echo (with or without text, deleted or unsupported), a read
  receipt or a reaction, in `messaging` or in `standby` (another app is the
  conversation's primary receiver). Echoes and comment changes never count.
  The webhook route keeps every payload with such an event, also one no job
  comes of (a reaction, a DM without text, a `standby` event). The database
  narrows the rows to the account's payloads with `messaging` or `standby`
  items (jsonb containment, index on `createdAt`); what counts is decided in
  one place, `inboundMessagingAccountIds` in `lib/meta/webhook.ts`, which the
  webhook route uses too.

A check is silent when at least 3 different people got an opening DM that
went out at least 12 and at most 18 hours ago, after the end of the
account's last A1 incident, and no inbound messaging event arrived since the
first of these DMs. Two silent checks in a row, at least one sweep interval
apart (A1's gap, a tenth early at most five minutes), open an incident; its
start (`messagingSilentSince`) is the last inbound messaging event before the
silence, or the first unanswered opening DM when none arrived in the last 7
days.

No judgment (the check changes nothing) while the account's connection is
lost (an A1 incident: no webhook arrives at all then) or in doubt (A1's
first failed check, until the next one decides), while the account is
paused for a Meta request limit (R1), or while it has no active campaign
whose DM has a button. A paused campaign's opening DMs still count while
another such campaign is active: a tap on them arrives as a webhook all the
same.

### Calibration

The thresholds come from replaying the production timeline of 2026-11-20 to
2026-11-26 11:37 UTC through the real check, every 30 minutes, for each of the
30 minutes the sweep may fall on
(`__tests__/messaging-silence-calibration.test.ts`, with the timeline in
`__tests__/fixtures/messaging-silence-timeline.json`):

- The silence: opening DMs to 3 people at 20:49 to 20:51 UTC on the 25th,
  right after the A1 reconnect, then nothing until the fix at 10:30. The
  first silent check comes between 08:52 and 09:21 UTC on the 26th, and the
  incident opens between 09:22 and 09:51 UTC (09:30 with sweeps on the hour
  and the half hour): 12.5 to 13 hours after the unanswered DMs, about an hour
  before the fix.
- Never a silent check before the silence began, quiet nights included. The
  closest call was the night of 2026-11-24/25: five people got their opening
  DM between 12:06 and 22:17 UTC and nothing came back for 24 hours, until a
  read receipt at 07:16. The 18-hour window is what keeps that night quiet
  with a margin: three of those DMs within six hours (18:08 to 20:49) would
  have made a silent check from 08:50 on, 93 minutes after the receipt;
  without the window (any age counts) the 12:06, 18:08 and 19:35 DMs would
  have made one from 07:35 on, 18 minutes after it, and with 2 people instead
  of 3 it would have been a false alarm from 06:09 on. 4 people would not
  have fired before the fix: the fourth opening DM of the silence went out at
  04:51.

A false alarm is worse than a few hours' delay, so the defaults stay
conservative. They can be set in the worker's environment:

| Variable | Meaning | Default | Allowed |
| --- | --- | --- | --- |
| `MESSAGING_SILENCE_MIN_PEOPLE` | Different people with an unanswered opening DM | 3 | 2 to 10, a whole number |
| `MESSAGING_SILENCE_MIN_AGE_HOURS` | How old each of those DMs is, at least | 12 | 4 to 36 |
| `MESSAGING_SILENCE_WINDOW_HOURS` | How old they are, at most | the minimum age plus 6 (18) | the minimum age plus 1 to plus 48 |

A value outside its range is moved to the nearest bound, anything that is
not a number falls back to the default, and the worker records a WARNING
about it once per start in Diagnostics.

### State

On `InstagramAccount` (migration `20261127090000_messaging_silence`, which
also adds the index on `WebhookEvent.createdAt`, and
`20261127120000_messaging_tap_search` for the search for lost taps; both
additive, NULL for existing rows):

| Column | Meaning |
| --- | --- |
| `messagingSilenceCheckAt` | The first silent check of the current run. |
| `messagingSilentSince` | Open incident: since when nothing arrived. |
| `messagingSilenceResult` | The last silence that ended: `since`, `endedAt`, `via` (`webhook` or `check`), and `taps`, what the search for lost taps found, once it has finished. |
| `messagingAlertSentAt` | When the last warning e-mail about a silence went out, for any silence of the account. |
| `messagingAlertRearmedAt` | When such a warning went out inside the 24 hours of the last one, after an all-clear. |
| `messagingAlertCount` | E-mails for the open silence: 1 after the alert, 2 after the reminder. |
| `messagingAllClearDueAt` | The all-clear of the last silence is still to go out: set when its search has finished. |
| `messagingAllClearSentAt` | When the last all-clear about a silence reached an owner or admin. |
| `messagingTapSearchFrom` | The start of an ended silence whose lost taps are still to be searched (the earlier one, when a search is still owed). Null once the search has run. |
| `messagingTapSearchUntil` | The end of the last silence that search covers. |
| `messagingTapSearchClaimedAt` | The lease of the search that runs right now, renewed while it reads; taken over after 10 minutes. |
| `messagingTapSearchProgress` | How far a search that stopped early got. |

### The end

One inbound messaging event ends the incident: the webhook route right after
it stored the event (`lib/instagram/messaging-silence-state.ts`, with the
account fields of its own lookup, so a webhook costs no query while nothing
is open), or else the next check, which first looks for one since the
incident's start, whatever else holds (also during an A1 incident or an R1
pause). The same event forgets a first silent check. A check that is not
silent never ends an open incident: the DMs that made it silent may simply
have grown too old to count. A reconnect does not end it either; only an
event that arrives does.

The end is one conditional update that also keeps the silence as
`messagingSilenceResult` and owes the search for the taps lost in it:
`messagingTapSearchFrom` is its start (or the start of an earlier silence
whose search is still owed, like A1's `connectionCatchUpFrom`) and
`messagingTapSearchUntil` its end. An all-clear of an earlier silence that is
still owed is dropped: it would only tell old news now. Whoever ended the
silence asks the worker for the search at once, as the queue job
`losttaps_<account>_<from>_<until>`; the worker's sweep asks again for a
search that is owed but neither running nor queued for later.

### The search for lost taps

`lib/instagram/lost-tap-search.ts`, once per silence:

- The people: everyone who got an opening DM in the silence (a `SENT` comment
  row of a campaign whose DM has a button, sent after `messagingTapSearchFrom`
  and at the latest at `messagingTapSearchUntil`) of a campaign that still
  answers taps (active, or paused but sent to this person by hand on the
  Comments page), and who has no tap or link on record for that campaign
  since their opening DM (`lib/instagram/lost-tap-records.ts`: a
  `reveal:<person>` or `dm:<mid>` row written after it, or a stored webhook
  with their tap on one of the campaign's buttons). Whoever tapped again
  after the silence was answered the ordinary way. The newest opening DMs
  first, at most 50 people; the others count as not checked.
- Their conversations: the account's conversation list
  (`/{ig-id}/conversations?platform=instagram&fields=id,updated_time,participants`),
  newest first, 50 per page, each matched by participant id, until everybody
  is found or a page reaches back before the oldest opening DM still wanted
  (a conversation with a tap would have moved up); at most 10 pages. Whoever
  is not found had no conversation that changed after the opening DM: no tap.
  A page Meta refuses with code 1 (one entry that cannot be read with its
  participants, docs/conversation-recovery.md) is halved until that entry is
  alone and then stepped over; a person not found after that counts as not
  checked. A conversation that did not change after the person's opening DM
  is not read; every other one is read once (its 20 newest messages).
- A lost tap is a message from the person (no one else's, never the
  account's own) whose text is the title of one of the campaign's buttons (the
  opening DM's, the follow prompt's or the second follow request's, as the
  worker sends them, 20 characters at most) and that is newer than the
  person's opening DM of that campaign. Of several, the newest. (A tap shows
  up in the Conversations API as such a message, verified on 2026-11-26.)
- It is continued with exactly the postback job the tap would have
  produced: `payload` rebuilt (`followcheck:<campaign>:open` or
  `reveal:<campaign>:open`, `followcheck:<campaign>` and
  `followcheck:<campaign>:retry` for the follow prompts), `mid` the message's
  id, `tappedAt` its time, `lostTap: true`, job id `losttap_<hash of account,
  person and mid>`. The oldest tap first, the first right away (at the
  earliest two minutes after a tap that fresh, whose webhook may still be on
  its way), then one every 2.5 minutes, in a pace of their own
  (`pace:taps:<ig>`), so they never wait behind a catch-up's comments. Only
  while Instagram's 24 hours from the tap leave at least an hour when the job
  runs; otherwise, and for a campaign paused meanwhile, the person is listed.
- Exactly once: the job takes the tap's own claim, keyed on its `mid`, so
  the same tap delivered late by its webhook gets one link. Before it does
  anything, it stands back if, since the tap, the campaign's link went out to
  the person, may have or waits for a pause, the campaign answered a DM
  keyword of theirs, or another tap of theirs on the campaign's buttons
  arrived: then that answer stands, and nobody gets the link twice. Its
  copies for an R1 pause and its follow re-checks go on with the same tap.
  The window, the follow-up and a late offer count from the tap.
- Meta's limits, as A1's catch-up: nothing is read while the account is
  paused; a pause, a request limit on a read, Meta reporting 60 % of a limit,
  three conversation reads in a row refused for the account, or a worker
  shutdown stops the run where it is, its progress is kept after every read
  (`messagingTapSearchProgress`) and a delayed job goes on from there. The
  reads are at least 5 seconds apart (on 2026-11-21 about 25 private replies
  and 50 conversation reads in one hour ran into Meta's app limit). Nothing is
  read while the account's connection is lost (A1). After 24 hours of trying
  it ends with what it has.
- Once per silence: the job id is the same for every request, the run holds a
  lease on the account row, and its end is one conditional update that sets
  `messagingTapSearchFrom` back to null with the result. A second run stands
  back and looks again when the lease would run out; a run that died is taken
  over after 10 minutes, and a tap found again is the same job. One more
  silence that ends while the search is owed is searched with it.

On the production silence of 2026-11-25/26 (the calibration timeline,
`__tests__/lost-tap-search.test.ts`): five people got an opening DM in it,
between 20:49 UTC and 10:04 UTC. The one whose tap at 10:30:57 ended it got
the link a second later and is left alone. The other four are found with one
page of the list, and only the conversations that changed after the opening
DM are read: five reads at most. Every tap of that silence came after 20:49,
so each still had more than ten hours of its 24 when the silence ended, and
each would have been continued.

### The e-mails and the dashboard

A1's infrastructure and rules (`lib/ops/incident-mail.ts`, shared by both):
every owner and admin of the workspace, the same transport and settings, the
alert when the incident opens and one reminder 24 hours later, at most one
warning per 24 hours per account (counted for the silence's own e-mails, so a
lost-connection warning does not hold one back), the alert at once for a new
silence after an all-clear (at most once per 24 hours), each e-mail claimed on
the account row before it is sent, with an `Idempotency-Key` per person that
is the same for every try. German with "du" when `DEFAULT_LOCALE=de`, English
otherwise (`lib/ops/messaging-silence-email.ts`): what is wrong in plain
words, since when, what it means, the likely causes (Instagram linked to or
unlinked from a Facebook Page, then select that Page when reconnecting;
"Allow access to messages" switched off in Instagram; another app set as the
default for Instagram under "Conversation routing" in the Business Suite) and
the fix with the link to `{NEXTAUTH_URL}/settings`.

The all-clear ("Instagram passes button taps on to OpenReply again") goes
out when the search for lost taps has finished: how long the silence lasted,
how many lost taps go on now, the people it was too late for or whose
campaign is paused (name, campaign and time of the tap; the owner is asked to
write to them in Instagram), how many got the opening DM without tapping,
and how many could not be looked at. It is dropped when it could not go out
within 24 hours, or once a silence or a lost connection is open again.

- A banner above every dashboard page, "Instagram is not passing on button
  taps", with since when, what it means, the causes and "Reconnect" (members
  are asked to have an owner or admin do it). While the account's connection
  is lost, only the lost connection is shown.
- Settings shows "Messages not arriving" instead of "Connected", and the
  account's notice with since when, the causes and the fix.
- Diagnostics lists the open silence with the e-mail, and the last silence
  for 7 days after it ended: from when to when and how long, while its search
  runs that it runs, then what it found as in the all-clear. It names the
  events in the reader's language.
- `/api/health` reports it in `checks.instagram`: `"status": "degraded"` and
  `silences: [{ account, since, reason: "messaging-silence", alertSentAt }]`,
  next to A1's `incidents`. The HTTP status and the top-level `status` stay as
  before.
- DMs keep going out, and "Send DM" on the Comments page works: only what
  people do in their DMs does not arrive.

