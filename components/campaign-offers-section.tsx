"use client";

/**
 * Campaign Offers Section
 *
 * The campaign editor's Weg-2 card inside "After the link" (R4, R11, R13):
 * whether the campaign offers a lead magnet once its link is out, in which
 * order, and when the offer starts: right after the link or 22 hours later.
 * The workspace's default order from the Offers page is the default, so
 * swapping a lead magnet never means editing campaigns; a custom order pins
 * this campaign's own list.
 *
 * The editor owns the state; this card only shows and changes it.
 */

import Link from "next/link";
import { Radio, Toggle } from "@/components/form-controls";
import { useI18n } from "@/lib/i18n/provider";
import { moveItem, type OfferRecord } from "@/lib/offers/editor";
import {
  followUpCanMeetOffer,
  LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES,
  OFFER_LATE_START_HOURS,
  resolveOfferOrder,
  type OfferDelayHours,
} from "@/lib/offers/schedule";

/**
 * What the editor needs of an offer: its name, whether it is paused, and
 * its messages and button for the campaign's preview.
 */
export type OfferOption = Pick<
  OfferRecord,
  "id" | "name" | "isActive" | "offerMessages" | "offerButtonLabel"
>;

/** The workspace's default order, or the campaign's own list of offers. */
export type OfferOrderMode = "default" | "custom";

/**
 * The workspace's current offers in the default order, or null when they
 * could not be loaded (the editor then keeps a stored order as it is).
 */
export async function fetchOfferOptions(): Promise<OfferOption[] | null> {
  try {
    const res = await fetch("/api/offers", { cache: "no-store" });
    const payload = await res.json();
    if (!payload.success || !Array.isArray(payload.data)) return null;
    return (payload.data as OfferRecord[]).map(
      ({ id, name, isActive, offerMessages, offerButtonLabel }) => ({
        id,
        name,
        isActive,
        offerMessages,
        offerButtonLabel,
      })
    );
  } catch {
    return null;
  }
}

function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

interface CampaignOffersSectionProps {
  /** Null: the offers could not be loaded. */
  offers: OfferOption[] | null;
  enabled: boolean;
  onToggle: () => void;
  orderMode: OfferOrderMode;
  onOrderModeChange: (mode: OfferOrderMode) => void;
  customIds: string[];
  onCustomIdsChange: (ids: string[]) => void;
  /** When the offer starts: right after the link (0) or 22 hours later. */
  delayHours: OfferDelayHours;
  onDelayHoursChange: (hours: OfferDelayHours) => void;
  openingDmEnabled: boolean;
  /** Switching offers on just switched the opening DM on as well. */
  openingDmSwitchedOn: boolean;
  followUpEnabled: boolean;
  /** How long the follow-up message waits after the link, in minutes. */
  followUpDelayMinutes: number;
  /** The "Manage offers" link was opened (in a new tab). */
  onManageOffers: () => void;
}

