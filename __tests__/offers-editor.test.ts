import { describe, expect, it } from "vitest";
import {
  builtInMessageDefaults,
  EMPTY_MESSAGE_DEFAULTS,
  mergeMessageDefaults,
  messageDefaultsSchema,
  messageDefaultsUpdateSchema,
  type OfferDefaults,
} from "../lib/campaigns/message-defaults";
import {
  clampDelaySeconds,
  clampReminderHours,
  cleanCustomOrder,
  editorStateFromOffer,
  fieldErrorsFromDetails,
  firstErrorField,
  firstMissingField,
  followTagTemplates,
  imageFileProblem,
  imageUploadProblem,
  moveItem,
  newOfferEditorState,
  offerDefaultsUpdate,
  offerPayload,
  percentOfOffered,
  sentMessages,
  tagNamesFromTemplates,
  type OfferEditorState,
  type OfferRecord,
} from "../lib/offers/editor";
import {
  OFFER_IMAGE_MAX_BYTES,
  offerFieldsSchema,
  offerInputSchema,
  offerPatchSchema,
} from "../lib/offers/schema";

const GERMAN = builtInMessageDefaults("de")!.offer;
const DRIVE_URL =
  "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing";

// What someone types into a new offer that starts from the German defaults.
function typedGermanOffer(): OfferEditorState {
  const state = newOfferEditorState(GERMAN);
  return {
    ...state,
    name: "Prompting Guide",
    tags: tagNamesFromTemplates(GERMAN.tagTemplates, "Prompting Guide"),
    cardImageUrl: "https://cdn.example.com/guide-cover.jpg",
    cardTitle: "ChatGPT Prompting Guide",
    cardSubtitle: "In 7 Schritten zu besseren Antworten",
    destinationUrl: DRIVE_URL,
  };
}

function storedOffer(overrides: Partial<OfferRecord> = {}): OfferRecord {
  return {
    id: "offer_1",
    name: "Prompting Guide",
    isActive: false,
    position: 2,
    archivedAt: null,
    offerMessages: ["Ich hab übrigens noch einen Guide.", "Soll ich ihn dir schicken?"],
    offerDelaysSeconds: [5, 2],
    offerButtonLabel: "Ja, gerne! 🙌",
    confirmationMessages: ["Alles klar!"],
    confirmationDelaysSeconds: [3],
    cardImageUrl: null,
    cardTitle: "ChatGPT Prompting Guide",
    cardSubtitle: null,
    cardButtonLabel: "Jetzt holen",
    destinationUrl: DRIVE_URL,
    reminderEnabled: false,
    reminderDelayHours: 12,
    reminderMessage: "Nur kurz zur Info 👇",
    tagOffered: "Guide angeboten",
    tagInterested: "Guide Interesse",
    tagSent: "[LM] Guide gesendet",
    tagClicked: "Guide geklickt",
    trackedUrl: "https://app.example.com/o/slug_1",
    funnel: { offered: 10, interested: 4, sent: 6, clicked: 2, stopped: 1 },
    ...overrides,
  };
}

