# Comment delivery retries

A failed API response is not proof that Instagram did not deliver a message.
In particular, Meta error 1 has been observed alongside actual inbox delivery.
Do not retry that outcome as a plain-text fallback or a new polling job.

The comment worker claims each DM/public-reply leg with an atomic DmLog update
before calling Instagram. The existing delivery-unconfirmed flags serve as
in-flight claims. Success replaces a claim with the corresponding sent state.
Only explicit provider rejections release a claim. Network/unknown API errors,
process crashes and failed result writes leave the claim in place. This favors
avoiding duplicate messages; inspect the inbox before manually retrying an
uncertain delivery, including a crash between the claim and the network call.

DM send attempts are incremented in the database, with a limit of three across
all webhook, retry and polling jobs for the campaign/comment pair. New job IDs
cannot reset that limit. Polling skips finished, uncertain or exhausted DM legs
while still allowing an unfinished public reply leg to be handled independently.
Historical Meta code 1/2/5xx failures are treated as uncertain on both paths.

A text fallback requires an explicit Meta code 100 template/button rejection.
If that fallback fails, its own outcome is preserved instead of being replaced
by the earlier template rejection. Meta button-tap jobs also use the existing
durable postback claim so redelivering the same tap cannot send it again.

Replies to DM keyword triggers take the same durable claim, one per connected
account, campaign and inbound message, before Instagram is called. A retried
job or a redelivered message cannot answer the same DM twice, even when its log
row was never written, and an unknown send outcome ends the job without a
retry, as for a button tap. The claim itself is taken outside the send's error
handling: when the database fails while taking it, nothing was sent, so the job
is retried like after any other database error instead of being recorded as an
unconfirmed delivery. Work that follows a delivered link (the follow-up
message, contact tags, lead-magnet offers) runs only after the SENT write and
outside the send's error handling. When it fails, for example because Redis
refuses the follow-up job, the failure is logged and the delivered DM stays
SENT: it is never marked failed and never retried.

A button tap takes its claim the same way, outside the send's error
handling: a database error while taking it gives the usage reservation back
and retries the job, instead of logging the tap FAILED and unconfirmed with
the link never sent. When Instagram refuses a message and the database then
fails to give its claim back, the refusal stays the outcome
(`ClaimReleaseError` in `lib/queue/send-helpers.ts`) rather than being
replaced by the database error. A campaign's tap or DM reply still records
that case as unconfirmed, which never retries into the claim left behind;
the offer engine records it as the refusal it is (below).

A read fallback (the opening DM was read but its button not tapped) is
skipped once the campaign answered the person: a tap that delivered the link,
or a DM keyword that the campaign's DM trigger answered because the person
typed the keyword instead of tapping. Both checks run when the job is queued
and again when it runs, so a campaign with an opening DM and the DM trigger
sends its link once. After them the job reads the person's contact: reading
opens no messaging window, so unless the person tapped or wrote in the last
23 hours and 55 minutes (Instagram's 24 hours less a five-minute margin; a DM
without text, such as a photo or the heart, counts as writing), the
fallback asks Instagram nothing, not even the name or the follow, reserves
nothing and leaves no row; the worker log says "Read fallback skipped: no open
messaging window". This is decided when the job runs, before the account's
pause, so a reply typed in the five minutes after reading still brings the
link.

No campaign is paused by this policy. New comments continue through the normal
flow. No schema migration is required.

The claim is per campaign, Instagram's private reply per comment. So the DM
claim (`claimCommentPrivateReply`) runs in one transaction with a look at the
other campaigns' rows of the comment, under a Postgres advisory lock on the
comment: of two jobs that claim one comment for two campaigns at the same
moment (two campaigns that match it, a manual send next to a webhook, sweep or
catch-up job), the second always sees the first one's claim and claims
nothing. What it does then depends on that claim:

- the other campaign's DM went out or may have (SENT, unconfirmed, or a
  claim older than ten minutes, `DM_CLAIM_IN_FLIGHT_MS`, whose worker died):
  SKIPPED_DEDUP, for good;
