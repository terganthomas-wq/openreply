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
retry, as for a button tap. Work that follows a delivered link (the follow-up
message, contact tags, lead-magnet offers) runs only after the SENT write and
outside the send's error handling. When it fails, for example because Redis
refuses the follow-up job, the failure is logged and the delivered DM stays
SENT: it is never marked failed and never retried.

No campaign is paused by this policy. New comments continue through the normal
flow. No schema migration is required.
