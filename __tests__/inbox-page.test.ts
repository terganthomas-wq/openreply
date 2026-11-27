/**
 * The Inbox page's list reads and its browser copies, as the page wires them
 * (Meta submission plan, part B, review of rollout R1: the follow-ups to C1
 * and C2), and the dashboard shell's clean-up of those copies.
 *
 * The repository has no DOM renderer, so a component is rendered once on the
 * server and its effects are collected and run by hand, as React runs them
 * after mounting: React's useEffect is replaced by a recorder, useEffectEvent
 * by the function itself. State updates after that render are no-ops on the
 * server, so the page is followed through what it asks the server (fetch),
 * what it keeps in sessionStorage, its timers (faked) and its refs, which keep
 * their values as in a browser. A re-render that React would make after a
 * state change does not happen here: where the page's next step depends on
 * one (the timer that ends a read pause), the next turn of the list timer
 * stands in for it. To see what the page shows after its updates, a test can
 * keep the state (keepState) and render it again (shownMarkup); only the first
 * render's effects and handlers run, as they are the ones a browser would
 * still hold here. A click runs the handler that render gave the element
 * (the "Refresh" button's onClick).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EffectCallback = () => void | (() => void);
interface RecordedEffect {
  effect: EffectCallback;
  deps: readonly unknown[] | undefined;
}

const hooks = vi.hoisted(() => ({
  effects: [] as RecordedEffect[],
  // With keepState: useState's values by call order, kept across renders, so
  // a second render shows what the first one's updates changed. Without it,
  // React's own useState, whose updates after the render go nowhere.
  keepState: false,
  states: [] as unknown[],
  cursor: 0,
}));
// The elements of the renders, with their props.
const ui = vi.hoisted(() => ({
  elements: [] as { type: unknown; props: Record<string, unknown> }[],
}));
const nav = vi.hoisted(() => ({ pathname: "/contacts" }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const reactUseState = actual.useState as (initial: unknown) => [unknown, (next: unknown) => void];
  return {
    ...actual,
    useEffect: (effect: EffectCallback, deps?: readonly unknown[]) => {
      hooks.effects.push({ effect, deps });
    },
    useEffectEvent: <T>(callback: T) => callback,
    useState: (initial: unknown) => {
      if (!hooks.keepState) return reactUseState(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      const set = (next: unknown) => {
        hooks.states[index] =
          typeof next === "function" ? (next as (previous: unknown) => unknown)(hooks.states[index]) : next;
      };
      return [hooks.states[index], set];
    },
  };
});
// JSX compiles to these: every element is noted with its props.
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  const make = actual.jsxDEV as (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => unknown;
  return {
    ...actual,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      ui.elements.push({ type, props });
      return make(type, props, ...rest);
    },
  };
});
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  type Make = (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => unknown;
  const noted =
    (make: Make): Make =>
    (type, props, ...rest) => {
      ui.elements.push({ type, props });
      return make(type, props, ...rest);
    };
  return { ...actual, jsx: noted(actual.jsx as Make), jsxs: noted(actual.jsxs as Make) };
});
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import InboxPage from "../app/(dashboard)/inbox/page";
import DashboardShell from "../components/dashboard-shell";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const ACCOUNT = "account_1";
const FULL = `/api/instagram/conversations?instagramAccountId=${ACCOUNT}`;
const PAGE = `${FULL}&silent=1`;

class MemoryStorage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

interface Answer {
  status: number;
  json: () => Promise<unknown>;
  headers: { get: (name: string) => string | null };
}

function answer(body: unknown, status = 200, retryAfter: string | null = null): Answer {
  return {
    status,
    json: async () => body,
    headers: { get: (name) => (name.toLowerCase() === "retry-after" ? retryAfter : null) },
  };
}

function conversation(id: string, text: string) {
  return {
    id,
    contact: { id: `ig_${id}`, username: `user_${id}` },
    updatedTime: "2026-11-27T09:59:00+0000",
    lastMessage: { text, fromMe: false, createdTime: "2026-11-27T09:59:00+0000" },
  };
}

// What the copy shows: the second DM was unsent after the copy was stored.
const COPY = [conversation("c1", "Hallo"), conversation("c2", "Unsent since")];
const FRESH_LIST = [conversation("c1", "Hallo")];
const LISTED = answer({
  success: true,
  data: { conversations: FRESH_LIST, account: { id: ACCOUNT, username: "studio", instagramId: "ig_owner" } },
});

let storage: MemoryStorage;
let documentStub: { visibilityState: "visible" | "hidden"; addEventListener: unknown; removeEventListener: unknown };
let documentListeners: Map<string, () => void>;
let listAnswers: Answer[];
let fetchMock: ReturnType<typeof vi.fn>;
let mounted: (() => void)[];

function listReads(): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/instagram/conversations?"));
}

/** What a list copy in the tab's storage holds, or null. */
function storedList(): { data: unknown; ts: number } | null {
  const raw = storage.getItem(`inbox:convs:${ACCOUNT}`);
  return raw ? (JSON.parse(raw) as { data: unknown; ts: number }) : null;
}

