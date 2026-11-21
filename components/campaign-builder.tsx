"use client";

/**
 * Campaign Builder
 *
 * Two-pane campaign editor: a control panel on the left and a live phone
 * preview on the right. Used for both creating and editing a campaign.
 *
 * Turn 1 wires the fully-functional pieces: trigger scope (specific / any /
 * next post), match mode (specific words / any word), the opening + reveal DM
 * text, public reply, and the tracked link. Button-driven delivery and the
 * follow / email / follow-up steps arrive in later turns.
 */

import { useI18n } from "@/lib/i18n/provider";
import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import PostPicker from "@/components/post-picker";
import CampaignPreview, { type PreviewTab } from "@/components/campaign-preview";
import CampaignOffersSection, {
  fetchOfferOptions,
  type OfferOption,
  type OfferOrderMode,
} from "@/components/campaign-offers-section";
import {
  CountedInput,
  LengthCounter,
  Radio,
  Section,
  Toggle,
} from "@/components/form-controls";
import { readCache, writeCache } from "@/lib/client-cache";
import {
  IMPORT_QUEUE_KEY,
  IMPORT_ACCOUNT_KEY,
  type ImportRow,
} from "@/lib/import-queue";
import { BUTTON_TEXT_MAX } from "@/lib/validation/text";
import { issueMessage } from "@/lib/validation/messages";
import {
  EMPTY_MESSAGE_DEFAULTS,
  messageDefaultsUpdateSchema,
  parseMessageDefaults,
  withImportRow,
  type CampaignDefaults,
} from "@/lib/campaigns/message-defaults";
import { isWebLink, offerRuleViolated } from "@/lib/campaigns/schema";
import { cleanCustomOrder, previewOffer } from "@/lib/offers/editor";
import {
  OFFER_LATE_START_HOURS,
  offerStartsLate,
  type OfferDelayHours,
} from "@/lib/offers/schedule";

type TriggerScope = "specific" | "any" | "next";
type MatchMode = "specific" | "any";

const MESSAGE_DEFAULTS_URL = "/api/workspace/message-defaults";

// What the campaign API takes for a DM's text. Instagram keeps only
// BUTTON_TEXT_MAX of a message that goes out with a button.
const DM_TEXT_MAX = 1000;

// The editor's own starting point, for a workspace without default texts:
// nothing switched on but the question-mark filter, and the English button
// labels the senders fall back to.
const BLANK_CAMPAIGN_TEXTS: CampaignDefaults = {
  ...EMPTY_MESSAGE_DEFAULTS.campaign,
  followPromptButtonLabel: "i'm following",
  linkButtonLabel: "Open link",
};

// The first field the defaults route refused, by the field's own name (the
// route names it by its whole path, "campaign.openingDmMessage"), with the
// route's message.
function firstFieldError(
  details: unknown
): { field: string; message: string } | null {
  const fieldErrors = (details as { fieldErrors?: Record<string, string[]> })
    ?.fieldErrors;
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    const [section, field] = path.split(".");
    if (section === "campaign" && field && typeof messages?.[0] === "string") {
      return { field, message: messages[0] };
    }
  }
  return null;
}

interface LoadedCampaign {
  id: string;
  name: string;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch?: boolean;
  dmTriggerEnabled: boolean;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  linkButtonLabel: string | null;
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  followUpEnabled: boolean;
  followUpMessage: string | null;
  followUpDelayMinutes: number | null;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  isActive: boolean;
  instagramAccountId: string;
  trackedLinks?: { destinationUrl: string; label?: string | null }[];
  ignoreQuestionComments?: boolean;
  followPromptRetryMessage?: string | null;
  followPromptRetryButtonLabel?: string | null;
  deliveryTag?: string | null;
  offersEnabled?: boolean;
  offerIds?: string[];
  offerDelayHours?: number;
}

interface CampaignBuilderProps {
  mode: "new" | "edit";
  campaignId?: string;
}

// Offers start only where there is an active one to offer.
function hasActiveOffer(offers: OfferOption[] | null): boolean {
  return Boolean(offers?.some((offer) => offer.isActive));
}

