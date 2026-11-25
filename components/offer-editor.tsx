"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Offer Editor
 *
 * Creates and edits a lead-magnet offer (R3): the offer messages with the
 * pause before each, the button on the last one, the confirmations after a
 * tap, the card, the reminder for people who do not tap, the feedback from
 * the landing page after a sign-up and the funnel tags, next to a live
 * preview of the DM thread. A new offer starts from the workspace's default
 * texts for offers.
 *
 * The card image is uploaded where a Vercel Blob store is connected (GET
 * /api/offers says so): picking a file sends it to /api/offers/image at
 * once and puts the URL it answers with into the form. Elsewhere the image
 * is a link typed into a field.
 *
 * Saving sends the whole offer (lib/offers/editor.ts offerPayload) and never
 * isActive: pausing belongs to the Offers page.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CountedInput, Section, Toggle } from "@/components/form-controls";
import OfferPreview from "@/components/offer-preview";
import {
  EMPTY_MESSAGE_DEFAULTS,
  offerDefaultsSchema,
  parseMessageDefaults,
  type OfferDefaults,
} from "@/lib/campaigns/message-defaults";
import { useI18n } from "@/lib/i18n/provider";
import {
  KEY_EXPIRY_WARNING_DAYS,
  SIGNUP_KEY_LIFETIME,
} from "@/lib/integrations/key-lifetime";
import {
  clampDelaySeconds,
  clampReminderHours,
  editorStateFromOffer,
  fieldErrorsFromDetails,
  firstErrorField,
  firstMissingField,
  followTagTemplates,
  imageFileProblem,
  imageUploadProblem,
  newOfferEditorState,
  offerDefaultsUpdate,
  offerFieldErrors,
  offerFieldOfPath,
  offerPayload,
  sentMessages,
  TAG_FIELD,
  TAG_KEYS,
  type ImageUploadProblem,
  type OfferEditorState,
  type OfferField,
  type OfferRecord,
  type TagKey,
  type TagTemplates,
  type TimedMessage,
} from "@/lib/offers/editor";
import {
  OFFER_DELAY_MAX_SECONDS,
  OFFER_IMAGE_TYPES,
  OFFER_MESSAGE_MAX,
  OFFER_MESSAGES_MAX,
  OFFER_NAME_MAX,
  OFFER_TAG_MAX,
  OFFER_URL_MAX,
  REMINDER_DELAY_MAX_HOURS,
  offerInputSchema,
} from "@/lib/offers/schema";
import { OFFER_LATE_START_HOURS } from "@/lib/offers/schedule";
import { SIGNUP_CALLBACK_PATH } from "@/lib/offers/signup-link";
import { BUTTON_TEXT_MAX, CARD_TEXT_MAX } from "@/lib/validation/text";

const MESSAGE_DEFAULTS_URL = "/api/workspace/message-defaults";
const OFFERS_URL = "/api/offers";
const OFFER_IMAGE_URL = "/api/offers/image";

// What GET /api/offers says about this installation besides the offers.
interface OfferSettings {
  // Whether card images can be uploaded here. Without an answer the editor
  // shows the image-URL field, which always works.
  imageUploadEnabled: boolean;
  // Where a landing page reports sign-ups, under the app's public address.
  signupUrl: string;
}

function offerSettings(payload: unknown): OfferSettings {
  const data = payload as {
    success?: unknown;
    imageUploadEnabled?: unknown;
    signupUrl?: unknown;
  } | null;
  return {
    imageUploadEnabled:
      data?.success === true && data.imageUploadEnabled === true,
    signupUrl: typeof data?.signupUrl === "string" ? data.signupUrl : "",
  };
}

function fetchOfferSettings(): Promise<OfferSettings> {
  return fetch(OFFERS_URL, { cache: "no-store" })
    .then((r) => r.json())
    .then(offerSettings)
    .catch(() => offerSettings(null));
}

// The workspace's default texts for offers, or null without them.
function fetchOfferDefaults(): Promise<{
  defaults: OfferDefaults | null;
  canManage: boolean;
}> {
  return fetch(MESSAGE_DEFAULTS_URL, { cache: "no-store" })
    .then((r) => r.json())
    .then((payload) => (payload.success ? payload.data : null))
    // Without them the form opens empty.
    .catch(() => null)
    .then((data) => ({
      defaults: parseMessageDefaults(data?.defaults)?.offer ?? null,
      canManage: data?.canManage === true,
    }));
}