function store(key: string, data: unknown, ts = Date.now()) {
  storage.setItem(key, JSON.stringify({ data, ts }));
}

/** The microtasks of the answered reads, then nothing is pending. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/**
 * Renders the component, then runs its effects in order as React does after
 * mounting. Returns the unmount: every cleanup, in order.
 */
function mount(element: ReturnType<typeof createElement>): () => void {
  hooks.effects.length = 0;
  hooks.states = [];
  hooks.cursor = 0;
  ui.elements.length = 0;
  renderToStaticMarkup(element);
  const cleanups: (() => void)[] = [];
  for (const { effect } of hooks.effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  const unmount = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  mounted.push(unmount);
  return unmount;
}

function openInbox(): () => void {
  return mount(createElement(InboxPage));
}

/** What a click on "Refresh" runs: the handler the first render gave it. */
function refreshButton(): () => void {
  const button = ui.elements.find(
    (element) => element.type === "button" && element.props.children === "Refresh"
  );
  if (!button) throw new Error("no Refresh button was rendered");
  return button.props.onClick as () => void;
}

/**
 * The Inbox as it shows now (keepState): rendered again with the state its
 * updates left. That render's effects are dropped.
 */
function shownMarkup(): string {
  hooks.cursor = 0;
  const html = renderToStaticMarkup(createElement(InboxPage));
  hooks.effects.length = 0;
  return html;
}

/** The header's status line, or null. */
function statusLine(html: string): string | null {
  return /<p role="status"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? null;
}

function returnToTab() {
  documentStub.visibilityState = "visible";
  documentListeners.get("visibilitychange")?.();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  hooks.keepState = false;
  storage = new MemoryStorage();
  documentListeners = new Map();
  documentStub = {
    visibilityState: "visible",
    addEventListener: (name: string, listener: () => void) => documentListeners.set(name, listener),
    removeEventListener: (name: string) => documentListeners.delete(name),
  };
  listAnswers = [];
  mounted = [];
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/instagram/accounts") {
      return answer({
        success: true,
        data: {
          instagramAccounts: [{ id: ACCOUNT, username: "studio", instagramId: "ig_owner" }],
          selectedInstagramAccountId: ACCOUNT,
        },
      });
    }
    if (url.startsWith("/api/instagram/conversations?")) return listAnswers.shift() ?? LISTED;
    return answer({ success: false, error: "not in this test" }, 404);
  });
  vi.stubGlobal("window", {
    sessionStorage: storage,
    // next/image's development check resolves the sidebar logo against it.
    location: { href: "https://dm.example.test/contacts" },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (callback: () => void, ms?: number) => setInterval(callback, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a list copy painted on opening the Inbox", () => {
  /** The account last used in this tab, with a list copy stored `age` ago. */
  function copyStoredAgo(age: number) {
    storage.setItem("inbox:selectedAccount", ACCOUNT);
    store(`inbox:convs:${ACCOUNT}`, COPY, NOW - age);
  }

  it("is the reference: an open without a copy reads the whole list at once", async () => {
    storage.setItem("inbox:selectedAccount", ACCOUNT);
    openInbox();
    await settle();
    expect(listReads()).toEqual([FULL]);
  });

  it("stands in until it is a minute old; then the whole list is read, as an open without a copy reads it", async () => {
    copyStoredAgo(40 * SECOND);
    openInbox();
    await advance(20 * SECOND - 1);
    expect(listReads()).toEqual([]);

    await advance(1);
    // Not the timer's one-page read, which a conversation Meta cannot expand
    // (upstream #60) makes fail: the whole list, narrowed down by the server.
    expect(listReads()).toEqual([FULL]);
    expect(storedList()).toEqual({ data: FRESH_LIST, ts: NOW + 20 * SECOND });

    // One such read per open: the timer's turns read the newest page again.
    await advance(120 * SECOND - 20 * SECOND);
    expect(listReads()).toEqual([FULL, PAGE]);
  });

  it("is read that way once, also when that read fails", async () => {
    copyStoredAgo(40 * SECOND);
    listAnswers.push(answer({ success: false, error: "Instagram could not be reached" }, 500));
    openInbox();
    await advance(20 * SECOND);
    expect(listReads()).toEqual([FULL]);

    await advance(100 * SECOND);
    expect(listReads()).toEqual([FULL, PAGE]);
  });

  it("in a tab hidden at that minute: the whole list is read on the return", async () => {
    copyStoredAgo(40 * SECOND);
    documentStub.visibilityState = "hidden";
    openInbox();
    await advance(5 * MINUTE);
    expect(listReads()).toEqual([]);

    returnToTab();
    await settle();
    expect(listReads()).toEqual([FULL]);
  });

  it("while reads are paused at that minute: the copy stays, and the first read after the pause is the whole list", async () => {
    copyStoredAgo(40 * SECOND);
    listAnswers.push(
      answer(
        { success: false, code: "inbox_budget", retryAt: new Date(NOW + MINUTE).toISOString() },
        429,
        "30"
      )
    );
    openInbox();
    await advance(20 * SECOND);
    expect(listReads()).toEqual([FULL]);
    // Refused: nothing was read, so nothing replaces the copy.
    expect(storedList()).toEqual({ data: COPY, ts: NOW - 40 * SECOND });

    // The timer's first turn after the pause.
    await advance(100 * SECOND);
    expect(listReads()).toEqual([FULL, FULL]);
    expect(storedList()).toEqual({ data: FRESH_LIST, ts: NOW + 120 * SECOND });
  });

  it("is not read again when a read replaced it before its minute", async () => {
    copyStoredAgo(10 * SECOND);
    openInbox();
    documentStub.visibilityState = "hidden";
    await advance(5 * SECOND);
    returnToTab();
    await settle();
    // The return reads, and it reads what an open without a copy reads.
    expect(listReads()).toEqual([FULL]);

    // The copy's minute: nothing more.
    await advance(50 * SECOND);
    expect(listReads()).toEqual([FULL]);
    await advance(120 * SECOND - 55 * SECOND);
    expect(listReads()).toEqual([FULL, PAGE]);
  });
});

describe("a whole list read that the hour's budget cut short", () => {
  const ACCOUNT_INFO = { id: ACCOUNT, username: "studio", instagramId: "ig_owner" };
  // 50 conversations shown; the budget had room for 9 of the newest.
  const SHOWN = Array.from({ length: 50 }, (_, i) => conversation(`shown_${i}`, "Shown"));
  const READ = Array.from({ length: 9 }, (_, i) => conversation(`read_${i}`, "New"));
  const ids = (list: unknown) => (list as { id: string }[]).map((c) => c.id);
  /** The server's answer: what it read, and until when the budget is used up. */
  const cutShort = (retryAfterSeconds: number) =>
    answer(
      {
        success: true,
        data: { conversations: READ, account: ACCOUNT_INFO },
        partial: { retryAt: new Date(Date.now() + retryAfterSeconds * SECOND).toISOString() },
      },
      200,
      String(retryAfterSeconds)
    );

  it("at the copy's minute: goes on top of the copy, pauses, and the first read after the pause is the whole list", async () => {
    storage.setItem("inbox:selectedAccount", ACCOUNT);
    store(`inbox:convs:${ACCOUNT}`, SHOWN, NOW - 40 * SECOND);
    listAnswers.push(cutShort(200));
    openInbox();

    await advance(20 * SECOND);
    expect(listReads()).toEqual([FULL]);
    // Nothing shown is lost: the 9 on top, then the copy's newest 41.
    const kept = storedList()?.data;
    expect(ids(kept)).toEqual([...ids(READ), ...ids(SHOWN).slice(0, 41)]);

    // The reads pause until the budget allows them again.
    await advance(100 * SECOND);
    expect(listReads()).toEqual([FULL]);

    // The first turn after the pause reads the whole list, as for the copy.
    await advance(120 * SECOND);
    expect(listReads()).toEqual([FULL, FULL]);
    expect(storedList()?.data).toEqual(FRESH_LIST);
  });

  it("after Refresh: keeps the list shown with what it read on top, and pauses", async () => {
    storage.setItem("inbox:selectedAccount", ACCOUNT);
    listAnswers.push(answer({ success: true, data: { conversations: SHOWN, account: ACCOUNT_INFO } }));
    openInbox();
    const refresh = refreshButton();
    await settle();
    expect(ids(storedList()?.data)).toEqual(ids(SHOWN));

    listAnswers.push(cutShort(200));
    refresh();
    await settle();
    expect(listReads()).toEqual([FULL, FULL]);
    expect(ids(storedList()?.data)).toEqual([...ids(READ), ...ids(SHOWN).slice(0, 41)]);

    // Paused at the timer's turn; after the pause the newest page, as usual.
    await advance(120 * SECOND);
    expect(listReads()).toEqual([FULL, FULL]);
    await advance(120 * SECOND);
    expect(listReads()).toEqual([FULL, FULL, PAGE]);
  });
});

describe("what the header says while the list is not up to date", () => {
  const LOST = answer(
    {
      success: false,
      code: "connection_lost",
      connectionLostAt: new Date(NOW - 60 * MINUTE).toISOString(),
      error: "The connection to Instagram is lost. Reconnect first.",
    },
    409
  );

  beforeEach(() => {
    hooks.keepState = true;
    storage.setItem("inbox:selectedAccount", ACCOUNT);
  });

  it("a failed Refresh keeps the list and says the conversations could not be loaded, until a read answers", async () => {
    openInbox();
    const refresh = refreshButton();
    await settle();
    expect(statusLine(shownMarkup())).toBeNull();

    listAnswers.push(answer({ success: false, error: "Instagram could not be reached" }, 500));
    refresh();
    await settle();
    const html = shownMarkup();
    expect(statusLine(html)).toBe("Failed to load conversations");
    expect(html).toContain("@user_c1");
    expect(storedList()?.data).toEqual(FRESH_LIST);

    refresh();
    await settle();
    expect(statusLine(shownMarkup())).toBeNull();
  });

  it("a lost connection on a later read: the list stays and the header says why", async () => {
    openInbox();
    await settle();
    listAnswers.push(LOST);

    // The timer's read.
    await advance(120 * SECOND);
    expect(listReads()).toEqual([FULL, PAGE]);
    const html = shownMarkup();
    expect(statusLine(html)).toBe("The connection to Instagram is lost. Reconnect first.");
    expect(html).toContain("@user_c1");
  });

  it("a lost connection on opening: said in the list's place", async () => {
    listAnswers.push(LOST);
    openInbox();
    await settle();

    expect(shownMarkup()).toContain(
      '<p class="px-4 py-6 text-sm text-error">The connection to Instagram is lost. Reconnect first.</p>'
    );
  });
});

describe("the Inbox's copies after leaving the Inbox", () => {
  /** Copies of a visit two minutes ago, one of a moment ago, other keys. */
  function visitCopies() {
    store("inbox:convs:account_1", COPY);
    store("inbox:msgs:thread_a", [{ text: "Unsent since" }]);
    vi.setSystemTime(NOW + 2 * MINUTE);
    store("inbox:msgs:thread_b", [{ text: "Read a moment ago" }]);
    storage.setItem("inbox:selectedAccount", ACCOUNT);
    store("posts:account_1", ["post"], NOW - 60 * MINUTE);
  }

  const KEPT = ["inbox:msgs:thread_b", "inbox:selectedAccount", "posts:account_1"];

  it("leaving the Inbox removes its copies older than a minute and keeps every other key", () => {
    // No account chosen yet: the page reads nothing, so only leaving it can
    // remove a copy here.
    const leave = openInbox();
    visitCopies();

    leave();

    expect([...storage.items.keys()].sort()).toEqual(KEPT);
  });

  /** The client shell the layout renders around every dashboard page. */
  function shell() {
    // A .ts test has no JSX, and the shell's props require children.
    // eslint-disable-next-line react/no-children-prop
    return createElement(DashboardShell, {
      workspaceName: "Studio",
      instagramUsername: "studio",
      instagramAccountCount: 1,
      canManage: true,
      children: createElement("p", null, "page"),
    });
  }

  it("opening any dashboard page removes them too", () => {
    visitCopies();
    nav.pathname = "/contacts";

    mount(shell());

    expect([...storage.items.keys()].sort()).toEqual(KEPT);
  });

  it("and so does every later page the dashboard navigates to", () => {
    // The layout keeps the shell mounted while the dashboard navigates, and
    // the shell renders again with the new path. React then runs an effect
    // again when one of its dependencies changed (Object.is), and only then.
    const renderOn = (pathname: string) => {
      nav.pathname = pathname;
      hooks.effects.length = 0;
      renderToStaticMarkup(shell());
      return hooks.effects.splice(0);
    };
    const changed = (before: RecordedEffect | undefined, after: RecordedEffect) =>
      !before?.deps ||
      !after.deps ||
      before.deps.length !== after.deps.length ||
      before.deps.some((dep, i) => !Object.is(dep, after.deps?.[i]));

    const onInbox = renderOn("/inbox");
    for (const { effect } of onInbox) effect();
    // The visit's copies, written while the shell stayed on the Inbox.
    visitCopies();

    const onContacts = renderOn("/contacts");
    for (const [i, next] of onContacts.entries()) {
      if (changed(onInbox[i], next)) next.effect();
    }

    expect([...storage.items.keys()].sort()).toEqual(KEPT);
  });
});
