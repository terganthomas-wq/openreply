/**
 * Length limits for text that Instagram cuts. Client-safe: no database import,
 * so the editors can show the same limits the API enforces.
 *
 * The senders cut with String.prototype.slice, which counts UTF-16 units
 * (lib/meta/client.ts, lib/instagram/send-messages.ts), and so do the
 * browser's maxLength and String.length. zod 4's .max() counts code points
 * instead, so "Ja, gerne! 🙌🙌🙌🙌🙌" (21 units, 16 code points) passes
 * .max(20) and then loses its last emoji, or half of it, in the DM. These
 * limits are therefore checked with .length.
 */

import { z } from "zod";

/** Button titles: Meta keeps the first 20 units. */
export const BUTTON_LABEL_MAX = 20;
/** Text of a message that carries buttons (button template): 640 units. */
export const BUTTON_TEXT_MAX = 640;
/** Generic-template card title and subtitle: 80 units each. */
export const CARD_TEXT_MAX = 80;

/**
 * A string of at most `max` UTF-16 units, the way Instagram counts them. The
 * issue carries the limit (params.maximum), so the editors can say it in the
 * interface language instead of showing this English message.
 */
export function utf16Max(max: number) {
  return z.string().refine((value) => value.length <= max, {
    error: `At most ${max} characters (emoji count as 2)`,
    params: { maximum: max },
  });
}

/** A text's length limit, as a failed check reports it. */
export interface TextLimit {
  max: number;
  /** Counted in UTF-16 units (an emoji takes two), as Instagram cuts. */
  utf16: boolean;
}

/**
 * The length limit a failed check is about: a UTF-16 limit (utf16Max, or a
 * custom issue that names its maximum) or zod's own .max() on a string, which
 * counts code points. Null for any other problem.
 */
export function textLimitOf(issue: z.core.$ZodIssue): TextLimit | null {
  if (issue.code === "too_big" && issue.origin === "string") {
    return { max: Number(issue.maximum), utf16: false };
  }
  if (issue.code === "custom" && typeof issue.params?.maximum === "number") {
    return { max: issue.params.maximum, utf16: true };
  }
  return null;
}