- it is on its way (claimed within ten minutes): nothing is decided yet, as
  that DM may still be refused or wait for a pause. The row waits (PENDING,
  "Waiting: another campaign (…) is sending …", no attempt used) and a copy
  of the job, `<job id base>_dedup_<n>`, looks again a minute later (plus up
  to 30 seconds by its id), through every campaign of the comment in order,
  at most six times; then SKIPPED_DEDUP.

A job that finds its own campaign's DM claimed by another job leaves the
public reply to that job: a "check your DMs" posted next to a DM on its way
could stand under a comment whose DM Instagram then refuses. (A claim older
than ten minutes gets its public reply from the next job, as a DM that may
have gone out.)

A DM sent by hand from the Comments page ([manual send](manual-send.md)) is a
comment job for exactly the chosen campaign and takes the same claim. With
"Reply publicly" switched off, the campaign's public reply is closed in the
claim's own transaction, so no other job posts it from the moment the claim
can be seen; a later manual send with it switched on opens that closing
again.

## Meta's request limits

Meta refuses calls with a request limit when the app, the token, the page or
the messaging API made too many calls in its rolling window: codes 4, 17, 32,
613, 80002 and 80006 (throttles) and 368 (a temporary block). The Meta client
turns every one of them into a `RateLimitError` that keeps Meta's code
(`lib/meta/limits.ts`, `isMetaThrottle` and `throttlePauseMs` in
`lib/instagram/delivery-errors.ts`). A request limit proves that nothing was
sent, so it is a confirmed rejection; 32, 613, 80002 and 80006 used to be
plain Meta errors and therefore "unconfirmed", never retried although nothing
went out. Zernio's own HTTP 429 stays a `RateLimitError` with code 429 and is
handled as before.

While a limit lasts, every further call is refused too, and retrying after 5
and 15 minutes only keeps it going. So an account pauses instead
(`lib/queue/account-pause.ts`):

