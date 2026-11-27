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
- A timer read asks for the newest page of the list only
  (`GET /api/instagram/conversations?silent=1`, `getConversations` with
  `maxPages: 1`) and puts it on top of what is shown. Opening the Inbox,
  another account or "Refresh" read the whole list (at most 50
  conversations).
- A copy stored in the browser (sessionStorage) is painted only while it is
  younger than a minute (`CACHE_MAX_AGE_MS`); such a copy stands in for the
  first read. An older copy is never painted, so a message unsent in the
  meantime does not come back from it.
- The server allows both GET routes together at most 40 reads of Meta an
  hour per connected account (`INBOX_READS_PER_HOUR` in
  `lib/inbox/read-budget.ts`), in a window of an hour from its first read.
  Beyond that they answer `429` with
  `{ "success": false, "code": "inbox_budget", "retryAt": "<ISO time>" }`
  and a `Retry-After` header, without calling Meta. The page keeps what it
  shows, says until when it pauses, and reads again from then on. The cap is
  a constant on purpose, not a setting.
- Sending by hand (`POST /api/instagram/conversations`) is never capped and
  does not count.
- When Redis fails or does not answer within 3 seconds, the read is allowed
  and a warning is logged: the cap protects the request limit, it is not an
  access control.

An Inbox that is open and used reads the list about 30 times an hour, plus
one thread read per new message in the open conversation, and never more
than 40 times an hour per account. A hidden or idle Inbox reads nothing.

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
  (`insightPosts` in the answer).
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
