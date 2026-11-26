/**
 * The alert e-mail about a lost Instagram connection (A1).
 *
 * When the worker's check opens an incident (lib/instagram/connection-check.ts),
 * every owner and admin of the workspace gets an e-mail that says what
 * happened and how to reconnect (lib/ops/connection-alert-email.ts). If the
 * connection is still lost 24 hours later, one reminder follows, and then
 * nothing more for that incident. At most one e-mail per 24 hours per
 * account, across incidents: a connection that keeps dropping does not
 * flood anyone's inbox, and the dashboard shows every incident anyway.
 *
 * Claimed before it is sent, like a DM: one conditional update of the
 * account row (connectionAlertSentAt, connectionAlertCount) takes the e-mail,
 * so two checks at once send it once. A send that got no answer (a timeout,
 * 429, 5xx) gives the claim back, and the next check tries again with the
 * same Idempotency-Key, which Resend keeps for 24 hours: an e-mail that did
 * go out is not sent twice. A refusal (any other 4xx) keeps the claim:
 * trying every 30 minutes would only be refused again, and Diagnostics says
 * why. Without e-mail settings nothing is claimed: the WARNING says what is
 * missing, and the alert goes out with the first check after a restart with
 * the settings.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { resolveLocale } from "@/lib/i18n";
import { connectionLostKind } from "@/lib/instagram/connection-incident";
import {
  buildConnectionAlertEmail,
  type AlertLocale,
  type ConnectionAlertKind,
} from "@/lib/ops/connection-alert-email";
import { CONNECTION_ALERT_EVENT } from "@/lib/ops/event-details";
import {
  mailTransportFromEnv,
  warnMailNotConfigured,
  type MailResult,
  type MailTransport,
} from "@/lib/ops/mail";
import { logWorkerEvent } from "@/lib/queue/send-helpers";

/** At most one e-mail per account in this time; the reminder comes after it. */
export const CONNECTION_ALERT_INTERVAL_MS = 24 * 60 * 60_000;
/** E-mails per incident: the alert and one reminder. */
export const MAX_CONNECTION_ALERTS = 2;
// More would be a mailing list, not a workspace's owners and admins.
const MAX_RECIPIENTS = 20;

/** What the alert needs of the account row. */
export interface AlertAccount {
  id: string;
  workspaceId: string;
  username: string;
  connectionLostAt: Date | null;
  connectionLostReason: string | null;
  connectionAlertSentAt: Date | null;
  connectionAlertCount: number;
}

/**
 * Which e-mail is due for the account's open incident, or null: the alert
 * while none went out for it, the reminder once, each only when the last
 * e-mail of the account is at least 24 hours old.
 */
export function connectionAlertDue(
  account: Pick<
    AlertAccount,
    "connectionLostAt" | "connectionAlertSentAt" | "connectionAlertCount"
  >,
  now: number
): ConnectionAlertKind | null {
  if (!account.connectionLostAt) return null;
  if (account.connectionAlertCount >= MAX_CONNECTION_ALERTS) return null;
  if (
    account.connectionAlertSentAt &&
    now - account.connectionAlertSentAt.getTime() < CONNECTION_ALERT_INTERVAL_MS
  ) {
    return null;
  }
  return account.connectionAlertCount === 0 ? "alert" : "reminder";
}

/**
 * Who gets the alert: the workspace's owners and admins, by their User
 * e-mail. The workspace's owner counts as one without a membership row, as
 * everywhere (lib/workspace-access.ts). Members never get it. Each address
 * once, in no particular order beyond the owner first.
 */
export async function connectionAlertRecipients(
  workspaceId: string
): Promise<string[]> {
  const [workspace, managers] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        owner: {
          select: {
            email: true,
            workspaceMembers: { where: { workspaceId }, select: { role: true } },
          },
        },
      },
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
      select: { user: { select: { email: true } } },
    }),
  ]);

  const owner = workspace?.owner;
  const ownerRole = owner?.workspaceMembers[0]?.role ?? "OWNER";
  const candidates = [
    ownerRole === "MEMBER" ? null : owner?.email,
    ...managers.map((manager) => manager.user.email),
  ];
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const candidate of candidates) {
    const address = candidate?.trim();
    if (!address || !/^[^@\s]+@[^@\s]+$/.test(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(address);
  }
  return recipients.slice(0, MAX_RECIPIENTS);
}

/** German for DEFAULT_LOCALE=de, English for anything else. */
export function alertLocale(
  env: Record<string, string | undefined> = process.env
): AlertLocale {
  return resolveLocale(env.DEFAULT_LOCALE) === "de" ? "de" : "en";
}

/** `{NEXTAUTH_URL}/settings`, or null when the worker has no app address. */
export function settingsUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  return base && /^https?:\/\//.test(base) ? `${base}/settings` : null;
}

/**
 * One e-mail to one person, the same for every try: the account, the
 * incident, which e-mail of it, and the person (hashed, so no address is
 * part of the key).
 */