- A throttle or block on a messaging call sets `meta:pause:<instagram id>` in
  Redis to the resume time, expiring with it: 20 minutes for a throttle, 60
  for a block (`META_THROTTLE_PAUSE_MINUTES`, `META_BLOCK_PAUSE_MINUTES`, 1 to
  240). A Lua script sets or extends it in one step; a pause is never
  shortened. The call that starts a pause records one WARNING ("Instagram
  request limit reached: sending paused until …"), not one per job.
- Before a messaging call a job asks `checkAccountPause`. While the account
  is paused it calls nothing and puts a copy of itself back on the queue
  (`requeueForPause`) for the resume time plus a jitter of 0 to 60 seconds
  derived from the copy's job id, so a backlog spreads over a minute. Copies
  are removed once they complete, like offer jobs, so a later pause can reuse
  the id. When Redis cannot be read the call goes ahead and Meta answers.

On the comment path this covers the private reply in every form (opening DM,
follow prompt, link) and the follow check at comment time, which now reports
a limit instead of reading it as "not following":

- A pause found before the send: nothing is reserved, claimed or called. The
  DM leg stays PENDING with "Instagram request limit; next try at HH:MM UTC"
  and the copy `comment_<account>_<comment>_pause_<n>` runs after the pause.
  A job of the catch-up after a lost connection (source RECOVERY) runs its
  copy in the catch-up's next free slot after the pause, 2.5 minutes after
  the one before (`lib/queue/send-pacing.ts`), instead of in the minute after
  it: a catch-up that met a pause must not send its backlog in one burst.
- A send refused for a limit: the hourly slot and the monthly reservation go
  back as for any refusal, the account pauses, and the DM claim is given back
  with its attempt (`releaseCommentClaim`: `dmDeliveryUnconfirmed` false, the
  attempt count from before the claim, PENDING with the reason) before the
  copy is queued. The job then ends without an error, so BullMQ's own
  retries do not run into the limit again. The public reply is not posted:
  it follows the DM, on the pass that sends it.
- After 12 copies (`MAX_PAUSE_REQUEUES`, about four hours of throttles) the
  comment fails as any refused send: FAILED with "Instagram request limit: the
  account was still paused after 12 waits …", and the job is thrown back to
  BullMQ. A refused send counts that one attempt, as before; a job that only
  found the pause counts none, and its BullMQ retries send nothing while the
  pause lasts.
- Exactly-once is unchanged: every send still takes the DM claim first, and
  a copy, a BullMQ retry, a redelivered webhook and a sweep job racing for the
  same comment get it once. The copies only replace BullMQ's retries.
- The comment sweep skips an account while it is paused, and a read that
  Meta refuses with a limit ends the whole sweep there, recorded once; the
  next sweep runs as scheduled. A campaign queues at most
  `COMMENT_POLL_MAX_PER_SWEEP` (30) comments per sweep across all of its
  posts, oldest first: per post, an any-post campaign over 30 posts could
  queue 900 private replies in one sweep, the kind of burst that runs into
  the limit.

Every message after a tap or a DM waits for the pause the same way: button
taps (the follow check, the follow prompt and the second follow request, the
link), the replies to DM keywords, the follow-up, and every offer message
(below). Instagram lets the account message a person only for 24 hours after
their last tap or DM, so these wait only while that window is still open
when the copy would run, with the same five-minute margin as every offer
message:

- A pause found before the message, or a message (or a follow check, asked
  with `throwOnLimit`) that Meta refuses with a limit: the claim and the
  monthly reservation go back as for any refusal (`sendClaimedPostback`
  releases the claim of a confirmed rejection), the account pauses, and a
  copy of the job runs after the pause under a deterministic id: a tap as
  `postback_<claim>_pause_<n>`, a DM as `message_<account>_<mid>_pause_<n>`
  (the webhook job's id plus the wait), a follow-up as
  `followup_<campaign>_<person>_pause_<n>`. The job ends without an error,
  so BullMQ's own retries do not run into the limit again.
- The copy carries what the job it copies knew: a tap its time and its id
  (`tappedAt`, `tapId`), a DM the time it arrived (`receivedAt`). It takes
  the same claim, stamps the contact with the tap's or the DM's own time and
  starts the same offer, so a copy can never count as a new tap or DM. A
  copy, a redelivered webhook and a BullMQ retry racing for the same tap or
  DM send it once (DB test `conversation-pause.db.test.ts`).
- Meanwhile the tap's link and the DM's reply show PENDING with
  "Instagram request limit; next try at HH:MM UTC" on their DmLog row; a row
  that says the message went out is never set back. A follow check or a
  follow prompt that waits creates no row: the tap's row is the link's. Once
  a link waited, though, a gated tap's copies keep the follow check's
  payload, so a pause that goes on meets them before the check; each such
  wait moves the PENDING row's next try along.
- A waiting row never stays PENDING once nothing will send it: the copy
  that ends without the message logs it FAILED with the reason (only a
  PENDING row; one that says the message went out stays). That is a capped
  or closed-window wait at a follow check or prompt as well as at the link,
  a copy whose campaign was paused or moved to another account meanwhile
  (or whose account has no usable token), a tap's copy whose
  follow check after the pause finds no follow and asks for the follow
  instead ("Not sent: the follow check after the account's pause found no
  follow"), and a DM's copy for a campaign that no longer answers the DM:
  paused, its DM trigger switched off, its keywords changed, or bound to
  another connection ("Not sent: the campaign was paused or changed while
  the account was paused"; the DM's copy settles these before it answers
  anything). Only the copies settle these rows, and the read fallback stands
  back while one is PENDING (below), so a row left PENDING would hold the
  campaign's read fallback for that person back for good.
- A read fallback waits one minute longer than the taps and DM replies held
  for the same pause, and it now also stands back while a tap's link or the
  campaign's answer to the person's DM waits (PENDING), so the fallback does
  not deliver the link next to them. A tap's copy, in turn, sends nothing
  when the link reached the person after the tap (a read fallback that ran
  once the pause was over, or another of their taps that waited with it).
  Every other tap re-sends the link, as before.
- When the window is closed by the time the copy would run, nothing is
  queued: the tap's link and the DM's reply are logged FAILED ("Instagram
  request limit: the messaging window closes before the account's pause ends
  …") without a retry, and so is a tap's waiting link behind a follow check
  or prompt; a follow prompt, a read fallback and a follow-up are only
  logged to the console, as their failures always were.
- After 12 copies the message fails as a refused send: the link or the reply
  is logged FAILED with "the account was still paused after 12 waits …" and
  the job is thrown back to BullMQ, as is a tap whose follow check still
  meets the limit (its waiting link logged FAILED the same way); a follow
  prompt, a read fallback and a follow-up are only logged.
- The follow-up has no claim, so its job never fails while it waits: a copy
  that could not be queued is logged, never retried next to one that was.
- The follow re-check acknowledgement is best effort: while the account is
  paused it is skipped, not held, and a limit on it only pauses the account,
  so the re-check after it waits.
- A refused message whose claim the database fails to give back only pauses
  the account: a copy would find the claim and send nothing.

The internal hourly limiter for private replies (750 per hour and account)
works as before.

Every Meta response also says how much of the app's limit and of the
account's business use case limit the last hour used (`x-app-usage`,
`x-business-use-case-usage`). From 80 % of any of them the worker records a
WARNING with the percentages, at most once per 10 minutes per account
(`lib/ops/meta-usage.ts`). Neither the headers nor the event carry a token.
Diagnostics shows an active pause per account, until when and how many jobs
wait for it, and shows the pause and usage events in the reader's language
and time zone.

## Lead-magnet offers

A campaign with offers starts one only after its link went out following a
button tap or an inbound DM, the only things that open Instagram's 24-hour
messaging window. After a link sent as the comment's private reply or as a
read fallback the offer is skipped, and an INFO event says so.

Every new trigger of a campaign starts the next offer the person has not had
yet, in the campaign's order: a new comment whose opening DM is tapped, a new
tap with another message id, a new DM. A repeat of the same trigger starts
nothing: a redelivered webhook, a retried job, a second tap that carries the
same message id, the reconciler seeing a comment again. The start is keyed on
the campaign and the trigger's id (`ContactOffer.startKey`, unique per contact;
the start job's id is derived from it). A retried start job finds the row its
first attempt created and queues the first message again; any later start for
that trigger stops there. `ContactOffer` is unique per contact and offer, so
nobody gets an offer twice, whichever campaign starts it. A crash between the
delivered link and queueing the start loses that start: a second offer for one
trigger would be worse, and the person's next trigger starts one.

Every offer message (the offer texts, the confirmations, the card, the card
again for a later tap, the reminder) is its own delayed job, removed once it
completes, and follows one policy:

- It counts toward the workspace's monthly DMs. Without a slot the offer stops
  (PLAN_LIMIT, WARNING) and nothing is sent.
- A durable claim per connected account, offer row, phase and step is taken
  before Instagram is called, outside the send's error handling. A database
  error on it gives the reservation back and retries the job. A claim taken
  by an earlier run means the message went out, or may have: it is not sent
  again, the reservation goes back and the sequence goes on.
- An unknown outcome is recorded as a WARNING and never sent again; the claim
  and the reservation stay and the sequence goes on.
- While Meta refuses the account's calls for a request limit (the account
  pause above), nothing is reserved, claimed or sent: the message's job runs
  again after the pause as `<its id>_pause_<n>` (for example
  `offer_<row>_card_pause_1`). A message Meta refuses with a limit releases
  the claim and the reservation, pauses the account and waits the same way;
  the card's fallbacks included, since the whole chain runs in one claim. A
  later tap's card waits as a copy of the tap (`offer_<row>_retap_<tap
  digest>_pause_<n>`), with the tap's time and id. The copy sends the same
  message under the same claim, so a copy and a retry of the same step send
  it once, and the sequence goes on from there. It waits only while the
  window, from the person's last tap or DM, is still open when the copy
  would run; otherwise the offer stops for the closed window (WINDOW_CLOSED,
  INFO). After 12 waits it stops with RATE_LIMITED (WARNING), the one stop a
  Meta request limit still causes. Zernio's own limit (HTTP 429) is retried
  by BullMQ after 5 and 15 minutes as before and stops the offer with
  RATE_LIMITED on the last attempt.
- A closed window stops the offer with an INFO event (WINDOW_CLOSED), any other
  refusal, an expired token included, with a WARNING (REJECTED). Both release
  the claim and the reservation and end the job without a retry, so an expected
  refusal never raises a worker alert.
- A refusal whose claim the database fails to give back is still a refusal:
  the reservation goes back, the offer stops for the refusal's reason, and a
  WARNING ("Offer message claim not released after a refusal") names the
  claim left behind. There is no retry and no wait for a pause, not even for
  a rate limit, because a retry or a copy would find the claim and take the
  message for sent; a Meta request limit still pauses the account. If
  recording the refusal fails as well, the job ends without a retry.
- Once the link reached the person (the card, one of its fallbacks or the
  reminder), a later failure does not mark the offer stopped: the card sent
  again for a later tap, a confirmation or the card after the reminder. It is
  logged as "Offer message not sent: …", and the funnel's "stopped" counts
  only offers that ended before the person got the link.
- The card's fallbacks (its text with the button, then plain text with the
  link) and the reminder's text fallback run inside the message's one claim,
  each only after a confirmed rejection of the previous form.

Each message re-checks the window first, five minutes before it closes, and
the reminder is scheduled no later than 23.5 hours after the person's last tap
or DM, so its retries still land inside the window. A tap on the offer's
button removes the waiting reminder. Until the card is out, every tap on that
button queues the confirmations again, which the job ids and claims keep from
sending anything twice; after it, a later tap gets the card once more, once per
tap. The reminder carries the link and counts as sent (`sentVia` REMINDER), but
it is not the card: a tap after the reminder still gets the confirmations and
then the card, which replaces REMINDER with the form it went out in and keeps
the time the link was first sent. Offer messages are never written to DmLog,
and no offer job requires its campaign to be active: pausing a campaign does
not cut off running offers.

A click on the card's or the reminder's link sets the row's `clickedAt` and
the offer's "clicked" tag in one transaction. Later clicks no longer find a
clicked row, so a tag written after the time could be lost for good; now a
failed write leaves neither, and the next click records both.

A sign-up the offer's landing page reports (`POST /api/offers/signup`) sets
the row's `signedUpAt` and the offer's "signed up" tag the same way, in one
transaction that only an unset `signedUpAt` lets through, so a repeated or
simultaneous report records nothing twice. Only that first report queues the
chat confirmation, under a job id per row (`offer_<row>_signup`). The
confirmation follows the policy above (window check, monthly DMs, claim per
row, the wait for an account's pause), with one difference: whatever keeps it from
going out is logged ("Sign-up confirmation not sent: …", INFO for a closed
window, an unavailable account or a deleted offer, WARNING otherwise) and
never marks the offer stopped, since the person got the link long before.
Sent, claimed by an earlier run or with an unknown outcome, it records
`signupMessageSentAt` and never goes out again. If queueing it fails after
the sign-up was recorded, the sign-up and the tag stay, the confirmation is
lost (a later report changes nothing) and a WARNING "Sign-up confirmation not
queued" says so.

Deleting an offer archives it when it was ever offered, so the card links
already sent keep redirecting, and deletes it otherwise. Whether it was
offered is read from `Offer.firstOfferedAt`, which the start sets before the
offer's first `ContactOffer` row and which stays when the rows go: they are
deleted with their contacts when an Instagram account is disconnected. Either
way the offer's id leaves every campaign's own order. A campaign whose own
order held only that offer gets its offers switched off (`offersEnabled`
false): an empty order reads as the workspace's default order, and the
campaign would start offers nobody picked for it. It keeps sending its link,
and the DELETE response names it in `campaignsWithoutOffers`, so the Offers
page can say which campaigns need new offers.
