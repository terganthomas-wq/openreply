"use client";

/**
 * Offers Page
 *
 * The workspace's lead-magnet offers (R10, R13) in their default order, each
 * with its funnel. Offers are created, edited, paused, reordered and deleted
 * here only; campaigns with offers on use this order unless they have their
 * own, so swapping a lead magnet never means editing campaigns.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Toggle } from "@/components/form-controls";
import { useI18n } from "@/lib/i18n/provider";
import {
  moveItem,
  percentOfOffered,
  type OfferRecord,
} from "@/lib/offers/editor";

// The HTTP status of a write that did not go through, 0 without a response.
type Failure = { status: number };

// One write to the Offers API: failure is null when it went through.
async function writeOffers(
  url: string,
  method: "PATCH" | "PUT" | "DELETE",
  body?: unknown
): Promise<{ failure: Failure | null; data: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const payload = await res.json().catch(() => null);
    if (res.ok && payload?.success) return { failure: null, data: payload.data };
    return { failure: { status: res.status }, data: null };
  } catch {
    return { failure: { status: 0 }, data: null };
  }
}

export default function OffersPage() {
  const { t, locale } = useI18n();
  const [offers, setOffers] = useState<OfferRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  // One write at a time: a reorder sends the whole list, so a toggle or a
  // second move in between could be undone by its rollback.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/offers", { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => {
        if (!active) return;
        if (payload.success) setOffers(payload.data);
        else setLoadFailed(true);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function failureText(failure: Failure, fallback: string) {
    return failure.status === 403
      ? t("Only owners and admins can change offers.")
      : fallback;
  }

  // Pause or resume: paused offers are skipped when a new offer is chosen,
  // running sequences finish.
  async function toggleActive(offer: OfferRecord) {
    if (busy) return;
    const next = !offer.isActive;
    setError(null);
    setBusy(true);
    setOffers((prev) =>
      prev.map((o) => (o.id === offer.id ? { ...o, isActive: next } : o))
    );
    const { failure } = await writeOffers(
      `/api/offers?id=${encodeURIComponent(offer.id)}`,
      "PATCH",
      { isActive: next }
    );
    if (failure) {
      setOffers((prev) =>
        prev.map((o) =>
          o.id === offer.id ? { ...o, isActive: offer.isActive } : o
        )
      );
      setError(failureText(failure, t("Could not save the change.")));
    }
    setBusy(false);
  }

  // The new default order in one request, shown at once and taken back if
  // it fails.
  async function move(index: number, direction: -1 | 1) {
    if (busy) return;
    const previous = offers;
    const next = moveItem(offers, index, direction);
    setError(null);
    setBusy(true);
    setOffers(next);
    const { failure } = await writeOffers("/api/offers", "PUT", {
      order: next.map((offer) => offer.id),
    });
    if (failure) {
      setOffers(previous);
      setError(
        failure.status === 400
          ? t("The list is out of date. Reload the page and try again.")
          : failureText(failure, t("Could not save the order."))
      );
    }
    setBusy(false);
  }

  async function remove(offer: OfferRecord) {
    setMenuOpenId(null);
    if (busy) return;
    if (
      !window.confirm(
        t("Delete this offer? If it was already offered it is archived and its history and sent links stay. To stop offering it for now, pause it instead.")
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    const { failure, data } = await writeOffers(
      `/api/offers?id=${encodeURIComponent(offer.id)}`,
      "DELETE"
    );
    if (failure) {
      setError(failureText(failure, t("Could not delete the offer.")));
    } else {
      setOffers((prev) => prev.filter((o) => o.id !== offer.id));
      // Campaigns whose own order held only this offer had their offers
      // switched off; they keep sending their link.
      const campaigns =
        (data as { campaignsWithoutOffers?: { name: string }[] } | null)
          ?.campaignsWithoutOffers ?? [];
      if (campaigns.length > 0) {
        setNotice(
          t("Offers are now off for these campaigns, because this offer was the only one in their own order: {names}", {
            names: campaigns.map((campaign) => campaign.name).join(", "),
          })
        );
      }
    }
    setBusy(false);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="panel h-44 rounded p-6" />
        ))}
      </div>
    );
  }

  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted">
            {t(offers.length === 1 ? "{count} offer" : "{count} offers", {
              count: offers.length,
            })}
          </p>
          {offers.length > 0 && (
            <p className="max-w-xl text-xs text-muted">
              {t("Campaigns with offers on use this order unless they have their own. Each person gets the first active offer they have not had yet.")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Link
            href="/offers/new"
            className="flex-1 rounded bg-accent px-4 py-2 text-center text-sm font-medium text-white hover:bg-accent-hover sm:flex-none"
          >
            {t("New offer")}
          </Link>
        </div>
      </div>

      {/* What a pause, move or delete did, fixed to the bottom of the
          screen: above the list it was out of view on a phone whenever the
          offer acted on was further down. */}
      {(error || notice) && (
        <div className="fixed bottom-4 left-4 right-4 z-30 space-y-2 sm:bottom-6 sm:left-auto sm:right-6 sm:w-[26rem]">
          {error && (
            <div
              role="alert"
              className="overflow-hidden rounded border border-error/20 bg-background shadow-lg"
            >
              <div className="flex items-start justify-between gap-3 bg-error/10 p-3 text-sm text-error">
                <span className="min-w-0 break-words">{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="shrink-0 text-xs text-muted hover:text-foreground"
                >
                  {t("Close")}
                </button>
              </div>
            </div>
          )}
          {notice && (
            <div
              role="status"
              className="overflow-hidden rounded border border-warning/30 bg-background shadow-lg"
            >
              <div className="flex items-start justify-between gap-3 bg-warning/10 p-3 text-sm text-foreground">
                {/* A long list of campaign names scrolls; Close stays. */}
                <span className="max-h-[40dvh] min-w-0 overflow-y-auto break-words">
                  {notice}
                </span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="shrink-0 text-xs text-muted hover:text-foreground"
                >
                  {t("Close")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {loadFailed && (
        <div className="panel rounded p-8 text-center text-sm text-muted">
          {t("Could not load the offers.")}
        </div>
      )}

      {/* Empty state */}
      {!loadFailed && offers.length === 0 && (
        <div className="panel rounded p-8 text-center sm:p-12">
          <h3 className="mb-2 text-lg font-semibold">{t("No offers yet")}</h3>
          <p className="mx-auto mb-6 max-w-md text-sm text-muted">
            {t("Offers turn a campaign into a funnel: once someone has the campaign's link, a few short DMs offer them a lead magnet. A tap on the button sends a card with your link; without a tap, a reminder follows. Every campaign with offers on uses them in the order shown here.")}
          </p>
          <Link
            href="/offers/new"
            className="inline-flex items-center gap-2 rounded bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            {t("Create offer")}
          </Link>
        </div>
      )}

      {/* Offer cards, in the default order */}
      <div className="space-y-3">
        {offers.map((offer, index) => {
          const { funnel } = offer;
          const stages = [
            { label: t("Offered"), count: funnel.offered, tag: offer.tagOffered, share: null },
            { label: t("Interested"), count: funnel.interested, tag: offer.tagInterested, share: percentOfOffered(funnel.interested, funnel.offered) },
            { label: t("Sent"), count: funnel.sent, tag: offer.tagSent, share: percentOfOffered(funnel.sent, funnel.offered) },
            { label: t("Clicked"), count: funnel.clicked, tag: offer.tagClicked, share: percentOfOffered(funnel.clicked, funnel.offered) },
            // Sign-ups the landing page reported: shown while it reports
            // them, and afterwards for as long as there are some.
            ...(offer.signupTrackingEnabled || funnel.signedUp > 0
              ? [{ label: t("Signed up"), count: funnel.signedUp, tag: offer.tagSignedUp, share: percentOfOffered(funnel.signedUp, funnel.offered) }]
              : []),
          ];
          return (
            <div key={offer.id} className="panel rounded p-4">
              {/* Wraps rather than compressing: on a phone the actions drop
                  to their own line. */}
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <div className="min-w-[12rem] flex-1">
                  {/* One line: a long name is cut, the status stays. */}
                  <div className="mb-1 flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {index + 1}.
                    </span>
                    {/* Names, texts and tags are the user's own words. */}
                    <h3 className="min-w-0 truncate text-sm font-semibold">
                      {offer.name}
                    </h3>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                        offer.isActive
                          ? "bg-success/10 text-success"
                          : "bg-zinc-500/10 text-muted"
                      }`}
                    >
                      {offer.isActive ? t("Active") : t("Paused")}
                    </span>
                  </div>
                  <p className="truncate text-sm text-muted">{offer.cardTitle}</p>
                  <p className="mt-1 truncate font-mono text-xs text-zinc-500">
                    {offer.destinationUrl}
                  </p>
                </div>

                {/* Actions */}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void move(index, -1)}
                    disabled={busy || index === 0}
                    aria-label={t("Move up")}
                    title={t("Move up")}
                    className="grid h-9 w-9 place-items-center rounded-md border border-border text-muted hover:border-border-hover hover:text-foreground disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => void move(index, 1)}
                    disabled={busy || index === offers.length - 1}
                    aria-label={t("Move down")}
                    title={t("Move down")}
                    className="grid h-9 w-9 place-items-center rounded-md border border-border text-muted hover:border-border-hover hover:text-foreground disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <span className="px-1.5">
                    <Toggle
                      on={offer.isActive}
                      onToggle={() => void toggleActive(offer)}
                      label={`${t("Active")}: ${offer.name}`}
                      disabled={busy}
                    />
                  </span>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() =>
                        setMenuOpenId((cur) => (cur === offer.id ? null : offer.id))
                      }
                      aria-label={t("More actions")}
                      aria-expanded={menuOpenId === offer.id}
                      className="grid h-9 w-9 place-items-center rounded text-lg leading-none text-muted hover:text-foreground"
                    >
                      ⋯
                    </button>
                    {menuOpenId === offer.id && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setMenuOpenId(null)}
                        />
                        <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
                          <Link
                            href={`/offers/${offer.id}/edit`}
                            className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover"
                          >
                            {t("Edit")}
                          </Link>
                          <button
                            type="button"
                            onClick={() => void remove(offer)}
                            disabled={busy}
                            className="block w-full px-3 py-2 text-left text-sm text-error hover:bg-surface-hover disabled:opacity-50"
                          >
                            {t("Delete")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Funnel: every stage against everyone offered, since the
                  reminder counts as sent without any interest. Each tile
                  lists the contacts with that stage's tag. Five tiles go
                  three to a row until there is room for all five: beside
                  the sidebar that is from xl on. At lg (1024 px) a tile is
                  128 px wide, too narrow for a label like "Eingetragen"
                  next to its share. */}
              <div
                className={`mt-4 grid grid-cols-2 gap-2 ${
                  stages.length > 4 ? "sm:grid-cols-3 xl:grid-cols-5" : "sm:grid-cols-4"
                }`}
              >
                {stages.map((stage) => (
                  <Link
                    key={stage.label}
                    href={{ pathname: "/contacts", query: { tag: stage.tag } }}
                    title={stage.tag}
                    className="min-w-0 rounded-lg border border-border bg-background px-3 py-2 transition-colors hover:border-border-hover"
                  >
                    {/* The stage's name is never cut: where it and the share
                        do not fit side by side (a narrow phone, a longer
                        word in another language), the share wraps. */}
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="min-w-0 break-words text-xs text-muted">
                        {stage.label}
                      </span>
                      {stage.share !== null && (
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">
                          {percent.format(stage.share / 100)}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">
                      {stage.count.toLocaleString(locale)}
                    </p>
                    <p className="truncate text-xs text-zinc-500">{stage.tag}</p>
                  </Link>
                ))}
              </div>
              {/* The stages are not steps one after the other: the reminder
                  sends the link without a tap. Said once the numbers show
                  it, so a higher count after Interested is not taken for an
                  error. */}
              {(funnel.sent > funnel.interested ||
                funnel.clicked > funnel.interested) && (
                <p className="mt-2 text-xs text-muted">
                  {t("“Sent” and “Clicked” also count people who got the link from the reminder without tapping the button, so these numbers can be higher than “Interested”.")}
                </p>
              )}
              {funnel.stopped > 0 && (
                <p className="mt-2 text-xs text-muted">
                  {t("{count} stopped early", { count: funnel.stopped })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
