"use client";

/**
 * Inbox
 *
 * Instagram DM conversations for the selected account, with message history
 * and a reply composer. Messages are read from the Conversations API (Meta
 * only exposes the 20 most recent per thread). Sending is subject to
 * Instagram's 24-hour messaging window — Meta's error is surfaced verbatim
 * when it applies.
 *
 * Reads are budgeted (lib/inbox/poll.ts; Meta submission plan, part B,
 * S1b): the list every 2 minutes while the tab is visible and used, stopped
 * after 10 idle minutes; the open thread when it opens, after an own send,
 * when the list shows it changed, and on "Refresh". The server allows 40
 * reads an hour per account and answers 429 inbox_budget beyond that; the
 * page then keeps what it shows and pauses until the given time. Sending by
 * hand is never blocked.
 */

import type { Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { readCache, writeCache } from "@/lib/client-cache";
import {
  CACHE_MAX_AGE_MS,
  LIST_POLL_MS,
  conversationChanged,
  inboxBudgetRetryAt,
  mergeConversationPage,
  pollState,
  readIsStale,
} from "@/lib/inbox/poll";
import type { ConversationListItem } from "@/app/api/instagram/conversations/route";
import type { ThreadMessage } from "@/app/api/instagram/conversations/[id]/route";

const convCacheKey = (accountId: string) => `inbox:convs:${accountId}`;
const msgCacheKey = (conversationId: string) => `inbox:msgs:${conversationId}`;

/**
 * "full" reads the whole list and replaces it (opening the Inbox, another
 * account, "Refresh"); "page" reads the newest page and puts it on top of
 * what is shown (the timer, a return to the tab, after a send).
 */
type ListRead = "full" | "page";

function formatTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function formatClock(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** A stored copy, but only while it is younger than CACHE_MAX_AGE_MS. */
function freshCache<T>(key: string): T | null {
  const cached = readCache<T>(key, CACHE_MAX_AGE_MS);
  return cached.data !== null && !cached.stale ? cached.data : null;
}

export default function InboxPage() {
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  // Seed from the last-used account so a revisit can paint the cached
  // conversation list immediately, before the account list even loads.
  const [selectedAccountId, setSelectedAccountId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem("inbox:selectedAccount") ?? "";
  });

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [convError, setConvError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // The list timer stopped after 10 minutes without input.
  const [idle, setIdle] = useState(false);
  // Until when the server refuses reads (its hourly budget is used up).
  const [budgetUntil, setBudgetUntil] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationRequests = useRef(new Set<string>());
  // What the callbacks below need as it is now, not as it was when they
  // were made: the account and conversation on screen, the list shown (the
  // base for telling whether the open thread changed), the last input and
  // list read, the end of a read pause, and the newest thread request.
  const accountRef = useRef("");
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<ConversationListItem[]>([]);
  const lastInputAtRef = useRef(0);
  const lastListReadAtRef = useRef(0);
  const budgetUntilRef = useRef(0);
  const threadRequestRef = useRef(0);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  // Accounts for the selector; default to the first connected account. Uses the
  // lightweight accounts endpoint (one query) rather than the heavy dashboard
  // stats aggregation, so the inbox isn't gated on analytics before it can load.
  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        setSelectedAccountId((prev) => {
          // Keep the seeded account only if it's still connected; otherwise
          // fall back to the default so a removed account can't wedge the inbox.
          const stillValid = prev && next.some((a) => a.id === prev);
          return stillValid
            ? prev
            : payload.data.selectedInstagramAccountId || next[0]?.id || "";
        });
      })
      .catch(() => setAccounts([]));
  }, []);

  // Remember the chosen account for the next visit.
  useEffect(() => {
    if (typeof window === "undefined" || !selectedAccountId) return;
    window.sessionStorage.setItem("inbox:selectedAccount", selectedAccountId);
  }, [selectedAccountId]);

  const pauseReads = useCallback((until: number) => {
    budgetUntilRef.current = until;
    setBudgetUntil(until);
  }, []);

  const endPause = useCallback(() => {
    if (!budgetUntilRef.current) return;
    budgetUntilRef.current = 0;
    setBudgetUntil(null);
  }, []);

  const selectConversation = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  // One read of a thread. Only the newest request paints, and only while its
  // conversation is still open. Opening one sets the loading state itself.
  const loadMessages = useCallback(
    async (conversationId: string) => {
      if (!selectedAccountId) return;
      const request = ++threadRequestRef.current;
      try {
        const res = await fetch(
          `/api/instagram/conversations/${conversationId}?instagramAccountId=${selectedAccountId}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        const pauseUntil = inboxBudgetRetryAt(res.status, data);
        if (pauseUntil !== null) {
          // Keep whatever is shown.
          pauseReads(pauseUntil);
          return;
        }
        if (data.success && request === threadRequestRef.current) {
          writeCache(msgCacheKey(conversationId), data.data.messages);
          if (activeIdRef.current === conversationId) setMessages(data.data.messages);
          endPause();
        }
      } catch {
        // keep whatever is shown
      } finally {
        // The newest read is done: whatever it found is shown now.
        if (request === threadRequestRef.current) setThreadLoading(false);
      }
    },
    [selectedAccountId, pauseReads, endPause]
  );

  // One read of the list. When the open conversation shows a change, its
  // thread is read too (unless the caller reads it anyway). Errors are shown
  // only where nothing is shown yet (`showErrors`, the first read); the
  // caller sets the loading state.
  const loadConversations = useCallback(
    async (
      read: ListRead,
      { showErrors = false, checkThread = true }: { showErrors?: boolean; checkThread?: boolean } = {}
    ) => {
      const accountId = selectedAccountId;
      if (!accountId || conversationRequests.current.has(accountId)) return;
      conversationRequests.current.add(accountId);
      try {
        const res = await fetch(
          `/api/instagram/conversations?instagramAccountId=${accountId}${read === "page" ? "&silent=1" : ""}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (accountRef.current !== accountId) return;
        const pauseUntil = inboxBudgetRetryAt(res.status, data);
        if (pauseUntil !== null) {
          // Keep whatever is shown.
          pauseReads(pauseUntil);
          return;
        }
        if (data.success) {
          const previous = conversationsRef.current;
          const fresh: ConversationListItem[] = data.data.conversations;
          const next = read === "page" ? mergeConversationPage(previous, fresh) : fresh;
          conversationsRef.current = next;
          lastListReadAtRef.current = Date.now();
          setConversations(next);
          writeCache(convCacheKey(accountId), next);
          setConvError(null);
          endPause();
          const open = activeIdRef.current;
          const openEntry = next.find((c) => c.id === open);
          const detailsBack = Boolean(
            previous.find((c) => c.id === open)?.detailsUnavailable
          );
          if (
            checkThread &&
            open &&
            openEntry &&
            !openEntry.detailsUnavailable &&
            (detailsBack || conversationChanged(previous, next, open))
          ) {
            void loadMessages(open);
          }
        } else if (showErrors) {
          setConvError(data.error ?? "Failed to load conversations");
        }
      } catch {
        if (showErrors && accountRef.current === accountId) {
          setConvError("Failed to load conversations");
        }
      } finally {
        conversationRequests.current.delete(accountId);
        // Any finished read of the account on screen ends its loading state.
        if (accountRef.current === accountId) setConvLoading(false);
      }
    },
    [selectedAccountId, loadMessages, pauseReads, endPause]
  );

  // Opening the Inbox or another account. A list stored less than a minute
  // ago is shown as it is (the timer reads next); an older one is not shown
  // at all, so a message unsent since cannot come back from it.
  useEffect(() => {
    if (!selectedAccountId) return;
    // Reset the open thread when switching accounts. This is an intentional
    // synchronous reset on a dependency change, not derived render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveId(null);
    activeIdRef.current = null;
    accountRef.current = selectedAccountId;
    lastInputAtRef.current = Date.now();
    lastListReadAtRef.current = 0;
    // The read budget is per account: another account starts unpaused.
    budgetUntilRef.current = 0;
    setBudgetUntil(null);
    setMessages([]);
    setIdle(false);
    setConvError(null);
    const cached = freshCache<ConversationListItem[]>(convCacheKey(selectedAccountId));
    if (cached) {
      conversationsRef.current = cached;
      setConversations(cached);
      setConvLoading(false);
      return;
    }
    conversationsRef.current = [];
    setConversations([]);
    setConvLoading(true);
    // Opened in a background tab: the first read waits until it is shown.
    if (document.visibilityState === "hidden") return;
    void loadConversations("full", { showErrors: true });
  }, [selectedAccountId, loadConversations]);

  // The timer's turn: read while the tab is visible and used; stop after 10
  // idle minutes; nothing while hidden or while the server pauses reads.
  const onTick = useEffectEvent(() => {
    // Stopped for idleness: only "Refresh" or a return to the tab resumes.
    if (idle) return;
    const now = Date.now();
    const state = pollState({
      visible: document.visibilityState === "visible",
      lastInputAt: lastInputAtRef.current,
      now,
    });
    if (state === "hidden") return;
    if (state === "idle") {
      setIdle(true);
      return;
    }
    if (now < budgetUntilRef.current) return;
    void loadConversations("page");
  });

  useEffect(() => {
    if (!selectedAccountId || idle) return;
    const timer = window.setInterval(() => onTick(), LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedAccountId, idle]);

  // Back on the tab: that is input, it ends an idle stop, and the list is
  // read once if its last read is older than a minute (the whole list when
  // nothing is shown yet, as in a tab opened in the background).
  const onReturn = useEffectEvent(() => {
    const now = Date.now();
    lastInputAtRef.current = now;
    setIdle(false);
    if (now < budgetUntilRef.current) return;
    if (!readIsStale(lastListReadAtRef.current, now)) return;
    const nothingShown = conversationsRef.current.length === 0;
    void loadConversations(nothingShown ? "full" : "page", { showErrors: nothingShown });
  });

  useEffect(() => {
    lastInputAtRef.current = Date.now();
    const noteInput = () => {
      lastInputAtRef.current = Date.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onReturn();
    };
    const inputs = ["pointerdown", "pointermove", "keydown", "focus", "focusin"] as const;
    for (const name of inputs) window.addEventListener(name, noteInput, { passive: true });
    // Scrolling the list or the thread: scroll events do not bubble.
    window.addEventListener("scroll", noteInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      for (const name of inputs) window.removeEventListener(name, noteInput);
      window.removeEventListener("scroll", noteInput, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // A read pause ends by itself at its time; the timer's rules decide then.
  const onPauseOver = useEffectEvent(() => {
    budgetUntilRef.current = 0;
    setBudgetUntil(null);
  });

  useEffect(() => {
    if (budgetUntil === null) return;
    const timer = window.setTimeout(() => {
      onPauseOver();
      onTick();
    }, Math.max(0, budgetUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [budgetUntil]);

  // Keep the thread pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // The open thread is read when it opens; there is no thread timer (a list
  // read reads it again when it shows a change).
  function openConversation(id: string) {
    selectConversation(id);
    setSendError(null);
    // Paint a recent stored thread synchronously so the pane never flashes
    // empty or shows the previously open conversation while the read runs.
    const cached = freshCache<ThreadMessage[]>(msgCacheKey(id));
    setMessages(cached ?? []);
    if (conversations.find((c) => c.id === id)?.detailsUnavailable) {
      setThreadLoading(false);
      return;
    }
    setThreadLoading(!cached);
    void loadMessages(id);
  }

  function handleRefresh() {
    lastInputAtRef.current = Date.now();
    setIdle(false);
    void loadConversations("full", { checkThread: false });
    const open = activeIdRef.current;
    if (open && !active?.detailsUnavailable) void loadMessages(open);
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !active?.contact.id || sending) return;
    setSending(true);
    setSendError(null);

    // Optimistically show the reply immediately, then confirm with the server.
    const optimistic: ThreadMessage = {
      id: `optimistic-${Date.now()}`,
      text,
      fromMe: true,
      fromUsername: null,
      createdTime: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");

    try {
      const res = await fetch("/api/instagram/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: selectedAccountId,
          recipientId: active.contact.id,
          text,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await loadMessages(active.id);
        // The thread was just read: the list's change is this send.
        void loadConversations("page", { checkThread: false });
      } else {
        // Roll the optimistic message back and restore the draft so it's not lost.
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setDraft(text);
        setSendError(data.error ?? t("Failed to send message"));
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      setSendError(t("Failed to send message"));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const pauseNote =
    budgetUntil !== null
      ? t("The Inbox pauses until {time} so that Instagram's request limit is not reached.", {
          time: formatClock(budgetUntil, locale),
        })
      : null;
  const statusNote = pauseNote ?? (idle ? t("Paused after 10 minutes without activity.") : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">{t("Inbox")}</h1>
          {statusNote && (
            <p role="status" className="mt-1 text-sm text-muted">
              {statusNote}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={setSelectedAccountId}
              includeAll={false}
            />
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={!selectedAccountId}
            className="rounded border border-border bg-surface px-3 py-2 text-sm font-semibold text-foreground transition hover:border-border-hover disabled:opacity-50"
          >
            {t("Refresh")}
          </button>
        </div>
      </div>

      <div className="grid h-[calc(100dvh-11rem)] grid-cols-1 overflow-hidden rounded border border-border sm:grid-cols-[300px_1fr]">
        {/* Conversation list. On mobile it takes the full pane and is hidden
            once a thread is open (ManyChat-style); on sm+ it is always shown. */}
        <div
          className={`min-h-0 flex-col border-b border-border sm:flex sm:border-b-0 sm:border-r ${
            active ? "hidden" : "flex"
          }`}
        >
          <div className="shrink-0 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
            {t("Conversations")}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {convLoading ? (
              <p className="px-4 py-6 text-sm text-muted">{t("Loading…")}</p>
            ) : convError ? (
              <p className="px-4 py-6 text-sm text-error">{convError === "Failed to load conversations" ? t("Failed to load conversations") : convError}</p>
            ) : conversations.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">{pauseNote ?? t("No conversations yet.")}</p>
            ) : (
              conversations.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openConversation(c.id)}
                    className={`block w-full border-b border-border px-4 py-3 text-left ${
                      isActive ? "bg-surface-hover" : "hover:bg-surface-hover"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {c.detailsUnavailable ? t("Details unavailable") : `@${c.contact.username ?? "unknown"}`}
                      </span>
                      <span className="shrink-0 text-[11px] text-zinc-500">
                        {formatTime(c.updatedTime, locale)}
                      </span>
                    </div>
                    {c.detailsUnavailable && (
                      <p className="mt-0.5 text-xs text-muted">{t("Instagram could not load this conversation.")}</p>
                    )}
                    {c.lastMessage && (
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {c.lastMessage.fromMe ? t("You: ") : ""}
                        {c.lastMessage.text || t("(no text)")}
                      </p>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Thread. On mobile it is only shown once a conversation is open and
            fills the pane; on sm+ it always sits beside the list. */}
        <div
          className={`min-h-0 flex-col ${active ? "flex" : "hidden sm:flex"}`}
        >
          {!active ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
              {t("Select a conversation to read and reply.")}
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
                <button
                  type="button"
                  onClick={() => selectConversation(null)}
                  className="-ml-1 rounded px-2 py-1 text-muted hover:text-foreground sm:hidden"
                  aria-label={t("Back to conversations")}
                >
                  {t("Back")}
                </button>
                <span className="truncate">
                  {active.detailsUnavailable ? t("Details unavailable") : `@${active.contact.username ?? "unknown"}`}
                </span>
              </div>

              <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
                {active.detailsUnavailable ? (
                  <p role="status" className="text-sm text-muted">
                    {t("Instagram could not load the details of this conversation. Other conversations are still available. You can check this chat in Instagram.")}
                  </p>
                ) : threadLoading && messages.length === 0 ? (
                  <p className="text-sm text-muted">{t("Loading…")}</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-muted">{pauseNote ?? t("No messages.")}</p>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                          m.fromMe
                            ? "bg-accent text-white"
                            : "bg-surface text-foreground border border-border"
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.text}</p>
                        <p
                          className={`mt-1 text-[10px] ${
                            m.fromMe ? "text-white/70" : "text-zinc-500"
                          }`}
                        >
                          {formatTime(m.createdTime, locale)}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="shrink-0 border-t border-border p-3">
                {sendError && (
                  <p className="mb-2 text-xs text-error">{sendError}</p>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    disabled={active.detailsUnavailable || !active.contact.id}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    placeholder={t("Write a reply…  (Enter to send, Shift+Enter for a new line)")}
                    className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={sending || !draft.trim() || !active.contact.id || active.detailsUnavailable}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    {sending ? t("Sending…") : t("Send")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
