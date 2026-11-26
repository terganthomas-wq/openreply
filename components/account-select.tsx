"use client";

import { useI18n } from "@/lib/i18n/provider";


export interface AccountOption {
  id: string;
  username: string;
  instagramId: string;
  name?: string | null;
  /** How the account is connected: "META" or "ZERNIO" (absent: unknown). */
  provider?: string;
}

interface AccountSelectProps {
  accounts: AccountOption[];
  value: string;
  onChange: (value: string) => void;
  includeAll?: boolean;
  label?: string;
  /**
   * Shown as the choice while `value` is none of the accounts, so that every
   * account can be chosen (a select shows its first option otherwise, and
   * choosing that one changes nothing).
   */
  placeholder?: string;
}

export default function AccountSelect({
  accounts,
  value,
  onChange,
  includeAll = true,
  label,
  placeholder,
}: AccountSelectProps) {
  const { t } = useI18n();
  const unmatched =
    placeholder !== undefined &&
    !(includeAll && value === "all") &&
    !accounts.some((account) => account.id === value);
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label ?? t("Instagram account")}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-52 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
      >
        {unmatched && (
          <option value={value} disabled>
            {placeholder}
          </option>
        )}
        {includeAll && <option value="all">{t("All accounts")}</option>}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            @{account.username}
          </option>
        ))}
      </select>
    </label>
  );
}

