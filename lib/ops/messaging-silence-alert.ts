/**
 * The e-mails about a messaging silence (A2): the alert when the worker's
 * check opens one (lib/instagram/messaging-silence-check.ts), one reminder 24
 * hours later if nothing arrived by then, and the all-clear once something
 * did (lib/instagram/messaging-silence-state.ts) and the search for the taps
 * lost meanwhile has finished (lib/instagram/lost-tap-search.ts), with what
 * it found. The words are in lib/ops/messaging-silence-email.ts.
 *
 * A1's infrastructure and rules (lib/ops/incident-mail.ts): the same
 * recipients (every owner and admin of the workspace, never members), the
 * same transport and settings (Resend or SMTP, DEFAULT_LOCALE, NEXTAUTH_URL),
 * at most one warning e-mail per 24 hours per account, here for the
 * silence's own e-mails, the alert at once for a new silence after an
 * all-clear (at most once per 24 hours), and every e-mail claimed on the
 * account row before it is sent, with an Idempotency-Key per person that is
 * the same for every try. An all-clear that could not go out within 24 hours,
 * or once a silence or a lost connection is open again, is dropped.
 */

import { prisma } from "@/lib/db/client";
import { readMessagingSilenceResult } from "@/lib/instagram/messaging-silence-incident";
import { ALL_CLEAR_MAX_AGE_MS } from "@/lib/ops/connection-all-clear";
import { alertLocale, settingsUrl } from "@/lib/ops/connection-alert";
import { MESSAGING_ALERT_EVENT, MESSAGING_ALL_CLEAR_EVENT } from "@/lib/ops/event-details";
import {
  hashedRecipient,
  incidentAlertDue,
  INCIDENT_ALERT_INTERVAL_MS,
  sendIncidentMail,
  type IncidentAlertKind,
  type IncidentAlertState,
  type IncidentMailOutcome,
} from "@/lib/ops/incident-mail";
import {
  buildMessagingSilenceAlertEmail,
  buildMessagingSilenceAllClearEmail,
} from "@/lib/ops/messaging-silence-email";
import { mailTransportFromEnv, type MailTransport } from "@/lib/ops/mail";
import { logWorkerEvent } from "@/lib/queue/send-helpers";

/** What the alert needs of the account row. */
export interface SilenceAlertAccount {
  id: string;
  workspaceId: string;
  username: string;
  messagingSilentSince: Date | null;
  messagingAlertSentAt: Date | null;
  messagingAlertCount: number;
  /** When the last all-clear about a silence went out (absent: none known). */
  messagingAllClearSentAt?: Date | null;
  /** When the last alert about a silence went out early, after an all-clear. */
  messagingAlertRearmedAt?: Date | null;
}

/** The account's fields as A1's warning rule reads them. */
export function messagingAlertState(account: SilenceAlertAccount): IncidentAlertState {
  return {
    openSince: account.messagingSilentSince,
    sentAt: account.messagingAlertSentAt,
    count: account.messagingAlertCount,
    allClearSentAt: account.messagingAllClearSentAt,
    rearmedAt: account.messagingAlertRearmedAt,
  };
}

/** Which e-mail is due for the account's open silence, or null (A1's rule). */
export function messagingAlertDue(
  account: SilenceAlertAccount,
  now: number
): IncidentAlertKind | null {
  return incidentAlertDue(messagingAlertState(account), now);
}

/**
 * One e-mail to one person, the same for every try: the account, the
 * silence (its start), which e-mail of it, and the person, hashed.
 */
export function messagingAlertIdempotencyKey({
  accountId,
  since,
  number,
  to,
}: {
  accountId: string;
  since: Date;
  number: number;
  to: string;
}): string {
  return `openreply-messaging-silence-alert/${accountId}/${since.getTime()}/${number}/${hashedRecipient(to)}`;
}

/** One all-clear to one person: the account, the silence's end and the person. */
export function messagingAllClearIdempotencyKey({
  accountId,
  endedAt,
  to,
}: {
  accountId: string;
  endedAt: Date;
  to: string;
}): string {
  return `openreply-messaging-silence-all-clear/${accountId}/${endedAt.getTime()}/${hashedRecipient(to)}`;
}

export type SilenceAlertOutcome = "not-due" | IncidentMailOutcome;
export type SilenceAllClearOutcome = "not-due" | "dropped" | IncidentMailOutcome;

// Accounts already told about having nobody to e-mail, in this process.
const warnedAlert = new Set<string>();
const warnedAllClear = new Set<string>();

interface MailOptions {
  now?: number;
  transport?: MailTransport | null;
  env?: Record<string, string | undefined>;
}

/**
 * Send the e-mail that is due for the account's open silence, if any. Never
 * throws for a failed send; a database error is thrown before anything is
 * sent.
 */
