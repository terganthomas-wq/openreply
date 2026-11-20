/**
 * Comments that ask something instead of asking for the resource.
 *
 * "Does the LINK work for Android?" matches the keyword LINK, but a DM with the
 * link does not answer it, and a "check your DMs" reply under it reads as if
 * nobody looked. Campaigns with `ignoreQuestionComments` leave such comments to
 * a human.
 *
 * The check has to see the raw comment text. The keyword matcher turns every
 * character that is not a letter, digit or mark into a space before it
 * compares, so a normalised text has no question mark left in it.
 *
 * Besides "?" it knows the full-width "？" (Chinese, Japanese), the inverted
 * "¿" that opens a Spanish question (people often leave the closing one out)
 * and the Arabic "؟".
 *
 * Kept apart from the keyword matcher so the worker and the comment sweep can
 * share it without touching the matcher's module.
 */

const QUESTION_MARK = /[?？¿؟]/;

export function isQuestionComment(raw: string): boolean {
  return QUESTION_MARK.test(raw);
}
