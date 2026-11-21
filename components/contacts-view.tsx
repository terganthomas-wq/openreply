"use client";

/**
 * Contacts List
 *
 * Everyone who commented a keyword, tapped a button or sent a DM (R1), one
 * row per connected account, with their tags (R2). The search (a handle, or
 * a whole IGSID) runs on the server, debounced; the tag and account filters
 * narrow it further. The Offers page's funnel opens it with ?tag=.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import {
  CONTACT_SEARCH_MIN_LENGTH,
  CONTACTS_PAGE_SIZE,
  contactSearchTerm,
} from "@/lib/contacts/query";
import { useI18n } from "@/lib/i18n/provider";

const SEARCH_DELAY_MS = 300;
// Tags a row shows; the rest are counted.
const TAGS_PER_ROW = 3;

const FILTER_LABEL =
  "text-xs font-semibold uppercase tracking-wide text-zinc-500";
const FILTER_FIELD =
  "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 outline-none focus:border-accent/40";
const PAGE_BUTTON =
  "px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground hover:border-border-hover disabled:opacity-30 disabled:pointer-events-none";

interface ContactRow {
  id: string;
  igsid: string;
  username: string | null;
  lastInteractionAt: string | null;
  updatedAt: string;
  instagramAccount: { username: string };
  tags: { tag: string; createdAt: string }[];
}

interface TagCount {
  tag: string;
  count: number;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Which list a response belongs to; the list is loading until the response
// for the current one is in.
function requestKey(...parts: (string | number)[]) {
  return JSON.stringify(parts);
}

export default function ContactsView({
  initialTag,
  initialQuery,
}: {
  initialTag: string;
  initialQuery: string;
}) {
  const { t, locale } = useI18n();
  // What is typed, and the search it became once typing paused.
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState(() => contactSearchTerm(initialQuery));
  const [tag, setTag] = useState(initialTag);
  const [accountId, setAccountId] = useState("all");
  const [page, setPage] = useState(1);
  const [reloads, setReloads] = useState(0);

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [tagCounts, setTagCounts] = useState<TagCount[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [failed, setFailed] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const currentKey = requestKey(search, tag, accountId, page, reloads);
  const loading = loadedKey !== currentKey;

  useEffect(() => {
    let active = true;
    fetch("/api/instagram/accounts")
      .then((res) => res.json())
      .then((payload) => {
        if (active && payload.success) {
          setAccounts(payload.data.instagramAccounts ?? []);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // A pause in typing starts the search; under two characters it lists
  // everyone again.
  useEffect(() => {
    const term = contactSearchTerm(query);
    if (term === search) return;
    const timer = window.setTimeout(() => {
      setSearch(term);
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, search]);

  useEffect(() => {
    let active = true;
    const key = requestKey(search, tag, accountId, page, reloads);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(CONTACTS_PAGE_SIZE),
    });
    if (search) params.set("q", search);
    if (tag) params.set("tag", tag);
    if (accountId !== "all") params.set("instagramAccountId", accountId);

    fetch(`/api/contacts?${params}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => {
        if (!active) return;
        if (!payload?.success) {
          setFailed(true);
          return;
        }
        const data = payload.data as {
          contacts: ContactRow[];
          pagination: Pagination;
          tagCounts?: TagCount[];
        };
        setFailed(false);
        setContacts(data.contacts);
        setPagination(data.pagination);
        if (data.tagCounts) setTagCounts(data.tagCounts);
        // Past the last page (the list shrank meanwhile): show the last one.
        const { totalPages } = data.pagination;
        if (data.contacts.length === 0 && totalPages > 0 && page > totalPages) {
          setPage(totalPages);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoadedKey(key);
      });
    return () => {
      active = false;
    };
  }, [search, tag, accountId, page, reloads]);

  function changeTag(value: string) {
    setTag(value);
    setPage(1);
  }

  function changeAccount(value: string) {
    setAccountId(value);
    setPage(1);
  }

  function clearFilters() {
    setQuery("");
    setSearch("");
    setTag("");
    setAccountId("all");
    setPage(1);
  }

  function formatTime(value: string) {
    return new Date(value).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  const typed = query.trim().replace(/^@+/, "");
  const searchTooShort = typed.length > 0 && contactSearchTerm(query) === "";
  const filtered = Boolean(search || tag || accountId !== "all");
  const total = pagination?.total ?? 0;
  // In the reader's alphabet: the database sorts by its own collation. A tag
  // from a link may have no contacts (yet): it stays selectable.
  const collator = new Intl.Collator(locale);
  const sortedTags = [...tagCounts].sort((a, b) => collator.compare(a.tag, b.tag));
  const tagOptions =
    tag && !tagCounts.some((entry) => entry.tag === tag)
      ? [{ tag, count: null }, ...sortedTags]
      : sortedTags;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          {pagination
            ? t(total === 1 ? "{count} contact" : "{count} contacts", {
                count: total.toLocaleString(locale),
              })
            : t("Loading…")}
        </p>
        <p className="max-w-2xl text-xs text-muted">
          {t("Everyone who commented a keyword, tapped a button or sent you a DM, per connected account. Tags show what they got.")}
        </p>
      </div>

      {/* Filters: stacked on phones, one row from sm. */}
      <div className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
            <span className={FILTER_LABEL}>{t("Search")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Username or Instagram ID")}
              autoComplete="off"
              enterKeyHint="search"
              className={FILTER_FIELD}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm sm:w-56">
            <span className={FILTER_LABEL}>{t("Tag")}</span>
            {/* Tag names are the user's own words: never translated. */}
            <select
              value={tag}
              onChange={(event) => changeTag(event.target.value)}
              className={FILTER_FIELD}
            >
              <option value="">{t("All tags")}</option>
              {tagOptions.map((entry) => (
                <option key={entry.tag} value={entry.tag}>
                  {entry.count === null
                    ? entry.tag
                    : `${entry.tag} (${entry.count.toLocaleString(locale)})`}
                </option>
              ))}
            </select>
          </label>
          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts}
              value={accountId}
              onChange={changeAccount}
            />
          )}
        </div>
        {searchTooShort && (
          <p className="text-xs text-muted">
            {t("Type at least {count} characters to search.", {
              count: CONTACT_SEARCH_MIN_LENGTH,
            })}
          </p>
        )}
      </div>

      {failed ? (
        <div className="panel rounded p-8 text-center">
          <p className="text-sm text-muted">{t("Could not load the contacts.")}</p>
          <button
            type="button"
            onClick={() => setReloads((count) => count + 1)}
            disabled={loading}
            className="mt-4 rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            {t("Try again")}
          </button>
        </div>
      ) : !pagination || (loading && contacts.length === 0) ? (
        // Until the first list, or the next one after an empty list: its
        // empty state might not fit the new filters.
        <div className="panel h-64 rounded" />
      ) : contacts.length === 0 ? (
        filtered ? (
          <div className="panel rounded p-8 text-center">
            <p className="text-sm text-muted">
              {t("No contacts match these filters.")}
            </p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
            >
              {t("Clear filters")}
            </button>
          </div>
        ) : (
          <div className="panel rounded p-8 text-center sm:p-12">
            <h3 className="mb-2 text-lg font-semibold">{t("No contacts yet")}</h3>
            <p className="mx-auto max-w-md text-sm text-muted">
              {t("Contacts appear here once someone comments a keyword, taps a button or sends you a DM.")}
            </p>
          </div>
        )
      ) : (
        <div
          className={`panel overflow-hidden rounded ${loading ? "opacity-60" : ""}`}
          aria-busy={loading}
        >
          {/* Five columns don't fit a phone: the table keeps its width and
              scrolls inside the panel. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-4 text-xs font-semibold uppercase tracking-wider text-muted sm:px-6">{t("Contact")}</th>
                  <th className="px-4 py-4 text-xs font-semibold uppercase tracking-wider text-muted sm:px-6">{t("Account")}</th>
                  <th className="px-4 py-4 text-xs font-semibold uppercase tracking-wider text-muted sm:px-6">{t("Tags")}</th>
                  <th className="px-4 py-4 text-xs font-semibold uppercase tracking-wider text-muted sm:px-6">{t("Last tap or DM")}</th>
                  <th className="px-4 py-4 text-xs font-semibold uppercase tracking-wider text-muted sm:px-6">{t("Last seen")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {contacts.map((contact) => {
                  // The filtered tag first, so a row shows why it is listed.
                  const tags = tag
                    ? [...contact.tags].sort(
                        (a, b) => Number(b.tag === tag) - Number(a.tag === tag)
                      )
                    : contact.tags;
                  const shown = tags.slice(0, TAGS_PER_ROW);
                  const more = tags.length - shown.length;
                  return (
                    <tr key={contact.id} className="hover:bg-surface-hover/50">
                      <td className="px-4 py-3 sm:px-6">
                        <Link
                          href={`/contacts/${contact.id}`}
                          prefetch={false}
                          className="font-medium text-foreground hover:text-accent"
                        >
                          {contact.username ? (
                            `@${contact.username}`
                          ) : (
                            <span className="font-mono text-xs">{contact.igsid}</span>
                          )}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted sm:px-6">
                        @{contact.instagramAccount.username}
                      </td>
                      <td className="px-4 py-3 sm:px-6">
                        {shown.length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          // Chips keep their width (up to 12rem), so the
                          // column grows instead of cutting every tag short.
                          <div className="flex max-w-sm flex-wrap gap-1">
                            {shown.map((entry) => (
                              <span
                                key={entry.tag}
                                title={entry.tag}
                                className="max-w-[12rem] shrink-0 truncate rounded-md border border-accent/10 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
                              >
                                {entry.tag}
                              </span>
                            ))}
                            {more > 0 && (
                              <span
                                title={t("{count} more tags", { count: more })}
                                className="rounded-md border border-border px-2 py-0.5 text-xs text-muted"
                              >
                                +{more}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted sm:px-6">
                        {contact.lastInteractionAt
                          ? formatTime(contact.lastInteractionAt)
                          : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted sm:px-6">
                        {formatTime(contact.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
              <p className="text-xs text-muted">
                {t("Showing {start}–{end} of {total}", {
                  start: (pagination.page - 1) * pagination.limit + 1,
                  end: Math.min(pagination.page * pagination.limit, pagination.total),
                  total: pagination.total,
                })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage(page - 1)}
                  className={PAGE_BUTTON}
                >
                  {t("Previous")}
                </button>
                <span className="px-2 text-xs text-muted">
                  {page} / {pagination.totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= pagination.totalPages || loading}
                  onClick={() => setPage(page + 1)}
                  className={PAGE_BUTTON}
                >
                  {t("Next")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
