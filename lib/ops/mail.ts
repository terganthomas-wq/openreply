/**
 * E-mail from the worker: the alert about a lost Instagram connection (A1,
 * lib/ops/connection-alert.ts).
 *
 * The same transport as the sign-in e-mails (lib/auth.ts): SMTP when
 * EMAIL_SERVER is set (that is what such a deployment signs in with),
 * otherwise Resend's HTTP API with RESEND_API_KEY. Both need EMAIL_FROM,
 * which the web app already uses. Without them nothing is sent, and the
 * worker records one WARNING per process start (warnMailNotConfigured).
 *
 * Nothing secret leaves here: the key goes only into Resend's Authorization
 * header, and error texts drop e-mail addresses and the SMTP URL before they
 * are logged.
 */

import type { SendMailOptions } from "nodemailer";
import { formatError, logWorkerEvent } from "@/lib/queue/send-helpers";
import { MAIL_UNCONFIGURED_EVENT } from "@/lib/ops/event-details";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
// How long a send may take before it counts as no answer.
const SEND_TIMEOUT_MS = 15_000;
// A generic client name: no person or installation in it.
const USER_AGENT = "OpenReply-Worker";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * The same for every try of one e-mail to one person: Resend sends an
   * e-mail with a key it has seen in the last 24 hours only once.
   */
  idempotencyKey: string;
}

export type MailResult =
  | { ok: true }
  | {
      ok: false;
      /** No answer, a 429 or a 5xx: worth another try later. */
      transient: boolean;
      /** Why, for logs and Diagnostics: no address, no key. */
      error: string;
    };

export interface MailTransport {
  readonly name: "resend" | "smtp";
  send(message: MailMessage): Promise<MailResult>;
}

const ADDRESS = /[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/g;

/** An error text without e-mail addresses and without the given secrets. */
export function redactMailError(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("<redacted>");
  }
  return out.replace(ADDRESS, "<address>").slice(0, 300);
}

function resendTransport(apiKey: string, from: string): MailTransport {
  return {
    name: "resend",
    async send(message) {
      let response: Response;
      try {
        response = await fetch(RESEND_EMAILS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            // An automatic notice (RFC 3834): no out-of-office replies to it.
            headers: { "Auto-Submitted": "auto-generated" },
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        return {
          ok: false,
          transient: true,
          error: redactMailError(`Resend: ${formatError(error)}`, [apiKey]),
        };
      }
      if (response.ok) return { ok: true };
      // The same key on its way or already sent: that e-mail went out once.
      if (response.status === 409) return { ok: true };
      const body = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const detail =
        typeof body?.message === "string" ? body.message : response.statusText;
      return {
        ok: false,
        transient: response.status === 429 || response.status >= 500,
        error: redactMailError(`Resend ${response.status}: ${detail}`, [apiKey]),
      };
    },
  };
}

type SendMail = (options: SendMailOptions) => Promise<unknown>;

function smtpTransport(server: string, from: string): MailTransport {
  let sender: Promise<SendMail> | null = null;
  const secrets = [server];
  try {
    const url = new URL(server);
    secrets.push(decodeURIComponent(url.password), url.password);
  } catch {
    // Not a URL: only the whole value is kept out of the logs.
  }
  return {
    name: "smtp",
    async send(message) {
      try {
        // Loaded on the first SMTP send only: Resend deployments never need it.
        sender ??= import("nodemailer").then((nodemailer) => {
          const createTransport =
            nodemailer.createTransport ?? nodemailer.default.createTransport;
          const transporter = createTransport(server);
          return (options) => transporter.sendMail(options);
        });
        await (await sender)({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: { "Auto-Submitted": "auto-generated" },
        });
        return { ok: true };
      } catch (error) {
        const code = (error as { responseCode?: unknown } | null)?.responseCode;
        return {
          ok: false,
          // A 5xx from the server is a refusal; anything else may pass later.
          transient: !(typeof code === "number" && code >= 500),
          error: redactMailError(`SMTP: ${formatError(error)}`, secrets),
        };
      }
    },
  };
}

/**
 * The worker's mail transport, or null when it has none: SMTP with
 * EMAIL_SERVER, else Resend with RESEND_API_KEY, each with EMAIL_FROM.
 */
export function mailTransportFromEnv(
  env: Record<string, string | undefined> = process.env
): MailTransport | null {
  const from = env.EMAIL_FROM?.trim();
  if (!from) return null;
  const server = env.EMAIL_SERVER?.trim();
  if (server) return smtpTransport(server, from);
  const apiKey = env.RESEND_API_KEY?.trim();
  if (apiKey) return resendTransport(apiKey, from);
  return null;
}

let warnedNotConfigured = false;

/**
 * One WARNING per process start that the worker cannot send e-mail: it
 * shows in every workspace's Diagnostics. Any warning e-mail about
 * Instagram may be the first to meet it (lib/ops/incident-mail.ts): about a
 * lost connection (A1) or about missing button taps (A2), an alert or an
 * all-clear. The e-mail itself is skipped, not used up: after the settings
 * are added and the worker restarted, the next check sends it.
 */
export async function warnMailNotConfigured(): Promise<void> {
  if (warnedNotConfigured) return;
  warnedNotConfigured = true;
  const message =
    "No warning e-mail about Instagram (a lost connection or missing button taps) can go out: the worker has no e-mail settings (RESEND_API_KEY and EMAIL_FROM, or EMAIL_SERVER and EMAIL_FROM, in its .env)";
  console.warn(`[Mail] ${message}`);
  await logWorkerEvent({
    workspaceId: null,
    level: "WARNING",
    message,
    payload: { kind: MAIL_UNCONFIGURED_EVENT },
  });
}

/** Tests: forget that the warning was recorded in this process. */
export function resetMailWarnings(): void {
  warnedNotConfigured = false;
}
