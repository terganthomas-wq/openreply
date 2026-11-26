/**
 * The e-mails about an account's incidents, shared by the lost connection
 * (A1: lib/ops/connection-alert.ts, lib/ops/connection-all-clear.ts) and the
 * messaging silence (A2: lib/ops/messaging-silence-alert.ts): who gets them,
 * when a warning is due, and how one is claimed before it is sent.
 *
 * - Who: every owner and admin of the workspace, by their User e-mail
 *   (incidentMailRecipients). Members never get one.
 * - When: the alert when an incident opens and one reminder 24 hours later,
 *   at most one warning per 24 hours per account and kind of incident, across
 *   incidents. A new incident after an all-clear gets its alert at once, but
 *   that happens at most once per 24 hours (incidentAlertDue).
 * - How: one conditional update of the account row takes the e-mail before
 *   it is sent, so two senders at once send it once. Each person gets an
 *   e-mail of their own (nobody sees the others' addresses) with an
 *   Idempotency-Key that is the same for every try. When nobody got it and a
 *   send got no answer (a timeout, 429, 5xx), the claim goes back and the next
 *   try uses the same keys, which Resend keeps for 24 hours: an e-mail that
 *   did go out is not sent twice. A refusal (any other 4xx) keeps the claim.
 *   Without e-mail settings or recipients nothing is claimed.
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { EmailContent } from "@/lib/ops/connection-alert-email";
import {
  warnMailNotConfigured,
  type MailResult,
  type MailTransport,
} from "@/lib/ops/mail";
import { logWorkerEvent } from "@/lib/queue/send-helpers";

/**
 * At most one warning e-mail per account and kind of incident in this time
 * (the alert after an all-clear aside, which is once in this time); the
 * reminder comes after it.
 */
export const INCIDENT_ALERT_INTERVAL_MS = 24 * 60 * 60_000;
/** E-mails per incident: the alert and one reminder. */
export const MAX_INCIDENT_ALERTS = 2;
// More would be a mailing list, not a workspace's owners and admins.
const MAX_RECIPIENTS = 20;

/** The first e-mail of an incident, or its one reminder after 24 hours. */
export type IncidentAlertKind = "alert" | "reminder";

/** What the warning rule looks at, whatever the kind of incident. */
export interface IncidentAlertState {
  /** The open incident's start; null while none is open. */
  openSince: Date | null;
  /** When the last warning e-mail of this kind went out, for any incident. */
  sentAt: Date | null;
  /** E-mails sent for the open incident. */
  count: number;
  /** When the last all-clear of this kind went out (absent: none known). */
  allClearSentAt?: Date | null;
  /** When the last alert of this kind went out early, after an all-clear. */
  rearmedAt?: Date | null;
}

/**
 * Whether a new incident's alert goes out inside the 24 hours of the last
 * warning: the all-clear came after that warning (the owners believe it is
 * over), and no alert went out early in the last 24 hours.
 */
export function incidentAlertRearmed(state: IncidentAlertState, now: number): boolean {
  const { sentAt, allClearSentAt, rearmedAt } = state;
  return (
    state.count === 0 &&
    Boolean(sentAt && allClearSentAt && allClearSentAt.getTime() > sentAt.getTime()) &&
    (!rearmedAt || now - rearmedAt.getTime() >= INCIDENT_ALERT_INTERVAL_MS)
  );
}

/**
 * Which e-mail is due for an open incident, or null: the alert while none
 * went out for it, the reminder once, each only when the last warning of this
 * kind is at least 24 hours old. A new incident after an all-clear gets its
 * alert at once (incidentAlertRearmed).
 */
export function incidentAlertDue(
  state: IncidentAlertState,
  now: number
): IncidentAlertKind | null {
  if (!state.openSince) return null;
  if (state.count >= MAX_INCIDENT_ALERTS) return null;
  if (state.sentAt && now - state.sentAt.getTime() < INCIDENT_ALERT_INTERVAL_MS) {
    return incidentAlertRearmed(state, now) ? "alert" : null;
  }
  return state.count === 0 ? "alert" : "reminder";
}

/**
 * Who gets the e-mails: the workspace's owners and admins, by their User
 * e-mail. The workspace's owner counts as one without a membership row, as
 * everywhere (lib/workspace-access.ts). Members never get them. Each address
 * once, in no particular order beyond the owner first.
 */
