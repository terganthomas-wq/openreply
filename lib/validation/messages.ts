/**
 * What a failed check says, in the interface language (R17).
 *
 * The schemas' own messages are English: API clients get them as they are.
 * The editors run the same schemas before they save (lib/offers/schema.ts,
 * lib/campaigns/message-defaults.ts) and word the problems with this
 * instead, so a German form never shows "At most 640 characters". Client-safe.
 */

import type { z } from "zod";
import type { I18n } from "@/lib/i18n";
import { LAST_OFFER_MESSAGE_RULE } from "@/lib/offers/schema";
import { textLimitOf } from "@/lib/validation/text";

/**
 * One issue in the interface language. Length limits, the ones the forms
 * can reach, are said with their number, and the last offer message names
 * the button it carries. Anything else keeps the schema's message: the
 * editors check those cases themselves before they get here.
 */
export function issueMessage(t: I18n["t"], issue: z.core.$ZodIssue): string {
  const limit = textLimitOf(issue);
  if (!limit) return issue.message;
  if (issue.code === "custom" && issue.params?.rule === LAST_OFFER_MESSAGE_RULE) {
    return t(
      "The last offer message carries the button: at most {max} characters (emoji count as 2).",
      { max: limit.max }
    );
  }
  return limit.utf16
    ? t("At most {max} characters (emoji count as 2).", { max: limit.max })
    : t("At most {max} characters.", { max: limit.max });
}
