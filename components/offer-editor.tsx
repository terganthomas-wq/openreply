"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Offer Editor
 *
 * Creates and edits a lead-magnet offer (R3): the offer messages with the
 * pause before each, the button on the last one, the confirmations after a
 * tap, the card, the reminder for people who do not tap and the four funnel
 * tags, next to a live preview of the DM thread. A new offer starts from the
 * workspace's default texts for offers.
 *
 * Saving sends the whole offer (lib/offers/editor.ts offerPayload) and never
 * isActive: pausing belongs to the Offers page.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { CountedInput, Section, Toggle } from "@/components/form-controls";
import OfferPreview from "@/components/offer-preview";
import {
  EMPTY_MESSAGE_DEFAULTS,
  parseMessageDefaults,
} from "@/lib/campaigns/message-defaults";
import { useI18n } from "@/lib/i18n/provider";
import {
  clampDelaySeconds,
  clampReminderHours,
  editorStateFromOffer,
  fieldErrorsFromDetails,
  firstErrorField,
  firstMissingField,
  followTagTemplates,
  newOfferEditorState,
  offerDefaultsUpdate,
  offerPayload,
  sentMessages,
  TAG_FIELD,
  TAG_KEYS,
  type OfferEditorState,
  type OfferField,
  type OfferRecord,
  type TagKey,
  type TagTemplates,
  type TimedMessage,
} from "@/lib/offers/editor";
import {
  OFFER_DELAY_MAX_SECONDS,
  OFFER_MESSAGE_MAX,
  OFFER_MESSAGES_MAX,
  OFFER_NAME_MAX,
  OFFER_TAG_MAX,
  OFFER_URL_MAX,
  REMINDER_DELAY_MAX_HOURS,
  offerInputSchema,
} from "@/lib/offers/schema";
import { BUTTON_TEXT_MAX, CARD_TEXT_MAX } from "@/lib/validation/text";

const MESSAGE_DEFAULTS_URL = "/api/workspace/message-defaults";

// A new message waits this long after the one before.
const NEW_MESSAGE_DELAY_SECONDS = 3;

type MessageListKey = "offerMessages" | "confirmationMessages";

const INPUT_CLASS =
  "w-full rounded-lg border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";

function inputClass(invalid: boolean, extra = "") {
  return `${INPUT_CLASS} ${invalid ? "border-error/60" : "border-border"} ${extra}`;
}

// The message of the first field the defaults route refused, as
// "field: message". That route names fields by their whole path.
function firstDefaultsError(details: unknown): string | null {
  const fieldErrors = (details as { fieldErrors?: Record<string, string[]> })
    ?.fieldErrors;
  const field = fieldErrors && Object.keys(fieldErrors)[0];
  if (!field) return null;
  return `${field.split(".").pop()}: ${fieldErrors[field][0]}`;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-error">{message}</p>;
}

interface OfferEditorProps {
  mode: "new" | "edit";
  offerId?: string;
}