export async function incidentMailRecipients(workspaceId: string): Promise<string[]> {
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

/** A person in an Idempotency-Key: hashed, so no address is part of it. */
export function hashedRecipient(to: string): string {
  return createHash("sha256").update(to.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export type IncidentMailOutcome =
  /** The worker has no e-mail settings; nothing claimed. */
  | "no-mail"
  /** Nobody to send to; nothing claimed. */
  | "no-recipients"
  /** Another sender claimed it first. */
  | "taken"
  | "sent"
  | "failed";

/** One e-mail about an incident, from its claim to its log lines. */
export interface IncidentMail {
  account: { id: string; workspaceId: string; username: string };
  /** Names it in Diagnostics: "<label> e-mail for @account sent to …". */
  label: string;
  /** Names it when nobody can get it: "<noRecipientsLabel> for @account not sent: …". */
  noRecipientsLabel: string;
  /** Accounts already told about having nobody to e-mail, per process and kind. */
  warnedNoRecipients: Set<string>;
  transport: MailTransport | null;
  /** Takes the e-mail on the account row: true when this send has it. */
  claim(): Promise<boolean>;
  /** Gives the claim back after nobody got it and a send got no answer. */
  release(): Promise<void>;
  build(): EmailContent;
  /** The same for every try of this e-mail to this person. */
  idempotencyKey(to: string): string;
  /** The INFO event's payload; the number of recipients is added. */
  event: { kind: string } & Record<string, Prisma.InputJsonValue>;
  /** Once it reached someone, before the INFO event. Must not throw. */
  onDelivered?(): Promise<void>;
  /** How the WARNING after a failed send ends: when it goes out again. */
  retryNote: string;
  refusalNote: string;
}

/**
 * Send one e-mail about an incident to every owner and admin, claimed before
 * it is sent (see above). Never throws for a failed send; a database error is
 * thrown before anything is sent.
 */
export async function sendIncidentMail(mail: IncidentMail): Promise<IncidentMailOutcome> {
  const { account, transport, label } = mail;
  if (!transport) {
    await warnMailNotConfigured();
    return "no-mail";
  }

  const recipients = await incidentMailRecipients(account.workspaceId);
  if (recipients.length === 0) {
    if (!mail.warnedNoRecipients.has(account.id)) {
      mail.warnedNoRecipients.add(account.id);
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `${mail.noRecipientsLabel} for @${account.username} not sent: the workspace has no owner or admin with an e-mail address`,
      });
    }
    return "no-recipients";
  }

  if (!(await mail.claim())) return "taken";

  const email = mail.build();
  // One e-mail per person, one after the other: nobody sees the others'
  // addresses, and Resend's rate limit is not tested.
  const results: MailResult[] = [];
  for (const to of recipients) {
    results.push(
      await transport.send({ to, ...email, idempotencyKey: mail.idempotencyKey(to) })
    );
  }
  const failures = results.filter(
    (result): result is Extract<MailResult, { ok: false }> => !result.ok
  );
  const delivered = results.length - failures.length;
  const errors = failures.map((failure) => failure.error).join("; ");

  if (delivered > 0) {
    await mail.onDelivered?.();
    await logWorkerEvent({
      workspaceId: account.workspaceId,
      level: "INFO",
      message: `${label} e-mail for @${account.username} sent to ${delivered} ${delivered === 1 ? "person" : "people"} (${transport.name})`,
      payload: { ...mail.event, recipients: delivered },
    });
    if (failures.length > 0) {
      await logWorkerEvent({
        workspaceId: account.workspaceId,
        level: "WARNING",
        message: `${label} e-mail for @${account.username} not sent to ${failures.length} of ${results.length} (${transport.name}): ${errors}`,
      });
    }
    return "sent";
  }

  // Nobody got it. Without an answer it may still go out: the claim goes
  // back and the next try uses the same keys. A refusal keeps the claim.
  const retry = failures.some((failure) => failure.transient);
  if (retry) await mail.release();
  await logWorkerEvent({
    workspaceId: account.workspaceId,
    level: "WARNING",
    message: `${label} e-mail for @${account.username} not sent (${transport.name}): ${errors}; ${retry ? mail.retryNote : mail.refusalNote}`,
  });
  return "failed";
}