// A new message waits this long after the one before.
const NEW_MESSAGE_DELAY_SECONDS = 3;

type MessageListKey = "offerMessages" | "confirmationMessages";

const INPUT_CLASS =
  "w-full rounded-lg border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";

function inputClass(invalid: boolean, extra = "") {
  return `${INPUT_CLASS} ${invalid ? "border-error/60" : "border-border"} ${extra}`;
}

// The first form field the defaults route refused, with the route's message.
// The route names fields by their whole path ("offer.offerMessages.1").
function firstDefaultsError(
  details: unknown
): { field: OfferField; message: string } | null {
  const fieldErrors = (details as { fieldErrors?: Record<string, string[]> })
    ?.fieldErrors;
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    const field = offerFieldOfPath(path.split("."));
    if (field && typeof messages?.[0] === "string") {
      return { field, message: messages[0] };
    }
  }
  return null;
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

  // Card images are uploaded where a Blob store is connected; elsewhere the
  // image is a link.
  const [imageUpload, setImageUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Sign-up feedback: where the landing page reports, and the workspace's
  // default confirmation, which fills an empty text when the switch goes on.
  const [signupUrl, setSignupUrl] = useState("");
  const [signupUrlCopied, setSignupUrlCopied] = useState(false);
  const [defaultSignupMessage, setDefaultSignupMessage] = useState("");

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
  // edit with the stored offer. Either way the offers API says whether card
  // images can be uploaded and where a landing page reports sign-ups.
  useEffect(() => {
    let active = true;
    if (mode === "new") {
      Promise.all([fetchOfferDefaults(), fetchOfferSettings()]).then(
        ([{ defaults, canManage }, settings]) => {
          if (!active) return;
          setForm(newOfferEditorState(defaults));
          setTemplates((defaults ?? EMPTY_MESSAGE_DEFAULTS.offer).tagTemplates);
          setDefaultSignupMessage(defaults?.signupMessage ?? "");
          setCanManageDefaults(canManage);
          setImageUpload(settings.imageUploadEnabled);
          setSignupUrl(settings.signupUrl);
          setLoading(false);
        }
      );
    } else {
      // The defaults only for the sign-up confirmation an empty text gets
      // when the switch goes on; the offer opens without them.
      void fetchOfferDefaults().then(({ defaults }) => {
        if (active) setDefaultSignupMessage(defaults?.signupMessage ?? "");
      });
      fetch(OFFERS_URL, { cache: "no-store" })
        .then((r) => r.json())
        .then((payload) => {
          if (!active) return;
          const offer = payload.success
            ? (payload.data as OfferRecord[]).find((o) => o.id === offerId)
            : undefined;
          if (!offer) return setNotFound(true);
          setForm(editorStateFromOffer(offer));
          setIsActive(offer.isActive);
          const settings = offerSettings(payload);
          setImageUpload(settings.imageUploadEnabled);
          setSignupUrl(settings.signupUrl);
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
  // An uploaded image, or the stored one, shows at once; a typed link once
  // typing stops.
  const previewImageUrl = imageUpload ? imageCandidate : shownImageUrl;
  const imageFailed =
    previewImageUrl !== "" && failedImageUrl === previewImageUrl;
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

  // Opens the tags and puts the cursor into one of them.
  function editTag(key: TagKey) {
    setTagsOpen(true);
    window.requestAnimationFrame(() => {
      const input = document.getElementById(fieldId(`tag-${key}`));
      input?.scrollIntoView({ behavior: "smooth", block: "center" });
      input?.focus({ preventScroll: true });
    });
  }

  // Switched on with no text yet, the confirmation starts from the
  // workspace's default, to keep, change or clear.
  function toggleSignupTracking() {
    setForm((current) => {
      const on = !current.signupTrackingEnabled;
      return {
        ...current,
        signupTrackingEnabled: on,
        signupMessage:
          on && !current.signupMessage.trim()
            ? defaultSignupMessage
            : current.signupMessage,
      };
    });
    clearErrors("signupTrackingEnabled", "signupMessage");
  }

  async function copySignupUrl() {
    try {
      await navigator.clipboard.writeText(signupUrl);
      setSignupUrlCopied(true);
      window.setTimeout(() => setSignupUrlCopied(false), 2000);
    } catch {
      // No clipboard (no https, no permission): the address is selected for
      // copying by hand.
      const address = document.getElementById(fieldId("signupUrl"));
      if (address) window.getSelection()?.selectAllChildren(address);
    }
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
        return imageUpload ? t("Image") : t("Image URL");
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
      case "signupTrackingEnabled":
      case "signupMessage":
        return t("Report the sign-up back");
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
        return t("Fill in all five tags.");
    }
  }

  // Field errors from the editor's own check, already in the interface
  // language (offerFieldErrors), or from the API, which the editor's check
  // leaves little to find. The two link fields get their own message.
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
    // The API's own rules first (limits, links, one pause per message),
    // worded in the interface language.
    const checked = offerInputSchema.safeParse(payload);
    if (!checked.success) {
      return showErrors(offerFieldErrors(checked.error.issues, t));
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
    const update = offerDefaultsUpdate(form);
    // The route's own rules first, worded in the interface language. It
    // checks these texts with the saved tag templates, which the editor
    // holds as well.
    const checked = offerDefaultsSchema.safeParse({
      ...update.offer,
      tagTemplates: templates,
    });
    if (!checked.success) {
      const fieldErrors = offerFieldErrors(checked.error.issues, t);
      const first = firstErrorField(fieldErrors);
      setDefaultsStatus({
        tone: "error",
        text: first
          ? `${fieldLabel(first)}: ${fieldErrors[first]}`
          : t("Could not save the default texts."),
      });
      return;
    }
    setDefaultsBusy(true);
    try {
      const res = await fetch(MESSAGE_DEFAULTS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
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
        const refused = firstDefaultsError(data.details);
        setDefaultsStatus({
          tone: "error",
          text: refused
            ? `${fieldLabel(refused.field)}: ${refused.message}`
            : data.error ?? t("Could not save the default texts."),
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

  function uploadProblemText(problem: ImageUploadProblem): string {
    switch (problem) {
      case "type":
        return t("Use a JPG, PNG or WebP image.");
      case "size":
        return t("This image is too large to upload. Use a smaller file; 1080 × 1080 is enough.");
      case "forbidden":
        return t("Only owners and admins can change offers.");
      case "notSetUp":
        return t("Image upload is not set up here. Paste a link to the image instead.");
      default:
        return t("The image could not be uploaded. Try again.");
    }
  }

  // Sends the picked file at once and puts the URL into the form. The old
  // image stays until the offer is saved with the new one, and is deleted
  // then.
  async function uploadImage(file: File) {
    setUploadError(null);
    const problem = imageFileProblem(file);
    if (problem) {
      setUploadError(uploadProblemText(problem));
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(OFFER_IMAGE_URL, { method: "POST", body });
      // The platform's own refusals (a 413 on Vercel) carry no JSON.
      const data = await res.json().catch(() => null);
      const url: unknown = data?.success ? data.data?.url : null;
      if (typeof url === "string" && url) {
        update("cardImageUrl", url, "cardImageUrl");
        return;
      }
      const failure = imageUploadProblem(res.status);
      // No Blob store after all: the link field still works.
      if (failure === "notSetUp") setImageUpload(false);
      setUploadError(uploadProblemText(failure));
    } catch {
      setUploadError(uploadProblemText("failed"));
    } finally {
      setUploading(false);
    }
  }

  function removeImage() {
    update("cardImageUrl", "", "cardImageUrl");
    setUploadError(null);
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
    signedUp: t("Signed up"),
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
        {/* Not while an image uploads: the save would keep the old one. */}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || uploading}
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
            {imageUpload ? (
              <div
                role="group"
                aria-labelledby={fieldId("cardImage")}
                aria-busy={uploading || undefined}
                className="space-y-2"
              >
                <p id={fieldId("cardImage")} className="text-xs text-muted">
                  {t("Image")}{" "}
                  <span className="font-normal">{t("(optional)")}</span>
                </p>
                {/* Opened by the buttons below; kept rendered (not display:
                    none) so every browser lets them open it. */}
                <input
                  ref={fileInput}
                  type="file"
                  accept={OFFER_IMAGE_TYPES.join(",")}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Picking the same file again must fire again.
                    e.target.value = "";
                    if (file) void uploadImage(file);
                  }}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="sr-only"
                />
                {previewImageUrl ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <img
                      key={previewImageUrl}
                      src={previewImageUrl}
                      alt={t("Card image")}
                      referrerPolicy="no-referrer"
                      onError={() => setFailedImageUrl(previewImageUrl)}
                      onLoad={() =>
                        setFailedImageUrl((current) =>
                          current === previewImageUrl ? null : current
                        )
                      }
                      className={`h-20 w-20 shrink-0 rounded-lg border border-border object-cover ${
                        imageFailed ? "hidden" : ""
                      }`}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => fileInput.current?.click()}
                        disabled={uploading}
                        aria-describedby={fieldId("cardImage-hint")}
                        className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
                      >
                        {uploading ? t("Uploading…") : t("Replace")}
                      </button>
                      <button
                        type="button"
                        onClick={removeImage}
                        disabled={uploading}
                        className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:text-error disabled:opacity-50"
                      >
                        {t("Remove")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading}
                    aria-describedby={fieldId("cardImage-hint")}
                    className="w-full rounded-lg border border-dashed border-border-hover px-3 py-6 text-sm font-medium text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                  >
                    {uploading ? t("Uploading…") : t("Choose image")}
                  </button>
                )}
                <FieldError message={errors.cardImageUrl} />
                {imageFailed && (
                  <p className="text-xs text-warning">
                    {t("This image does not load. Replace it with a JPG, PNG or WebP file.")}
                  </p>
                )}
                {uploadError && (
                  <p role="alert" className="text-xs text-error">
                    {uploadError}
                  </p>
                )}
                <p id={fieldId("cardImage-hint")} className="text-xs text-muted">
                  {t("JPG, PNG or WebP, up to 5 MB. Square images (1080 × 1080) work best.")}
                </p>
              </div>
            ) : (
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
                {/* Left by an upload that found no Blob store after all. */}
                {uploadError && (
                  <p role="alert" className="text-xs text-error">
                    {uploadError}
                  </p>
                )}
                {!errors.cardImageUrl && imageNotHttps && (
                  <p className="text-xs text-warning">
                    {t("The image needs a direct https link.")}
                  </p>
                )}
                {previewImageUrl && (
                  <div className="flex items-center gap-3 pt-1">
                    <img
                      key={previewImageUrl}
                      src={previewImageUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      onError={() => setFailedImageUrl(previewImageUrl)}
                      onLoad={() =>
                        setFailedImageUrl((current) =>
                          current === previewImageUrl ? null : current
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
            )}
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
                  {/* A campaign can start the offer 22 hours after its link
                      (campaign editor, After the link). No reminder
                      follows such an offer: whoever leaves it untapped
                      gets nothing more. */}
                  <p className="text-xs text-muted">
                    {t(
                      "Only for campaigns that start the offer right after the link. Campaigns that start it {hours} hours later send no reminder.",
                      { hours: OFFER_LATE_START_HOURS }
                    )}
                  </p>
                </div>
              )}
            </div>
          </Section>

          {/* Sign-up feedback: the links carry the person's code (ig=…) to
              the landing page, which reports the sign-up back. Off, the
              links go out as typed. */}
          <Section title={t("Report the sign-up back")}>
            <p className="text-xs text-muted">
              {t("For a landing page with a sign-up form, for example for your newsletter. The link on the card and in the reminder then gets a personal code (ig=…). Your landing page sends it back as soon as the person has signed up. They then get the tag and, if Instagram still allows it, your message in the chat.")}
            </p>
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-foreground">
                  {t("Report sign-ups from the landing page")}
                </span>
                <Toggle
                  on={form.signupTrackingEnabled}
                  onToggle={toggleSignupTracking}
                  label={t("Report sign-ups from the landing page")}
                />
              </div>
              {form.signupTrackingEnabled && (
                <div className="mt-3 space-y-4">
                  {/* Where the landing page reports, and with which key. The
                      whole address shows, wrapped where needed: a one-line
                      field cut it off, so it could be neither checked nor
                      passed on to whoever builds the landing page. A click
                      selects all of it; on a phone, Copy goes below it. */}
                  <div className="space-y-1">
                    <div
                      role="group"
                      aria-labelledby={fieldId("signupUrl-label")}
                      className="space-y-1"
                    >
                      <p id={fieldId("signupUrl-label")} className="text-xs text-muted">
                        {t("Your landing page reports the sign-up to this address")}
                      </p>
                      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
                        <code
                          id={fieldId("signupUrl")}
                          className="block min-h-9.5 min-w-0 select-all break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs leading-5 text-foreground sm:flex-1"
                        >
                          {signupUrl}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copySignupUrl()}
                          disabled={!signupUrl}
                          className="shrink-0 self-start rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
                        >
                          {signupUrlCopied ? t("Copied!") : t("Copy")}
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-muted">
                      {t("Your landing page also needs a key with the access “{access}”.", {
                        access: t("Report sign-ups"),
                      })}{" "}
                      {/* A new tab: the offer here is not saved yet. */}
                      <Link
                        href="/integrations"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-accent hover:underline"
                      >
                        {t("Create the key under API & MCP")}
                      </Link>
                    </p>
                    <p className="text-xs text-muted">
                      {t(
                        "A key for your landing page lasts up to {days} days. From {warnDays} days before it expires, API & MCP and Diagnostics show a notice when you open them (there is no e-mail): then create a new key and replace it on your landing page.",
                        {
                          days: SIGNUP_KEY_LIFETIME.maxDays,
                          warnDays: KEY_EXPIRY_WARNING_DAYS,
                        }
                      )}
                    </p>
                  </div>

                  <details className="rounded-lg border border-border px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-foreground">
                      {t("Details for whoever builds your landing page")}
                    </summary>
                    <div className="mt-2 space-y-2 text-xs text-muted">
                      <p>
                        {t("Copy the value of ig from the address of the landing page into a hidden form field and store it with the sign-up. Once the sign-up is confirmed (with double opt-in: after the click in the confirmation email), your server sends it:")}
                      </p>
                      {/* The request itself: code, not translated. */}
                      <pre className="overflow-x-auto whitespace-pre rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                        {`POST ${signupUrl || SIGNUP_CALLBACK_PATH}\nAuthorization: Bearer <key>\nContent-Type: application/json\n\n{"token": "<ig>"}`}
                      </pre>
                      <p>
                        {t("Wait at most 3 seconds for the answer and ignore errors, so the page never breaks. The key stays on the server, never in the page itself.")}
                      </p>
                    </div>
                  </details>

                  {/* The confirmation in the chat */}
                  <div className="space-y-1">
                    <label
                      htmlFor={fieldId("signupMessage")}
                      className="block text-xs text-muted"
                    >
                      {t("Message in the chat after the sign-up")}{" "}
                      <span className="font-normal">{t("(optional)")}</span>
                    </label>
                    <textarea
                      id={fieldId("signupMessage")}
                      value={form.signupMessage}
                      onChange={(e) =>
                        update("signupMessage", e.target.value, "signupMessage")
                      }
                      placeholder={t("Write a message")}
                      rows={3}
                      maxLength={OFFER_MESSAGE_MAX}
                      aria-invalid={Boolean(errors.signupMessage) || undefined}
                      className={inputClass(Boolean(errors.signupMessage), "resize-none")}
                    />
                    <FieldError message={errors.signupMessage} />
                    <p className="text-xs text-muted">
                      {t("Leave it empty to only tag the person.")}{" "}
                      {"{username}"} {t("personalizes.")}
                    </p>
                    <p className="text-xs text-muted">
                      {t("Instagram allows the message only up to 24 hours after the person's last tap or DM. Whoever signs up later only gets the tag.")}
                    </p>
                  </div>

                  {/* The tag; it is edited with the other tags. */}
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
                    {/* Tag names are the user's own words: never translated. */}
                    <span className="min-w-0 break-words">
                      {t("Tag for everyone who signed up: {tag}", {
                        tag: form.tags.signedUp.trim() || "—",
                      })}
                    </span>
                    <button
                      type="button"
                      onClick={() => editTag("signedUp")}
                      className="font-medium text-accent hover:underline"
                    >
                      {t("Change the tag")}
                    </button>
                  </div>
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
                  {t("Saves the offer messages with their pauses, the button, the confirmations, the card's button, the reminder and the message after the sign-up. Name, card, link and tags are set per offer.")}
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
              cardImageUrl={
                previewImageUrl && !imageFailed ? previewImageUrl : null
              }
              cardTitle={form.cardTitle}
              cardSubtitle={form.cardSubtitle}
              cardButtonLabel={form.cardButtonLabel}
              reminderEnabled={form.reminderEnabled}
              reminderDelayHours={form.reminderDelayHours}
              reminderMessage={form.reminderMessage}
              signupTrackingEnabled={form.signupTrackingEnabled}
              signupMessage={form.signupMessage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
