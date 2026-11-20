/**
 * Question comments — the ones a campaign can leave to a human.
 *
 * The check runs on the raw comment text, before the keyword matcher has
 * turned every question mark into a space.
 */

import { describe, expect, it } from "vitest";
import { isQuestionComment } from "../lib/automation/question-filter";
import { stripSpecialCharacters } from "../lib/utils/keyword-matcher";

describe("isQuestionComment", () => {
  it.each([
    ["Does the LINK work on Android?", "a question mark"],
    ["LINK？", "the full-width mark of Chinese and Japanese"],
    ["¿Me mandas el LINK", "the inverted mark that opens a Spanish question"],
    ["هل الرابط مجاني؟", "the Arabic question mark"],
    ["?", "a mark on its own"],
    ["LINK ?!", "a mark among other punctuation"],
  ])("finds a question in %j (%s)", (text) => {
    expect(isQuestionComment(text)).toBe(true);
  });

  it.each([
    "LINK",
    "LINK!",
    "¡LINK!",
    "LINK please 🙏",
    "Link: https://example.com/guide",
    "",
  ])("finds no question in %j", (text) => {
    expect(isQuestionComment(text)).toBe(false);
  });

  it("needs the raw text, since the keyword matcher drops the mark", () => {
    expect(isQuestionComment("LINK?")).toBe(true);
    expect(isQuestionComment(stripSpecialCharacters("LINK?"))).toBe(false);
  });
});
