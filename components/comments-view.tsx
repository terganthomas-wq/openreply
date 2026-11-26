"use client";

/**
 * Kommentare (M1, "Manuell senden")
 *
 * The comments of the newest posts from the last 7 days, newest first, each
 * with where its DM stands, and per comment a campaign and "DM senden" for
 * the comments the keywords missed. The list is read when the page opens (and
 * on "Mehr laden", a reload or another account): never in the background.
 * After a send only the DM log is asked, every few seconds, until the
 * worker's outcome is in. Owners and admins only, like every send.
 */

import { useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import {
  COMMENTS_MAX_POSTS,
  COMMENTS_PAGE_POSTS,
} from "@/lib/comments/manual";
import {
  defaultCampaignId,
  defaultPublicReply,
  lastAttempt,
  manualSendSettled,
  relativeTime,
  sendBlock,
  withStatus,
  type CampaignOption,
  type CommentRow,
  type CommentsPageData,
  type CommentStatus,
  type PendingSend,
  type SendBlock,
} from "@/lib/comments/view";
import type { I18n } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

// How often, and how long, the page asks for a send's outcome.
const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 20;

type Filter = "without-dm" | "all";
type Failure = "forbidden" | "provider" | "no-account" | "error";

const NOTICE =
  "rounded border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning";
const CHIP_BASE = "px-3 py-1.5 rounded-lg text-xs font-medium transition-all";
const CHIP_ON = "bg-accent/15 text-accent border border-accent/20";
const CHIP_OFF =
  "bg-surface text-muted border border-border hover:border-border-hover hover:text-foreground";
const FIELD =
  "w-full min-w-0 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent/40 disabled:opacity-50";

function requestKey(...parts: (string | number | null)[]) {
  return JSON.stringify(parts);
}

function formatClock(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Why a send is not possible, in the reader's words. */
export function blockText(
  block: SendBlock,
  { t, locale }: Pick<I18n, "t" | "locale">
): string | null {
  switch (block.kind) {
    case "sent":
      return t("A DM for this comment already went out. Instagram allows only one per comment.");
    case "too-old":
      return t("Older than 7 days: Instagram no longer allows a DM.");
    case "paused":
      return t("Sending paused until {time}: Instagram limit reached.", {
        time: formatClock(block.until, locale),
      });
    case "attempts":
      return t("Instagram refused this campaign's DM three times. Choose another campaign.");
    // The empty campaign field and the greyed-out button say it already.
    case "no-campaign":
    case "sending":
      return null;
  }
}

/** A refused send (POST /api/instagram/comments/send), in the reader's words. */
export function refusalText(
  reason: string | undefined,
  pausedUntil: string | undefined,
  { t, locale }: Pick<I18n, "t" | "locale">
): string {
  switch (reason) {
    case "already_sent":
      return t("A DM for this comment already went out. Instagram allows only one per comment.");
    case "too_old":
      return t("Older than 7 days: Instagram no longer allows a DM.");
    case "paused":
      return pausedUntil
        ? t("Sending paused until {time}: Instagram limit reached.", {
            time: formatClock(pausedUntil, locale),
          })
        : t("Instagram limit reached. Try again in a few minutes.");
    case "attempts_used":
      return t("Instagram refused this campaign's DM three times. Choose another campaign.");
    case "own_comment":
      return t("That is your own comment.");
    case "comment_not_found":
      return t("Instagram no longer finds this comment. It may have been deleted.");
    case "foreign_media":
      return t("This comment is not under one of your newest posts.");
    case "not_comment_campaign":
      return t("This campaign has no DM text.");
    case "campaign_not_found":
      return t("This campaign no longer exists. Reload the page.");
    case "provider":
      return t("Sending by hand needs an account connected with your own Meta app.");
    case "worker_outdated":
      return t("The sending service is not updated yet. Try again later.");
    case "rate_limited":
      return t("Too many DMs in a short time. Wait a minute.");
    case "instagram_limit":
      return t("Instagram limit reached. Try again in a few minutes.");
    default:
      return t("Could not send the DM. Try again.");
  }
}

/** The status line of a comment: its DM, or its last try without one. */
function StatusLine({ row }: { row: CommentRow }) {
  const { t } = useI18n();
  if (row.delivery) {
    const campaign = row.delivery.campaignName;
    if (row.delivery.state === "sending") {
      return <span className="text-warning">{t("Sending…")}</span>;
    }
    return (
      <span className="text-success">
        {row.delivery.state === "unconfirmed"
          ? t("DM sent, not confirmed · {campaign}", { campaign })
          : row.delivery.manual
            ? t("DM sent by hand · {campaign}", { campaign })
            : t("DM sent · {campaign}", { campaign })}
      </span>
    );
  }
  const last = lastAttempt(row);
  const campaign = last?.campaignName ?? "";
  return (
    <span className="text-muted">
      {t("No DM")}
      {last && (
        <span className="block text-xs" title={last.errorMessage ?? undefined}>
          {last.status === "FAILED"
            ? t("Not sent with “{campaign}”: Instagram refused it.", { campaign })
            : last.status === "SKIPPED_DEDUP"
              ? t("Not sent with “{campaign}”: another campaign answers this comment.", { campaign })
              : last.status === "PENDING"
                ? t("Waiting to be sent with “{campaign}”.", { campaign })
                : t("Not sent with “{campaign}”.", { campaign })}
        </span>
      )}
    </span>
  );
}

export interface CommentCardProps {
  row: CommentRow;
  campaigns: CampaignOption[];
  /** The chosen campaign's id ("" for none). */
  campaignId: string;
  /** "Öffentlich antworten" as set (before the campaign is asked). */
  publicReply: boolean;
  sending: boolean;
  /** A refused send or a send without an outcome, in the reader's words. */
  notice: string | null;
  pausedUntil: string | null;
  /** The answer's time (ms): ages and the 7 days count from it. */
  now: number;
  onCampaignChange: (campaignId: string) => void;
  onPublicReplyChange: (on: boolean) => void;
  onSend: () => void;
}

/** One comment: who, what, when, its DM, and the manual send. */
export function CommentCard({
  row,
  campaigns,
  campaignId,
  publicReply,
  sending,
  notice,
  pausedUntil,
  now,
  onCampaignChange,
  onPublicReplyChange,
  onSend,
}: CommentCardProps) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const campaign = campaigns.find((option) => option.id === campaignId) ?? null;
  const block = sendBlock({ row, campaignId, pausedUntil, sending, now });
  const reason = block ? blockText(block, i18n) : null;
  // Nothing to choose any more once the DM is out or the 7 days are over.
  const settled = block?.kind === "sent" || block?.kind === "too-old";
  const replyAvailable = Boolean(campaign?.hasPublicReply);
  const selectId = `campaign-${row.id}`;
  const replyId = `public-reply-${row.id}`;

  return (
    <li className="panel rounded p-4 space-y-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="min-w-0 truncate font-medium text-foreground">
          {row.username ? `@${row.username}` : "—"}
        </span>
        <time
          dateTime={row.timestamp}
          title={new Date(row.timestamp).toLocaleString(locale)}
          className="text-xs text-muted"
        >
          {relativeTime(row.timestamp, now, locale)}
        </time>
        {row.permalink && (
          <a
            href={row.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted underline hover:text-foreground"
          >
            {t("View post")}
          </a>
        )}
      </div>

      {/* User content: never translated, wrapped at any character so a long
          word or link cannot widen the page. */}
      <p className="whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]">
        {row.text || t("(no text)")}
      </p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusLine row={row} />
        {row.ownerReplied && (
          <span className="rounded-md border border-border px-2 py-0.5 text-muted">
            {t("You replied")}
          </span>
        )}
        {row.question && (
          <span className="rounded-md border border-warning/20 bg-warning/10 px-2 py-0.5 text-warning">
            {t("Question")}
          </span>
        )}
        {row.match && !row.delivery && (
          <span className="max-w-full truncate rounded-md border border-accent/10 bg-accent/10 px-2 py-0.5 font-medium text-accent">
            {t("Matches: {campaign}", { campaign: row.match.name })}
          </span>
        )}
      </div>

      {!settled && (
        <div className="space-y-2">
          <label htmlFor={selectId} className="sr-only">
            {t("Campaign")}
          </label>
          <select
            id={selectId}
            value={campaignId}
            onChange={(event) => onCampaignChange(event.target.value)}
            disabled={sending}
            className={FIELD}
          >
            <option value="">{t("Choose a campaign")}</option>
            {campaigns.map((option) => (
              <option key={option.id} value={option.id}>
                {option.isActive
                  ? option.name
                  : t("{name} (paused)", { name: option.name })}
              </option>
            ))}
          </select>
          {campaign && !campaign.isActive && (
            <p className="text-xs text-muted">
              {t("This campaign is paused. Sending it by hand still works.")}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label
              htmlFor={replyId}
              className={`flex items-center gap-2 text-sm ${replyAvailable ? "text-foreground" : "text-muted"}`}
            >
              <input
                id={replyId}
                type="checkbox"
                checked={replyAvailable && publicReply}
                disabled={!replyAvailable || sending}
                onChange={(event) => onPublicReplyChange(event.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              {t("Reply publicly")}
            </label>
            <button
              type="button"
              onClick={onSend}
              disabled={block !== null}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:pointer-events-none"
            >
              {sending || block?.kind === "sending" ? t("Sending…") : t("Send DM")}
            </button>
          </div>
          {campaign && !replyAvailable && (
            <p className="text-xs text-muted">
              {t("This campaign has no public reply.")}
            </p>
          )}
        </div>
      )}

      {reason && <p className="text-xs text-muted">{reason}</p>}
      {notice && (
        <p role="status" className="text-xs text-error">
          {notice}
        </p>
      )}
    </li>
  );
}

/** Drop a comment's entry from a map of per-comment state. */
function without<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

export default function CommentsView() {
  const i18n = useI18n();
  const { t } = i18n;
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  // Null: the workspace's newest account, as the server picks it.
  const [accountId, setAccountId] = useState<string | null>(null);
  const [posts, setPosts] = useState(COMMENTS_PAGE_POSTS);
  const [filter, setFilter] = useState<Filter>("without-dm");
  const [reloads, setReloads] = useState(0);
  const [data, setData] = useState<CommentsPageData | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Per comment: the campaign and the public reply as changed by hand, the
  // sends under way, what a send answered, and newer statuses from polls.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [replies, setReplies] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Record<string, PendingSend>>({});
  const [starting, setStarting] = useState<Record<string, true>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, CommentStatus>>({});
  // Comments sent from here stay in "Ohne DM" until the next load.
  const [touched, setTouched] = useState<Record<string, true>>({});
  const [pollTick, setPollTick] = useState(0);

  const currentKey = requestKey(accountId, posts, reloads);
  const loading = loadedKey !== currentKey;

  useEffect(() => {
    let active = true;
    fetch("/api/instagram/accounts")
      .then((res) => res.json())
      .then((payload) => {
        if (active && payload?.success) {
          setAccounts(payload.data.instagramAccounts ?? []);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const key = requestKey(accountId, posts, reloads);
    const params = new URLSearchParams({ posts: String(posts) });
    if (accountId) params.set("instagramAccountId", accountId);
    fetch(`/api/instagram/comments?${params}`, { cache: "no-store" })
      .then(async (res) => ({
        status: res.status,
        payload: await res.json().catch(() => null),
      }))
      .then(({ status, payload }) => {
        if (!active) return;
        if (status === 403) return setFailure("forbidden");
        if (payload?.reason === "provider") return setFailure("provider");
        if (payload?.reason === "no_account") return setFailure("no-account");
        if (!payload?.success) return setFailure("error");
        setFailure(null);
        setData(payload.data as CommentsPageData);
        // The fresh list has the newest statuses.
        setStatuses({});
        setTouched({});
      })
      .catch(() => {
        if (active) setFailure("error");
      })
      .finally(() => {
        if (active) setLoadedKey(key);
      });
    return () => {
      active = false;
    };
  }, [accountId, posts, reloads]);

  // While sends wait for the worker: ask the DM log every few seconds, and
  // stop for each send once its outcome is in (or after a minute). Only the
  // sends this poll asked about change: a send started meanwhile stays.
  const pollAccountId = data?.account.id ?? null;
  useEffect(() => {
    const ids = Object.keys(pending);
    if (ids.length === 0 || !pollAccountId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        ids: ids.join(","),
        instagramAccountId: pollAccountId,
      });
      fetch(`/api/instagram/comments?${params}`, { cache: "no-store" })
        .then((res) => res.json())
        .then((payload) => {
          if (!active || !payload?.success) return;
          const fresh = payload.data.statuses as Record<string, CommentStatus>;
          const done = (entry: PendingSend, id: string) =>
            manualSendSettled(fresh[id], entry);
          const timedOut = ids.filter(
            (id) => !done(pending[id], id) && pending[id].polls + 1 >= MAX_POLLS
          );
          setStatuses((previous) => ({ ...previous, ...fresh }));
          setPending((previous) => {
            const next = { ...previous };
            for (const id of ids) {
              const entry = previous[id];
              if (!entry) continue;
              if (done(entry, id) || entry.polls + 1 >= MAX_POLLS) delete next[id];
              else next[id] = { ...entry, polls: entry.polls + 1 };
            }
            return next;
          });
          if (timedOut.length > 0) {
            setNotices((notes) => ({
              ...notes,
              ...Object.fromEntries(
                timedOut.map((id) => [id, t("No result yet. Reload the page in a moment.")])
              ),
            }));
          }
        })
        .catch(() => {})
        .finally(() => {
          if (active) setPollTick((tick) => tick + 1);
        });
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [pending, pollAccountId, pollTick, t]);

  function changeAccount(id: string) {
    setAccountId(id);
    setPosts(COMMENTS_PAGE_POSTS);
    setChoices({});
    setReplies({});
    setPending({});
    setNotices({});
  }

  async function send(row: CommentRow, campaignId: string, publicReply: boolean) {
    setStarting((map) => ({ ...map, [row.id]: true }));
    setNotices((map) => without(map, row.id));
    setTouched((map) => ({ ...map, [row.id]: true }));
    try {
      const res = await fetch("/api/instagram/comments/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commentId: row.id,
          automationId: campaignId,
          publicReply,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (res.status === 202 && payload?.success) {
        setPending((map) => ({
          ...map,
          [row.id]: {
            automationId: campaignId,
            previousUpdatedAt: payload.previousUpdatedAt ?? null,
            polls: 0,
          },
        }));
        return;
      }
      if (payload?.status) {
        const status = payload.status as CommentStatus;
        setStatuses((map) => ({ ...map, [row.id]: status }));
      }
      setNotices((map) => ({
        ...map,
        [row.id]: refusalText(payload?.reason, payload?.pausedUntil, i18n),
      }));
    } catch {
      setNotices((map) => ({ ...map, [row.id]: t("Could not send the DM. Try again.") }));
    } finally {
      setStarting((map) => without(map, row.id));
    }
  }

  if (failure === "forbidden") {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-muted">
          {t("Only owners and admins can see the comments here and send DMs.")}
        </p>
      </div>
    );
  }
  if (failure === "provider" || failure === "no-account") {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-muted">
          {failure === "provider"
            ? t("Sending by hand needs an account connected with your own Meta app.")
            : t("Connect an Instagram account first.")}
        </p>
      </div>
    );
  }

  const now = data ? Date.parse(data.generatedAt) : 0;
  const rows = (data?.comments ?? []).map((row) => withStatus(row, statuses[row.id]));
  const shown = rows.filter(
    (row) => filter === "all" || !row.delivery || touched[row.id]
  );

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-muted">
        {t("Send a campaign's DM by hand, for example for a comment without the exact keyword. Instagram allows one DM per comment, up to 7 days after the comment.")}
      </p>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {(["without-dm", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={`${CHIP_BASE} ${filter === value ? CHIP_ON : CHIP_OFF}`}
            >
              {value === "without-dm" ? t("Without DM") : t("All")}
            </button>
          ))}
        </div>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={accountId ?? data?.account.id ?? accounts[0]?.id ?? ""}
            onChange={changeAccount}
            includeAll={false}
          />
        )}
      </div>

      {data?.pausedUntil && (
        <p role="status" className={NOTICE}>
          {t("Sending paused until {time}: Instagram limit reached. The comments load again after that.", {
            time: formatClock(data.pausedUntil, i18n.locale),
          })}
        </p>
      )}
      {data?.readLimited && (
        <p role="status" className={NOTICE}>
          {t("Instagram limit reached while loading. Some posts are missing: try again in a few minutes.")}
        </p>
      )}
      {data && data.failedPosts > 0 && (
        <p role="status" className={NOTICE}>
          {t("Some posts could not be read.")}
        </p>
      )}

      {failure === "error" ? (
        <div className="panel rounded p-8 text-center">
          <p className="text-sm text-muted">{t("Could not load the comments.")}</p>
          <button
            type="button"
            onClick={() => setReloads((count) => count + 1)}
            disabled={loading}
            className="mt-4 rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            {t("Try again")}
          </button>
        </div>
      ) : !data ? (
        <div className="panel h-64 rounded" aria-busy="true" />
      ) : data.pausedUntil ? null : shown.length === 0 ? (
        <div className="panel rounded p-8 text-center">
          <p className="text-sm text-muted">
            {filter === "without-dm"
              ? t("No comments without a DM in the last 7 days.")
              : t("No comments in the last 7 days.")}
          </p>
        </div>
      ) : (
        <ul className={`space-y-3 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          {shown.map((row) => {
            const campaignId = choices[row.id] ?? defaultCampaignId(row, data.campaigns);
            const publicReply = replies[row.id] ?? defaultPublicReply(row);
            return (
              <CommentCard
                key={row.id}
                row={row}
                campaigns={data.campaigns}
                campaignId={campaignId}
                publicReply={publicReply}
                sending={Boolean(pending[row.id] || starting[row.id])}
                notice={notices[row.id] ?? null}
                pausedUntil={data.pausedUntil}
                now={now}
                onCampaignChange={(id) =>
                  setChoices((map) => ({ ...map, [row.id]: id }))
                }
                onPublicReplyChange={(on) =>
                  setReplies((map) => ({ ...map, [row.id]: on }))
                }
                onSend={() => {
                  const campaign = data.campaigns.find((option) => option.id === campaignId);
                  void send(row, campaignId, Boolean(campaign?.hasPublicReply) && publicReply);
                }}
              />
            );
          })}
        </ul>
      )}

      {data && data.hasMore && !data.pausedUntil && posts < COMMENTS_MAX_POSTS && (
        <div className="text-center">
          <button
            type="button"
            onClick={() =>
              setPosts((count) => Math.min(COMMENTS_MAX_POSTS, count + COMMENTS_PAGE_POSTS))
            }
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            {loading ? t("Loading…") : t("Load more")}
          </button>
        </div>
      )}
    </div>
  );
}
