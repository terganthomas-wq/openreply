# Manual send

The **Comments** page (dashboard menu, owners and admins only) sends a
campaign's DM by hand: for a comment without the exact keyword ("kallt",
"Guide bitte", the keyword inside a longer word), for a comment the owner
first answered by hand, or for someone who asks for the guide in a reply
(send the DM to their own comment). Instagram's app cannot send messages with
buttons; the API can, so the campaign's DM goes out exactly as the automation
would send it.

## What the page shows

- The comments of the account's 15 newest posts from the last 7 days, newest
  first. "Load more" adds 15 posts at a time, up to 60. The account's own
  comments are left out, and replies to a comment are not rows of their own.
- The filter starts at "Without DM"; "All" also shows comments whose DM went
  out.
- Per comment: the author, the text, how long ago, a link to the post, and
  its state:
  - "DM sent · campaign" when a campaign's DmLog row for the comment is SENT,
    with "by hand" for a manual send, and "not confirmed" when Meta's answer
    left the delivery uncertain (`dmDeliveryUnconfirmed`). Otherwise "No DM",
    with the outcome of the last try.
  - "You replied" when the account answered the comment in public.
  - "Question" when the comment has a question mark (campaigns with the
    question filter leave it out).
  - "Matches: campaign" when a campaign would answer it on its own. The page
    uses the worker's own rule (`lib/automation/comment-match.ts`, shared with
    the comment sweep): keywords as whole words unless the campaign allows
    partial matches, the question filter, and a campaign bound to the post
    before an any-post campaign.

## Sending

Choose the campaign (preselected: the one that matches, otherwise none) and
press "Send DM".

- `POST /api/instagram/comments/send` with
  `{ "commentId": "…", "automationId": "…", "publicReply": true }` checks, in
  this order: the campaign belongs to the workspace and has a DM text, the
  account is connected through your own Meta app, its connection is not lost
  ([connection alert](connection-alert.md): refused with `connection_lost`,
  the page shows "Reconnect"), the running worker knows manual sends, the account is not paused for a Meta request limit, no DM
  for the comment went out (or may have, or is on its way), the campaign has
  send attempts left for it, and Instagram still has the comment
  (`/{comment-id}?fields=id,text,timestamp,from{id,username},media{id}`),
  under one of the account's newest posts, within 7 days and not by the
  account itself. Then it queues the worker's `process-comment` job with
  `source: "MANUAL"`, `forceAutomationId` and `publicReplyOverride`, and
  answers `202 { "success": true, "queued": true }`. A refusal names its
  `reason`, which the page shows in the reader's language. At most 30 sends a
  minute per person.
- The worker sends exactly that campaign: its keywords, its question filter,
  its post and whether it is active do not matter (a paused campaign can be
  sent by hand; the page says so). Everything after the DM runs as for any
  comment: the follow gate, the link, the delivery tag, the follow-up, offers
  and their late start. The DmLog row gets `matchedKeyword: "(manuell)"`.
- "Reply publicly" posts the campaign's public reply under the comment. It
  starts on, and off where the account already replied. Switched off, the
  comment's public reply is closed for good, so no later webhook or sweep job
  posts it either.
- The page then shows "Sending…" and asks the DM log (not Instagram) every
  three seconds for the outcome, for up to a minute.

## One DM per comment

Instagram allows one private reply per comment, for 7 days after the comment.
Every guarantee of an automatic comment DM holds for a manual one
(see [delivery retries](delivery-retries.md)):

- The DM is claimed on the campaign's DmLog row before Instagram is called,
  and a send that may have reached Instagram is never repeated. A double click
  queues one job (`manual_<account>_<comment>_<campaign>_<attempts>`; BullMQ
  takes an id once while the job waits or runs, and the job is removed when it
  ends). A try after a refused DM counts an attempt and so gets a new id; the
  three attempts per campaign and comment count across every path.
- The claim is per campaign, the private reply per comment. A manual send
  therefore checks the other campaigns' rows for a DM that went out, may have,
  or is on its way, before it claims and again right after. An automatic job
  checks for a manual send's claim right after its own. Of two sends that
  claim the same comment at the same moment, at least one sees the other and
  gives its claim back with its attempt; the comment never gets two DMs.
- While the account is paused for a Meta request limit, the job waits for the
  pause like any comment job, under its own copy id
  (`manual_<account>_<comment>_<campaign>_pause_<n>`).

## Cost in Meta requests

A page view costs one read of the posts and one read of each post's newest 50
comments (16 reads for 15 posts), never a second page. Each read is cached in
Redis for 60 seconds per account, so a reload or "Load more" only reads what
is missing. The page reads nothing in the background, nothing while the
account is paused or its connection is lost (it shows since when, with
"Reconnect"), and stops at a Meta limit on a read. A send costs one read
of the comment (plus one of the posts, unless they are cached).

## Rollout

The worker has to be updated with the web app. Until the running worker names
`manual-send` in its heartbeat (`WORKER_FEATURES`, `lib/ops/worker-health.ts`),
the send is refused with `worker_outdated`: an older worker would read the job
as an ordinary comment and answer it with whichever campaign matches.
