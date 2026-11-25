"use client";

/**
 * Key Expiry Notice
 *
 * Service keys that need a new one, on the API & MCP page and in
 * Diagnostics: keys that expire within 14 days, and keys that have expired
 * although something used them in the last 30 days, which is refused now
 * (lib/integrations/key-lifetime.ts). Revoking a key ends its warning.
 */

import Link from "next/link";
import { useI18n } from "@/lib/i18n/provider";
import {
  KEY_RECENT_USE_DAYS,
  type KeyExpiryWarning,
} from "@/lib/integrations/key-lifetime";
import { keyAccess, type KeyAccess } from "@/lib/integrations/scopes";

/**
 * The words for each kind of key, by its scopes: the API & MCP page's form
 * and key list, and this notice. A key with campaigns:write alone comes only
 * from the API. The offer editor names the sign-up key's access the same way.
 */
export const ACCESS_LABELS = {
  read: "Read only",
  write: "Read and write",
  createOnly: "Write only",
  signups: "Report sign-ups",
} as const satisfies Record<KeyAccess, string>;

/** A key that needs a new one, as the keys route and Diagnostics send it. */
export interface KeyNeedingAttention {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  warning: KeyExpiryWarning;
}

export default function KeyExpiryNotice({
  keys,
  linkToKeys = false,
  canManageKeys = true,
}: {
  keys: readonly KeyNeedingAttention[];
  /** Diagnostics points to the API & MCP page, where keys are made. */
  linkToKeys?: boolean;
  /**
   * Whether the reader may create and revoke keys: owners and admins. Every
   * member sees Diagnostics; a member is asked to have an owner or admin
   * replace the key, and gets no link to a page that would refuse them.
   */
  canManageKeys?: boolean;
}) {
  const { t, locale } = useI18n();
  if (keys.length === 0) return null;

  return (
    <section className="rounded border border-warning/30 bg-warning/10 p-4 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">
        {t("Keys are expiring")}
      </h2>
      <ul className="mt-3 space-y-1 text-sm text-foreground">
        {keys.map((key) => {
          const access = keyAccess(key.scopes);
          // Key names are the user's own words: never translated.
          const values = {
            name: key.name,
            access: access ? t(ACCESS_LABELS[access]) : key.scopes.join(" + "),
            date: new Date(key.expiresAt).toLocaleDateString(locale),
          };
          return (
            <li key={key.id} className="break-words">
              {key.warning === "expired"
                ? t(
                    "Key “{name}” ({access}) expired on {date}, but was used in the last {days} days.",
                    { ...values, days: KEY_RECENT_USE_DAYS }
                  )
                : t("Key “{name}” ({access}) expires on {date}.", values)}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-sm text-foreground">
        {canManageKeys
          ? t(
              "An expired key no longer works: your landing page, for example, can no longer report sign-ups. Create a new key in time, replace the old one wherever it is used, then revoke the old one."
            )
          : t(
              "An expired key no longer works: your landing page, for example, can no longer report sign-ups. Ask your workspace owner or an admin to create a new key in time and revoke the old one."
            )}
      </p>
      {linkToKeys && canManageKeys && (
        <Link
          href="/integrations"
          className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
        >
          {t("Open API & MCP")}
        </Link>
      )}
    </section>
  );
}
