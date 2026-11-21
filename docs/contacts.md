# Contacts

A contact is one Instagram user as one connected account sees them: their
Instagram-scoped id (IGSID), their handle when a comment carried it, and the
tags they got. The same person on two connected accounts is two contacts,
because Instagram gives them a different id on each. A contact is recorded
when a campaign's keyword matches their comment, on every button tap and on
every DM they send.

Contacts belong to the account, not to a campaign: pausing or deleting a
campaign keeps them and their tags. Disconnecting an Instagram account in
Settings deletes its contacts, with their tags and offer history; after a
reconnect everyone starts fresh and can get every offer again.

## Tags

A tag records a step and the time it was first set; a repeat keeps that time.
Campaigns add their delivery tag (**After the link** in the campaign editor)
when their link reaches someone, and every offer adds its four tags as people
go through it: offered, interested, sent, clicked. Tag names are yours and
are matched exactly. The campaign editor suggests the tags that exist, so one
name is not spelled two ways.

## The Contacts page

**Contacts** in the sidebar lists everyone, last seen first. Search by handle
(any part, any case, with or without the @) or by a whole Instagram ID; the
search starts at two characters. Filter by tag and, with several connected
accounts, by account. The funnel tiles on the Offers page open the list
filtered by that stage's tag.

A contact's page shows their account and id, when they were first and last
seen and when they last tapped a button or sent a DM (Instagram's 24-hour
messaging window counts from there), their tags with dates, and for every
offer how far they got. Below, one history, newest first: their comments,
button taps and DMs with the DM log's status, every offer stage, every tag
and their clicks on campaign links. It shows the latest 100 DM log entries and
the latest 50 clicks. Entries of a deleted campaign say so.

## Deleting a contact (data deletion requests)

Owners and admins can delete a contact on its page, for example when the
person asks for their data to be deleted. In one transaction:

- the contact goes, and with it their tags and offer history;
- their clicks on campaign links are deleted;
- their DM log entries stay, anonymised: no Instagram id, no name and no
  comment or DM text. The campaigns' counts keep them, and a comment that
  was answered stays marked as answered, so the reconciler never answers it
  again. Button-tap entries, whose id contains the Instagram id, get a new id;
- the worker's events in Diagnostics lose the person's Instagram id and
  handle; where a failed job's id or a message contains the Instagram id, it
  reads "deleted". What an event says about the campaign or offer stays. An
  event whose details would still name the person loses its details. The
  workspace's events are matched by the Instagram id, which Instagram gives
  per account;
- the raw webhook payloads that name the person on this account (their
  comments and DMs word for word, their button taps) are emptied. The entries
  themselves stay, with their status and error, for Diagnostics.

This cannot be undone. If the person comments, taps or writes again, they are
recorded as a new contact and can be offered everything again. A comment whose
DM was still being retried when the contact was deleted can still be answered,
which records them anew.

Not touched by the deletion: jobs already queued for the person.

Contacts are personal data: the service API and the MCP server do not expose
them.