describe("offerPayload", () => {
  it("builds a body offerInputSchema accepts from the German defaults", () => {
    const payload = offerPayload(typedGermanOffer());

    const parsed = offerInputSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(payload).toEqual({
      name: "Prompting Guide",
      offerMessages: GERMAN.offerMessages,
      offerDelaysSeconds: [5, 3, 2],
      offerButtonLabel: "Ja, gerne! 🙌",
      confirmationMessages: ["Alles klar!", "Hier geht's zum Guide 👇"],
      confirmationDelaysSeconds: [3, 3],
      cardImageUrl: "https://cdn.example.com/guide-cover.jpg",
      cardTitle: "ChatGPT Prompting Guide",
      cardSubtitle: "In 7 Schritten zu besseren Antworten",
      cardButtonLabel: "Jetzt holen",
      destinationUrl: DRIVE_URL,
      reminderEnabled: true,
      reminderDelayHours: 23,
      reminderMessage: GERMAN.reminderMessage,
      tagOffered: "Prompting Guide angeboten",
      tagInterested: "Prompting Guide Interesse",
      tagSent: "[LM] Prompting Guide gesendet",
      tagClicked: "Prompting Guide geklickt",
    });
  });

  it("sends every field of the offer and never isActive", () => {
    const keys = Object.keys(offerPayload(typedGermanOffer())).sort();
    const schemaKeys = Object.keys(offerFieldsSchema.shape)
      .filter((key) => key !== "isActive")
      .sort();

    expect(keys).toEqual(schemaKeys);
    // PATCH: a whole offer, not the Offers page's pause switch, and the
    // offer stays paused or active as it is.
    const patch = offerPatchSchema.safeParse(offerPayload(typedGermanOffer()));
    expect(patch.success).toBe(true);
    expect(patch.data).not.toHaveProperty("isActive");
    expect(patch.data).toHaveProperty("offerMessages");
  });

  it("drops blank rows with their pauses, trims and keeps pauses in range", () => {
    const state: OfferEditorState = {
      ...typedGermanOffer(),
      offerMessages: [
        { text: "  Erste Nachricht  ", delaySeconds: 90 },
        { text: "   ", delaySeconds: 7 },
        { text: "Letzte Nachricht", delaySeconds: -4 },
      ],
      confirmationMessages: [{ text: "", delaySeconds: 3 }],
      cardImageUrl: "   ",
      cardSubtitle: "  ",
    };

    const payload = offerPayload(state);

    expect(payload.offerMessages).toEqual(["Erste Nachricht", "Letzte Nachricht"]);
    expect(payload.offerDelaysSeconds).toEqual([60, 0]);
    expect(payload.confirmationMessages).toEqual([]);
    expect(payload.confirmationDelaysSeconds).toEqual([]);
    expect(payload.cardImageUrl).toBeNull();
    expect(payload.cardSubtitle).toBeNull();
    expect(offerInputSchema.safeParse(payload).success).toBe(true);
  });

  it("keeps the reminder's text while the reminder is off", () => {
    const payload = offerPayload({
      ...typedGermanOffer(),
      reminderEnabled: false,
      reminderDelayHours: 40,
    });

    expect(payload.reminderEnabled).toBe(false);
    expect(payload.reminderMessage).toBe(GERMAN.reminderMessage);
    expect(payload.reminderDelayHours).toBe(23);
    expect(offerInputSchema.safeParse(payload).success).toBe(true);
  });

  it("round-trips a stored offer through the form", () => {
    const offer = storedOffer();
    const payload = offerPayload(editorStateFromOffer(offer));

    expect(payload).toEqual({
      name: offer.name,
      offerMessages: offer.offerMessages,
      offerDelaysSeconds: offer.offerDelaysSeconds,
      offerButtonLabel: offer.offerButtonLabel,
      confirmationMessages: offer.confirmationMessages,
      confirmationDelaysSeconds: offer.confirmationDelaysSeconds,
      cardImageUrl: null,
      cardTitle: offer.cardTitle,
      cardSubtitle: null,
      cardButtonLabel: offer.cardButtonLabel,
      destinationUrl: offer.destinationUrl,
      reminderEnabled: false,
      reminderDelayHours: 12,
      reminderMessage: offer.reminderMessage,
      tagOffered: offer.tagOffered,
      tagInterested: offer.tagInterested,
      tagSent: offer.tagSent,
      tagClicked: offer.tagClicked,
    });
    expect(offerInputSchema.safeParse(payload).success).toBe(true);
  });

  it("is accepted for a workspace without default texts once the form is filled", () => {
    const state = newOfferEditorState(null);
    expect(state.offerMessages).toEqual([{ text: "", delaySeconds: 0 }]);
    expect(state.reminderEnabled).toBe(false);

    const filled: OfferEditorState = {
      ...state,
      name: "Checklist",
      offerMessages: [{ text: "Want my checklist?", delaySeconds: 2 }],
      offerButtonLabel: "Yes please",
      cardTitle: "The checklist",
      cardButtonLabel: "Get it",
      destinationUrl: "https://example.com/checklist",
      tags: tagNamesFromTemplates(EMPTY_MESSAGE_DEFAULTS.offer.tagTemplates, "Checklist"),
    };
    expect(firstMissingField(filled)).toBeNull();
    expect(offerInputSchema.safeParse(offerPayload(filled)).success).toBe(true);
  });
});

describe("tag names", () => {
  it("come from the workspace's tag templates", () => {
    expect(tagNamesFromTemplates(GERMAN.tagTemplates, "Prompting Guide")).toEqual({
      offered: "Prompting Guide angeboten",
      interested: "Prompting Guide Interesse",
      sent: "[LM] Prompting Guide gesendet",
      clicked: "Prompting Guide geklickt",
    });
    expect(
      tagNamesFromTemplates(EMPTY_MESSAGE_DEFAULTS.offer.tagTemplates, " Guide ")
    ).toEqual({
      offered: "Guide offered",
      interested: "Guide interested",
      sent: "Guide sent",
      clicked: "Guide clicked",
    });
  });

  it("start from the templates in a new offer and follow its name until typed over", () => {
    const templates: OfferDefaults["tagTemplates"] = GERMAN.tagTemplates;
    const state = newOfferEditorState(GERMAN);
    expect(state.tags).toEqual({
      offered: "angeboten",
      interested: "Interesse",
      sent: "[LM] gesendet",
      clicked: "geklickt",
    });

    const typedOver = { ...state.tags, sent: "Guide raus" };
    const renamed = followTagTemplates(
      typedOver,
      ["offered", "interested", "clicked"],
      templates,
      "Guide"
    );
    expect(renamed).toEqual({
      offered: "Guide angeboten",
      interested: "Guide Interesse",
      sent: "Guide raus",
      clicked: "Guide geklickt",
    });
    // A stored offer's tags follow nothing.
    expect(followTagTemplates(typedOver, [], templates, "Other")).toEqual(typedOver);
  });
});