export function connectionAlertIdempotencyKey({
  accountId,
  lostAt,
  number,
  to,
}: {
  accountId: string;
  lostAt: Date;
  number: number;
  to: string;
}): string {
  const person = createHash("sha256")
    .update(to.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `openreply-connection-alert/${accountId}/${lostAt.getTime()}/${number}/${person}`;
}

export type ConnectionAlertOutcome =
  /** No e-mail is due (none open, 24 hours not over, reminder sent). */
  | "not-due"
  /** The worker has no e-mail settings; nothing claimed. */
  | "no-mail"
  /** Nobody to send to; nothing claimed. */
  | "no-recipients"
  /** Another check claimed it first. */
  | "taken"
  | "sent"
  | "failed";

// Accounts already told about having nobody to e-mail, in this process.
const warnedNoRecipients = new Set<string>();

/**
 * Send the e-mail that is due for the account's open incident, if any.
 * Never throws for a failed send; a database error is thrown before anything
 * is sent.
 */
export async function sendConnectionAlert(
  account: AlertAccount,
  {
    now = Date.now(),
    transport = mailTransportFromEnv(),
    env = process.env,
  }: {
    now?: number;
    transport?: MailTransport | null;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<ConnectionAlertOutcome> {
  const kind = connectionAlertDue(account, now);
  const lostAt = account.connectionLostAt;
  if (!kind || !lostAt) return "not-due";

  if (!transport) {
    await warnMailNotConfigured();
    return "no-mail";
  }

  const recipients = await connectionAlertRecipients(account.workspaceId);
  if (recipients.length === 0) {
    if (!warnedNoRecipients.has(account.id)) {
      warnedNoRecipients.add(account.id);
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `Connection alert for @${account.username} not sent: the workspace has no owner or admin with an e-mail address`,
      });
    }
    return "no-recipients";
  }

  // The claim: exactly the state this decision was made on, so a second
  // check (or a reconnect that ended the incident) wins nothing here.
  const previousSentAt = account.connectionAlertSentAt;
  const previousCount = account.connectionAlertCount;
  const number = previousCount + 1;
  const sentAt = new Date(now);
  const claim = await prisma.instagramAccount.updateMany({
    where: {
      id: account.id,
      connectionLostAt: lostAt,
      connectionAlertCount: previousCount,
      connectionAlertSentAt: previousSentAt,
    },
    data: { connectionAlertSentAt: sentAt, connectionAlertCount: number },
  });
  if (claim.count !== 1) return "taken";

  const email = buildConnectionAlertEmail({
    locale: alertLocale(env),
    kind,
    username: account.username,
    lostAt,
    reason: connectionLostKind(account.connectionLostReason),
    settingsUrl: settingsUrl(env),
  });

  // One e-mail per person, one after the other: nobody sees the others'
  // addresses, and Resend's rate limit is not tested.
  const results: MailResult[] = [];
  for (const to of recipients) {
    results.push(
      await transport.send({
        to,
        ...email,
        idempotencyKey: connectionAlertIdempotencyKey({
          accountId: account.id,
          lostAt,
          number,
          to,
        }),
      })
    );
  }
  const failures = results.filter(
    (result): result is Extract<MailResult, { ok: false }> => !result.ok
  );
  const delivered = results.length - failures.length;
  const reminder = kind === "reminder";
  const what = reminder ? "Connection alert reminder" : "Connection alert";

  if (delivered > 0) {
    await logWorkerEvent({
      workspaceId: account.workspaceId,
      level: "INFO",
      message: `${what} e-mail for @${account.username} sent to ${delivered} ${delivered === 1 ? "person" : "people"} (${transport.name})`,
      payload: {
        kind: CONNECTION_ALERT_EVENT,
        account: account.username,
        recipients: delivered,
        reminder,
      },
    });
    if (failures.length > 0) {
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `${what} e-mail for @${account.username} not sent to ${failures.length} of ${results.length} (${transport.name}): ${failures.map((failure) => failure.error).join("; ")}`,
      });
    }
    return "sent";
  }

  // Nobody got it. Without an answer it may still go out: the claim goes
  // back and the next check tries again with the same keys. A refusal
  // keeps the claim.
  const retry = failures.some((failure) => failure.transient);
  if (retry) {
    await prisma.instagramAccount.updateMany({
      where: {
        id: account.id,
        connectionAlertSentAt: sentAt,
        connectionAlertCount: number,
      },
      data: {
        connectionAlertSentAt: previousSentAt,
        connectionAlertCount: previousCount,
      },
    });
  }
  await logWorkerEvent({
    workspaceId: account.workspaceId,
    level: "WARNING",
    message: `${what} e-mail for @${account.username} not sent (${transport.name}): ${failures.map((failure) => failure.error).join("; ")}; ${retry ? "the next check tries again" : "not tried again for this incident before 24 hours have passed"}`,
  });
  return "failed";
}

/** Tests: forget which accounts were warned about having no recipients. */
export function resetConnectionAlertWarnings(): void {
  warnedNoRecipients.clear();
}
