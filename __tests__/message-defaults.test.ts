import { describe, expect, it } from "vitest";
import {
  BUILT_IN_MESSAGE_DEFAULTS,
  builtInMessageDefaults,
  EMPTY_MESSAGE_DEFAULTS,
  isMessageDefaultsSection,
  mergeMessageDefaults,
  messageDefaultsSchema,
  messageDefaultsUpdateSchema,
  parseMessageDefaults,
  renderTagTemplate,
  resetMessageDefaultsSection,
  withImportRow,
  type MessageDefaults,
} from "../lib/campaigns/message-defaults";

// 11 units of text plus five emoji of two units each: 21 UTF-16 units but
// only 16 code points, so zod's own .max(20) would let it through.
const LABEL_21_UNITS = "Ja, gerne! 🙌🙌🙌🙌🙌";
const LABEL_20_UNITS = "Ja, gerne!! 🙌🙌🙌🙌";
// A button message's text is cut after 640 units. 641 units are 640 code
// points here.
const TEXT_641_UNITS = `${"a".repeat(639)}🙌`;
const TEXT_640_UNITS = `${"a".repeat(638)}🙌`;

const german = BUILT_IN_MESSAGE_DEFAULTS.de as MessageDefaults;

// Every button title in a set of defaults.
function labels(defaults: MessageDefaults) {
  const { campaign, offer } = defaults;
  return {
    openingDmButtonLabel: campaign.openingDmButtonLabel,
    followPromptButtonLabel: campaign.followPromptButtonLabel,
    followPromptRetryButtonLabel: campaign.followPromptRetryButtonLabel,
    linkButtonLabel: campaign.linkButtonLabel,
    offerButtonLabel: offer.offerButtonLabel,
    cardButtonLabel: offer.cardButtonLabel,
  };
}

// Every text that goes out as the text of a message with buttons.
function buttonTexts(defaults: MessageDefaults) {
  const { campaign, offer } = defaults;
  return {
    openingDmMessage: campaign.openingDmMessage,
    followPromptMessage: campaign.followPromptMessage,
    followPromptRetryMessage: campaign.followPromptRetryMessage,
    dmMessage: campaign.dmMessage,
    lastOfferMessage: offer.offerMessages[offer.offerMessages.length - 1],
    reminderMessage: offer.reminderMessage,
  };
}

// Every string value, however deep.
function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(textsOf);
  return [];
}

function withCampaign(campaign: Partial<MessageDefaults["campaign"]>) {
  return { ...german, campaign: { ...german.campaign, ...campaign } };
}

function withOffer(offer: Partial<MessageDefaults["offer"]>) {
  return { ...german, offer: { ...german.offer, ...offer } };
}