export default function OfferEditor({ mode, offerId }: OfferEditorProps) {
  const { t } = useI18n();
  const router = useRouter();
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<OfferField, string>>>({});

  const [form, setForm] = useState<OfferEditorState>(() =>
    newOfferEditorState(null)
  );
  // Shown in edit mode; changed on the Offers page only.
  const [isActive, setIsActive] = useState(true);
  // A new offer's tags follow its name through the templates until one is
  // typed over. A stored offer keeps its tags: contacts already carry them.
  const [templates, setTemplates] = useState<TagTemplates>(
    EMPTY_MESSAGE_DEFAULTS.offer.tagTemplates
  );
  const [followingTags, setFollowingTags] = useState<TagKey[]>(() =>
    mode === "new" ? [...TAG_KEYS] : []
  );
  const [tagsOpen, setTagsOpen] = useState(false);

  // The preview's account: the workspace's newest connected one.
  const [username, setUsername] = useState("yourbrand");

  // New offers: whether this person may save the texts as defaults.
  const [canManageDefaults, setCanManageDefaults] = useState(false);
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [defaultsStatus, setDefaultsStatus] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  // The card image is loaded a moment after typing stops, and only from an
  // https link, so a half-typed address requests nothing.
  const [shownImageUrl, setShownImageUrl] = useState("");
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((payload) => {
        const name = payload.success
          ? payload.data?.instagramAccounts?.[0]?.username
          : null;
        if (active && typeof name === "string" && name) setUsername(name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // A new offer opens with the workspace's default texts for offers; an
  // edit with the stored offer.
  useEffect(() => {
    let active = true;
    if (mode === "new") {
      fetch(MESSAGE_DEFAULTS_URL, { cache: "no-store" })
        .then((r) => r.json())
        .then((payload) => (payload.success ? payload.data : null))
        // Without them the form opens empty.
        .catch(() => null)
        .then((data) => {
          if (!active) return;
          const defaults = parseMessageDefaults(data?.defaults)?.offer ?? null;
          setForm(newOfferEditorState(defaults));
          setTemplates(
            (defaults ?? EMPTY_MESSAGE_DEFAULTS.offer).tagTemplates
          );
          setCanManageDefaults(data?.canManage === true);
          setLoading(false);
        });
    } else {
      fetch("/api/offers", { cache: "no-store" })
        .then((r) => r.json())
        .then((payload) => {
          if (!active) return;
          const offer = payload.success
            ? (payload.data as OfferRecord[]).find((o) => o.id === offerId)
            : undefined;
          if (!offer) return setNotFound(true);
          setForm(editorStateFromOffer(offer));
          setIsActive(offer.isActive);
        })
        .catch(() => {
          if (active) setNotFound(true);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [mode, offerId]);

  const typedImageUrl = form.cardImageUrl.trim();
  const imageCandidate = /^https:\/\/\S+$/i.test(typedImageUrl)
    ? typedImageUrl
    : "";
  useEffect(() => {
    const timer = window.setTimeout(() => setShownImageUrl(imageCandidate), 400);
    return () => window.clearTimeout(timer);
  }, [imageCandidate]);
  const imageFailed = shownImageUrl !== "" && failedImageUrl === shownImageUrl;
  // Meta fetches the image itself and takes https only.
  const imageNotHttps =
    typedImageUrl.length >= "https://".length &&
    !typedImageUrl.toLowerCase().startsWith("https://");

  function clearErrors(...fields: OfferField[]) {
    setErrors((current) => {
      if (!fields.some((field) => current[field] !== undefined)) return current;
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });
  }

  function update<K extends keyof OfferEditorState>(
    key: K,
    value: OfferEditorState[K],
    ...fields: OfferField[]
  ) {
    setForm((current) => ({ ...current, [key]: value }));
    clearErrors(...fields);
  }

  function setName(name: string) {
    setForm((current) => ({
      ...current,
      name,
      tags: followTagTemplates(current.tags, followingTags, templates, name),
    }));
    clearErrors("name");
  }

  function setTag(key: TagKey, value: string) {
    setFollowingTags((keys) => keys.filter((other) => other !== key));
    setForm((current) => ({ ...current, tags: { ...current.tags, [key]: value } }));
    clearErrors(TAG_FIELD[key]);
  }

  function messageFields(list: MessageListKey): OfferField[] {
    return list === "offerMessages"
      ? ["offerMessages", "offerDelaysSeconds"]
      : ["confirmationMessages", "confirmationDelaysSeconds"];
  }

  function changeMessage(
    list: MessageListKey,
    index: number,
    patch: Partial<TimedMessage>
  ) {
    setForm((current) => ({
      ...current,
      [list]: current[list].map((message, i) =>
        i === index ? { ...message, ...patch } : message
      ),
    }));
    clearErrors(...messageFields(list));
  }

  function addMessage(list: MessageListKey) {
    setForm((current) =>
      current[list].length >= OFFER_MESSAGES_MAX
        ? current
        : {
            ...current,
            [list]: [
              ...current[list],
              { text: "", delaySeconds: NEW_MESSAGE_DELAY_SECONDS },
            ],
          }
    );
  }

  function removeMessage(list: MessageListKey, index: number) {
    setForm((current) => ({
      ...current,
      [list]: current[list].filter((_, i) => i !== index),
    }));
    clearErrors(...messageFields(list));
  }

  function fieldLabel(field: OfferField): string {
    switch (field) {
      case "name":
        return t("Offer name");
      case "offerMessages":
      case "offerDelaysSeconds":
        return t("Offer messages");
      case "offerButtonLabel":
        return t("Button label");
      case "confirmationMessages":
      case "confirmationDelaysSeconds":
        return t("Confirmation messages");
      case "cardImageUrl":
        return t("Image URL");
      case "cardTitle":
        return t("Title");
      case "cardSubtitle":
        return t("Subtitle");
      case "cardButtonLabel":
        return t("Card button label");
      case "destinationUrl":
        return t("Link behind the button");
      case "reminderEnabled":
      case "reminderDelayHours":
      case "reminderMessage":
        return t("Reminder");
      default:
        return t("Tags");
    }
  }

  function missingMessage(field: OfferField): string {
    switch (field) {
      case "name":
        return t("Give the offer a name.");
      case "offerMessages":
        return t("Write at least one offer message.");
      case "offerButtonLabel":
        return t("Add the button label.");
      case "cardTitle":
        return t("Give the card a title.");
      case "cardButtonLabel":
        return t("Add the card's button label.");
      case "destinationUrl":
        return t("Add the link behind the button.");
      case "reminderMessage":
        return t("Write the reminder, or turn it off.");
      default:
        return t("Fill in all four tags.");
    }
  }

  // Field errors from the schema or the API: the two link fields get a
  // message in the interface language, the length limits keep the API's.
  function showErrors(fieldErrors: Partial<Record<OfferField, string>>) {
    const shown = { ...fieldErrors };
    if (shown.cardImageUrl) shown.cardImageUrl = t("The image needs a direct https link.");
    if (shown.destinationUrl && form.destinationUrl.trim()) {
      shown.destinationUrl = t("Enter the full link, starting with https://.");
    }
    const first = firstErrorField(shown);
    setErrors(shown);
    if (!first) return;
    setError(`${fieldLabel(first)}: ${shown[first]}`);
    if (TAG_KEYS.some((key) => TAG_FIELD[key] === first)) setTagsOpen(true);
    window.requestAnimationFrame(() =>
      document
        .getElementById(fieldId("error"))
        ?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
  }

  async function save() {
    setError(null);
    setErrors({});
    const missing = firstMissingField(form);
    if (missing) return showErrors({ [missing]: missingMessage(missing) });
    const payload = offerPayload(form);
    // The API's own rules first: limits, links, one pause per message.
    const checked = offerInputSchema.safeParse(payload);
    if (!checked.success) {
      return showErrors(fieldErrorsFromDetails(checked.error.flatten()));
    }

    setSaving(true);
    try {
      const res =
        mode === "new"
          ? await fetch("/api/offers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/offers?id=${encodeURIComponent(offerId ?? "")}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
      const data = await res.json();
      if (data.success) {
        // refresh() busts the router cache, so the list shows the save.
        router.push("/offers");
        router.refresh();
        return;
      }
      if (res.status === 403) {
        setError(t("Only owners and admins can change offers."));
        return;
      }
      const fieldErrors = fieldErrorsFromDetails(data.details);
      if (firstErrorField(fieldErrors)) showErrors(fieldErrors);
      else setError(data.error ?? t("Failed to save offer"));
    } catch {
      setError(t("Failed to save offer"));
    } finally {
      setSaving(false);
    }
  }

  // Owners and admins: new offers of the workspace start with these texts.
  async function saveTextsAsDefaults() {
    setDefaultsStatus(null);
    setDefaultsBusy(true);
    try {
      const res = await fetch(MESSAGE_DEFAULTS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(offerDefaultsUpdate(form)),
      });
      const data = await res.json();
      if (data.success) {
        const saved = parseMessageDefaults(data.data?.defaults)?.offer;
        if (saved) setTemplates(saved.tagTemplates);
        setDefaultsStatus({
          tone: "success",
          text: t("Saved. New offers now start with these texts."),
        });
      } else {
        setDefaultsStatus({
          tone: "error",
          text:
            firstDefaultsError(data.details) ??
            data.error ??
            t("Could not save the default texts."),
        });
      }
    } catch {
      setDefaultsStatus({
        tone: "error",
        text: t("Could not save the default texts."),
      });
    } finally {
      setDefaultsBusy(false);
    }
  }

  if (loading) {
    return <div className="panel h-64 rounded" />;
  }

  if (notFound) {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-muted">{t("Offer not found.")}</p>
        <Link
          href="/offers"
          className="mt-4 inline-block rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          {t("Back to offers")}
        </Link>
      </div>
    );
  }

  function messageList(list: MessageListKey) {
    const messages = form[list];
    const isOfferList = list === "offerMessages";
    const listError = isOfferList
      ? errors.offerMessages ?? errors.offerDelaysSeconds
      : errors.confirmationMessages ?? errors.confirmationDelaysSeconds;
    return (
      <div className="space-y-2">
        {messages.map((message, i) => {
          // The last offer message carries the button: a button message
          // keeps 640 UTF-16 units of text.
          const carriesButton = isOfferList && i === messages.length - 1;
          const max = carriesButton ? BUTTON_TEXT_MAX : OFFER_MESSAGE_MAX;
          const canRemove = !isOfferList || messages.length > 1;
          return (
            <div
              key={i}
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input
                    type="number"
                    min={0}
                    max={OFFER_DELAY_MAX_SECONDS}
                    value={message.delaySeconds}
                    onChange={(e) =>
                      changeMessage(list, i, {
                        delaySeconds: clampDelaySeconds(Number(e.target.value)),
                      })
                    }
                    className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                  />
                  {t("seconds before")}
                </label>
                {canRemove && (
                  <button
                    type="button"
                    onClick={() => removeMessage(list, i)}
                    aria-label={t("Remove message")}
                    title={t("Remove message")}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-hover hover:text-error"
                  >
                    ✕
                  </button>
                )}
              </div>
              <textarea
                id={i === 0 ? fieldId(list) : undefined}
                value={message.text}
                onChange={(e) => changeMessage(list, i, { text: e.target.value })}
                placeholder={t("Write a message")}
                rows={3}
                maxLength={max}
                aria-invalid={Boolean(listError) || undefined}
                className={inputClass(Boolean(listError), "resize-none")}
              />
              {carriesButton && (
                <p
                  className={`text-right text-xs tabular-nums ${
                    message.text.length > max ? "text-error" : "text-muted"
                  }`}
                >
                  {message.text.length}/{max}
                </p>
              )}
            </div>
          );
        })}
        <FieldError message={listError} />
        {messages.length < OFFER_MESSAGES_MAX && (
          <button
            type="button"
            onClick={() => addMessage(list)}
            className="text-xs font-medium text-accent hover:underline"
          >
            {t("+ Add a message")}
          </button>
        )}
      </div>
    );
  }

  const tagLabels: Record<TagKey, string> = {
    offered: t("Offered"),
    interested: t("Interested"),
    sent: t("Sent"),
    clicked: t("Clicked"),
  };
  const tagsError = TAG_KEYS.map((key) => errors[TAG_FIELD[key]]).find(Boolean);

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/offers"
            className="shrink-0 text-sm text-muted hover:text-foreground"
          >
            {t("← Offers")}
          </Link>
          {mode === "edit" && (
            <span
              className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${
                isActive ? "bg-success/15 text-success" : "bg-zinc-500/15 text-muted"
              }`}
            >
              {isActive ? t("Active") : t("Paused")}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="ml-auto rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {saving
            ? t("Saving…")
            : mode === "new"
              ? t("Create offer")
              : t("Save changes")}
        </button>
      </div>

      {/* min-w-0 on the cells: a grid item defaults to min-width:auto, so a
          long string widens the whole page instead of wrapping. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr] lg:gap-8">
        <div className="min-w-0 space-y-8">
          {error && (
            <div
              id={fieldId("error")}
              role="alert"
              className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error"
            >
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor={fieldId("name")}
              className="block text-sm font-semibold text-foreground"
            >
              {t("Offer name")}
            </label>
            {/* The name is the user's own: never translated. */}
            <input
              id={fieldId("name")}
              value={form.name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("e.g. Prompting guide")}
              maxLength={OFFER_NAME_MAX}
              aria-invalid={Boolean(errors.name) || undefined}
              className={inputClass(Boolean(errors.name))}
            />
            <FieldError message={errors.name} />
          </div>

          <Section title={t("Offer messages")}>
            <p className="text-xs text-muted">
              {t("Sent one after another once the campaign's link is out. The last one carries the button.")}{" "}
              {"{username}"} {t("personalizes.")}
            </p>
            {messageList("offerMessages")}
            <div className="space-y-1">
              <label
                htmlFor={fieldId("offerButtonLabel")}
                className="block text-xs text-muted"
              >
                {t("Button label")}
              </label>
              <CountedInput
                id={fieldId("offerButtonLabel")}
                value={form.offerButtonLabel}
                onChange={(value) =>
                  update("offerButtonLabel", value, "offerButtonLabel")
                }
                placeholder={t("e.g. Yes, please!")}
                invalid={Boolean(errors.offerButtonLabel)}
              />
              <FieldError message={errors.offerButtonLabel} />
            </div>
          </Section>

          <Section title={t("When they tap the button")}>
            <p className="text-xs text-muted">
              {t("Sent after the tap, before the card.")}
            </p>
            {messageList("confirmationMessages")}
          </Section>

          <Section title={t("The card")}>
            <div className="space-y-1">
              <label
                htmlFor={fieldId("cardImageUrl")}
                className="block text-xs text-muted"
              >
                {t("Image URL")}{" "}
                <span className="font-normal">{t("(optional)")}</span>
              </label>
              <input
                id={fieldId("cardImageUrl")}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={form.cardImageUrl}
                onChange={(e) =>
                  update("cardImageUrl", e.target.value, "cardImageUrl")
                }
                placeholder="https://…/cover.jpg"
                maxLength={OFFER_URL_MAX}
                aria-invalid={Boolean(errors.cardImageUrl) || undefined}
                className={inputClass(Boolean(errors.cardImageUrl))}
              />
              <FieldError message={errors.cardImageUrl} />
              {!errors.cardImageUrl && imageNotHttps && (
                <p className="text-xs text-warning">
                  {t("The image needs a direct https link.")}
                </p>
              )}
              {shownImageUrl && (
                <div className="flex items-center gap-3 pt-1">
                  <img
                    key={shownImageUrl}
                    src={shownImageUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={() => setFailedImageUrl(shownImageUrl)}
                    onLoad={() =>
                      setFailedImageUrl((current) =>
                        current === shownImageUrl ? null : current
                      )
                    }
                    className={`h-16 w-16 shrink-0 rounded border border-border object-cover ${
                      imageFailed ? "hidden" : ""
                    }`}
                  />
                  {imageFailed && (
                    <p className="text-xs text-warning">
                      {t("This image does not load. Google Drive share links are web pages, not images: use a direct link to the image file.")}
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs text-muted">
                {t("A direct https link to the image file. Square images (1080 × 1080) work best.")}
              </p>
            </div>
            <div className="space-y-1">
              <label
                htmlFor={fieldId("cardTitle")}
                className="block text-xs text-muted"
              >
                {t("Title")}
              </label>
              <CountedInput
                id={fieldId("cardTitle")}
                value={form.cardTitle}
                onChange={(value) => update("cardTitle", value, "cardTitle")}
                placeholder={t("e.g. The complete guide")}
                max={CARD_TEXT_MAX}
                invalid={Boolean(errors.cardTitle)}
              />
              <FieldError message={errors.cardTitle} />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={fieldId("cardSubtitle")}
                className="block text-xs text-muted"
              >
                {t("Subtitle")}{" "}
                <span className="font-normal">{t("(optional)")}</span>
              </label>
              <CountedInput
                id={fieldId("cardSubtitle")}
                value={form.cardSubtitle}
                onChange={(value) => update("cardSubtitle", value, "cardSubtitle")}
                placeholder=""
                max={CARD_TEXT_MAX}
                invalid={Boolean(errors.cardSubtitle)}
              />
              <FieldError message={errors.cardSubtitle} />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={fieldId("cardButtonLabel")}
                className="block text-xs text-muted"
              >
                {t("Card button label")}
              </label>
              <CountedInput
                id={fieldId("cardButtonLabel")}
                value={form.cardButtonLabel}
                onChange={(value) =>
                  update("cardButtonLabel", value, "cardButtonLabel")
                }
                placeholder={t("Button label")}
                invalid={Boolean(errors.cardButtonLabel)}
              />
              <FieldError message={errors.cardButtonLabel} />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={fieldId("destinationUrl")}
                className="block text-xs text-muted"
              >
                {t("Link behind the button")}
              </label>
              <input
                id={fieldId("destinationUrl")}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={form.destinationUrl}
                onChange={(e) =>
                  update("destinationUrl", e.target.value, "destinationUrl")
                }
                placeholder="https://drive.google.com/…"
                maxLength={OFFER_URL_MAX}
                aria-invalid={Boolean(errors.destinationUrl) || undefined}
                className={inputClass(Boolean(errors.destinationUrl))}
              />
              <FieldError message={errors.destinationUrl} />
              <p className="text-xs text-muted">
                {t("Google Drive and Docs share links work. Every click goes through a tracked link first.")}
              </p>
            </div>
          </Section>

          <Section title={t("If they don't tap")}>
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-foreground">
                  {t("Send a reminder")}
                </span>
                <Toggle
                  on={form.reminderEnabled}
                  onToggle={() =>
                    update(
                      "reminderEnabled",
                      !form.reminderEnabled,
                      "reminderEnabled",
                      "reminderMessage"
                    )
                  }
                  label={t("Send a reminder")}
                />
              </div>
              {form.reminderEnabled && (
                <div className="mt-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={REMINDER_DELAY_MAX_HOURS}
                      value={form.reminderDelayHours}
                      onChange={(e) =>
                        update(
                          "reminderDelayHours",
                          clampReminderHours(Number(e.target.value)),
                          "reminderDelayHours"
                        )
                      }
                      aria-label={t("hours after the offer")}
                      className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                    />
                    <span className="text-xs text-muted">
                      {t("hours after the offer")}
                    </span>
                  </div>
                  {/* Goes out with the card's button, so it is held to the
                      640 units of a button message. */}
                  <textarea
                    id={fieldId("reminderMessage")}
                    value={form.reminderMessage}
                    onChange={(e) =>
                      update("reminderMessage", e.target.value, "reminderMessage")
                    }
                    placeholder={t("Write a message")}
                    rows={3}
                    maxLength={BUTTON_TEXT_MAX}
                    aria-invalid={Boolean(errors.reminderMessage) || undefined}
                    className={inputClass(Boolean(errors.reminderMessage), "resize-none")}
                  />
                  <p
                    className={`text-right text-xs tabular-nums ${
                      form.reminderMessage.length > BUTTON_TEXT_MAX
                        ? "text-error"
                        : "text-muted"
                    }`}
                  >
                    {form.reminderMessage.length}/{BUTTON_TEXT_MAX}
                  </p>
                  <FieldError
                    message={errors.reminderMessage ?? errors.reminderDelayHours}
                  />
                  <p className="text-xs text-muted">
                    {t("Only if they have not tapped. It carries the card's button. Instagram allows it up to 24 hours after their last tap or DM.")}
                  </p>
                </div>
              )}
            </div>
          </Section>

          <div className="rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setTagsOpen(!tagsOpen)}
              aria-expanded={tagsOpen}
              aria-controls={fieldId("tags")}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-semibold text-foreground"
            >
              {t("Tags")}
              <span aria-hidden="true" className="text-muted">
                {tagsOpen ? "−" : "+"}
              </span>
            </button>
            {tagsOpen && (
              <div
                id={fieldId("tags")}
                className="space-y-3 border-t border-border p-3"
              >
                <p className="text-xs text-muted">
                  {t("Contacts get these tags as they go through the offer. New offers take them from the offer's name.")}
                </p>
                {TAG_KEYS.map((key) => (
                  <div key={key} className="space-y-1">
                    <label
                      htmlFor={fieldId(`tag-${key}`)}
                      className="block text-xs text-muted"
                    >
                      {tagLabels[key]}
                    </label>
                    {/* Tag names are the user's own words: never translated. */}
                    <input
                      id={fieldId(`tag-${key}`)}
                      value={form.tags[key]}
                      onChange={(e) => setTag(key, e.target.value)}
                      maxLength={OFFER_TAG_MAX}
                      aria-invalid={Boolean(errors[TAG_FIELD[key]]) || undefined}
                      className={inputClass(Boolean(errors[TAG_FIELD[key]]))}
                    />
                  </div>
                ))}
                <FieldError message={tagsError} />
              </div>
            )}
          </div>

          {/* Owners and admins manage the workspace's default texts for
              offers where they see them: in a new offer. */}
          {mode === "new" && canManageDefaults && (
            <Section title={t("Default texts")}>
              <div className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-xs text-muted">
                  {t("Saves the offer messages with their pauses, the button, the confirmations, the card's button and the reminder. Name, card, link and tags are set per offer.")}
                </p>
                <button
                  type="button"
                  onClick={() => void saveTextsAsDefaults()}
                  disabled={defaultsBusy || saving}
                  className="w-full rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
                >
                  {defaultsBusy
                    ? t("Saving…")
                    : t("Save these texts as defaults for new offers")}
                </button>
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

        {/* Right: preview, under the form on phones */}
        <div className="min-w-0">
          <p className="mb-4 text-sm text-muted">{t("Preview")}</p>
          <div className="flex min-w-0 justify-center lg:sticky lg:top-6 lg:block">
            <OfferPreview
              username={username}
              avatarUrl={null}
              offerMessages={sentMessages(form.offerMessages)}
              offerButtonLabel={form.offerButtonLabel}
              confirmationMessages={sentMessages(form.confirmationMessages)}
              cardImageUrl={shownImageUrl && !imageFailed ? shownImageUrl : null}
              cardTitle={form.cardTitle}
              cardSubtitle={form.cardSubtitle}
              cardButtonLabel={form.cardButtonLabel}
              reminderEnabled={form.reminderEnabled}
              reminderDelayHours={form.reminderDelayHours}
              reminderMessage={form.reminderMessage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
