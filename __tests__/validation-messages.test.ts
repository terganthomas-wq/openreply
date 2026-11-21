/**
 * The editors' own wording of what a failed check says (R17): length limits
 * in the interface language, never the schemas' English. The API keeps its
 * English messages for its clients.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BUILT_IN_MESSAGE_DEFAULTS,
  messageDefaultsSchema,
  messageDefaultsUpdateSchema,
  type MessageDefaults,
} from "../lib/campaigns/message-defaults";
import { createI18n } from "../lib/i18n";
import { offerInputSchema } from "../lib/offers/schema";
import { issueMessage } from "../lib/validation/messages";
import { textLimitOf, utf16Max } from "../lib/validation/text";

const de = createI18n("de").t;
const en = createI18n("en").t;
const german = BUILT_IN_MESSAGE_DEFAULTS.de as MessageDefaults;

// A text one emoji too long for a button message: 641 UTF-16 units.
const TEXT_641_UNITS = `${"a".repeat(639)}🙌`;

function firstIssue(result: { success: boolean; error?: z.ZodError }) {
  expect(result.success).toBe(false);
  return result.error!.issues[0];
}

describe("textLimitOf", () => {
  it("reads a UTF-16 limit from utf16Max and keeps the API's message", () => {
    const issue = firstIssue(utf16Max(20).safeParse("Ja, gerne! 🙌🙌🙌🙌🙌"));

    expect(textLimitOf(issue)).toEqual({ max: 20, utf16: true });
    expect(issue.message).toBe("At most 20 characters (emoji count as 2)");
  });

  it("reads zod's own string limit, which counts code points", () => {
    expect(textLimitOf(firstIssue(z.string().max(3).safeParse("abcd")))).toEqual({
      max: 3,
      utf16: false,
    });
  });

  it("finds no limit in other problems", () => {
    expect(textLimitOf(firstIssue(z.string().min(1).safeParse("")))).toBeNull();
    expect(textLimitOf(firstIssue(z.array(z.string()).max(1).safeParse(["a", "b"])))).toBeNull();
    expect(textLimitOf(firstIssue(z.url().safeParse("nope")))).toBeNull();
  });
});

describe("issueMessage", () => {
  it("says the 640 units of a campaign's default texts in German", () => {
    // The opening DM saved as a default, as the campaign editor sends it.
    const issue = firstIssue(
      messageDefaultsUpdateSchema.safeParse({
        campaign: { openingDmMessage: "a".repeat(746) },
      })
    );

    expect(issue.path).toEqual(["campaign", "openingDmMessage"]);
    expect(issueMessage(de, issue)).toBe("Höchstens 640 Zeichen (Emojis zählen doppelt).");
    expect(issueMessage(en, issue)).toBe("At most 640 characters (emoji count as 2).");
  });

  it("names the button the last offer message carries, in an offer and in its defaults", () => {
    const offer = firstIssue(
      offerInputSchema.safeParse({
        name: "Guide",
        offerMessages: ["Hallo", TEXT_641_UNITS],
        offerDelaysSeconds: [0, 0],
        offerButtonLabel: "Ja",
        cardTitle: "Guide",
        cardButtonLabel: "Holen",
        destinationUrl: "https://example.com/guide",
        reminderEnabled: false,
        tagOffered: "o",
        tagInterested: "i",
        tagSent: "s",
        tagClicked: "c",
        tagSignedUp: "e",
      })
    );
    const defaults = firstIssue(
      messageDefaultsSchema.safeParse({
        ...german,
        offer: { ...german.offer, offerMessages: ["a", "b", TEXT_641_UNITS] },
      })
    );

    for (const issue of [offer, defaults]) {
      expect(issueMessage(de, issue)).toBe(
        "Die letzte Angebotsnachricht trägt den Button: höchstens 640 Zeichen (Emojis zählen doppelt)."
      );
      // The API's own message stays English for its clients.
      expect(issue.message).toBe(
        "The last offer message carries the button: at most 640 characters (emoji count as 2)"
      );
    }
  });

  it("says a limit counted in code points without the emoji rule", () => {
    const issue = firstIssue(
      messageDefaultsUpdateSchema.safeParse({
        campaign: { publicReplyMessages: ["a".repeat(1001)] },
      })
    );

    expect(issueMessage(de, issue)).toBe("Höchstens 1000 Zeichen.");
  });

  it("keeps the schema's message for anything that is no length limit", () => {
    const issue = firstIssue(z.string().min(1, "Too short").safeParse(""));

    expect(issueMessage(de, issue)).toBe("Too short");
  });
});