describe("the built-in German defaults", () => {
  it("pass the schema unchanged", () => {
    const parsed = messageDefaultsSchema.safeParse(german);
    expect(parsed.success).toBe(true);
    // Nothing for the schema to trim or fill in: the seed is stored as is.
    expect(parsed.data).toEqual(german);
  });

  it("keep every button label within the 20 UTF-16 units Instagram shows", () => {
    for (const [field, label] of Object.entries(labels(german))) {
      expect(label.length, field).toBeGreaterThan(0);
      expect(label.length, field).toBeLessThanOrEqual(20);
    }
  });

  it("keep every text that carries buttons within 640 UTF-16 units", () => {
    for (const [field, text] of Object.entries(buttonTexts(german))) {
      expect(text.length, field).toBeGreaterThan(0);
      expect(text.length, field).toBeLessThanOrEqual(640);
    }
  });

  it("name no brand, niche or product", () => {
    // Every customer's workspace starts from these (R18). The texts, not the
    // field names: followPromptMessage is a field, not copy.
    const texts = textsOf(german);
    expect(texts.length).toBeGreaterThan(20);
    for (const text of texts) {
      for (const word of ["Altbau", "sustainabim", "Prompt"]) {
        expect(text.toLowerCase(), text).not.toContain(word.toLowerCase());
      }
    }
  });

  it("open a new campaign with everything but keywords, post and link", () => {
    expect(german.campaign).toEqual({
      openingDmEnabled: true,
      openingDmMessage:
        "Hey, ich hab gesehen, dass du mein Reel kommentiert hast 😊 Möchtest du die Unterlage haben? Dann tipp einfach auf den Button.",
      openingDmButtonLabel: "Ja, schick sie mir",
      requireFollow: true,
      followPromptMessage:
        "Bitte folge mir zuerst, dann bekommst du sie :)\n\nMach das kurz und tipp dann auf „Erledigt“.",
      followPromptButtonLabel: "Erledigt 👍",
      followPromptRetryMessage:
        "Ich sehe dein Folgen noch nicht. Manchmal braucht Instagram einen Moment. Folge mir kurz und tipp dann noch einmal auf „Erledigt“.",
      followPromptRetryButtonLabel: "Erledigt 👍",
      dmMessage: "Hier geht's direkt zu deiner Unterlage 👇",
      linkButtonLabel: "Jetzt öffnen",
      publicReplyEnabled: true,
      publicReplyMessages: [
        "Ich hab dir eine Nachricht geschickt 😄",
        "Hab dir den Link per DM geschickt 🤓",
        "Check deine DMs 👍",
        "Erledigt! Schau mal in dein Postfach 😄",
        "Schau mal in dein Instagram-Postfach 🤓",
      ],
      ignoreQuestionComments: true,
      offersEnabled: true,
    });
  });

  it("start a new offer with the template's texts and pauses", () => {
    expect(german.offer).toEqual({
      offerMessages: [
        "Ich hab übrigens noch einen ausführlichen Guide geschrieben.",
        "Er hilft dir, noch mehr aus dem Thema herauszuholen.",
        "Soll ich ihn dir schicken? Er ist für dich kostenlos :)",
      ],
      offerDelaysSeconds: [5, 3, 2],
      offerButtonLabel: "Ja, gerne! 🙌",
      confirmationMessages: ["Alles klar!", "Hier geht's zum Guide 👇"],
      confirmationDelaysSeconds: [3, 3],
      cardButtonLabel: "Jetzt holen",
      reminderEnabled: true,
      reminderDelayHours: 23,
      reminderMessage:
        "Hey, nur kurz zur Info: Der Guide ist nicht ewig kostenlos, aber du kannst ihn dir hier noch holen 👇",
      tagTemplates: {
        offered: "{name} angeboten",
        interested: "{name} Interesse",
        sent: "[LM] {name} gesendet",
        clicked: "{name} geklickt",
      },
    });
  });
});

describe("builtInMessageDefaults", () => {
  it("has a set for German only", () => {
    expect(builtInMessageDefaults("de")).toEqual(german);
    for (const locale of ["en", "zh-TW", "pt-BR", "ru"] as const) {
      expect(builtInMessageDefaults(locale), locale).toBeNull();
    }
  });

  it("hands out a copy, so a caller cannot change the built-in set", () => {
    const copy = builtInMessageDefaults("de") as MessageDefaults;
    copy.campaign.publicReplyMessages.push("changed");
    copy.offer.tagTemplates.sent = "changed";
    expect(german.campaign.publicReplyMessages).toHaveLength(5);
    expect(german.offer.tagTemplates.sent).toBe("[LM] {name} gesendet");
  });
});

describe("EMPTY_MESSAGE_DEFAULTS", () => {
  it("passes the schema: no texts, nothing on but the question-mark filter", () => {
    expect(messageDefaultsSchema.safeParse(EMPTY_MESSAGE_DEFAULTS).success).toBe(true);
    const { campaign, offer } = EMPTY_MESSAGE_DEFAULTS;
    expect(Object.values(labels(EMPTY_MESSAGE_DEFAULTS))).toEqual(["", "", "", "", "", ""]);
    expect([campaign.openingDmEnabled, campaign.requireFollow, campaign.publicReplyEnabled, campaign.offersEnabled, offer.reminderEnabled]).toEqual([false, false, false, false, false]);
    // New campaigns get the filter from the campaign API anyway.
    expect(campaign.ignoreQuestionComments).toBe(true);
    expect(offer.reminderDelayHours).toBe(23);
    expect(offer.tagTemplates).toEqual({
      offered: "{name} offered",
      interested: "{name} interested",
      sent: "{name} sent",
      clicked: "{name} clicked",
    });
  });
});

