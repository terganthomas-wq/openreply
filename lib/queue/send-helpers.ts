/**
 * Send helpers shared by the DM worker and the modules it hands work to.
 *
 * Every direct message outside a comment's private reply is claimed and its
 * errors are read the same way. Keeping that in one module means work moved
 * out of dm-worker.ts (what follows a delivered link, the offer messages that
 * come later) uses the same claim and the same retry policy instead of a copy
 * that drifts.
 */

import type {
  OperationalEventLevel,
  Prisma,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  classifySendError,
  isConfirmedSendRejection,
} from "@/lib/instagram/delivery-errors";
import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import { ZernioApiError } from "@/lib/zernio/client";

export function formatError(error: unknown): string {
  if (error instanceof MetaApiError) {
    return `${error.name} ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

// Meta rejections that a plain-text retry cannot fix: the send was refused for
// the conversation, not for the button template. Retrying as text just burns
// the attempt and — worse — overwrites the real error with a misleading one
// ("invalid for a private reply", because the first attempt already used up the
// comment's single allowed private reply).
export const NON_TEMPLATE_REJECTIONS = [
  /outside of allowed window/i,
  /invalid for a private reply/i,
  /requested user cannot be found/i,
];

export function isTemplateRejection(error: unknown): boolean {
  if (
    error instanceof TokenExpiredError ||
    error instanceof RateLimitError ||
    error instanceof ZernioApiError
  ) {
    return false;
  }
  // Falling back is another send: allow it only for a proven template error.
  return error instanceof MetaApiError && error.code === 100 &&
    /template|button/i.test(error.message) &&
    !NON_TEMPLATE_REJECTIONS.some((pattern) => pattern.test(error.message));
}

// Prisma's unique-constraint violation. Checked by code alone: the error class
// and its metadata differ between driver adapters, the code does not.
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export async function sendPostbackOnce({
  operationId,
  send,
}: {
  operationId: string;
  send: () => Promise<unknown>;
}): Promise<boolean> {
  try {
    await prisma.postbackDelivery.create({ data: { id: operationId } });
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  try {
    await send();
    return true;
  } catch (error) {
    // A durable claim survives queue eviction, concurrent redelivery, and a
    // process crash during delivery. Only confirmed rejections permit retry.
    if (isConfirmedSendRejection(error)) {
      await prisma.postbackDelivery.delete({ where: { id: operationId } });
      throw error;
    }
    throw classifySendError(error);
  }
}

// An entry for the Diagnostics timeline. Best effort: it runs next to sends
// that already happened, so a failed write must never fail or retry the job
// that reported it.
export async function logWorkerEvent({
  workspaceId,
  level,
  message,
  payload,
}: {
  workspaceId: string | null;
  level: OperationalEventLevel;
  message: string;
  payload?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.operationalEvent.create({
      data: { workspaceId, source: "WORKER", level, message, payload },
    });
  } catch {
    // Nothing to do: the event is lost, the job goes on.
  }
}
