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
sends its link once.

No campaign is paused by this policy. New comments continue through the normal
flow. No schema migration is required.

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
  next sweep runs as scheduled.

Button taps, DM keyword replies, follow-ups and offer messages do not check
the pause yet; for them a rate limit is still retried after 5 and 15 minutes
as described above and below. The internal hourly limiter for private
replies (750 per hour and account) works as before.

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
- A rate limit releases the claim and the reservation and is retried by BullMQ
  after 5 and 15 minutes, still inside the window. On the last attempt the
  offer stops (RATE_LIMITED, WARNING).
- A closed window stops the offer with an INFO event (WINDOW_CLOSED), any other
  refusal, an expired token included, with a WARNING (REJECTED). Both release
  the claim and the reservation and end the job without a retry, so an expected
  refusal never raises a worker alert.
- A refusal whose claim the database fails to give back is still a refusal:
  the reservation goes back, the offer stops for the refusal's reason, and a
  WARNING ("Offer message claim not released after a refusal") names the
  claim left behind. There is no retry, not even for a rate limit, because a
  retry would find the claim and take the message for sent. If recording the
  refusal fails as well, the job ends without a retry.
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
row, retries for rate limits), with one difference: whatever keeps it from
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
