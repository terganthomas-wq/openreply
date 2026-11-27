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
 * stands in for it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EffectCallback = () => void | (() => void);
interface RecordedEffect {
  effect: EffectCallback;
  deps: readonly unknown[] | undefined;
}

const hooks = vi.hoisted(() => ({ effects: [] as RecordedEffect[] }));
const nav = vi.hoisted(() => ({ pathname: "/contacts" }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: EffectCallback, deps?: readonly unknown[]) => {
      hooks.effects.push({ effect, deps });
    },
    useEffectEvent: <T>(callback: T) => callback,
  };
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

function returnToTab() {
  documentStub.visibilityState = "visible";
  documentListeners.get("visibilitychange")?.();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
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
