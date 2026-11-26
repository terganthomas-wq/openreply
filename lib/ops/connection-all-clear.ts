/**
 * The all-clear e-mail after a lost Instagram connection (A1 requirement 6).
 *
 * When the catch-up of an incident has finished
 * (lib/instagram/connection-catch-up.ts), every owner and admin of the
 * workspace gets "Instagram-Verbindung wieder da": how long the connection
 * was lost, how many comments of the meantime get their DM now, and the
 * comments they answered by hand, which get none automatically, with a link
 * to the Kommentare page (lib/ops/connection-all-clear-email.ts). Same
 * recipients, transport and settings as the alert (lib/ops/connection-alert.ts).
 *
 * Once per catch-up: the finished catch-up sets connectionAllClearDueAt, and
 * one conditional update of the account row takes it before the e-mail is
 * sent, so two senders at once send it once. Once it reached someone,
 * connectionAllClearSentAt records it: a connection lost again after it gets
 * its alert at once (lib/ops/connection-alert.ts). A send that got no answer (a
 * timeout, 429, 5xx) gives it back, and the worker's next sweep tries again
 * with the same Idempotency-Key, which Resend keeps for 24 hours; a refusal
 * keeps it taken. Without e-mail settings or recipients nothing is taken, and
 * the next sweep tries again. After 24 hours, or once the connection is lost
 * again, an all-clear that is still owed is dropped: it would say something
 * that is no longer news, or no longer true. Diagnostics shows the catch-up
 * either way.
 *
 * The claimed send is shared with the e-mails about a messaging silence (A2):
 * lib/ops/incident-mail.ts.
 */

import { prisma } from "@/lib/db/client";
import { readCatchUpResult } from "@/lib/instagram/catch-up-state";
import { buildAllClearEmail } from "@/lib/ops/connection-all-clear-email";
import { alertLocale } from "@/lib/ops/connection-alert";
import { CONNECTION_ALL_CLEAR_EVENT } from "@/lib/ops/event-details";
import { hashedRecipient, sendIncidentMail } from "@/lib/ops/incident-mail";
import { mailTransportFromEnv, type MailTransport } from "@/lib/ops/mail";
import { logWorkerEvent } from "@/lib/queue/send-helpers";

/** An all-clear that could not go out within this time is dropped. */
export const ALL_CLEAR_MAX_AGE_MS = 24 * 60 * 60_000;

/** `{NEXTAUTH_URL}/comments` (the Kommentare page), or null without the app's address. */
export function commentsPageUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  return base && /^https?:\/\//.test(base) ? `${base}/comments` : null;
}

/**
 * One all-clear to one person, the same for every try: the account, the
 * catch-up (when it finished) and the person, hashed.
 */
export function allClearIdempotencyKey({
  accountId,
  finishedAt,
  to,
}: {
  accountId: string;
  finishedAt: Date;
  to: string;
}): string {
  return `openreply-connection-all-clear/${accountId}/${finishedAt.getTime()}/${hashedRecipient(to)}`;
}

export type AllClearOutcome =
  /** None owed. */
  | "not-due"
  /** Dropped: older than 24 hours, the connection is lost again, or no catch-up to tell. */
  | "dropped"
  /** The worker has no e-mail settings; kept for the next try. */
  | "no-mail"
  /** Nobody to send to; kept for the next try. */
  | "no-recipients"
  /** Someone else took it first. */
  | "taken"
  | "sent"
  | "failed";

// Accounts already told about having nobody to e-mail, in this process.
const warnedNoRecipients = new Set<string>();

/**
 * Send the account's all-clear e-mail if one is owed. Never throws for a
 * failed send; a database error is thrown before anything is sent.
 */
export async function sendConnectionAllClear(
  accountId: string,
  {
    now = Date.now(),
    transport = mailTransportFromEnv(),
    env = process.env,
  }: {
    now?: number;
    transport?: MailTransport | null;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<AllClearOutcome> {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      connectionLostAt: true,
      connectionAllClearDueAt: true,
      connectionCatchUpResult: true,
    },
  });
  const due = account?.connectionAllClearDueAt;
  if (!account || !due) return "not-due";

  const result = readCatchUpResult(account.connectionCatchUpResult);
  const drop = !result
    ? "no catch-up to report"
    : account.connectionLostAt
      ? "the connection is lost again"
      : now - due.getTime() > ALL_CLEAR_MAX_AGE_MS
        ? "it could not go out within 24 hours"
        : null;
  if (drop || !result) {
    const { count } = await prisma.instagramAccount.updateMany({
      where: { id: account.id, connectionAllClearDueAt: due },
      data: { connectionAllClearDueAt: null },
    });
    if (count === 1) {
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `All-clear e-mail for @${account.username} not sent: ${drop ?? "no catch-up to report"}`,
      });
    }
    return "dropped";
  }

  return sendIncidentMail({
    account,
    label: "All-clear",
    noRecipientsLabel: "All-clear e-mail",
    warnedNoRecipients,
    transport,
    // The claim: exactly the all-clear this decision was made on.
    claim: async () => {
      const claim = await prisma.instagramAccount.updateMany({
        where: { id: account.id, connectionAllClearDueAt: due, connectionLostAt: null },
        data: { connectionAllClearDueAt: null },
      });
      return claim.count === 1;
    },
    // Owed again, unless a newer catch-up owes its own meanwhile.
    release: async () => {
      await prisma.instagramAccount.updateMany({
        where: { id: account.id, connectionAllClearDueAt: null },
        data: { connectionAllClearDueAt: due },
      });
    },
    build: () =>
      buildAllClearEmail({
        locale: alertLocale(env),
        username: account.username,
        lostAt: new Date(result.lostAt),
        recoveredAt: new Date(result.recoveredAt),
        queued: result.queued,
        ownerAnswered: result.ownerAnswered,
        ownerAnsweredTotal: result.ownerAnsweredTotal,
        skipped: result.skipped,
        commentsUrl: commentsPageUrl(env),
      }),
    idempotencyKey: (to) =>
      allClearIdempotencyKey({ accountId: account.id, finishedAt: due, to }),
    event: { kind: CONNECTION_ALL_CLEAR_EVENT, account: account.username },
    // Only an all-clear that went out counts: should the connection drop
    // again, its alert goes out at once instead of up to 24 hours after the
    // last warning (lib/ops/connection-alert.ts), as the owners' last e-mail
    // said it is back. Best effort: without it the 24 hours hold as before.
    onDelivered: async () => {
      await prisma.instagramAccount
        .updateMany({
          where: { id: account.id },
          data: { connectionAllClearSentAt: new Date(now) },
        })
        .catch((error) =>
          console.error(
            "[All-clear] Could not record the sent all-clear:",
            error instanceof Error ? error.message : "unknown error"
          )
        );
    },
    retryNote: "the next sweep tries again",
    refusalNote: "not tried again",
  });
}

/** Tests: forget which accounts were warned about having no recipients. */
export function resetAllClearWarnings(): void {
  warnedNoRecipients.clear();
}
