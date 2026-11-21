"use client";

/**
 * Contact Detail
 *
 * One person's history (R10): who they are on which account, their tags with
 * the time each was first set, how far they got with every offer, and one
 * timeline of their comments, button taps and DMs, the offers' stages, their
 * tags and their campaign link clicks, newest first. Owners and admins delete
 * the contact here on request (GDPR).
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import StatusBadge from "@/components/status-badge";
import {
  HISTORY_CLICK_LIMIT,
  HISTORY_MESSAGE_LIMIT,
  type ContactTimelineEvent,
} from "@/lib/contacts/history";
import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

interface ContactOfferRow {
  id: string;
  automationId: string | null;
  offeredAt: string;
  pitchSentAt: string | null;
  interestedAt: string | null;
  sentAt: string | null;
  sentVia: string | null;
  reminderSentAt: string | null;
  clickedAt: string | null;
  signedUpAt: string | null;
  signupMessageSentAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  offer: { name: string; archivedAt: string | null };
  automation: { name: string } | null;
}

interface ContactHistory {
  contact: {
    id: string;
    igsid: string;
    username: string | null;
    account: string;
    lastInteractionAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  tags: { tag: string; createdAt: string }[];
  offers: ContactOfferRow[];
  timeline: ContactTimelineEvent[];
  truncated: { messages: boolean; clicks: boolean };
  canManage: boolean;
}

type Load =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "failed" }
  | { state: "ready"; data: ContactHistory };

// How an offer's lead magnet went out (ContactOffer.sentVia).
const SENT_VIA: Record<string, StaticMessageKey> = {
  CARD: "Card",
  BUTTON: "Button message",
  TEXT: "Text message",
  REMINDER: "Reminder",
};

export default function ContactPage() {
  const { id } = useParams<{ id: string }>();
  // Keyed by the id, so another contact starts afresh.
  return <ContactDetail key={id} contactId={id} />;
}

function ContactDetail({ contactId }: { contactId: string }) {
  const { t, label, locale } = useI18n();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reloads, setReloads] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/contacts?id=${encodeURIComponent(contactId)}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const payload = await res.json().catch(() => null);
        if (!active) return;
        if (res.status === 404) setLoad({ state: "missing" });
        else if (res.ok && payload?.success) {
          setLoad({ state: "ready", data: payload.data });
        } else setLoad({ state: "failed" });
      })
      .catch(() => {
        if (active) setLoad({ state: "failed" });
      });
    return () => {
      active = false;
    };
  }, [contactId, reloads]);

  function formatTime(value: string) {
    return new Date(value).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  async function deleteContact() {
    if (
      !window.confirm(
        t("Delete this contact? Their tags, offer history and link clicks are deleted, and their entries in the DM log and in Diagnostics are anonymised. This cannot be undone.")
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/contacts?id=${encodeURIComponent(contactId)}`,
        { method: "DELETE" }
      );
      const payload = await res.json().catch(() => null);
      // Gone already (deleted in another tab) is as good as deleted.
      if ((res.ok && payload?.success) || res.status === 404) {
        router.push("/contacts");
        return;
      }
      setDeleteError(
        res.status === 403
          ? t("Only owners and admins can delete contacts.")
          : t("Could not delete the contact.")
      );
    } catch {
      setDeleteError(t("Could not delete the contact."));
    }
    setDeleting(false);
  }

  const backLink = (
    <Link href="/contacts" className="text-sm text-muted hover:text-foreground">
      {t("← Contacts")}
    </Link>
  );

  if (load.state === "loading") {
    return <div className="panel h-64 rounded" />;
  }
  if (load.state === "missing") {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-muted">{t("Contact not found.")}</p>
        <Link
          href="/contacts"
          className="mt-4 inline-block rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          {t("Back to contacts")}
        </Link>
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-muted">{t("Could not load the contact.")}</p>
        <button
          type="button"
          onClick={() => {
            setLoad({ state: "loading" });
            setReloads((count) => count + 1);
          }}
          className="mt-4 rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          {t("Try again")}
        </button>
      </div>
    );
  }

  const { contact, tags, offers, timeline, truncated, canManage } = load.data;

  // A campaign name links to the campaign; a deleted one says so (R16).
  function campaignName(campaignId: string | null, name: string | null) {
    if (!campaignId || name === null) {
      return <span>{t("Deleted campaign")}</span>;
    }
    return (
      <Link
        href={`/campaigns/${campaignId}`}
        prefetch={false}
        className="break-words underline decoration-border underline-offset-2 hover:text-foreground"
      >
        {name}
      </Link>
    );
  }

  function eventTitle(event: ContactTimelineEvent): string {
    switch (event.kind) {
      case "comment":
        return t("Commented");
      case "tap":
        return t("Tapped a button");
      case "dm":
        return t("Sent a DM");
      case "tag":
        return t("Tag added: {tag}", { tag: event.tag });
      case "click":
        return t("Clicked the campaign link");
      case "offer":
        switch (event.stage) {
          case "offered":
            return t("Offer started: {offer}", { offer: event.offer });
          case "pitched":
            return t("Offer messages sent: {offer}", { offer: event.offer });
          case "interested":
            return t("Tapped the offer button: {offer}", { offer: event.offer });
          case "sent":
            return t("Lead magnet sent: {offer}", { offer: event.offer });
          case "reminded":
            return t("Reminder sent: {offer}", { offer: event.offer });
          case "clicked":
            return t("Clicked the offer link: {offer}", { offer: event.offer });
          case "signedUp":
            return t("Signed up on the landing page: {offer}", { offer: event.offer });
          case "signupConfirmed":
            return t("Sign-up confirmed in the chat: {offer}", { offer: event.offer });
          case "stopped":
            return t("Offer stopped early: {offer}", { offer: event.offer });
        }
    }
  }

  // What the entry adds to its title: how the lead magnet went out, or
  // why the offer stopped.
  function eventDetail(event: ContactTimelineEvent): string | null {
    if (event.kind !== "offer") return null;
    if (event.stage === "sent" && event.sentVia) {
      return Object.hasOwn(SENT_VIA, event.sentVia)
        ? t(SENT_VIA[event.sentVia])
        : event.sentVia;
    }
    if (event.stage === "stopped" && event.stopReason) {
      return label(event.stopReason);
    }
    return null;
  }

  const name = contact.username ? `@${contact.username}` : contact.igsid;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {backLink}

      {/* Who */}
      <section className="panel space-y-4 rounded p-4 sm:p-6">
        <h1 className="min-w-0 break-words text-lg font-semibold">{name}</h1>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Account")}</dt>
            <dd className="break-words text-foreground">@{contact.account}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Instagram ID")}</dt>
            <dd className="break-all font-mono text-xs text-foreground">
              {contact.igsid}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("First seen")}</dt>
            <dd className="text-foreground">{formatTime(contact.createdAt)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Last seen")}</dt>
            <dd className="text-foreground">{formatTime(contact.updatedAt)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Last tap or DM")}</dt>
            <dd className="text-foreground">
              {contact.lastInteractionAt
                ? formatTime(contact.lastInteractionAt)
                : "—"}
            </dd>
          </div>
        </dl>
      </section>

      {/* Tags, each linking to everyone who has it */}
      <section className="panel rounded p-4 sm:p-6">
        <h2 className="mb-3 text-sm font-semibold">{t("Tags")}</h2>
        {tags.length === 0 ? (
          <p className="text-sm text-muted">{t("No tags yet.")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {tags.map((entry) => (
              <li
                key={entry.tag}
                className="max-w-full rounded-md border border-accent/10 bg-accent/10 px-2 py-1 text-xs"
              >
                {/* Tag names are the user's own words: never translated. */}
                <Link
                  href={{ pathname: "/contacts", query: { tag: entry.tag } }}
                  prefetch={false}
                  className="break-words font-medium text-accent hover:underline"
                >
                  {entry.tag}
                </Link>
                <span className="ml-2 whitespace-nowrap text-muted">
                  {formatTime(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Offers: how far this person got with each */}
      <section className="panel rounded p-4 sm:p-6">
        <h2 className="mb-3 text-sm font-semibold">{t("Offers")}</h2>
        {offers.length === 0 ? (
          <p className="text-sm text-muted">{t("No offers yet")}</p>
        ) : (
          <div className="space-y-3">
            {offers.map((row) => {
              const stages: { label: string; at: string | null; detail?: string }[] = [
                { label: t("Offered"), at: row.offeredAt },
                { label: t("Offer messages sent"), at: row.pitchSentAt },
                { label: t("Interested"), at: row.interestedAt },
                {
                  label: t("Sent"),
                  at: row.sentAt,
                  detail:
                    row.sentVia && Object.hasOwn(SENT_VIA, row.sentVia)
                      ? t(SENT_VIA[row.sentVia])
                      : (row.sentVia ?? undefined),
                },
                { label: t("Reminder"), at: row.reminderSentAt },
                { label: t("Clicked"), at: row.clickedAt },
              ];
              // Only offers whose landing page reported the sign-up have
              // these, so they show only once there is one.
              if (row.signedUpAt) {
                stages.push({ label: t("Signed up"), at: row.signedUpAt });
              }
              if (row.signupMessageSentAt) {
                stages.push({
                  label: t("Sign-up confirmed in the chat"),
                  at: row.signupMessageSentAt,
                });
              }
              if (row.stoppedAt) {
                stages.push({
                  label: t("Stopped early"),
                  at: row.stoppedAt,
                  detail: row.stopReason ? label(row.stopReason) : undefined,
                });
              }
              return (
                <div
                  key={row.id}
                  className="rounded-lg border border-border bg-background p-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 break-words text-sm font-medium">
                      {row.offer.name}
                    </h3>
                    {row.offer.archivedAt && (
                      <span className="shrink-0 rounded-full bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-muted">
                        {t("Deleted")}
                      </span>
                    )}
                  </div>
                  {/* Label left, value right; on a phone a value that does
                      not fit moves under its label. */}
                  <dl className="mt-3 max-w-lg space-y-1 text-sm">
                    {/* The campaign whose link started it. */}
                    <div className="flex flex-wrap items-baseline gap-x-4">
                      <dt className="text-muted">{t("Campaign")}</dt>
                      <dd className="ml-auto min-w-0 break-words text-right text-foreground">
                        {campaignName(row.automationId, row.automation?.name ?? null)}
                      </dd>
                    </div>
                    {stages.map((stage) => (
                      <div
                        key={stage.label}
                        className="flex flex-wrap items-baseline gap-x-4"
                      >
                        <dt className="text-muted">{stage.label}</dt>
                        <dd className="ml-auto text-right text-foreground">
                          <span className="whitespace-nowrap">
                            {stage.at ? formatTime(stage.at) : "—"}
                          </span>
                          {stage.at && stage.detail && (
                            <span className="block text-xs text-muted">
                              {stage.detail}
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Everything in one timeline, newest first */}
      <section className="panel rounded p-4 sm:p-6">
        <h2 className="mb-1 text-sm font-semibold">{t("History")}</h2>
        {timeline.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t("Nothing recorded yet.")}</p>
        ) : (
          <ol className="divide-y divide-border">
            {timeline.map((event) => {
              const detail = eventDetail(event);
              const fromCampaign = event.kind !== "tag";
              return (
                <li key={event.key} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="break-words text-sm text-foreground">
                      {eventTitle(event)}
                      {detail && <span className="text-muted"> · {detail}</span>}
                    </p>
                    {/* The person's own words, as written. */}
                    {(event.kind === "comment" || event.kind === "dm") &&
                      event.text && (
                        <p className="whitespace-pre-wrap break-words rounded bg-background px-2 py-1 text-sm text-muted">
                          {event.text}
                        </p>
                      )}
                    {event.kind === "click" && event.url && (
                      <p
                        className="truncate font-mono text-xs text-muted"
                        title={event.url}
                      >
                        {event.url}
                      </p>
                    )}
                    <p className="text-xs text-muted">
                      {formatTime(event.at)}
                      {fromCampaign && (
                        <>
                          {" · "}
                          {campaignName(event.campaignId, event.campaign)}
                        </>
                      )}
                    </p>
                  </div>
                  {(event.kind === "comment" ||
                    event.kind === "tap" ||
                    event.kind === "dm") && <StatusBadge status={event.status} />}
                </li>
              );
            })}
          </ol>
        )}
        {(truncated.messages || truncated.clicks) && (
          <p className="mt-3 text-xs text-muted">
            {t("Shows the latest {messages} comments, taps and DMs and the latest {clicks} link clicks.", {
              messages: HISTORY_MESSAGE_LIMIT,
              clicks: HISTORY_CLICK_LIMIT,
            })}
          </p>
        )}
      </section>

      {/* Data deletion */}
      {canManage && (
        <section className="space-y-3 rounded border border-error/20 p-4 sm:p-6">
          <h2 className="text-sm font-semibold">{t("Delete contact")}</h2>
          <p className="text-sm text-muted">
            {t("For a data deletion request. Deletes this person's tags, offer history and link clicks and anonymises their entries in the DM log and in Diagnostics, so campaign counts stay. If they comment or write again, they start as a new contact.")}
          </p>
          {deleteError && (
            <div
              role="alert"
              className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error"
            >
              {deleteError}
            </div>
          )}
          <button
            type="button"
            onClick={() => void deleteContact()}
            disabled={deleting}
            className="w-full rounded-lg border border-error/30 px-4 py-2 text-sm font-medium text-error hover:bg-error/10 disabled:opacity-50 sm:w-auto"
          >
            {deleting ? t("Deleting…") : t("Delete contact")}
          </button>
        </section>
      )}
    </div>
  );
}
