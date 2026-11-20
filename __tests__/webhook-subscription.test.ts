import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeInstagramAccountToWebhooks } from "../lib/meta/client";

/**
 * Which webhook fields an Instagram account is subscribed to on connect.
 *
 * Button taps reach the app only through messaging_postbacks. Without it, a tap
 * on the follow gate's "I'm following" button or an opening DM's button never
 * arrives, and the person never gets the link.
 */
describe("subscribeInstagramAccountToWebhooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("subscribes comments, messages and button taps", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await subscribeInstagramAccountToWebhooks(
      "17841400000000000",
      { accessToken: "token", unifiedLogin: true }
    );

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(
      /^https:\/\/graph\.facebook\.com\/v[\d.]+\/17841400000000000\/subscribed_apps$/
    );
    expect(JSON.parse(init.body).subscribed_fields).toEqual([
      "comments",
      "messages",
      "messaging_postbacks",
    ]);
  });
});
