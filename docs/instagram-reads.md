# Instagram reads of the dashboard

Every Meta call the app makes, sends and reads alike, counts against one
request limit per Meta app. On one account about 25 private replies and 50
conversation reads within an hour made Meta refuse every call of the app with
`(#4) Application request limit reached` for about an hour. The dashboard
therefore bounds the reads it makes on its own.

## Inbox

The Inbox used to read the conversation list and the open thread every 12
seconds, up to 600 reads an hour for one open tab. Now
(`lib/inbox/poll.ts`, `app/(dashboard)/inbox/page.tsx`):

- The list is read every 2 minutes (`LIST_POLL_MS`), and only while the tab
  is visible and was used in the last 10 minutes (pointer, key, scroll,
  focus). A hidden tab reads nothing. Coming back to the tab reads the list
  once if its last read is older than a minute.
- After 10 minutes without input (`IDLE_STOP_MS`) the timer stops and the
  header says so. "Refresh", always shown, reads at once and starts the timer
  again; so does coming back to the tab.
- There is no thread timer. The open thread is read when it opens, after an
  own send, when a list read shows that its update time or last message
  changed (`conversationChanged`), and on "Refresh".
- A timer read makes exactly one request: the newest page of the list
  (`GET /api/instagram/conversations?silent=1`, `getConversations` with
  `maxPages: 1`), put on top of what is shown. When Meta refuses that page
  (a conversation whose details it cannot expand, upstream #60), the timer
  read fails and the list stays as it is; it does not narrow the page down.
  Opening the Inbox, another account or "Refresh" read the whole list (at
  most 50 conversations), narrowing such a page down as
  [conversation recovery](conversation-recovery.md) describes, and so does
  the read that replaces a list copy painted on opening (next point), also
  when a turn of the timer makes it.
- A copy stored in the browser (sessionStorage) is painted only while it is
  younger than a minute (`CACHE_MAX_AGE_MS`); an older one is never painted.
  A thread copy is painted when the thread opens, which reads it at once. A
  list copy painted on opening stands in for the first read until it is a
  minute old (`firstListReadIn`). Then the list is read as an opening
  without a copy reads it: the whole list, a refused page narrowed down, and
  an error shown in the list's place, so the copy goes either way. In a tab
  hidden at that moment, the read comes with the return to the tab. While
  reads are paused (below), the copy stays, as anything shown does, and the
  first turn of the timer or return to the tab after the pause makes the
  read. A list read that replaced the copy before (a return to the tab,
  "Refresh", the page read after an own send) stands for it, so there is
  one such read per opening. A message unsent in the meantime therefore
  shows from a list copy until that read has answered.
- Copies older than a minute are removed from the tab's storage
  (`pruneInboxCopies`, `lib/inbox/copies.ts`): when an account opens in the
  Inbox, after every successful read, when the Inbox is left, and whenever a
  dashboard page opens (`components/dashboard-shell.tsx`, on every change of
  the path). Every other key stays, the account the Inbox remembers
  (`inbox:selectedAccount`) too. A copy that is younger than a minute when
  the Inbox is left stays until a dashboard page opens after that minute,
  or until the tab is closed.
- The server allows both GET routes together at most 40 requests to Meta
  an hour per connected account (`INBOX_READS_PER_HOUR` in
  `lib/inbox/read-budget.ts`), in a window of an hour from its first read.
  Every request counts, not every call of a route: a list of several pages,
  or a page narrowed down around a conversation Meta cannot expand, takes
  one read per request (`getConversations`' `beforeRequest`). When the
  budget ends in the middle of a list, the answer is the part read so far,
  marked `"partial": { "retryAt": "<ISO time>" }` with a `Retry-After`
  header: the page puts those conversations on top of what it shows, as for
  a timer read (`mergeConversationPage`), so the list does not shrink, and
  it pauses as below. A list copy painted
  on opening is still read whole after the pause.
  Beyond the budget the routes answer `429` with
  `{ "success": false, "code": "inbox_budget", "retryAt": "<ISO time>" }`
  and a `Retry-After` header, without calling Meta. The page keeps what it
  shows, says until when it pauses, and reads again from then on; it counts
  the pause from its own clock by `Retry-After`, and never less than 30
  seconds, so a browser clock ahead of the server's cannot start the next
  read at once. The cap is a constant on purpose, not a setting.
- While the worker has paused the account for a Meta request limit
  (`meta:pause:<instagram id>`, see [delivery retries](delivery-retries.md)),
  both GET routes answer the same `429` with the pause's end and do not call
  Meta; the budget is left alone. When Meta refuses an Inbox read itself for
  a request limit, the route answers the same `429` for the pause the worker
  takes after such a refusal (20 minutes, an hour for a block, or
  `META_THROTTLE_PAUSE_MINUTES` and `META_BLOCK_PAUSE_MINUTES` where they are
  set), so the page stops asking during the block. It does not pause the
  worker.
- While the account's connection is lost (A1, see
  [connection alert](connection-alert.md)), both GET routes answer `409`
  with `{ "success": false, "code": "connection_lost", "connectionLostAt":
  "<ISO time>" }` without calling Meta or taking a read, as the Kommentare
  page reads nothing then. On opening the page says so in the list's place,
  later in its header above the list it keeps. A reconnect ends it.
- A "Refresh" that fails keeps the list, and the header says the
  conversations could not be loaded until a list read answers again. A
  timer read that fails stays silent, as it fails on every turn while Meta
  refuses the newest page.
- Sending by hand (`POST /api/instagram/conversations`) is never capped and
  does not count.
- When Redis fails or does not answer within 3 seconds, the read is allowed
  and a warning is logged: the cap protects the request limit, it is not an
  access control.

An Inbox that is open and used reads the list about 30 times an hour, plus
one thread read per new message in the open conversation, and never makes
more than 40 requests to Meta an hour per account. A hidden or idle Inbox
reads nothing.

## Overview

The Overview shows views, reach, saves and shares per post, which takes one
insights read per post (`instagram_manage_insights`): up to 500 reads on
every open of "All time". Now (`app/api/instagram/overview/route.ts`,
`lib/instagram/overview-cache.ts`):

- It opens with "Last 12". Insights are read for the 12 newest posts only
  (`INSIGHT_POSTS`), three at a time.
- Larger ranges (25, 50, 100 and all time, still at most 500 posts) show
  likes and comments for every post and insights only for the newest 12; no
  insights call goes beyond them. The page says so above the totals, and the
  totals of views, reach, saves and shares sum only those posts
  (`insightPosts` in the answer). Any other `count` reads as 12, so it costs
  no media read and no cache key of its own.
- Each post's insights are kept in Redis for 6 hours
  (`insights:v1:<account row>:<media id>`), the whole answer for 10 minutes
  (`overview:v1:<account row>:<range>`). Opening the page again within 10
  minutes makes no Instagram call (`fromCache: true`); the page shows when the
  answer was read ("As of", `cachedAt`). Only business metrics and the
  account's own captions are stored; the list of the workspace's accounts is
  always read fresh.
- Followers come from today's snapshot (the daily cron at 07:00 UTC) once it
  exists; otherwise one profile read as before, with the 30-day backfill on a
  new account's first open.
- After a request limit or an expired token the remaining posts are not
  asked in that request. A failed insights read is not stored, so it is
  retried with the next answer after the 10 minutes.
- A Redis that fails or does not answer within 3 seconds is skipped for the
  rest of the request, and the page reads Instagram as before.
- Accounts connected through Zernio are reported as before: no cache, and
  insights for every listed post.

With nothing new posted, the Overview of one account makes at most 12
insights calls every 6 hours, plus one media read per open after the 10
minutes. Meta's App Review looks for calls of each requested permission in the
30 days before a submission: open the Overview at least once in that time.