export default function CampaignBuilder({ mode, campaignId }: CampaignBuilderProps) {
  const { t } = useI18n();
  const router = useRouter();

  // Editing waits for the campaign, a new campaign for the default texts, so
  // nothing typed meanwhile is overwritten when they arrive.
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New mode: the workspace's default texts (null when it has none) and
  // whether this person may change them.
  const [campaignDefaults, setCampaignDefaults] =
    useState<CampaignDefaults | null>(null);
  const [canManageDefaults, setCanManageDefaults] = useState(false);
  const [defaultsBusy, setDefaultsBusy] = useState<"save" | "reset" | null>(
    null
  );
  const [defaultsStatus, setDefaultsStatus] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const [name, setName] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);

  const [triggerScope, setTriggerScope] = useState<TriggerScope>("specific");
  const [postId, setPostId] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [postThumb, setPostThumb] = useState<string | null>(null);
  const [postCaption, setPostCaption] = useState("");

  // Post IDs already tied to another automation on this account, so the picker
  // can flag them and the user knows not to double-assign. Maps postId ->
  // the campaign name using it (for the tooltip).
  const [usedPosts, setUsedPosts] = useState<Record<string, string>>({});

  const [matchMode, setMatchMode] = useState<MatchMode>("specific");
  const [keywordText, setKeywordText] = useState("");
  const [wholeWordMatch, setWholeWordMatch] = useState(true);
  const [dmTriggerEnabled, setDmTriggerEnabled] = useState(false);
  // On for new campaigns: a question under a reel is rarely a request for the
  // link. Editing loads the stored value, which is off for older campaigns.
  const [ignoreQuestionComments, setIgnoreQuestionComments] = useState(
    BLANK_CAMPAIGN_TEXTS.ignoreQuestionComments
  );

  // The texts and switches below start blank and take the workspace's
  // default texts in new mode (applyCampaignFields).
  const [publicReplyEnabled, setPublicReplyEnabled] = useState(
    BLANK_CAMPAIGN_TEXTS.publicReplyEnabled
  );
  const [publicReplyMessages, setPublicReplyMessages] = useState<string[]>([""]);

  const [openingDmEnabled, setOpeningDmEnabled] = useState(
    BLANK_CAMPAIGN_TEXTS.openingDmEnabled
  );
  const [openingDmMessage, setOpeningDmMessage] = useState(
    BLANK_CAMPAIGN_TEXTS.openingDmMessage
  );
  const [openingDmButtonLabel, setOpeningDmButtonLabel] = useState(
    BLANK_CAMPAIGN_TEXTS.openingDmButtonLabel
  );

  const [dmMessage, setDmMessage] = useState(BLANK_CAMPAIGN_TEXTS.dmMessage);
  const [linkOpen, setLinkOpen] = useState(false);
  const [trackedDestinationUrl, setTrackedDestinationUrl] = useState("");
  const [linkButtonLabel, setLinkButtonLabel] = useState(
    BLANK_CAMPAIGN_TEXTS.linkButtonLabel
  );
  const [secondLinkOpen, setSecondLinkOpen] = useState(false);
  const [secondaryDestinationUrl, setSecondaryDestinationUrl] = useState("");
  const [secondaryButtonLabel, setSecondaryButtonLabel] = useState("Open link");
  const [requireFollow, setRequireFollow] = useState(
    BLANK_CAMPAIGN_TEXTS.requireFollow
  );
  const [followPromptMessage, setFollowPromptMessage] = useState(
    BLANK_CAMPAIGN_TEXTS.followPromptMessage
  );
  const [followPromptButtonLabel, setFollowPromptButtonLabel] = useState(
    BLANK_CAMPAIGN_TEXTS.followPromptButtonLabel
  );
  // Left empty, the second follow request repeats the first one.
  const [followPromptRetryMessage, setFollowPromptRetryMessage] = useState(
    BLANK_CAMPAIGN_TEXTS.followPromptRetryMessage
  );
  const [followPromptRetryButtonLabel, setFollowPromptRetryButtonLabel] =
    useState(BLANK_CAMPAIGN_TEXTS.followPromptRetryButtonLabel);
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUpMessage, setFollowUpMessage] = useState("");
  const [followUpDelayMinutes, setFollowUpDelayMinutes] = useState(0);
  const [deliveryTag, setDeliveryTag] = useState("");
  const deliveryTagId = useId();
  // The workspace's tags, suggested as the delivery tag is typed: asked for
  // once, when the field first gets focus. Null until then.
  const [tagSuggestions, setTagSuggestions] = useState<string[] | null>(null);
  const tagSuggestionsId = useId();

  // Weg 2 (R4, R13): offers after the link, in the workspace's default order
  // from the Offers page or in this campaign's own. The offers are loaded
  // with the campaign or the defaults; null when that failed.
  const [offerOptions, setOfferOptions] = useState<OfferOption[] | null>(null);
  const [offersEnabled, setOffersEnabled] = useState(false);
  const [offerOrderMode, setOfferOrderMode] =
    useState<OfferOrderMode>("default");
  const [customOfferIds, setCustomOfferIds] = useState<string[]>([]);
  // When the offer starts: right after the link, or 22 hours later. New
  // campaigns start it right after the link.
  const [offerDelayHours, setOfferDelayHours] = useState<OfferDelayHours>(0);
  // Switching offers on switched the opening DM on too: the card says why.
  const [openingDmSwitchedOn, setOpeningDmSwitchedOn] = useState(false);
  // Whether the workspace's default texts were asked for (new mode always).
  const [defaultsFetched, setDefaultsFetched] = useState(false);
  // How often "Manage offers" opened the Offers page in another tab; coming
  // back reloads the offers, so new or paused ones show here.
  const [offersPageVisits, setOffersPageVisits] = useState(0);

  const [previewTab, setPreviewTab] = useState<PreviewTab>("dm");

  // CSV import queue. When present, each save advances to the next row instead
  // of returning to the campaigns list.
  const [importQueue, setImportQueue] = useState<ImportRow[] | null>(null);
  const [importTotal, setImportTotal] = useState(0);

  const keywords = useMemo(
    () =>
      keywordText
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    [keywordText]
  );

  // Fetch the connected account's real avatar for the preview (cache-first so
  // it shows instantly on a return visit instead of a blank circle).
  useEffect(() => {
    if (!selectedAccountId) return;
    let cancelled = false;
    const cacheKey = `ig-avatar:${selectedAccountId}`;
    const cached = readCache<string | null>(cacheKey, 30 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached.data !== null) setAvatarUrl(cached.data);

    const params = new URLSearchParams({ instagramAccountId: selectedAccountId });
    fetch(`/api/instagram/profile?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const url = d.success ? d.data.profilePictureUrl ?? null : null;
        setAvatarUrl(url);
        writeCache(cacheKey, url);
      })
      .catch(() => {
        if (!cancelled && cached.data === null) setAvatarUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId]);

  // Load accounts (both modes need them for the preview username + selector).
  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        setSelectedAccountId(
          (prev) => prev || payload.data.selectedInstagramAccountId || next[0]?.id || ""
        );
      })
      .catch(() => setAccounts([]));
  }, []);

  // Prefill when editing, together with the offers its order can name.
  useEffect(() => {
    if (mode !== "edit" || !campaignId) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/automations", { cache: "no-store" }).then((r) => r.json()),
      fetchOfferOptions(),
    ])
      .then(([payload, offers]) => {
        if (cancelled) return;
        if (!payload.success) return setNotFound(true);
        const c = (payload.data as LoadedCampaign[]).find((x) => x.id === campaignId);
        if (!c) return setNotFound(true);
        setName(c.name);
        setSelectedAccountId(c.instagramAccountId);
        setTriggerScope(
          c.matchAnyPost ? "any" : c.pendingNextReel ? "next" : "specific"
        );
        setPostId(c.postId);
        setPostUrl(c.postUrl);
        setMatchMode(c.matchAnyWord ? "any" : "specific");
        setKeywordText(c.keywords.join(", "));
        setWholeWordMatch(c.wholeWordMatch ?? true);
        setDmTriggerEnabled(c.dmTriggerEnabled ?? false);
        setIgnoreQuestionComments(c.ignoreQuestionComments ?? false);
        setPublicReplyEnabled(c.publicReplyEnabled);
        setPublicReplyMessages(
          c.publicReplyMessages?.length
            ? c.publicReplyMessages
            : c.publicReplyMessage
              ? [c.publicReplyMessage]
              : [""]
        );
        setOpeningDmEnabled(c.openingDmEnabled);
        setOpeningDmMessage(c.openingDmMessage ?? "");
        setOpeningDmButtonLabel(c.openingDmButtonLabel ?? "");
        setDmMessage(c.dmMessage);
        setLinkButtonLabel(c.linkButtonLabel ?? "Open link");
        setIsActive(c.isActive);
        const link = c.trackedLinks?.[0]?.destinationUrl ?? "";
        setTrackedDestinationUrl(link);
        setLinkOpen(Boolean(link));
        const secondLink = c.trackedLinks?.[1];
        setSecondaryDestinationUrl(secondLink?.destinationUrl ?? "");
        setSecondaryButtonLabel(secondLink?.label ?? "Open link");
        setSecondLinkOpen(Boolean(secondLink?.destinationUrl));
        setRequireFollow(c.requireFollow ?? false);
        setFollowPromptMessage(c.followPromptMessage ?? "");
        setFollowPromptButtonLabel(
          c.followPromptButtonLabel ?? "i'm following"
        );
        setFollowPromptRetryMessage(c.followPromptRetryMessage ?? "");
        setFollowPromptRetryButtonLabel(c.followPromptRetryButtonLabel ?? "");
        setFollowUpEnabled(c.followUpEnabled ?? false);
        setFollowUpMessage(c.followUpMessage ?? "");
        setFollowUpDelayMinutes(c.followUpDelayMinutes ?? 0);
        setDeliveryTag(c.deliveryTag ?? "");
        setOfferOptions(offers);
        setOffersEnabled(c.offersEnabled ?? false);
        // An own order stays one, even when cleaning empties it: saving it
        // then asks for an offer instead of silently using the default
        // order. Ids of deleted offers drop out; without the list they are
        // kept as stored.
        const storedIds = c.offerIds ?? [];
        setOfferOrderMode(storedIds.length > 0 ? "custom" : "default");
        setCustomOfferIds(
          offers ? cleanCustomOrder(storedIds, offers) : storedIds
        );
        setOfferDelayHours(
          offerStartsLate(c.offerDelayHours) ? OFFER_LATE_START_HOURS : 0
        );
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, campaignId]);

  // Track which posts on the selected account are already assigned to an
  // automation, so the picker can highlight them. The campaign being edited is
  // excluded — its own post should read as selected, not "taken".
  useEffect(() => {
    if (!selectedAccountId) return;
    let cancelled = false;
    fetch("/api/automations", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (cancelled || !payload.success) return;
        const map: Record<string, string> = {};
        for (const a of payload.data as LoadedCampaign[]) {
          if (!a.postId) continue;
          if (a.instagramAccountId !== selectedAccountId) continue;
          if (mode === "edit" && a.id === campaignId) continue;
          map[a.postId] = a.name;
        }
        setUsedPosts(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId, mode, campaignId]);

  // Put default texts and switches into the form; a field left out stays as
  // it is. The offer switch is only turned on while the workspace has an
  // active offer (until then a new campaign has nothing to offer, and can
  // switch offers on later) and with a complete opening DM: offers need it
  // (R11), and defaults that switch it off would leave a campaign that
  // cannot be saved until fixed by hand.
  function applyCampaignFields(
    fields: Partial<CampaignDefaults>,
    offers: OfferOption[] | null
  ) {
    if (fields.offersEnabled !== undefined) {
      const openingDm = {
        offersEnabled: true,
        openingDmEnabled: fields.openingDmEnabled ?? openingDmEnabled,
        openingDmMessage: fields.openingDmMessage ?? openingDmMessage,
        openingDmButtonLabel:
          fields.openingDmButtonLabel ?? openingDmButtonLabel,
      };
      setOffersEnabled(
        fields.offersEnabled &&
          hasActiveOffer(offers) &&
          !offerRuleViolated(openingDm)
      );
      setOpeningDmSwitchedOn(false);
    }
    if (fields.openingDmEnabled !== undefined)
      setOpeningDmEnabled(fields.openingDmEnabled);
    if (fields.openingDmMessage !== undefined)
      setOpeningDmMessage(fields.openingDmMessage);
    if (fields.openingDmButtonLabel !== undefined)
      setOpeningDmButtonLabel(fields.openingDmButtonLabel);
    if (fields.requireFollow !== undefined) setRequireFollow(fields.requireFollow);
    if (fields.followPromptMessage !== undefined)
      setFollowPromptMessage(fields.followPromptMessage);
    if (fields.followPromptButtonLabel !== undefined)
      setFollowPromptButtonLabel(fields.followPromptButtonLabel);
    if (fields.followPromptRetryMessage !== undefined)
      setFollowPromptRetryMessage(fields.followPromptRetryMessage);
    if (fields.followPromptRetryButtonLabel !== undefined)
      setFollowPromptRetryButtonLabel(fields.followPromptRetryButtonLabel);
    if (fields.dmMessage !== undefined) setDmMessage(fields.dmMessage);
    if (fields.linkButtonLabel !== undefined)
      setLinkButtonLabel(fields.linkButtonLabel);
    if (fields.publicReplyEnabled !== undefined)
      setPublicReplyEnabled(fields.publicReplyEnabled);
    // The form always shows at least one reply field.
    if (fields.publicReplyMessages !== undefined)
      setPublicReplyMessages(
        fields.publicReplyMessages.length > 0 ? fields.publicReplyMessages : [""]
      );
    if (fields.ignoreQuestionComments !== undefined)
      setIgnoreQuestionComments(fields.ignoreQuestionComments);
  }

  // Prefill the editable fields from one queued import row: the cells it
  // fills go over the workspace's default texts, so every row starts from
  // them, offers in the default order included. The reel is left unset so
  // the user picks it per row.
  function prefillFromRow(
    row: ImportRow,
    defaults: CampaignDefaults | null,
    offers: OfferOption[] | null
  ) {
    setName(row.name ?? "");
    setTriggerScope("specific");
    setPostId(null);
    setPostUrl(null);
    setPostThumb(null);
    setPostCaption("");
    setMatchMode("specific");
    setKeywordText((row.keywords ?? []).join(", "));
    setOfferOrderMode("default");
    setCustomOfferIds([]);
    setOfferDelayHours(0);
    applyCampaignFields(withImportRow(defaults, row), offers);
    const link = row.trackedUrl ?? "";
    setTrackedDestinationUrl(link);
    // With default texts the link is what is left to fill in.
    setLinkOpen(Boolean(link) || defaults !== null);
    setError(null);
  }

  // Once the defaults are in: the first queued row over them, or the
  // defaults alone. An Effect Event, so the effect below runs once per mount
  // and still calls this render's functions.
  const onDefaultsLoaded = useEffectEvent(
    (
      defaults: CampaignDefaults | null,
      queue: ImportRow[] | null,
      offers: OfferOption[] | null
    ) => {
      if (queue) {
        prefillFromRow(queue[0], defaults, offers);
      } else if (defaults) {
        applyCampaignFields(defaults, offers);
        setLinkOpen(true);
      }
    }
  );

  // New campaigns open with the workspace's default texts (R14): the opening
  // DM, both follow requests, the link DM and its button, the public replies,
  // the question-mark filter and the offers, so keywords, post and link are
  // what is left. A staged CSV import (new mode only) puts its rows over
  // them, the first one right away. Editing keeps the stored values and
  // never asks.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (mode !== "new") return;
    let queue: ImportRow[] | null = null;
    try {
      const raw = window.localStorage.getItem(IMPORT_QUEUE_KEY);
      const acct = window.localStorage.getItem(IMPORT_ACCOUNT_KEY);
      const staged = raw ? (JSON.parse(raw) as ImportRow[]) : null;
      if (Array.isArray(staged) && staged.length > 0) {
        queue = staged;
        setImportQueue(staged);
        setImportTotal(staged.length);
        if (acct) setSelectedAccountId(acct);
      }
    } catch {
      // ignore a malformed queue
    }

    let cancelled = false;
    Promise.all([
      fetch(MESSAGE_DEFAULTS_URL, { cache: "no-store" })
        .then((r) => r.json())
        .then((payload) => (payload.success ? payload.data : null))
        // Without them the editor opens blank, as it always did.
        .catch(() => null),
      fetchOfferOptions(),
    ]).then(([data, offers]) => {
      if (cancelled) return;
      const defaults = parseMessageDefaults(data?.defaults)?.campaign ?? null;
      setCampaignDefaults(defaults);
      setDefaultsFetched(true);
      setCanManageDefaults(data?.canManage === true);
      setOfferOptions(offers);
      onDefaultsLoaded(defaults, queue, offers);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Back from the Offers page opened by "Manage offers": its offers, new or
  // paused ones included, replace the list once, and deleted ones leave this
  // campaign's own order. Each opening waits for the next return.
  useEffect(() => {
    if (offersPageVisits === 0) return;
    let active = true;
    function reloadOffers() {
      window.removeEventListener("focus", reloadOffers);
      void fetchOfferOptions().then((offers) => {
        if (!active || !offers) return;
        setOfferOptions(offers);
        setCustomOfferIds((ids) => cleanCustomOrder(ids, offers));
      });
    }
    window.addEventListener("focus", reloadOffers);
    return () => {
      active = false;
      window.removeEventListener("focus", reloadOffers);
    };
  }, [offersPageVisits]);

  const username =
    accounts.find((a) => a.id === selectedAccountId)?.username ?? "yourbrand";

  // With a link the DM goes out with its button, and Instagram keeps 640
  // units of the text; without one it is a plain message.
  const dmTextMax = trackedDestinationUrl.trim() ? BUTTON_TEXT_MAX : DM_TEXT_MAX;

  function handlePostSelect(
    id: string,
    url?: string,
    thumb?: string,
    caption?: string
  ) {
    setPostId(id);
    setPostUrl(url ?? null);
    setPostThumb(thumb ?? null);
    setPostCaption(caption ?? "");
  }

  function loadTagSuggestions() {
    if (tagSuggestions !== null) return;
    setTagSuggestions([]);
    fetch("/api/contacts?view=tags", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        setTagSuggestions(
          (payload.data.tagCounts as { tag: string }[]).map((entry) => entry.tag)
        );
      })
      // Without suggestions the field still takes any tag.
      .catch(() => {});
  }

  function ensureLinkToken() {
    setDmMessage((cur) => (cur.includes("{link}") ? cur : `${cur.trim()} {link}`.trim()));
  }

  // The workspace's default texts, asked for once. A new campaign has them
  // from the start; editing asks only when offers need the opening DM.
  async function loadCampaignDefaults(): Promise<CampaignDefaults | null> {
    if (defaultsFetched) return campaignDefaults;
    try {
      const res = await fetch(MESSAGE_DEFAULTS_URL, { cache: "no-store" });
      const payload = await res.json();
      if (!payload.success) return null;
      const defaults =
        parseMessageDefaults(payload.data?.defaults)?.campaign ?? null;
      setCampaignDefaults(defaults);
      setDefaultsFetched(true);
      return defaults;
    } catch {
      return null;
    }
  }

  // R11: Instagram allows offers only after the person taps a button (or
  // DMs), so offers need the opening DM. Switching them on turns it on as
  // well and fills its empty text and button from the default texts.
  async function toggleOffers() {
    if (offersEnabled) {
      setOffersEnabled(false);
      setOpeningDmSwitchedOn(false);
      return;
    }
    setOffersEnabled(true);
    if (
      openingDmEnabled &&
      openingDmMessage.trim() &&
      openingDmButtonLabel.trim()
    ) {
      return;
    }
    if (!openingDmEnabled) {
      setOpeningDmEnabled(true);
      setOpeningDmSwitchedOn(true);
    }
    const defaults = await loadCampaignDefaults();
    const message = defaults?.openingDmMessage.trim() ?? "";
    const label = defaults?.openingDmButtonLabel.trim() ?? "";
    // Only into empty fields: whatever was typed meanwhile stays.
    if (message) setOpeningDmMessage((cur) => (cur.trim() ? cur : message));
    if (label) setOpeningDmButtonLabel((cur) => (cur.trim() ? cur : label));
  }

  async function handleSubmit(activeValue: boolean) {
    setError(null);

    if (!selectedAccountId) return setError(t("Connect an Instagram account first."));
    if (triggerScope === "specific" && !postId)
      return setError(t("Pick a post or reel to trigger the campaign."));
    if (matchMode === "specific" && keywords.length === 0)
      return setError(t("Add at least one keyword, or switch to any word."));
    if (!dmMessage.trim()) return setError(t("Add the DM with the link."));
    if (openingDmEnabled && (!openingDmMessage.trim() || !openingDmButtonLabel.trim()))
      return setError(t("Your opening DM needs a message and a button label."));
    if (offersEnabled && !openingDmEnabled)
      return setError(t("Offers need the opening DM: Instagram only allows them after the person taps a button."));
    if (offersEnabled && offerOrderMode === "custom" && customOfferIds.length === 0)
      return setError(t("Add at least one offer to the custom order, or use the default order."));
    // The API takes http(s) links only (webLink); said here in the
    // interface language instead of the API's English.
    if (
      [trackedDestinationUrl, secondaryDestinationUrl].some(
        (link) => link.trim() !== "" && !isWebLink(link.trim())
      )
    )
      return setError(t("Enter the full link, starting with https://."));

    setSaving(true);

    const payload = {
      name: name.trim() || `Campaign for @${username}`,
      instagramAccountId: selectedAccountId,
      postId: triggerScope === "specific" ? postId : null,
      postUrl: triggerScope === "specific" ? postUrl : null,
      matchAnyPost: triggerScope === "any",
      pendingNextReel: triggerScope === "next",
      matchAnyWord: matchMode === "any",
      keywords: matchMode === "any" ? [] : keywords,
      wholeWordMatch,
      dmTriggerEnabled,
      dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled ? openingDmMessage : null,
      openingDmButtonLabel: openingDmEnabled ? openingDmButtonLabel : null,
      publicReplyEnabled,
      publicReplyMessages: publicReplyEnabled
        ? publicReplyMessages.map((m) => m.trim()).filter(Boolean)
        : [],
      trackedDestinationUrl: trackedDestinationUrl.trim() || "",
      linkButtonLabel: linkButtonLabel.trim() || "Open link",
      secondaryDestinationUrl: secondaryDestinationUrl.trim() || "",
      secondaryButtonLabel: secondaryButtonLabel.trim() || "Open link",
      requireFollow,
      followPromptMessage: requireFollow ? followPromptMessage.trim() : "",
      followPromptButtonLabel: requireFollow
        ? followPromptButtonLabel.trim() || "i'm following"
        : "",
      // Empty is saved as null, "not set": the second request then repeats
      // the first one's text and button.
      followPromptRetryMessage: requireFollow
        ? followPromptRetryMessage.trim() || null
        : null,
      followPromptRetryButtonLabel: requireFollow
        ? followPromptRetryButtonLabel.trim() || null
        : null,
      followUpEnabled,
      followUpMessage: followUpEnabled ? followUpMessage.trim() : "",
      followUpDelayMinutes: followUpEnabled ? followUpDelayMinutes : 0,
      ignoreQuestionComments,
      deliveryTag: deliveryTag.trim() || null,
      offersEnabled,
      // Empty means the workspace's default order. Offers switched off keep
      // no order of their own.
      offerIds:
        offersEnabled && offerOrderMode === "custom" ? customOfferIds : [],
      // Kept with offers off too: it only applies while they are on.
      offerDelayHours,
      isActive: activeValue,
    };

    try {
      const res =
        mode === "new"
          ? await fetch("/api/automations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/automations?id=${campaignId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
      const data = await res.json();
      if (data.success) {
        // The post we just assigned is now in use. Reflect it immediately so
        // the picker flags it on the next imported row — the fetch that builds
        // this map doesn't re-run while the builder stays mounted through the
        // import queue.
        if (triggerScope === "specific" && postId) {
          const assignedPostId = postId;
          setUsedPosts((prev) => ({ ...prev, [assignedPostId]: payload.name }));
        }
        // Importing: advance to the next queued row instead of leaving.
        if (importQueue && importQueue.length > 1) {
          const remaining = importQueue.slice(1);
          try {
            window.localStorage.setItem(
              IMPORT_QUEUE_KEY,
              JSON.stringify(remaining)
            );
          } catch {
            // ignore
          }
          setImportQueue(remaining);
          prefillFromRow(remaining[0], campaignDefaults, offerOptions);
          setSaving(false);
          if (typeof window !== "undefined") window.scrollTo({ top: 0 });
          return;
        }
        if (importQueue) {
          try {
            window.localStorage.removeItem(IMPORT_QUEUE_KEY);
            window.localStorage.removeItem(IMPORT_ACCOUNT_KEY);
          } catch {
            // ignore
          }
        }
        // refresh() busts the router cache so the list reflects the save
        // instead of landing on a stale (empty) campaigns page.
        router.push("/campaigns");
        router.refresh();
      } else {
        // Surface the specific field that failed validation instead of a
        // generic "Invalid input".
        const fieldErrors = data.details?.fieldErrors as
          | Record<string, string[]>
          | undefined;
        const firstField = fieldErrors && Object.keys(fieldErrors)[0];
        setError(
          firstField
            ? `${firstField}: ${fieldErrors[firstField][0]}`
            : data.error ?? t("Failed to save campaign")
        );
        if (typeof window !== "undefined")
          window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch {
      setError(t("Failed to save campaign"));
    } finally {
      setSaving(false);
    }
  }

  // Skip the current imported row without saving a campaign for it, advancing
  // to the next one (or finishing the import if it was the last).
  function skipRow() {
    if (!importQueue) return;
    setError(null);
    if (importQueue.length > 1) {
      const remaining = importQueue.slice(1);
      try {
        window.localStorage.setItem(IMPORT_QUEUE_KEY, JSON.stringify(remaining));
      } catch {
        // ignore
      }
      setImportQueue(remaining);
      prefillFromRow(remaining[0], campaignDefaults, offerOptions);
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
      return;
    }
    // Last row skipped — finish the import.
    try {
      window.localStorage.removeItem(IMPORT_QUEUE_KEY);
      window.localStorage.removeItem(IMPORT_ACCOUNT_KEY);
    } catch {
      // ignore
    }
    router.push("/campaigns");
    router.refresh();
  }

  // The texts and switches new campaigns take from the defaults, as this
  // form has them. A text is kept while its switch is off, so a campaign
  // that turns the switch on gets the default text back. The offer switch
  // has its own rules (offersSwitchForDefaults).
  function currentCampaignTexts(): Omit<CampaignDefaults, "offersEnabled"> {
    return {
      openingDmEnabled,
      openingDmMessage,
      openingDmButtonLabel,
      requireFollow,
      followPromptMessage,
      followPromptButtonLabel,
      followPromptRetryMessage,
      followPromptRetryButtonLabel,
      dmMessage,
      linkButtonLabel,
      publicReplyEnabled,
      publicReplyMessages: publicReplyMessages
        .map((m) => m.trim())
        .filter(Boolean),
      ignoreQuestionComments,
    };
  }

  // The offer switch new campaigns open with, as this form has it. Offers
  // need the opening DM (R11), so without one they are saved off. While the
  // workspace has no active offer (or its offers could not be loaded) the
  // form shows them off whatever the defaults say; the saved value stays.
  function offersSwitchForDefaults(): Partial<
    Pick<CampaignDefaults, "offersEnabled">
  > {
    if (!openingDmEnabled) return { offersEnabled: false };
    if (offersEnabled || hasActiveOffer(offerOptions)) return { offersEnabled };
    return {};
  }

  // A field of the default texts, named as this form shows it.
  function campaignFieldLabel(field: PropertyKey | undefined): string {
    switch (field) {
      case "openingDmEnabled":
      case "openingDmMessage":
      case "openingDmButtonLabel":
        return t("an opening DM");
      case "requireFollow":
      case "followPromptMessage":
      case "followPromptButtonLabel":
        return t("a follow requirement first");
      case "followPromptRetryMessage":
      case "followPromptRetryButtonLabel":
        return t("If they still don't follow after tapping");
      case "dmMessage":
      case "linkButtonLabel":
        return t("a DM with a link");
      case "publicReplyEnabled":
      case "publicReplyMessages":
        return t("reply to their comments under the post");
      case "ignoreQuestionComments":
        return t("Ignore comments with a question mark");
      case "offersEnabled":
        return t("Then offer a lead magnet");
      default:
        return t("Default texts");
    }
  }

  // Owners and admins: new campaigns of the workspace open with these texts
  // and switches, the offer switch included (offersSwitchForDefaults).
  async function saveTextsAsDefaults() {
    setDefaultsStatus(null);
    if (
      openingDmEnabled &&
      (!openingDmMessage.trim() || !openingDmButtonLabel.trim())
    ) {
      return setDefaultsStatus({
        tone: "error",
        text: t("Your opening DM needs a message and a button label."),
      });
    }
    if (offersEnabled && !openingDmEnabled) {
      return setDefaultsStatus({
        tone: "error",
        text: t("Offers need the opening DM: Instagram only allows them after the person taps a button."),
      });
    }
    const campaign = { ...currentCampaignTexts(), ...offersSwitchForDefaults() };
    // The route's own rules first, worded in the interface language: the
    // texts that go out with a button keep 640 characters there.
    const checked = messageDefaultsUpdateSchema.safeParse({ campaign });
    if (!checked.success) {
      const [issue] = checked.error.issues;
      return setDefaultsStatus({
        tone: "error",
        text: `${campaignFieldLabel(issue.path[1])}: ${issueMessage(t, issue)}`,
      });
    }
    setDefaultsBusy("save");
    try {
      const res = await fetch(MESSAGE_DEFAULTS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign }),
      });
      const data = await res.json();
      if (data.success) {
        setCampaignDefaults(
          parseMessageDefaults(data.data?.defaults)?.campaign ?? null
        );
        setDefaultsStatus({
          tone: "success",
          text: t("Saved. New campaigns now open with these texts."),
        });
      } else {
        const refused = firstFieldError(data.details);
        setDefaultsStatus({
          tone: "error",
          text: refused
            ? `${campaignFieldLabel(refused.field)}: ${refused.message}`
            : data.error ?? t("Could not save the default texts."),
        });
      }
    } catch {
      setDefaultsStatus({
        tone: "error",
        text: t("Could not save the default texts."),
      });
    } finally {
      setDefaultsBusy(null);
    }
  }

  // Owners and admins: back to the built-in texts of the interface language
  // (none for some languages: then new campaigns open blank). Only the
  // campaigns' texts: the offers' default texts live in the same record and
  // stay as saved. The form shows what new campaigns open with from now on.
  async function resetDefaults() {
    if (
      !window.confirm(
        t("Reset the default texts for new campaigns to the built-in ones? The texts in this form are replaced as well.")
      )
    )
      return;
    setDefaultsStatus(null);
    setDefaultsBusy("reset");
    try {
      const res = await fetch(`${MESSAGE_DEFAULTS_URL}?section=campaign`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.success) {
        setDefaultsStatus({
          tone: "error",
          text: data.error ?? t("Could not reset the default texts."),
        });
        return;
      }
      const defaults =
        parseMessageDefaults(data.data?.defaults)?.campaign ?? null;
      setCampaignDefaults(defaults);
      applyCampaignFields(defaults ?? BLANK_CAMPAIGN_TEXTS, offerOptions);
      setDefaultsStatus({ tone: "success", text: t("Default texts reset.") });
    } catch {
      setDefaultsStatus({
        tone: "error",
        text: t("Could not reset the default texts."),
      });
    } finally {
      setDefaultsBusy(null);
    }
  }

  if (loading) {
    return <div className="panel h-64 rounded" />;
  }

  if (notFound) {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-muted">{t("Campaign not found.")}</p>
        <button
          onClick={() => router.push("/campaigns")}
          className="mt-4 rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          {t("Back to campaigns")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {importQueue && (
        <div className="rounded border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <span className="font-medium text-foreground">
            {t("Importing {current} of {total}.", { current: importTotal - importQueue.length + 1, total: importTotal })}
          </span>{" "}
          <span className="text-muted">
            {t("Fields are prefilled from your CSV. Pick the reel, edit anything, and save to load the next one — or Skip if you don’t want this one.")}
          </span>
        </div>
      )}

      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          {mode === "edit" ? (
            <>
              <span className="truncate text-sm font-semibold text-foreground">
                {name || t("Untitled campaign")}
              </span>
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  isActive ? "bg-success/15 text-success" : "bg-zinc-500/15 text-muted"
                }`}
              >
                {isActive ? t("LIVE") : t("PAUSED")}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted">{t("New campaign")}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {importQueue && (
            <button
              type="button"
              onClick={skipRow}
              disabled={saving}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
            >
              {importQueue.length > 1 ? t("Skip") : t("Skip & finish")}
            </button>
          )}
          {mode === "edit" &&
            (isActive ? (
              <button
                type="button"
                onClick={() => handleSubmit(false)}
                disabled={saving}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
              >
                {t("Stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleSubmit(true)}
                disabled={saving}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
              >
                {t("Go Live")}
              </button>
            ))}
          <button
            type="button"
            onClick={() => handleSubmit(mode === "new" ? true : isActive)}
            disabled={saving}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? t("Saving…") : mode === "new" ? t("Go Live") : t("Save changes")}
          </button>
        </div>
      </div>

      {/* min-w-0 on the cells: a grid item defaults to min-width:auto, so a
          long string widens the whole page instead of wrapping. */}
      <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:gap-8">
      {/* Left: controls */}
      <div className="space-y-8 min-w-0">
        {error && (
          <div className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <label className="text-sm font-semibold text-foreground">
            {t("Campaign name")}{" "}
            <span className="font-normal text-muted">{t("(optional)")}</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("e.g. YC referral")}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
            maxLength={100}
          />
          {accounts.length > 1 && (
            <div className="pt-2">
              <AccountSelect
                accounts={accounts}
                value={selectedAccountId}
                onChange={(id) => {
                  setSelectedAccountId(id);
                  setPostId(null);
                  setPostUrl(null);
                  setPostThumb(null);
                }}
                includeAll={false}
                label={t("Instagram account")}
              />
            </div>
          )}
        </div>

        <Section title={t("When someone comments on")}>
          <Radio
            checked={triggerScope === "specific"}
            onSelect={() => setTriggerScope("specific")}
          >
            {t("a specific post or reel")}
          </Radio>
          {triggerScope === "specific" && (
            <div className="rounded-lg border border-border p-2">
              <PostPicker
                selectedPostId={postId}
                instagramAccountId={selectedAccountId}
                usedPostIds={usedPosts}
                onSelect={handlePostSelect}
              />
            </div>
          )}
          <Radio
            checked={triggerScope === "any"}
            onSelect={() => setTriggerScope("any")}
          >
            {t("any post or reel")}
          </Radio>
          <Radio
            checked={triggerScope === "next"}
            onSelect={() => setTriggerScope("next")}
          >
            {t("next post or reel")}
          </Radio>
        </Section>

        <Section title={t("And this comment has")}>
          <Radio
            checked={matchMode === "specific"}
            onSelect={() => setMatchMode("specific")}
          >
            {t("a specific word or words")}
          </Radio>
          {matchMode === "specific" && (
            <div className="space-y-1">
              <input
                value={keywordText}
                onChange={(e) => setKeywordText(e.target.value)}
                placeholder={t("Enter a word or multiple")}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
              />
              <p className="text-xs text-muted">{t("Use commas to separate words")}</p>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                <span className="text-sm text-foreground">{t("Match part of a word")}</span>
                <Toggle
                  on={!wholeWordMatch}
                  onToggle={() => setWholeWordMatch(!wholeWordMatch)}
                  label={t("Match part of a word")}
                />
              </div>
              {!wholeWordMatch && (
                <p className="text-xs text-muted">
                  {t("Also fires when a keyword is part of a longer word, e.g. “link” in “links”.")}
                </p>
              )}
            </div>
          )}
          <Radio
            checked={matchMode === "any"}
            onSelect={() => setMatchMode("any")}
          >
            {t("any word")}
          </Radio>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm text-foreground">
              {t("also reply when someone DMs")}{" "}
              {matchMode === "any" ? t("anything") : t("these words")}
            </span>
            <Toggle
              on={dmTriggerEnabled}
              onToggle={() => setDmTriggerEnabled(!dmTriggerEnabled)}
              label={`${t("also reply when someone DMs")} ${
                matchMode === "any" ? t("anything") : t("these words")
              }`}
            />
          </div>
          {dmTriggerEnabled && (
            <p className="text-xs text-muted">
              {matchMode === "any"
                ? t("Every DM to this account gets the reply below — use with care.")
                : t("A DM containing any of these words gets the same reply, no comment needed.")}
            </p>
          )}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm text-foreground">
              {t("Ignore comments with a question mark")}
            </span>
            <Toggle
              on={ignoreQuestionComments}
              onToggle={() => setIgnoreQuestionComments(!ignoreQuestionComments)}
              label={t("Ignore comments with a question mark")}
            />
          </div>
          {ignoreQuestionComments && (
            <p className="text-xs text-muted">
              {t("For example, “Was ist ein Prompt?” gets no DM.")}
            </p>
          )}
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm text-foreground">
              {t("reply to their comments under the post")}
            </span>
            <Toggle
              on={publicReplyEnabled}
              onToggle={() => setPublicReplyEnabled(!publicReplyEnabled)}
              label={t("reply to their comments under the post")}
            />
          </div>
          {publicReplyEnabled && (
            <div className="space-y-2">
              {publicReplyMessages.map((msg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={msg}
                    onChange={(e) =>
                      setPublicReplyMessages((prev) =>
                        prev.map((m, idx) => (idx === i ? e.target.value : m))
                      )
                    }
                    placeholder={t("Sent you a DM! 📩")}
                    maxLength={1000}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                  />
                  {publicReplyMessages.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setPublicReplyMessages((prev) =>
                          prev.filter((_, idx) => idx !== i)
                        )
                      }
                      className="shrink-0 px-2 text-muted hover:text-error"
                      aria-label={t("Remove reply")}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {publicReplyMessages.length < 10 && (
                <button
                  type="button"
                  onClick={() =>
                    setPublicReplyMessages((prev) => [...prev, ""])
                  }
                  className="text-xs font-medium text-accent hover:underline"
                >
                  {t("+ Add another reply")}
                </button>
              )}
              <p className="text-xs text-muted">
                {t("One is picked at random each time, so replies don't look identical.")}
              </p>
            </div>
          )}
        </Section>

        <Section title={t("They will get")}>
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">{t("an opening DM")}</span>
              <Toggle
                on={openingDmEnabled}
                onToggle={() => {
                  setOpeningDmEnabled(!openingDmEnabled);
                  setOpeningDmSwitchedOn(false);
                }}
                label={t("an opening DM")}
              />
            </div>
            {openingDmEnabled && (
              <div className="mt-3 space-y-2">
                {/* It goes out with its button, so Instagram keeps 640
                    units of it. Older campaigns may hold more: the counter
                    turns red. */}
                <textarea
                  value={openingDmMessage}
                  onChange={(e) => setOpeningDmMessage(e.target.value)}
                  placeholder={t("Hey there! I'm so happy you're here 😊")}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none"
                  maxLength={BUTTON_TEXT_MAX}
                />
                <LengthCounter value={openingDmMessage} max={BUTTON_TEXT_MAX} />
                <CountedInput
                  value={openingDmButtonLabel}
                  onChange={setOpeningDmButtonLabel}
                  placeholder={t("Send me the link")}
                />
              </div>
            )}
          </div>
          <div className="mt-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">
                {t("a follow requirement first")}
              </span>
              <Toggle
                on={requireFollow}
                onToggle={() => setRequireFollow(!requireFollow)}
                label={t("a follow requirement first")}
              />
            </div>
            {requireFollow && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={followPromptMessage}
                  onChange={(e) => setFollowPromptMessage(e.target.value)}
                  placeholder={t("quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over")}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none"
                  maxLength={BUTTON_TEXT_MAX}
                />
                <LengthCounter value={followPromptMessage} max={BUTTON_TEXT_MAX} />
                <CountedInput
                  value={followPromptButtonLabel}
                  onChange={setFollowPromptButtonLabel}
                  placeholder={t("i'm following")}
                />
                <p className="text-xs text-muted">
                  {t("We send the link only after they tap the button and Instagram confirms the follow. If it can't be verified, we send it anyway.")}
                </p>
                {/* The second request goes out once the automatic re-checks
                    still see no follow. The placeholders show what an empty
                    field sends: the first request again. Its text goes out
                    with a button, so Instagram keeps 640 units of it, and the
                    API takes no more. */}
                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-sm text-foreground">
                    {t("If they still don't follow after tapping")}
                  </p>
                  <textarea
                    value={followPromptRetryMessage}
                    onChange={(e) => setFollowPromptRetryMessage(e.target.value)}
                    placeholder={
                      followPromptMessage.trim() ||
                      t("quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over")
                    }
                    rows={3}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none"
                    maxLength={BUTTON_TEXT_MAX}
                  />
                  <LengthCounter
                    value={followPromptRetryMessage}
                    max={BUTTON_TEXT_MAX}
                  />
                  <CountedInput
                    value={followPromptRetryButtonLabel}
                    onChange={setFollowPromptRetryButtonLabel}
                    placeholder={followPromptButtonLabel.trim() || t("i'm following")}
                  />
                  <p className="text-xs text-muted">
                    {t("Their next tap gets the link without another check, so nobody gets stuck.")}
                  </p>
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title={t("And then, they will get")}>
          <div className="rounded-lg border border-border p-3 space-y-2">
            <span className="text-sm text-foreground">{t("a DM with a link")}</span>
            <textarea
              value={dmMessage}
              onChange={(e) => setDmMessage(e.target.value)}
              placeholder={t("Write a message")}
              rows={3}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none"
              maxLength={dmTextMax}
            />
            <LengthCounter value={dmMessage} max={dmTextMax} />
            {linkOpen ? (
              <div className="space-y-2">
                <input
                  value={trackedDestinationUrl}
                  onChange={(e) => setTrackedDestinationUrl(e.target.value)}
                  onBlur={ensureLinkToken}
                  placeholder="https://yourlink.com/offer"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                />
                <CountedInput
                  value={linkButtonLabel}
                  onChange={setLinkButtonLabel}
                  placeholder={t("Button label (e.g. Open link)")}
                />
                {secondLinkOpen ? (
                  <div className="space-y-2 border-t border-border pt-2">
                    <input
                      value={secondaryDestinationUrl}
                      onChange={(e) => setSecondaryDestinationUrl(e.target.value)}
                      placeholder="https://yourlink.com/second"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                    />
                    <CountedInput
                      value={secondaryButtonLabel}
                      onChange={setSecondaryButtonLabel}
                      placeholder={t("Second button label")}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSecondLinkOpen(true)}
                    className="w-full rounded-lg border border-border py-2 text-sm text-muted hover:text-foreground"
                  >
                    {t("+ Add A Second Link")}
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setLinkOpen(true)}
                className="w-full rounded-lg border border-border py-2 text-sm text-muted hover:text-foreground"
              >
                {t("+ Add A Link")}
              </button>
            )}
            <p className="text-xs text-muted">
              {"{link}"} {t("inserts the tracked link;")} {"{username}"} {t("personalizes.")}
            </p>
          </div>
          <div className="mt-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">
                {t("a follow-up thank-you message")}
              </span>
              <Toggle
                on={followUpEnabled}
                onToggle={() => setFollowUpEnabled(!followUpEnabled)}
                label={t("a follow-up thank-you message")}
              />
            </div>
            {followUpEnabled && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={followUpMessage}
                  onChange={(e) => setFollowUpMessage(e.target.value)}
                  placeholder={t("Btw just wanted to say thanks for following me, I appreciate the support 🙌")}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none"
                  maxLength={1000}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                  <span className="text-xs text-muted">{t("Send it")}</span>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    value={followUpDelayMinutes}
                    onChange={(e) =>
                      setFollowUpDelayMinutes(
                        Math.max(0, Math.min(1440, Math.floor(Number(e.target.value) || 0)))
                      )
                    }
                    className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                  />
                  <span className="text-xs text-muted">
                    {t("minutes after the link")}
                  </span>
                </div>
                <p className="text-xs text-muted">
                  {followUpDelayMinutes > 0
                    ? t("Sent {minutes} min after they tap through.", { minutes: followUpDelayMinutes })
                    : t("Sent right after they tap through.")}
                  {" {username}"} {t("personalizes it. Max 24 hours, to stay inside Instagram's messaging window.")}
                </p>
              </div>
            )}
          </div>
        </Section>

        <Section title={t("After the link")}>
          <div className="space-y-2 rounded-lg border border-border p-3">
            <label
              htmlFor={deliveryTagId}
              className="block text-sm text-foreground"
            >
              {t("Tag people who got the link")}
            </label>
            {/* Tag names are the user's own words: never translated. */}
            <input
              id={deliveryTagId}
              value={deliveryTag}
              onChange={(e) => setDeliveryTag(e.target.value)}
              onFocus={loadTagSuggestions}
              list={tagSuggestionsId}
              placeholder={t("e.g. [LM] Guide sent")}
              maxLength={100}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
            />
            {/* Tags contacts already have, so one name is not spelled two ways. */}
            <datalist id={tagSuggestionsId}>
              {tagSuggestions?.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <p className="text-xs text-muted">
              {t("Contacts get this tag when this campaign's link reaches them. Leave it empty for no tag.")}
            </p>
          </div>
          <CampaignOffersSection
            offers={offerOptions}
            enabled={offersEnabled}
            onToggle={() => void toggleOffers()}
            orderMode={offerOrderMode}
            onOrderModeChange={setOfferOrderMode}
            customIds={customOfferIds}
            onCustomIdsChange={setCustomOfferIds}
            delayHours={offerDelayHours}
            onDelayHoursChange={setOfferDelayHours}
            openingDmEnabled={openingDmEnabled}
            openingDmSwitchedOn={openingDmSwitchedOn}
            followUpEnabled={followUpEnabled}
            onManageOffers={() => setOffersPageVisits((visits) => visits + 1)}
          />
        </Section>

        {/* Owners and admins manage the workspace's default texts where
            they see them: in a new campaign. */}
        {mode === "new" && canManageDefaults && (
          <Section title={t("Default texts")}>
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-xs text-muted">
                {t("Saves the opening DM, both follow requests, the link DM text and button, the public replies and which of them are on, the question-mark filter and whether a lead magnet is offered after the link. Everything else, like keywords, post and link, is set per campaign.")}
              </p>
              <button
                type="button"
                onClick={saveTextsAsDefaults}
                disabled={defaultsBusy !== null || saving}
                className="w-full rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
              >
                {defaultsBusy === "save"
                  ? t("Saving…")
                  : t("Save these texts as defaults for new campaigns")}
              </button>
              {campaignDefaults && (
                <button
                  type="button"
                  onClick={resetDefaults}
                  disabled={defaultsBusy !== null || saving}
                  className="w-full rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
                >
                  {t("Reset to built-in defaults")}
                </button>
              )}
              {defaultsStatus && (
                <p
                  role="status"
                  className={`text-xs ${
                    defaultsStatus.tone === "error" ? "text-error" : "text-success"
                  }`}
                >
                  {defaultsStatus.text}
                </p>
              )}
            </div>
          </Section>
        )}
      </div>

      {/* Right: preview */}
      <div>
        <p className="mb-4 text-sm text-muted">{t("Preview")}</p>
        <div className="flex min-w-0 justify-center lg:sticky lg:top-6 lg:block">
          <CampaignPreview
            tab={previewTab}
            onTabChange={setPreviewTab}
            username={username}
            avatarUrl={avatarUrl}
            postThumb={postThumb}
            caption={postCaption}
            sampleComment={keywords[0] ?? ""}
            dmTriggerEnabled={dmTriggerEnabled}
            publicReplyEnabled={publicReplyEnabled}
            publicReplyMessage={publicReplyMessages.find((m) => m.trim()) ?? ""}
            openingDmEnabled={openingDmEnabled}
            openingDmMessage={openingDmMessage}
            openingDmButtonLabel={openingDmButtonLabel}
            revealMessage={dmMessage}
            hasLink={Boolean(trackedDestinationUrl.trim())}
            linkButtonLabel={linkButtonLabel || "Open link"}
            linkUrl={trackedDestinationUrl.trim() || undefined}
            hasSecondLink={
              secondLinkOpen && Boolean(secondaryDestinationUrl.trim())
            }
            secondLinkButtonLabel={secondaryButtonLabel || "Open link"}
            requireFollow={requireFollow}
            followPromptMessage={followPromptMessage}
            followPromptButtonLabel={followPromptButtonLabel || "i'm following"}
            followPromptRetryMessage={followPromptRetryMessage}
            followPromptRetryButtonLabel={followPromptRetryButtonLabel}
            followUpEnabled={followUpEnabled}
            followUpMessage={followUpMessage}
            followUpDelayMinutes={followUpDelayMinutes}
            offer={
              offersEnabled
                ? previewOffer(
                    offerOptions,
                    offerOrderMode === "custom" ? customOfferIds : []
                  )
                : null
            }
            offerDelayHours={offerDelayHours}
          />
        </div>
      </div>
      </div>
    </div>
  );
}