describe("messageDefaultsSchema", () => {
  it.each([
    ["openingDmButtonLabel"],
    ["followPromptButtonLabel"],
    ["followPromptRetryButtonLabel"],
    ["linkButtonLabel"],
  ] as const)("counts %s in UTF-16 units, as Instagram cuts it", (field) => {
    expect(messageDefaultsSchema.safeParse(withCampaign({ [field]: LABEL_20_UNITS })).success).toBe(true);
    const parsed = messageDefaultsSchema.safeParse(withCampaign({ [field]: LABEL_21_UNITS }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].path).toEqual(["campaign", field]);
  });

  it.each([["offerButtonLabel"], ["cardButtonLabel"]] as const)(
    "counts the offer's %s in UTF-16 units",
    (field) => {
      expect(messageDefaultsSchema.safeParse(withOffer({ [field]: LABEL_20_UNITS })).success).toBe(true);
      expect(messageDefaultsSchema.safeParse(withOffer({ [field]: LABEL_21_UNITS })).success).toBe(false);
    }
  );

  it.each([
    ["openingDmMessage"],
    ["followPromptMessage"],
    ["followPromptRetryMessage"],
    ["dmMessage"],
  ] as const)("holds %s to the 640 units of a button message", (field) => {
    expect(messageDefaultsSchema.safeParse(withCampaign({ [field]: TEXT_640_UNITS })).success).toBe(true);
    expect(messageDefaultsSchema.safeParse(withCampaign({ [field]: TEXT_641_UNITS })).success).toBe(false);
  });

  it("holds the reminder and the last offer message to 640 units, the others to 1000", () => {
    expect(messageDefaultsSchema.safeParse(withOffer({ reminderMessage: TEXT_641_UNITS })).success).toBe(false);
    const last = messageDefaultsSchema.safeParse(
      withOffer({ offerMessages: ["a", "b", TEXT_641_UNITS] })
    );
    expect(last.success).toBe(false);
    expect(last.error?.issues[0].path).toEqual(["offer", "offerMessages", 2]);
    // Sent without buttons: only the 1000 of a campaign's messages.
    expect(
      messageDefaultsSchema.safeParse(withOffer({ offerMessages: [TEXT_641_UNITS, "b", "c"] })).success
    ).toBe(true);
    expect(
      messageDefaultsSchema.safeParse(withOffer({ offerMessages: ["a".repeat(1001), "b", "c"] })).success
    ).toBe(false);
  });

  it("wants one pause per offer and confirmation message", () => {
    const offer = messageDefaultsSchema.safeParse(withOffer({ offerDelaysSeconds: [5, 3] }));
    expect(offer.error?.issues.map((issue) => issue.path)).toEqual([["offer", "offerDelaysSeconds"]]);
    const confirmation = messageDefaultsSchema.safeParse(
      withOffer({ confirmationMessages: ["Alles klar!"] })
    );
    expect(confirmation.error?.issues.map((issue) => issue.path)).toEqual([
      ["offer", "confirmationDelaysSeconds"],
    ]);
  });

  it("keeps lists, pauses and hours to what offers and campaigns take", () => {
    expect(messageDefaultsSchema.safeParse(withCampaign({ publicReplyMessages: Array(11).fill("Hi") })).success).toBe(false);
    expect(messageDefaultsSchema.safeParse(withCampaign({ publicReplyMessages: ["Hi", "  "] })).success).toBe(false);
    expect(messageDefaultsSchema.safeParse(withOffer({ offerDelaysSeconds: [5, 3, 61] })).success).toBe(false);
    expect(messageDefaultsSchema.safeParse(withOffer({ reminderDelayHours: 24 })).success).toBe(false);
    expect(messageDefaultsSchema.safeParse(withOffer({ reminderDelayHours: 0 })).success).toBe(false);
    expect(
      messageDefaultsSchema.safeParse(withOffer({ tagTemplates: { ...german.offer.tagTemplates, sent: " " } })).success
    ).toBe(false);
  });

  it("trims texts", () => {
    const parsed = messageDefaultsSchema.parse(
      withCampaign({ dmMessage: "  Hier  ", publicReplyMessages: [" Check deine DMs 👍 "] })
    );
    expect(parsed.campaign.dmMessage).toBe("Hier");
    expect(parsed.campaign.publicReplyMessages).toEqual(["Check deine DMs 👍"]);
  });
});