export default function CampaignOffersSection({
  offers,
  enabled,
  onToggle,
  orderMode,
  onOrderModeChange,
  customIds,
  onCustomIdsChange,
  delayHours,
  onDelayHoursChange,
  openingDmEnabled,
  openingDmSwitchedOn,
  followUpEnabled,
  followUpDelayMinutes,
  onManageOffers,
}: CampaignOffersSectionProps) {
  const { t } = useI18n();
  const byId = new Map((offers ?? []).map((offer) => [offer.id, offer]));
  const remaining = (offers ?? []).filter((offer) => !customIds.includes(offer.id));
  // What the worker would offer from: the active offers in this order.
  const effective = offers
    ? resolveOfferOrder(
        orderMode === "custom" ? customIds : [],
        offers.filter((offer) => offer.isActive)
      )
    : [];

  function selectCustom() {
    // A custom order starts as a copy of the default one, to rearrange.
    if (customIds.length === 0 && offers) {
      onCustomIdsChange(offers.map((offer) => offer.id));
    }
    onOrderModeChange("custom");
  }

  let orderHint: { tone: "muted" | "warning"; text: string } | null = null;
  if (offers && offers.length === 0) {
    orderHint = {
      tone: "muted",
      text: t("No offers yet. Until you create one on the Offers page, nobody gets an offer."),
    };
  } else if (offers && orderMode === "custom" && customIds.length === 0) {
    orderHint = {
      tone: "warning",
      text: t("Add at least one offer to the custom order, or use the default order."),
    };
  } else if (offers && effective.length === 0) {
    orderHint = {
      tone: "warning",
      text: t("No active offer in this order, so nobody gets an offer right now."),
    };
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">
          {t("Then offer a lead magnet")}
        </span>
        <Toggle
          on={enabled}
          onToggle={onToggle}
          label={t("Then offer a lead magnet")}
        />
      </div>

      {enabled && (
        <div className="space-y-3">
          {openingDmEnabled && openingDmSwitchedOn && (
            <p
              role="status"
              className="rounded border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-foreground"
            >
              {t("The opening DM is on now: offers need it, because Instagram only allows them after the person taps its button.")}
            </p>
          )}
          {!openingDmEnabled && (
            <p className="text-xs text-warning">
              {t("Offers need the opening DM: Instagram only allows them after the person taps a button.")}
            </p>
          )}

          {offers === null ? (
            <p className="text-xs text-error">{t("Could not load the offers.")}</p>
          ) : (
            <div className="space-y-2">
              <Radio
                checked={orderMode === "default"}
                onSelect={() => onOrderModeChange("default")}
              >
                {t("Default order (Offers page)")}
              </Radio>
              {orderMode === "default" && offers.length > 0 && (
                <ol className="space-y-1 rounded-lg border border-border bg-surface px-3 py-2">
                  {offers.map((offer, i) => (
                    <li
                      key={offer.id}
                      className={`flex min-w-0 items-baseline gap-2 text-sm ${
                        offer.isActive ? "text-foreground" : "text-muted"
                      }`}
                    >
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {i + 1}.
                      </span>
                      {/* Offer names are the user's own words. */}
                      <span className="min-w-0 flex-1 truncate">{offer.name}</span>
                      {!offer.isActive && (
                        <span className="shrink-0 text-xs text-muted">
                          {t("paused, skipped")}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              <Radio checked={orderMode === "custom"} onSelect={selectCustom}>
                {t("Custom order for this campaign")}
              </Radio>
              {orderMode === "custom" && (
                <div className="space-y-2">
                  {customIds.length > 0 && (
                    <ol className="space-y-1.5">
                      {customIds.map((id, i) => {
                        const offer = byId.get(id);
                        return (
                          <li
                            key={id}
                            className="flex min-w-0 items-center gap-1 rounded-lg border border-border bg-surface py-1 pl-3 pr-1"
                          >
                            <span className="shrink-0 text-xs tabular-nums text-muted">
                              {i + 1}.
                            </span>
                            <div className="min-w-0 flex-1 px-1">
                              <p
                                className={`truncate text-sm ${
                                  offer?.isActive === false
                                    ? "text-muted"
                                    : "text-foreground"
                                }`}
                              >
                                {offer?.name ?? id}
                              </p>
                              {offer?.isActive === false && (
                                <p className="text-xs text-muted">
                                  {t("paused, skipped")}
                                </p>
                              )}
                            </div>
                            <IconButton
                              label={t("Move up")}
                              disabled={i === 0}
                              onClick={() =>
                                onCustomIdsChange(moveItem(customIds, i, -1))
                              }
                            >
                              ↑
                            </IconButton>
                            <IconButton
                              label={t("Move down")}
                              disabled={i === customIds.length - 1}
                              onClick={() =>
                                onCustomIdsChange(moveItem(customIds, i, 1))
                              }
                            >
                              ↓
                            </IconButton>
                            <IconButton
                              label={t("Remove")}
                              onClick={() =>
                                onCustomIdsChange(
                                  customIds.filter((other) => other !== id)
                                )
                              }
                            >
                              ✕
                            </IconButton>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {remaining.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        const id = e.target.value;
                        if (id) onCustomIdsChange([...customIds, id]);
                      }}
                      aria-label={t("Add offer…")}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                    >
                      <option value="">{t("Add offer…")}</option>
                      {remaining.map((offer) => (
                        <option key={offer.id} value={offer.id}>
                          {offer.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {orderHint && (
                <p
                  className={`text-xs ${
                    orderHint.tone === "warning" ? "text-warning" : "text-muted"
                  }`}
                >
                  {orderHint.text}
                </p>
              )}
            </div>
          )}

          <p className="text-xs text-muted">
            {t("Each person gets the first offer they have not been offered yet, never one twice.")}
          </p>

          {/* When the offer starts. Late, it comes the next day while
              Instagram's window is still open, and whoever leaves it
              untapped hears nothing more. */}
          <div className="space-y-2">
            <p className="text-sm text-foreground">
              {t("When should the offer start?")}
            </p>
            <Radio
              checked={delayHours !== OFFER_LATE_START_HOURS}
              onSelect={() => onDelayHoursChange(0)}
            >
              {t("Right after the link")}
            </Radio>
            <Radio
              checked={delayHours === OFFER_LATE_START_HOURS}
              onSelect={() => onDelayHoursChange(OFFER_LATE_START_HOURS)}
            >
              {t("{hours} hours later", { hours: OFFER_LATE_START_HOURS })}
            </Radio>
            {/* Shown under either option, so it names the one without a
                reminder: under "Right after the link", "this mode" read as
                that one. */}
            <p className="text-xs text-muted">
              {t(
                "Instagram only allows messages up to 24 hours after the person's last tap or DM. At {hours} hours that window is still open. With “{hours} hours later” there is no reminder.",
                { hours: OFFER_LATE_START_HOURS }
              )}
            </p>
          </div>

          {/* Right after the link, the offer runs from the link on, so any
              follow-up can come in between. A late offer starts 21.5 to 22
              hours after the tap or DM: only a follow-up that waits longer
              than 21 hours can reach it. */}
          {followUpEnabled &&
            followUpCanMeetOffer(delayHours, followUpDelayMinutes) && (
              <p className="text-xs text-warning">
                {delayHours === OFFER_LATE_START_HOURS
                  ? t(
                      "The follow-up message comes {minutes} minutes after the link. The offer may have started by then, so the follow-up can land between the offer messages. With {limit} minutes or less it comes before the offer.",
                      {
                        minutes: followUpDelayMinutes,
                        limit: LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES,
                      }
                    )
                  : t("The follow-up message also goes out after the link, so it can land between the offer messages.")}
              </p>
            )}
          {/* A new tab: the editor keeps no draft, so leaving it would lose
              the campaign typed so far. */}
          <Link
            href="/offers"
            target="_blank"
            rel="noopener"
            onClick={onManageOffers}
            className="inline-block text-xs font-medium text-accent hover:underline"
          >
            {t("Manage offers")} ↗
          </Link>
        </div>
      )}
    </div>
  );
}
