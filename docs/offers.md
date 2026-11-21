# Lead-magnet offers ("Weg 2")

A campaign sends its link (the resource of a reel) as before. With offers
switched on it then offers a lead magnet: a few short DMs ending with a
button, a card with your link for everyone who taps it, and a reminder for
everyone who does not. Offers belong to the workspace, not to a campaign: you
manage them in one place, **Offers** in the sidebar, and every campaign with
offers on uses them.

## How it runs

1. Someone triggers a campaign and gets its link after tapping a button (the
   opening DM or the follow request) or after sending a DM.
2. The campaign picks the first offer this person has not been offered yet,
   in its order (below), right after the link or 22 hours later (see
   [When the offer starts](#when-the-offer-starts)). Nobody gets the same
   offer twice, whichever campaign or post it comes from. With none left,
   nothing more is sent.
3. The offer messages go out one after another, each after its own pause (0
   to 60 seconds). The last one carries the button, for example
   "Ja, gerne! 🙌".
4. A tap on the button sends the confirmation messages, then the card: image,
   title, subtitle and a button that opens your link.
5. Without a tap, the reminder goes out after the hours you set (1 to 23),
   with the card's button. An offer that started 22 hours after the link has
   no reminder.

Every new trigger of a campaign by the same person (a new comment whose
opening DM they tap, a new tap, a new DM) sends the link again and starts the
next offer they have not had. A repeat of the same trigger (a webhook
Instagram sends twice, a retried job) starts nothing.

Tags record how far each person got, per offer: offered, interested (tapped
the button), sent (got the card or the reminder), clicked (opened the link)
and signed up (the landing page reported the sign-up, see
[Sign-up feedback](#sign-up-feedback-from-the-landing-page)). New offers take
their tag names from the workspace's tag templates and the offer's name, for
example "Guide angeboten" and "[LM] Guide gesendet"; you can change them
under **Tags** in the editor. The funnel on the Offers page counts the same
stages, each as a share of everyone offered ("Signed up" while the offer
reports sign-ups, or once there are some): a reminder counts as sent without
any interest, so the stages are not nested, and sent and clicked can be
higher than interested (the page then says why under the tiles). "Stopped
early" counts offers that ended before the person got the link, for example
because the messaging window closed. A Meta request limit only delays a
message: it waits for the end of the account's pause, and the offer stops
only when the window closes meanwhile or after twelve waits
([delivery retries](delivery-retries.md#metas-request-limits)).

## Which offer a campaign uses

- **Default order (Offers page)**: the order of the Offers page, changed with
  the arrows there. Swapping a lead magnet never means editing campaigns:
  create the new offer, move it up, pause or delete the old one.
- **Custom order for this campaign**: the campaign's own list, picked in the
  campaign editor under **After the link**. Offers not in the list are never
  offered by this campaign.

Paused offers are skipped in both. Turning offers on in the campaign editor
also turns the opening DM on (see below) and fills it from the default texts
when it is empty.

## When the offer starts

**When should the offer start?** in the campaign editor (under **After the
link**; `offerDelayHours` in the campaign API) has two settings:

- **Right after the link** (the default, `0`): the offer messages follow the
  link within seconds, and the reminder goes to everyone who does not tap.
- **22 hours later** (`22`): the offer starts the next day, 22 hours after
  the tap or DM that brought the link, rounded down to a full or half hour
  (UTC) so that starts within the same half hour wake the database once.
  Instagram's 24-hour window is still open then, and a tap on the offer's
  button opens a new one for the confirmations and the card. There is no
  reminder: whoever does not tap gets nothing more.

At its start a late offer works like any other: it takes the campaign's
current offer order and checks the window. It only takes the contact the
delivery recorded: one recorded by the time the delivery queued the start
(the job's timestamp, plus a minute for the database's clock). A contact
deleted in the meantime gets nothing and is not created again, and neither
does the person's new contact when they wrote or tapped again after that
deletion; the start is skipped with an anonymous log line. The bound is the
queue time rather than the tap or DM itself because someone whose first DM
brought the link is recorded only when the worker gets to that DM. If the
window has closed after all, for example because the worker was down, the
start is skipped and Diagnostics says "Offer skipped: messaging window
closed".

The setting applies to links delivered from then on. Late starts already
waiting keep their time when it changes, also when a campaign goes back to
**Right after the link**. Switching the campaign's offers off or deleting the
campaign stops them; pausing it does not, since their links went out.

## Instagram's 24-hour window

Instagram allows messages beyond the comment's private reply only within 24
hours of the person's last button tap or DM. That is why a campaign with
offers needs the opening DM: its tap opens the window. A link that went out
without a tap or a DM (as the comment's private reply) starts no offer.
Every offer message checks the window first, and the reminder is sent no
later than 23.5 hours after the person's last tap or DM, so it may come a
little earlier than the hours you set. A follow-up message switched on in the
same campaign also goes out after the link. With an offer right after the link
it can land between the offer messages, and the campaign editor warns about
it. With an offer 22 hours later it comes first as long as it waits at most
1260 minutes (21 hours): the offer starts 21.5 to 22 hours after the tap or
DM, and the other half hour is for a link that took a while. Only a longer
follow-up can reach the offer, and only then does the editor warn. A link that
an Instagram request limit held back for longer
(`docs/delivery-retries.md`) can still bring a shorter follow-up near it.

## The card image

Instagram downloads the card's image itself, from a public `https` link.

**Upload.** Where a Vercel Blob store is connected to the project (it sets
`BLOB_READ_WRITE_TOKEN`, see `deploy/README.de.md`), the editor uploads the
image: **Choose image** takes a JPG, PNG or WebP file of up to 5 MB (square,
1080 × 1080, works best; JPG and PNG are the safest choice for Instagram),
shows it and offers **Replace** and **Remove**. The server tells what the
file is from its first bytes, whatever its name says, and stores it publicly
under `offers/<workspace id>/` with a random suffix; saving the offer makes
its URL the card image. Only owners and admins upload. On Vercel a request
carries at most 4.5 MB, so a file between 4.5 and 5 MB is refused there as
too large.

Saving the offer with another image or none deletes the old upload, and so
does deleting an offer nobody got yet. An archived offer keeps its image,
because the cards already sent still show it, and so does any other offer of
the workspace that shows the same file. Deleting is best effort: if it fails,
the file stays behind, as does an upload that was never saved with an offer
(replaced again before saving, or the editor left without saving). Images
hosted anywhere else are never deleted.

**Link.** Without a Blob store the editor shows the **Image URL** field
instead. It needs a direct `https` link to the image file (JPG or PNG;
square, 1080 × 1080, works best). A Google Drive share link is a web page,
not an image: the editor shows a warning when the image does not load, and
Instagram cannot show it either.

If Instagram refuses a card, its title and subtitle go out as a message with
the button instead (Diagnostics notes "Offer card fell back to a button
message"). The link behind the card's button may be any web page, Google
Drive and Docs share links included. Clicks go through a tracked link
(`/o/<slug>`) that forwards to it and records the click.

## Sign-up feedback from the landing page

**Report the sign-up back** in the offer editor is for a landing page with a
sign-up form, such as a newsletter with double opt-in. With it on, a click
on the card's or the reminder's link reaches the landing page with the
person's own code added: `?ig=<code>` (24 base64url characters, 144 random
bits, `ContactOffer.signupToken`). The code is created on the person's first
click and stays the same; the rest of the address stays as typed, its query
and fragment included, and an `ig` it carried is replaced. With the switch
off, or for a link whose `?r=` belongs to nobody who got the offer, the
destination goes out exactly as typed; a failed lookup never costs the
person the link.

The landing page keeps the code with the pending sign-up and, once the
sign-up is confirmed, reports it from its server: `POST /api/offers/signup`
with `{"token": "<ig value>"}` and a service key that has `signups:write`
(**Report sign-ups** on the API & MCP page; such a key can do nothing else,
lives up to 365 days, a year by default, and API & MCP and Diagnostics warn
14 days before it expires, see `docs/integrations.md`).
The request, the answers and a PHP example are in `deploy/README.de.md`. The
first report records the sign-up (`signedUpAt` and the offer's "signed up"
tag, in one transaction) and queues the chat confirmation; every later report
of the same code answers `{"data": {"alreadyRecorded": true}}` and changes
nothing. A code of another workspace, of an offer whose switch is off or of
a deleted contact answers 404. The answer never waits for Instagram.

The confirmation is the offer's **Message in the chat after the sign-up**,
with `{username}` like the other texts; empty means the tag alone. New offers
start with the workspace's default (in German "Danke fürs Eintragen! Ich habe
dir gerade alles per E-Mail geschickt 📩"), and switching the feedback on for
an offer without a text fills that default in. It goes out once, only while
Instagram's 24-hour window is open (from the person's last tap or DM), and
counts toward the monthly DMs. Whatever keeps it from going out (a closed
window, an unavailable account, a deleted offer, a refusal, the monthly
limit) is reported in Diagnostics as "Sign-up confirmation not sent: …" and
never marks the offer stopped. The contact's history shows the sign-up and
the confirmation.

Offers that existed before have the feedback off; their "signed up" tag is
"<name> eingetragen" ("<name> signed up" for an offer whose "offered" tag
ends in "offered"). Deleting a contact deletes its offer rows and with them
its codes.

## Pause or delete

- **Pause** (the switch on the Offers page): no new person gets the offer, the
  campaigns move on to the next one in their order. Sequences already running
  finish: taps on the button still get the card, and reminders still go out.
  Resume it the same way.
- **Delete**: an offer nobody got yet is deleted. One that was ever offered is
  archived instead: it leaves the Offers page and every campaign's order, its
  messages that have not gone out yet are not sent, and the card links already
  sent keep working. Its tags stay on the contacts. A campaign whose own order
  held only this offer gets its offers switched off; it keeps sending its
  link, and the Offers page names it.

## Default texts

A new offer starts with the workspace's default texts for offers (in German,
the built-in set). Owners and admins can save the texts of a new offer as the
defaults with **Save these texts as defaults for new offers**: the offer
messages with their pauses, both buttons' labels, the confirmations, the
reminder and the message after a sign-up. Name, card, link, tags and whether
the landing page reports sign-ups are set per offer. Defaults saved before
the sign-up message existed get it, and the "signed up" tag template, from
the built-in set of the reader's language until they are saved again.

## Limits

Instagram cuts some texts, counting an emoji as two characters: button labels
after 20, the card's title and subtitle after 80, the text of a message with
a button (the last offer message and the reminder) after 640. The editor and
the API hold you to these. An offer has at most five offer messages and five
confirmations. Offer messages count toward the workspace's monthly DMs.