describe("parseMessageDefaults", () => {
  it("reads stored defaults and treats anything else as none", () => {
    expect(parseMessageDefaults(german)).toEqual(german);
    expect(parseMessageDefaults(null)).toBeNull();
    expect(parseMessageDefaults({})).toBeNull();
    expect(parseMessageDefaults({ ...german, version: 2 })).toBeNull();
    expect(parseMessageDefaults({ ...german, campaign: { ...german.campaign, linkButtonLabel: LABEL_21_UNITS } })).toBeNull();
  });
});

describe("messageDefaultsUpdateSchema and mergeMessageDefaults", () => {
  it("changes the fields an update names and keeps the rest", () => {
    const update = messageDefaultsUpdateSchema.parse({
      campaign: { openingDmMessage: "Neu", publicReplyMessages: ["Eins"], requireFollow: false },
    });
    const merged = mergeMessageDefaults(german, update);
    expect(merged).toEqual({
      version: 1,
      campaign: { ...german.campaign, openingDmMessage: "Neu", publicReplyMessages: ["Eins"], requireFollow: false },
      offer: german.offer,
    });
    expect(messageDefaultsSchema.safeParse(merged).success).toBe(true);
  });

  it("changes an offer's fields without the campaign's", () => {
    const merged = mergeMessageDefaults(
      german,
      messageDefaultsUpdateSchema.parse({
        offer: { offerMessages: ["Eins", "Zwei"], offerDelaysSeconds: [1, 2] },
      })
    );
    expect(merged.campaign).toEqual(german.campaign);
    expect(merged.offer.offerMessages).toEqual(["Eins", "Zwei"]);
    expect(merged.offer.offerDelaysSeconds).toEqual([1, 2]);
  });

  it("refuses unknown fields instead of dropping them", () => {
    expect(messageDefaultsUpdateSchema.safeParse({ campaign: { openingDmMesage: "typo" } }).success).toBe(false);
    expect(messageDefaultsUpdateSchema.safeParse({ campaigns: {} }).success).toBe(false);
    expect(messageDefaultsUpdateSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(messageDefaultsUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("checks each field it is given", () => {
    const parsed = messageDefaultsUpdateSchema.safeParse({ campaign: { linkButtonLabel: LABEL_21_UNITS } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].path).toEqual(["campaign", "linkButtonLabel"]);
  });

  it("leaves rules across fields to the merged whole", () => {
    // Three messages over two pauses only fail once merged.
    const update = messageDefaultsUpdateSchema.parse({ offer: { offerDelaysSeconds: [1, 2] } });
    expect(messageDefaultsSchema.safeParse(mergeMessageDefaults(german, update)).success).toBe(false);
  });
});

describe("resetMessageDefaultsSection", () => {
  // Saved by an admin: their own texts for campaigns and for offers.
  const ownCampaign = { ...german.campaign, openingDmMessage: "Willst du die Checkliste?" };
  const ownOffer = {
    ...german.offer,
    offerMessages: ["Mein eigenes Angebot"],
    offerDelaysSeconds: [1],
    offerButtonLabel: "Klar!",
  };
  const saved: MessageDefaults = { ...german, campaign: ownCampaign, offer: ownOffer };

  it("puts the campaign section back to the built-in set and keeps the offer's texts", () => {
    const reset = resetMessageDefaultsSection(saved, "campaign", german);
    expect(reset).toEqual({ ...german, campaign: german.campaign, offer: ownOffer });
    expect(messageDefaultsSchema.safeParse(reset).success).toBe(true);
    // A copy: changing it leaves the built-in set alone.
    reset!.campaign.publicReplyMessages.push("Noch eine");
    expect(german.campaign.publicReplyMessages).toHaveLength(5);
  });

  it("puts the offer section back and keeps the campaign's texts", () => {
    expect(resetMessageDefaultsSection(saved, "offer", german)).toEqual({
      ...german,
      campaign: ownCampaign,
      offer: german.offer,
    });
  });

  it("empties the section in a language without a built-in set", () => {
    expect(resetMessageDefaultsSection(saved, "campaign", null)).toEqual({
      ...EMPTY_MESSAGE_DEFAULTS,
      offer: ownOffer,
    });
  });

  it("gives null when nothing saved is left to keep, so the column goes back to NULL", () => {
    // Only the campaign texts were the admin's own.
    expect(resetMessageDefaultsSection({ ...german, campaign: ownCampaign }, "campaign", german)).toBeNull();
    expect(
      resetMessageDefaultsSection({ ...EMPTY_MESSAGE_DEFAULTS, campaign: ownCampaign }, "campaign", null)
    ).toBeNull();
    // Nothing readable was saved.
    expect(resetMessageDefaultsSection(null, "offer", german)).toBeNull();
  });

  it("knows the two sections and nothing else", () => {
    expect(isMessageDefaultsSection("campaign")).toBe(true);
    expect(isMessageDefaultsSection("offer")).toBe(true);
    for (const value of ["campaigns", "", "version", null, undefined, 1]) {
      expect(isMessageDefaultsSection(value)).toBe(false);
    }
  });
});

describe("renderTagTemplate", () => {
  it("puts the offer's name into the template", () => {
    expect(renderTagTemplate("[LM] {name} gesendet", "Guide")).toBe("[LM] Guide gesendet");
    expect(renderTagTemplate("{name} angeboten", "  Prompting Guide ")).toBe("Prompting Guide angeboten");
    expect(renderTagTemplate("{name} / {name}", "A")).toBe("A / A");
    expect(renderTagTemplate("Guide angeboten", "Anything")).toBe("Guide angeboten");
  });

  it("keeps a name as typed, replacement patterns included", () => {
    expect(renderTagTemplate("[LM] {name}", "$& $1 $$")).toBe("[LM] $& $1 $$");
  });

  it("trims and cuts to the 100 characters of a tag without splitting an emoji", () => {
    expect(renderTagTemplate("  {name} geklickt  ", "Guide")).toBe("Guide geklickt");
    const cut = renderTagTemplate("{name}", `${"a".repeat(99)}🙌🙌`);
    expect(Array.from(cut)).toHaveLength(100);
    expect(cut.endsWith("🙌")).toBe(true);
    // A cut that ends on a space leaves no trailing space.
    expect(renderTagTemplate("{name} gesendet", "a".repeat(99))).toBe("a".repeat(99));
  });
});

describe("withImportRow", () => {
  const row = {
    name: "Row",
    keywords: ["GUIDE"],
    dmMessage: "Hier ist dein Link {link}",
    publicReply: "",
    trackedUrl: "",
    openingDmMessage: "",
    openingDmButtonLabel: "",
  };

  it("keeps the defaults for every cell a row leaves empty", () => {
    expect(withImportRow(german.campaign, row)).toEqual({
      ...german.campaign,
      dmMessage: "Hier ist dein Link {link}",
    });
  });

  it("puts the cells a row fills over the defaults", () => {
    expect(
      withImportRow(german.campaign, {
        ...row,
        publicReply: "Schau in deine DMs",
        openingDmMessage: "Willst du den Link?",
        openingDmButtonLabel: "Klar",
      })
    ).toEqual({
      ...german.campaign,
      dmMessage: "Hier ist dein Link {link}",
      publicReplyEnabled: true,
      publicReplyMessages: ["Schau in deine DMs"],
      openingDmEnabled: true,
      openingDmMessage: "Willst du den Link?",
      openingDmButtonLabel: "Klar",
    });
  });

  it("gives a row's opening DM the default button, else the import's own", () => {
    const opening = { ...row, openingDmMessage: "Willst du den Link?" };
    expect(withImportRow(german.campaign, opening).openingDmButtonLabel).toBe("Ja, schick sie mir");
    expect(withImportRow(EMPTY_MESSAGE_DEFAULTS.campaign, opening).openingDmButtonLabel).toBe("Send link");
    expect(withImportRow(null, opening)).toMatchObject({ openingDmEnabled: true, openingDmButtonLabel: "Send link" });
  });

  it("sets only the row's own fields without defaults, as the import always did", () => {
    expect(withImportRow(null, row)).toEqual({
      dmMessage: "Hier ist dein Link {link}",
      publicReplyEnabled: false,
      publicReplyMessages: [],
      openingDmEnabled: false,
      openingDmMessage: "",
      openingDmButtonLabel: "",
    });
    // A button label without an opening DM is kept, the DM stays off.
    expect(withImportRow(null, { ...row, openingDmButtonLabel: "Send it" })).toMatchObject({
      openingDmEnabled: false,
      openingDmButtonLabel: "Send it",
    });
  });

  it("copes with rows staged by an older import", () => {
    expect(withImportRow(german.campaign, { keywords: ["GUIDE"] })).toEqual(german.campaign);
  });
});