describe("percentOfOffered", () => {
  it("counts every stage against everyone offered, in whole percent", () => {
    expect(percentOfOffered(1, 3)).toBe(33);
    expect(percentOfOffered(2, 3)).toBe(67);
    expect(percentOfOffered(3, 3)).toBe(100);
    // Sent can exceed interested: the reminder counts as sent.
    expect(percentOfOffered(6, 10)).toBe(60);
  });

  it("is 0 while nobody was offered or nobody reached the stage", () => {
    expect(percentOfOffered(0, 0)).toBe(0);
    expect(percentOfOffered(0, 12)).toBe(0);
    expect(percentOfOffered(5, 0)).toBe(0);
  });
});

describe("moveItem", () => {
  const order = ["a", "b", "c"];

  it("moves an entry up and down by one place", () => {
    expect(moveItem(order, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(order, 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(order, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(order, 2, -1)).toEqual(["a", "c", "b"]);
  });

  it("changes nothing past either end and never mutates the list", () => {
    expect(moveItem(order, 0, -1)).toEqual(order);
    expect(moveItem(order, 2, 1)).toEqual(order);
    expect(moveItem(order, 5, -1)).toEqual(order);
    expect(moveItem(order, -1, 1)).toEqual(order);
    const moved = moveItem(order, 0, 1);
    expect(moved).not.toBe(order);
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("cleanCustomOrder", () => {
  const offers = [
    { id: "o1", archivedAt: null },
    { id: "o2", archivedAt: "2026-11-20T10:00:00.000Z" },
    { id: "o3" },
  ];

  it("drops unknown and archived ids and keeps the rest in their order", () => {
    expect(cleanCustomOrder(["o3", "gone", "o2", "o1"], offers)).toEqual(["o3", "o1"]);
  });

  it("counts each id once and keeps paused offers", () => {
    const paused = [{ id: "o1", isActive: false }, { id: "o3", isActive: true }];
    expect(cleanCustomOrder(["o1", "o3", "o1"], paused)).toEqual(["o1", "o3"]);
  });

  it("empties an order whose offers are all gone", () => {
    expect(cleanCustomOrder(["gone", "o2"], offers)).toEqual([]);
    expect(cleanCustomOrder([], offers)).toEqual([]);
  });
});

describe("form checks", () => {
  it("names the first required field left empty", () => {
    const complete = typedGermanOffer();
    expect(firstMissingField(complete)).toBeNull();
    expect(firstMissingField({ ...complete, name: "  " })).toBe("name");
    expect(
      firstMissingField({
        ...complete,
        offerMessages: [{ text: " ", delaySeconds: 0 }],
      })
    ).toBe("offerMessages");
    expect(firstMissingField({ ...complete, offerButtonLabel: "" })).toBe("offerButtonLabel");
    expect(firstMissingField({ ...complete, cardTitle: "" })).toBe("cardTitle");
    expect(firstMissingField({ ...complete, cardButtonLabel: " " })).toBe("cardButtonLabel");
    expect(firstMissingField({ ...complete, destinationUrl: "" })).toBe("destinationUrl");
    expect(firstMissingField({ ...complete, reminderMessage: "" })).toBe("reminderMessage");
    expect(
      firstMissingField({ ...complete, reminderEnabled: false, reminderMessage: "" })
    ).toBeNull();
    expect(
      firstMissingField({ ...complete, tags: { ...complete.tags, clicked: " " } })
    ).toBe("tagClicked");
  });

  it("reads the API's field errors and finds the first one in form order", () => {
    const errors = fieldErrorsFromDetails({
      formErrors: [],
      fieldErrors: {
        tagSent: ["Too small"],
        offerButtonLabel: ["At most 20 characters (emoji count as 2)"],
        unknownField: ["ignored"],
      },
    });

    expect(errors).toEqual({
      offerButtonLabel: "At most 20 characters (emoji count as 2)",
      tagSent: "Too small",
    });
    expect(firstErrorField(errors)).toBe("offerButtonLabel");
    expect(fieldErrorsFromDetails(undefined)).toEqual({});
    expect(fieldErrorsFromDetails({ fieldErrors: "nope" })).toEqual({});
    expect(firstErrorField({})).toBeNull();
  });

  it("matches what the schema reports for a label of 21 UTF-16 units", () => {
    const payload = offerPayload({
      ...typedGermanOffer(),
      offerButtonLabel: "Ja, gerne! 🙌🙌🙌🙌🙌",
    });
    const parsed = offerInputSchema.safeParse(payload);

    expect(parsed.success).toBe(false);
    const errors = fieldErrorsFromDetails(parsed.error!.flatten());
    expect(firstErrorField(errors)).toBe("offerButtonLabel");
  });

  it("keeps pauses and reminder hours where the API takes them", () => {
    expect(clampDelaySeconds(Number(""))).toBe(0);
    expect(clampDelaySeconds(2.7)).toBe(2);
    expect(clampDelaySeconds(61)).toBe(60);
    expect(clampDelaySeconds(Number.NaN)).toBe(0);
    expect(clampReminderHours(0)).toBe(1);
    expect(clampReminderHours(24)).toBe(23);
    expect(clampReminderHours(Number.NaN)).toBe(23);
    expect(sentMessages([{ text: " a ", delaySeconds: 99 }])).toEqual([
      { text: "a", delaySeconds: 60 },
    ]);
  });
});

describe("offerDefaultsUpdate", () => {
  it("saves the shared texts only, as the defaults route accepts them", () => {
    const update = offerDefaultsUpdate({
      ...typedGermanOffer(),
      offerMessages: [
        { text: "Neu: mein Guide", delaySeconds: 4 },
        { text: " ", delaySeconds: 9 },
      ],
      reminderDelayHours: 6,
    });

    expect(messageDefaultsUpdateSchema.safeParse(update).success).toBe(true);
    expect(Object.keys(update.offer ?? {}).sort()).toEqual([
      "cardButtonLabel",
      "confirmationDelaysSeconds",
      "confirmationMessages",
      "offerButtonLabel",
      "offerDelaysSeconds",
      "offerMessages",
      "reminderDelayHours",
      "reminderEnabled",
      "reminderMessage",
    ]);
    expect(update.offer?.offerMessages).toEqual(["Neu: mein Guide"]);
    expect(update.offer?.offerDelaysSeconds).toEqual([4]);

    // Merged over the built-in set, as the route saves it: still valid, and
    // the tag templates keep their saved value.
    const merged = messageDefaultsSchema.safeParse(
      mergeMessageDefaults(builtInMessageDefaults("de")!, update)
    );
    expect(merged.success).toBe(true);
    expect(merged.data?.offer.tagTemplates).toEqual(GERMAN.tagTemplates);
    expect(merged.data?.offer.reminderDelayHours).toBe(6);
  });
});

describe("card image upload in the editor", () => {
  it("lets JPEG, PNG and WebP files of up to 5 MB go to the server", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(imageFileProblem({ type, size: 300_000 })).toBeNull();
    }
    expect(imageFileProblem({ type: "image/png", size: OFFER_IMAGE_MAX_BYTES })).toBeNull();
    // A type the browser cannot name: the server reads the content.
    expect(imageFileProblem({ type: "", size: 300_000 })).toBeNull();
  });

  it("stops other types, empty files and files over 5 MB before they are sent", () => {
    for (const type of ["image/gif", "image/svg+xml", "image/heic", "text/html", "application/pdf"]) {
      expect(imageFileProblem({ type, size: 300_000 })).toBe("type");
    }
    expect(imageFileProblem({ type: "image/jpeg", size: 0 })).toBe("type");
    expect(imageFileProblem({ type: "image/jpeg", size: OFFER_IMAGE_MAX_BYTES + 1 })).toBe("size");
  });

  it("reads what went wrong from the upload's status alone", () => {
    // 413 also comes from the platform, without JSON (4.5 MB on Vercel).
    expect(imageUploadProblem(413)).toBe("size");
    expect(imageUploadProblem(415)).toBe("type");
    expect(imageUploadProblem(403)).toBe("forbidden");
    expect(imageUploadProblem(503)).toBe("notSetUp");
    for (const status of [400, 401, 500, 502]) {
      expect(imageUploadProblem(status)).toBe("failed");
    }
  });

  it("saves an uploaded image's URL as the card image, and a removed one as none", () => {
    const uploaded =
      "https://teststore.public.blob.vercel-storage.com/offers/workspace_123/cover-AbC123xYz.jpg";

    expect(offerInputSchema.parse(offerPayload({ ...typedGermanOffer(), cardImageUrl: uploaded })).cardImageUrl).toBe(uploaded);
    expect(offerInputSchema.parse(offerPayload({ ...typedGermanOffer(), cardImageUrl: "" })).cardImageUrl).toBeNull();
  });
});