export async function sendMessagingSilenceAlert(
  account: SilenceAlertAccount,
  { now = Date.now(), transport = mailTransportFromEnv(), env = process.env }: MailOptions = {}
): Promise<SilenceAlertOutcome> {
  const kind = messagingAlertDue(account, now);
  const since = account.messagingSilentSince;
  if (!kind || !since) return "not-due";

  // The claim: exactly the state this decision was made on, so a second
  // check, or an inbound event that ended the silence, wins nothing here.
  const previousSentAt = account.messagingAlertSentAt;
  const previousCount = account.messagingAlertCount;
  const previousRearmedAt = account.messagingAlertRearmedAt ?? null;
  const rearmed =
    previousSentAt !== null && now - previousSentAt.getTime() < INCIDENT_ALERT_INTERVAL_MS;
  const number = previousCount + 1;
  const sentAt = new Date(now);
  const reminder = kind === "reminder";

  return sendIncidentMail({
    account,
    label: reminder ? "Messaging silence reminder" : "Messaging silence alert",
    noRecipientsLabel: "Messaging silence alert",
    warnedNoRecipients: warnedAlert,
    transport,
    claim: async () => {
      const claim = await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          messagingSilentSince: since,
          messagingAlertCount: previousCount,
          messagingAlertSentAt: previousSentAt,
          ...(rearmed ? { messagingAlertRearmedAt: previousRearmedAt } : {}),
        },
        data: {
          messagingAlertSentAt: sentAt,
          messagingAlertCount: number,
          ...(rearmed ? { messagingAlertRearmedAt: sentAt } : {}),
        },
      });
      return claim.count === 1;
    },
    release: async () => {
      await prisma.instagramAccount.updateMany({
        where: { id: account.id, messagingAlertSentAt: sentAt, messagingAlertCount: number },
        data: {
          messagingAlertSentAt: previousSentAt,
          messagingAlertCount: previousCount,
          ...(rearmed ? { messagingAlertRearmedAt: previousRearmedAt } : {}),
        },
      });
    },
    build: () =>
      buildMessagingSilenceAlertEmail({
        locale: alertLocale(env),
        kind,
        username: account.username,
        since,
        settingsUrl: settingsUrl(env),
      }),
    idempotencyKey: (to) =>
      messagingAlertIdempotencyKey({ accountId: account.id, since, number, to }),
    event: { kind: MESSAGING_ALERT_EVENT, account: account.username, reminder },
    retryNote: "the next check tries again",
    refusalNote: "not tried again for this silence before 24 hours have passed",
  });
}

/**
 * Send the all-clear after the account's last silence if one is owed. Never
 * throws for a failed send; a database error is thrown before anything is
 * sent.
 */
export async function sendMessagingSilenceAllClear(
  accountId: string,
  { now = Date.now(), transport = mailTransportFromEnv(), env = process.env }: MailOptions = {}
): Promise<SilenceAllClearOutcome> {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      connectionLostAt: true,
      messagingSilentSince: true,
      messagingAllClearDueAt: true,
      messagingSilenceResult: true,
    },
  });
  const due = account?.messagingAllClearDueAt;
  if (!account || !due) return "not-due";

  const result = readMessagingSilenceResult(account.messagingSilenceResult);
  // It would say something that is no longer true, or no longer news.
  const drop = !result
    ? "no silence to report"
    : account.messagingSilentSince
      ? "messaging events are missing again"
      : account.connectionLostAt
        ? "the connection is lost"
        : now - due.getTime() > ALL_CLEAR_MAX_AGE_MS
          ? "it could not go out within 24 hours"
          : null;
  if (drop || !result) {
    const { count } = await prisma.instagramAccount.updateMany({
      where: { id: account.id, messagingAllClearDueAt: due },
      data: { messagingAllClearDueAt: null },
    });
    if (count === 1) {
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `Messaging all-clear e-mail for @${account.username} not sent: ${drop ?? "no silence to report"}`,
      });
    }
    return "dropped";
  }

  return sendIncidentMail({
    account,
    label: "Messaging all-clear",
    noRecipientsLabel: "Messaging all-clear e-mail",
    warnedNoRecipients: warnedAllClear,
    transport,
    claim: async () => {
      const claim = await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          messagingAllClearDueAt: due,
          messagingSilentSince: null,
          connectionLostAt: null,
        },
        data: { messagingAllClearDueAt: null },
      });
      return claim.count === 1;
    },
    release: async () => {
      await prisma.instagramAccount.updateMany({
        where: { id: account.id, messagingAllClearDueAt: null },
        data: { messagingAllClearDueAt: due },
      });
    },
    build: () =>
      buildMessagingSilenceAllClearEmail({
        locale: alertLocale(env),
        username: account.username,
        since: new Date(result.since),
        endedAt: new Date(result.endedAt),
        taps: result.taps ?? null,
      }),
    idempotencyKey: (to) =>
      messagingAllClearIdempotencyKey({ accountId: account.id, endedAt: due, to }),
    event: { kind: MESSAGING_ALL_CLEAR_EVENT, account: account.username },
    // A silence after it gets its alert at once (A1's re-arm). Best effort:
    // without it the 24 hours of the last warning hold.
    onDelivered: async () => {
      await prisma.instagramAccount
        .updateMany({
          where: { id: account.id },
          data: { messagingAllClearSentAt: new Date(now) },
        })
        .catch((error) =>
          console.error(
            "[Messaging silence] Could not record the sent all-clear:",
            error instanceof Error ? error.message : "unknown error"
          )
        );
    },
    retryNote: "the next sweep tries again",
    refusalNote: "not tried again",
  });
}

/** Tests: forget which accounts were warned about having no recipients. */
export function resetMessagingSilenceMailWarnings(): void {
  warnedAlert.clear();
  warnedAllClear.clear();
}
