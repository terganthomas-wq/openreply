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
