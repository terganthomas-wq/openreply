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

No campaign is paused by this policy. New comments continue through the normal
flow. No schema migration is required.

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
- The card's fallbacks (its text with the button, then plain text with the
  link) and the reminder's text fallback run inside the message's one claim,
  each only after a confirmed rejection of the previous form.

Each message re-checks the window first, five minutes before it closes, and
the reminder is scheduled no later than 23.5 hours after the person's last tap
or DM, so its retries still land inside the window. A tap on the offer's
button removes the waiting reminder. Until the card is out, every tap on that
button queues the confirmations again, which the job ids and claims keep from
sending anything twice; after it, a later tap gets the card once more, once per
tap. Offer messages are never written to DmLog, and no offer job requires its
campaign to be active: pausing a campaign does not cut off running offers.
