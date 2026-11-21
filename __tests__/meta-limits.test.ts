/**
 * Meta's request limits: how each refusal is classified, how long an account
 * pauses after it, the follow check's way of reporting one, and the usage
 * Meta reports with every response (R1).
 *
 * The codes were checked against a live refusal: "(#4) Application request
 * limit reached (/v25.0/<ig-id>/messages) [code=4 type=OAuthException]".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUserFollowStatus,
  MetaApiError,
  PermissionError,
  RateLimitError,
  sendDirectMessage,
  sendPrivateReply,
} from "../lib/meta/client";
import {
  classifySendError,
  isConfirmedSendRejection,
  isDeliveryUnconfirmed,
  isMetaBlock,
  isMetaThrottle,
  throttlePauseMs,
} from "../lib/instagram/delivery-errors";
import { pauseMinutesFromEnv } from "../lib/meta/limits";
import {
  highestUsagePercent,
  observeMetaUsage,
  parseMetaUsage,
  type MetaUsageReport,
} from "../lib/meta/usage";
import { zernioRequest } from "../lib/zernio/client";

const fetchMock = vi.fn();

function metaError(code: number, status = 400, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({
      error: {
        message: "(#4) Application request limit reached",
        type: "OAuthException",
        code,
        fbtrace_id: "trace",
      },
    }),
    { status, headers }
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  observeMetaUsage(null);
  vi.unstubAllEnvs();
});

describe("classifying Meta's refusals", () => {
  it.each([4, 17, 32, 613, 80002, 80006])(
    "reads code %i as a throttle that keeps its code",
    async (code) => {
      fetchMock.mockResolvedValueOnce(metaError(code));
      const error = await sendPrivateReply("token", "ig", "comment", "hi").catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).code).toBe(code);
      expect(isMetaThrottle(error)).toBe(true);
      expect(isMetaBlock(error)).toBe(false);
    }
  );

  it("reads 368 as a block, still a request limit", async () => {
    fetchMock.mockResolvedValueOnce(metaError(368));
    const error = await sendDirectMessage("token", "ig", "user", "hi").catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).code).toBe(368);
    expect(isMetaThrottle(error)).toBe(true);
    expect(isMetaBlock(error)).toBe(true);
  });

  it("leaves other refusals as they were", async () => {
    fetchMock.mockResolvedValueOnce(metaError(100));
    const permission = await sendDirectMessage("token", "ig", "user", "hi").catch(
      (e: unknown) => e
    );
    expect(permission).toBeInstanceOf(PermissionError);
    expect(isMetaThrottle(permission)).toBe(false);

    fetchMock.mockResolvedValueOnce(metaError(1, 500));
    const unknown = await sendDirectMessage("token", "ig", "user", "hi").catch(
      (e: unknown) => e
    );
    expect(unknown).toBeInstanceOf(MetaApiError);
    expect(unknown).not.toBeInstanceOf(RateLimitError);
    expect(isMetaThrottle(unknown)).toBe(false);
  });

  it.each([32, 613, 80002, 80006])(
    "treats code %i as a refusal, no longer as a message that may have gone out",
    async (code) => {
      fetchMock.mockResolvedValueOnce(metaError(code));
      const error = await sendDirectMessage("token", "ig", "user", "hi").catch(
        (e: unknown) => e
      );
      // Before, these were plain MetaApiErrors: "delivery unconfirmed", never
      // retried, although Meta had refused them.
      expect(isConfirmedSendRejection(error)).toBe(true);
      expect(classifySendError(error)).toBe(error);
      expect(isDeliveryUnconfirmed(classifySendError(error))).toBe(false);
    }
  );

  it("keeps Zernio's own limit apart from Meta's block", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const error = await zernioRequest({ apiKey: "key", path: "/accounts" }).catch(
      (e: unknown) => e
    );
    // Still a RateLimitError, retried as before, but no account pause: it
    // used to carry the class's default 368, Meta's block.
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).code).toBe(429);
    expect(isMetaThrottle(error)).toBe(false);
    expect(throttlePauseMs(error)).toBe(0);
  });
});

describe("how long an account pauses", () => {
  const throttle = new RateLimitError("limit", undefined, undefined, 4);
  const block = new RateLimitError("blocked", undefined, undefined, 368);

  it("pauses 20 minutes for a throttle and 60 for a block", () => {
    expect(throttlePauseMs(throttle, {})).toBe(20 * 60_000);
    expect(throttlePauseMs(block, {})).toBe(60 * 60_000);
  });

  it("takes the minutes from META_THROTTLE_PAUSE_MINUTES and META_BLOCK_PAUSE_MINUTES", () => {
    const env = { META_THROTTLE_PAUSE_MINUTES: "5", META_BLOCK_PAUSE_MINUTES: "90" };
    expect(throttlePauseMs(throttle, env)).toBe(5 * 60_000);
    expect(throttlePauseMs(block, env)).toBe(90 * 60_000);
  });

  it("reads the process environment by default", () => {
    vi.stubEnv("META_THROTTLE_PAUSE_MINUTES", "7");
    expect(throttlePauseMs(throttle)).toBe(7 * 60_000);
  });

  it.each([
    ["", 20],
    ["  ", 20],
    ["abc", 20],
    ["0", 1],
    ["-5", 1],
    ["12.9", 12],
    ["241", 240],
    ["100000", 240],
  ])("bounds the setting %j to %i minutes", (value, minutes) => {
    expect(pauseMinutesFromEnv(value, 20)).toBe(minutes);
  });

  it("does not pause for anything but a request limit", () => {
    expect(throttlePauseMs(new PermissionError("no"), {})).toBe(0);
    expect(throttlePauseMs(new Error("network"), {})).toBe(0);
  });
});

describe("the follow check during a request limit", () => {
  const context = { accessToken: "token", instagramId: "ig1" };

  it("throws the limit when asked to, instead of reading it as unknown", async () => {
    fetchMock.mockResolvedValueOnce(metaError(4));
    const error = await getUserFollowStatus(context, "person", {
      throwOnLimit: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).code).toBe(4);
  });

  it("stays unknown (null) for a limit unless asked, as before", async () => {
    fetchMock.mockResolvedValueOnce(metaError(4));
    await expect(getUserFollowStatus(context, "person")).resolves.toBeNull();
  });

  it("stays unknown for every other failure, even when asked", async () => {
    fetchMock.mockResolvedValueOnce(metaError(100));
    await expect(
      getUserFollowStatus(context, "person", { throwOnLimit: true })
    ).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 500 }));
    await expect(
      getUserFollowStatus(context, "person", { throwOnLimit: true })
    ).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      getUserFollowStatus(context, "person", { throwOnLimit: true })
    ).resolves.toBeNull();
  });

  it("still reads a follow", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ is_user_follow_business: true }))
    );
    await expect(
      getUserFollowStatus(context, "person", { throwOnLimit: true })
    ).resolves.toBe(true);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ is_user_follow_business: false }))
    );
    await expect(getUserFollowStatus(context, "person")).resolves.toBe(false);
  });
});

describe("the usage Meta reports with every response", () => {
  const APP = JSON.stringify({ call_count: 85, total_cputime: 12, total_time: 30 });
  const BUSINESS = JSON.stringify({
    "17841400000000001": [
      {
        type: "instagram",
        call_count: 3,
        total_cputime: 91.5,
        total_time: 4,
        estimated_time_to_regain_access: 7,
      },
    ],
  });

  it("reads both headers", () => {
    const usage = parseMetaUsage(
      new Headers({ "x-app-usage": APP, "x-business-use-case-usage": BUSINESS })
    );
    expect(usage).toEqual({
      app: { callCount: 85, totalCputime: 12, totalTime: 30 },
      business: [
        {
          id: "17841400000000001",
          type: "instagram",
          callCount: 3,
          totalCputime: 91.5,
          totalTime: 4,
          estimatedTimeToRegainAccess: 7,
        },
      ],
    });
    expect(highestUsagePercent(usage!)).toBe(91.5);
  });

  it("ignores missing, empty and unreadable headers", () => {
    expect(parseMetaUsage(new Headers())).toBeNull();
    expect(parseMetaUsage(new Headers({ "x-app-usage": "not json" }))).toBeNull();
    expect(parseMetaUsage(new Headers({ "x-app-usage": "[1,2]" }))).toBeNull();
    expect(parseMetaUsage(undefined)).toBeNull();
    expect(
      parseMetaUsage(
        new Headers({ "x-business-use-case-usage": JSON.stringify({ x: "nope" }) })
      )
    ).toBeNull();
  });

  it("never takes the time to regain access for a percentage", () => {
    const usage = parseMetaUsage(
      new Headers({
        "x-business-use-case-usage": JSON.stringify({
          ig: [{ call_count: 1, estimated_time_to_regain_access: 95 }],
        }),
      })
    );
    expect(highestUsagePercent(usage!)).toBe(1);
  });

  it("hands every response's usage and account to the observer", async () => {
    const reports: MetaUsageReport[] = [];
    observeMetaUsage((report) => reports.push(report));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ recipient_id: "u", message_id: "m" }), {
        headers: { "x-app-usage": APP },
      })
    );
    await sendDirectMessage(
      { accessToken: "secret-token", instagramId: "ig1" },
      "ig1",
      "user",
      "hi"
    );
    expect(reports).toEqual([
      {
        usage: { app: { callCount: 85, totalCputime: 12, totalTime: 30 }, business: [] },
        instagramId: "ig1",
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain("secret-token");
  });

  it("reports the usage of a refused call too, which still throws as before", async () => {
    const reports: MetaUsageReport[] = [];
    observeMetaUsage((report) => reports.push(report));
    fetchMock.mockResolvedValueOnce(metaError(4, 400, { "x-app-usage": APP }));
    await expect(
      sendDirectMessage({ accessToken: "t", instagramId: "ig1" }, "ig1", "u", "hi")
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(reports).toHaveLength(1);
  });

  it("never lets a failing observer break the call", async () => {
    observeMetaUsage(() => {
      throw new Error("observer broke");
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ recipient_id: "u", message_id: "m" }), {
        headers: { "x-app-usage": APP },
      })
    );
    await expect(
      sendDirectMessage("token", "ig1", "user", "hi")
    ).resolves.toMatchObject({ message_id: "m" });
  });

  it("names no account for a bare token", async () => {
    const reports: MetaUsageReport[] = [];
    observeMetaUsage((report) => reports.push(report));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ recipient_id: "u", message_id: "m" }), {
        headers: { "x-app-usage": APP },
      })
    );
    await sendDirectMessage("token", "ig1", "user", "hi");
    expect(reports[0].instagramId).toBeNull();
  });
});
