import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import {
  DEFAULT_BLOCK_PAUSE_MINUTES,
  DEFAULT_THROTTLE_PAUSE_MINUTES,
  META_BLOCK_CODE,
  isMetaLimitCode,
  pauseMinutesFromEnv,
} from "@/lib/meta/limits";
import {
  ZernioApiError,
  ZernioDeliveryUnconfirmedError,
} from "@/lib/zernio/client";

/**
 * Whether Meta refused a call for one of its request limits: a throttle
 * (codes 4, 17, 32, 613, 80002, 80006) or a block (368). Nothing was sent, so
 * the call is worth repeating once the limit is over, and until then the
 * account's other calls are refused as well. Zernio's own limit is not one:
 * it arrives with code 429 (lib/zernio/client.ts).
 */
export function isMetaThrottle(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError && isMetaLimitCode(error.code);
}

/** A request limit that is a block (368): it lasts longer than a throttle. */
export function isMetaBlock(error: unknown): boolean {
  return isMetaThrottle(error) && error.code === META_BLOCK_CODE;
}

/**
 * How long an account's messaging pauses after this error: 20 minutes for a
 * throttle, 60 for a block, or META_THROTTLE_PAUSE_MINUTES and
 * META_BLOCK_PAUSE_MINUTES (1 to 240). 0 for any other error.
 */
export function throttlePauseMs(
  error: unknown,
  env: Record<string, string | undefined> = process.env
): number {
  if (!isMetaThrottle(error)) return 0;
  const minutes = isMetaBlock(error)
    ? pauseMinutesFromEnv(env.META_BLOCK_PAUSE_MINUTES, DEFAULT_BLOCK_PAUSE_MINUTES)
    : pauseMinutesFromEnv(
        env.META_THROTTLE_PAUSE_MINUTES,
        DEFAULT_THROTTLE_PAUSE_MINUTES
      );
  return minutes * 60_000;
}

export class DeliveryUnconfirmedError extends Error {
  constructor(error: unknown) {
    const detail =
      error instanceof Error ? error.message : "Unknown send outcome";
    super(
      `Message delivery is unconfirmed; automatic retries stopped. Inspect the Instagram inbox before retrying. ${detail}`,
    );
    this.name = "DeliveryUnconfirmedError";
  }
}

export function isDeliveryUnconfirmed(
  error: unknown,
): error is DeliveryUnconfirmedError | ZernioDeliveryUnconfirmedError {
  return (
    error instanceof DeliveryUnconfirmedError ||
    error instanceof ZernioDeliveryUnconfirmedError
  );
}

// Only explicit rejections prove that no message was delivered. Meta code 1,
// network failures, invalid responses and local persistence failures do not.
export function isConfirmedSendRejection(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof TokenExpiredError)
    return true;
  if (error instanceof ZernioApiError)
    return error.code >= 400 && error.code < 500;
  return (
    error instanceof MetaApiError && [10, 100, 200, 551].includes(error.code)
  );
}

export function classifySendError(error: unknown): unknown {
  return isDeliveryUnconfirmed(error) || isConfirmedSendRejection(error)
    ? error
    : new DeliveryUnconfirmedError(error);
}

// Old workers logged these uncertain Meta responses as retryable failures.
export function hasLegacyUnconfirmedDelivery(
  error: string | null | undefined,
): boolean {
  return Boolean(
    error &&
    /(?:MetaApiError (?:1|2|5\d\d):|\[code=(?:1|2|5\d\d)\b)/.test(error),
  );
}
