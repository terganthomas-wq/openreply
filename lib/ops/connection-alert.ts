/**
 * The alert e-mail about a lost Instagram connection (A1).
 *
 * When the worker's check opens an incident (lib/instagram/connection-check.ts),
 * every owner and admin of the workspace gets an e-mail that says what
 * happened and how to reconnect (lib/ops/connection-alert-email.ts). If the
 * connection is still lost 24 hours later, one reminder follows, and then
 * no further warning for that incident; the all-clear after the catch-up
 * (lib/ops/connection-all-clear.ts) comes on top. At most one warning e-mail
 * per 24 hours per account, across incidents: a connection that keeps
 * dropping does not flood anyone's inbox, and the dashboard shows every
 * incident anyway. With one exception: when the owners were told the
 * connection is back (the all-clear went out after the last warning), a new
 * incident gets its alert at once, or their last e-mail would say "wieder
 * da" while nothing goes out. That happens at most once per 24 hours
 * (connectionAlertRearmedAt), so alert, all-clear, alert cannot loop.
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
 *
 * The rule, the recipients and the claimed send are shared with the e-mails
 * about a messaging silence (A2): lib/ops/incident-mail.ts.
 */

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
  hashedRecipient,
  incidentAlertDue,
  incidentAlertRearmed,
  incidentMailRecipients,
  INCIDENT_ALERT_INTERVAL_MS,
  MAX_INCIDENT_ALERTS,
  sendIncidentMail,
  type IncidentAlertState,
} from "@/lib/ops/incident-mail";
import { mailTransportFromEnv, type MailTransport } from "@/lib/ops/mail";

/**
 * At most one warning e-mail per account in this time (the alert after an
 * all-clear aside, which is once in this time); the reminder comes after it.
 */
export const CONNECTION_ALERT_INTERVAL_MS = INCIDENT_ALERT_INTERVAL_MS;
/** E-mails per incident: the alert and one reminder. */
export const MAX_CONNECTION_ALERTS = MAX_INCIDENT_ALERTS;

/** What the alert needs of the account row. */
export interface AlertAccount {
  id: string;
  workspaceId: string;
  username: string;
  connectionLostAt: Date | null;
  connectionLostReason: string | null;
  connectionAlertSentAt: Date | null;
  connectionAlertCount: number;
  /** When the last all-clear e-mail went out (absent: none known). */
  connectionAllClearSentAt?: Date | null;
  /** When the last alert went out early, after an all-clear. */
  connectionAlertRearmedAt?: Date | null;
}

type DueFields = Pick<
  AlertAccount,
  | "connectionLostAt"
  | "connectionAlertSentAt"
  | "connectionAlertCount"
  | "connectionAllClearSentAt"
  | "connectionAlertRearmedAt"
>;

/** The account's fields as the shared warning rule reads them. */
function alertState(account: DueFields): IncidentAlertState {
  return {
    openSince: account.connectionLostAt,
    sentAt: account.connectionAlertSentAt,
    count: account.connectionAlertCount,
    allClearSentAt: account.connectionAllClearSentAt,
    rearmedAt: account.connectionAlertRearmedAt,
  };
}

/**
 * Whether a new incident's alert goes out inside the 24 hours of the last
 * warning: the all-clear came after that warning (the owners believe the
 * connection works), and no alert went out early in the last 24 hours.
 */
export function connectionAlertRearmed(account: DueFields, now: number): boolean {
  return incidentAlertRearmed(alertState(account), now);
}

/**
 * Which e-mail is due for the account's open incident, or null: the alert
 * while none went out for it, the reminder once, each only when the last
 * warning e-mail of the account is at least 24 hours old. A new incident
 * after an all-clear gets its alert at once (connectionAlertRearmed).
 */
export function connectionAlertDue(
  account: DueFields,
  now: number
): ConnectionAlertKind | null {
  return incidentAlertDue(alertState(account), now);
}

/**
 * Who gets the alert: the workspace's owners and admins, by their User
 * e-mail (lib/ops/incident-mail.ts). Members never get it.
 */
export const connectionAlertRecipients = incidentMailRecipients;

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
  return `openreply-connection-alert/${accountId}/${lostAt.getTime()}/${number}/${hashedRecipient(to)}`;
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

  // The claim: exactly the state this decision was made on, so a second
  // check (or a reconnect that ended the incident) wins nothing here. An
  // alert inside the 24 hours (after an all-clear) records that it went out
  // early, which keeps the next early one 24 hours away.
  const previousSentAt = account.connectionAlertSentAt;
  const previousCount = account.connectionAlertCount;
  const previousRearmedAt = account.connectionAlertRearmedAt ?? null;
  const rearmed =
    previousSentAt !== null &&
    now - previousSentAt.getTime() < CONNECTION_ALERT_INTERVAL_MS;
  const number = previousCount + 1;
  const sentAt = new Date(now);
  const reminder = kind === "reminder";

  return sendIncidentMail({
    account,
    label: reminder ? "Connection alert reminder" : "Connection alert",
    noRecipientsLabel: "Connection alert",
    warnedNoRecipients,
    transport,
    claim: async () => {
      const claim = await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          connectionLostAt: lostAt,
          connectionAlertCount: previousCount,
          connectionAlertSentAt: previousSentAt,
          ...(rearmed ? { connectionAlertRearmedAt: previousRearmedAt } : {}),
        },
        data: {
          connectionAlertSentAt: sentAt,
          connectionAlertCount: number,
          ...(rearmed ? { connectionAlertRearmedAt: sentAt } : {}),
        },
      });
      return claim.count === 1;
    },
    release: async () => {
      await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          connectionAlertSentAt: sentAt,
          connectionAlertCount: number,
        },
        data: {
          connectionAlertSentAt: previousSentAt,
          connectionAlertCount: previousCount,
          ...(rearmed ? { connectionAlertRearmedAt: previousRearmedAt } : {}),
        },
      });
    },
    build: () =>
      buildConnectionAlertEmail({
        locale: alertLocale(env),
        kind,
        username: account.username,
        lostAt,
        reason: connectionLostKind(account.connectionLostReason),
        settingsUrl: settingsUrl(env),
      }),
    idempotencyKey: (to) =>
      connectionAlertIdempotencyKey({ accountId: account.id, lostAt, number, to }),
    event: { kind: CONNECTION_ALERT_EVENT, account: account.username, reminder },
    retryNote: "the next check tries again",
    refusalNote: "not tried again for this incident before 24 hours have passed",
  });
}

/** Tests: forget which accounts were warned about having no recipients. */
export function resetConnectionAlertWarnings(): void {
  warnedNoRecipients.clear();
}
