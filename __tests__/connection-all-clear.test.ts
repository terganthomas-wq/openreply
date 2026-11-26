/**
 * The all-clear e-mail after a lost Instagram connection (A1): who gets it
 * (owners and admins only, each once), what it says in German with "du" and
 * in English (how long, how many comments get their DM, the comments the
 * owner answered by hand with author, text, time and the post, the link to
 * the Kommentare page, what was left out), and that it goes out once per
 * catch-up: claimed before the send, given back without an answer, kept after
 * a refusal, dropped when it is no longer news.
 *
 * Resend is fetch answered here: nothing leaves the test. The account rows
 * evaluate the claim's conditions (helpers/fake-connection-db.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConnectionDb, fakeAccount } from "./helpers/fake-connection-db";

const state = vi.hoisted(() => ({
  db: null as unknown as import("./helpers/fake-connection-db").FakeConnectionDb,
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db.prisma;
  },
}));

import type { CatchUpResult, OwnerAnsweredComment } from "../lib/instagram/catch-up-state";
import { EMPTY_SKIPPED } from "../lib/instagram/catch-up-state";
import {
  allClearIdempotencyKey,
  commentsPageUrl,
  resetAllClearWarnings,
  sendConnectionAllClear,
} from "../lib/ops/connection-all-clear";
import {
  buildAllClearEmail,
  formatDowntime,
  type AllClearEmailInput,
} from "../lib/ops/connection-all-clear-email";
import { RESEND_EMAILS_URL, resetMailWarnings } from "../lib/ops/mail";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOST_AT = new Date("2026-11-25T16:45:00.000Z");
const RECOVERED = new Date("2026-11-25T20:50:00.000Z");
const FINISHED = new Date("2026-11-25T21:05:00.000Z");
const NOW = FINISHED.getTime() + MINUTE;
const FORMAL = /\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/;

const ANNA: OwnerAnsweredComment = {
  commentId: "c_anna",
  username: "anna",
  text: "Guide bitte",
  timestamp: "2026-11-25T17:02:00.000Z",
  permalink: "https://www.instagram.com/p/p1/",
};

function catchUpResult(overrides: Partial<CatchUpResult> = {}): CatchUpResult {
  return {
    v: 1,
    lostAt: LOST_AT.toISOString(),
    recoveredAt: RECOVERED.toISOString(),
    finishedAt: FINISHED.toISOString(),
    since: new Date(LOST_AT.getTime() - 45 * MINUTE).toISOString(),
    queued: 3,
    firstJobAt: FINISHED.toISOString(),
    lastJobAt: new Date(FINISHED.getTime() + 40_000).toISOString(),
    ownerAnswered: [ANNA],
    ownerAnsweredTotal: 1,
    posts: 30,
    pages: 31,
    skipped: { ...EMPTY_SKIPPED },
    complete: true,
    ...overrides,
  };
}

function input(overrides: Partial<AllClearEmailInput> = {}): AllClearEmailInput {
  return {
    locale: "de",
    username: "thomas.tergan",
    lostAt: LOST_AT,
    recoveredAt: RECOVERED,
    queued: 3,
    ownerAnswered: [ANNA],
    ownerAnsweredTotal: 1,
    skipped: { ...EMPTY_SKIPPED },
    commentsUrl: "https://dm.example.test/comments",
    ...overrides,
  };
}

let resendCalls: { init: RequestInit; body: Record<string, unknown> }[];
let resendAnswer: (call: number) => Response | Promise<Response>;

function warnings() {
  return state.db.events.filter((event) => event.level === "WARNING");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.db = new FakeConnectionDb();
  state.db.accounts.push(
    fakeAccount({
      connectionRecoveredAt: RECOVERED,
      connectionCatchUpResult: catchUpResult(),
      connectionAllClearDueAt: FINISHED,
    })
  );
  state.db.users.push(
    { id: "u_owner", email: "owner@example.test" },
    { id: "u_admin", email: "admin@example.test" },
    { id: "u_member", email: "member@example.test" }
  );
  state.db.workspaces.push({ id: "workspace_1", ownerId: "u_owner" });
  state.db.members.push(
    { workspaceId: "workspace_1", userId: "u_owner", role: "OWNER", createdAt: new Date(NOW - 3 * HOUR) },
    { workspaceId: "workspace_1", userId: "u_admin", role: "ADMIN", createdAt: new Date(NOW - 2 * HOUR) },
    { workspaceId: "workspace_1", userId: "u_member", role: "MEMBER", createdAt: new Date(NOW - HOUR) }
  );
  resendCalls = [];
  resendAnswer = (call) => Response.json({ id: `email_${call}` });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== RESEND_EMAILS_URL) throw new Error(`unexpected request to ${String(input)}`);
      resendCalls.push({ init: init ?? {}, body: JSON.parse(String(init?.body)) });
      return resendAnswer(resendCalls.length);
    })
  );
  vi.stubEnv("RESEND_API_KEY", "re_test_only");
  vi.stubEnv("EMAIL_FROM", "OpenReply <alerts@example.test>");
  vi.stubEnv("EMAIL_SERVER", "");
  vi.stubEnv("NEXTAUTH_URL", "https://dm.example.test/");
  vi.stubEnv("DEFAULT_LOCALE", "de");
  resetMailWarnings();
  resetAllClearWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("who gets it", () => {
  it("every owner and admin once, never a member, each with a key of their own", async () => {
    expect(await sendConnectionAllClear("account_1")).toBe("sent");

    expect(resendCalls.map((call) => call.body.to)).toEqual([
      ["owner@example.test"],
      ["admin@example.test"],
    ]);
    for (const call of resendCalls) {
      const to = (call.body.to as string[])[0];
      expect(call.init.headers).toMatchObject({
        Authorization: "Bearer re_test_only",
        "Idempotency-Key": allClearIdempotencyKey({ accountId: "account_1", finishedAt: FINISHED, to }),
      });
      expect(call.body.from).toBe("OpenReply <alerts@example.test>");
      // The key only in the header, no address in the key.
      expect(JSON.stringify(call.body)).not.toContain("re_test_only");
      expect(String((call.init.headers as Record<string, string>)["Idempotency-Key"])).not.toContain("@");
    }
    expect(state.db.account().connectionAllClearDueAt).toBeNull();
    const [sent] = state.db.events.filter((event) => event.payload?.kind === "connection-all-clear");
    expect(sent).toMatchObject({
      level: "INFO",
      payload: { kind: "connection-all-clear", account: "thomas.tergan", recipients: 2 },
    });
    expect(sent.message).not.toContain("@example.test");
  });

  it("links the Kommentare page of the app", () => {
    expect(commentsPageUrl({ NEXTAUTH_URL: "https://dm.example.test/" })).toBe(
      "https://dm.example.test/comments"
    );
    expect(commentsPageUrl({})).toBeNull();
    expect(commentsPageUrl({ NEXTAUTH_URL: "dm.example.test" })).toBeNull();
  });
});

describe("what it says", () => {
  it("in German with du: back, how long in Berlin time, how many, the answered comments and the way to send them", () => {
    const email = buildAllClearEmail(input());
    expect(email.subject).toBe("Instagram-Verbindung wieder da: OpenReply sendet wieder DMs");
    expect(email.text).toContain("die Verbindung zu deinem Instagram-Konto @thomas.tergan ist wieder da.");
    expect(email.text).toContain(
      "Die Unterbrechung dauerte etwa 4 Stunden und 5 Minuten: am 25.11.2026 von 17:45 bis 21:50 Uhr."
    );
    expect(email.text).toContain(
      "3 Kommentare mit deinen Keywords bekommen ihre DM jetzt nach und nach, etwa eine alle 2,5 Minuten."
    );
    expect(email.text).toContain(
      "Auf einen Kommentar hast du in der Zwischenzeit selbst geantwortet. OpenReply schickt ihm keine automatische DM, falls du den Guide schon von Hand geschickt hast:"
    );
    expect(email.text).toContain(
      "- @anna am 25.11.2026 um 18:02 Uhr: „Guide bitte“ (Beitrag ansehen: https://www.instagram.com/p/p1/)"
    );
    expect(email.text).toContain(
      "Soll jemand davon die DM doch noch bekommen? Dann schick sie auf der Seite „Kommentare“ mit „DM senden“: https://dm.example.test/comments"
    );
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toMatch(FORMAL);
      expect(part).not.toContain("Automatische Nachricht");
    }
    // The same in HTML, with the post and the Kommentare page as plain links.
    expect(email.html).toContain('<html lang="de">');
    expect(email.html).toContain('<a href="https://www.instagram.com/p/p1/"');
    expect(email.html).toContain('<a href="https://dm.example.test/comments"');
    expect(email.html).toContain("Kommentare öffnen");
    // No image, no tracking.
    expect(email.html).not.toMatch(/<img|utm_|\/r\//);
  });

  it("in English with UTC for every other locale", () => {
    expect(buildAllClearEmail(input({ locale: "en" })).text).toContain(
      "3 comments with your keywords get their DM now, one after the other, about one every 2.5 minutes."
    );
    const email = buildAllClearEmail(input({ locale: "en", queued: 1 }));
    expect(email.subject).toBe("Instagram connection is back: OpenReply is sending DMs again");
    expect(email.text).toContain("The connection to your Instagram account @thomas.tergan is back.");
    expect(email.text).toContain(
      "It was lost for about 4 hours and 5 minutes: on 25 November 2026 from 16:45 to 20:50 UTC."
    );
    expect(email.text).toContain("1 comment with your keywords gets its DM now.");
    expect(email.text).toContain("- @anna on 25 November 2026, 17:02 UTC: “Guide bitte” (View post: https://www.instagram.com/p/p1/)");
    expect(email.text).toContain("Send it on the Comments page with “Send DM”: https://dm.example.test/comments");
  });

  it("says when nothing needed a DM, and lists no one when the owner answered none", () => {
    const email = buildAllClearEmail(input({ queued: 0, ownerAnswered: [], ownerAnsweredTotal: 0 }));
    expect(email.text).toContain(
      "OpenReply hat die Kommentare aus dieser Zeit durchgesehen: Für keinen davon musste eine DM nachgeholt werden."
    );
    expect(email.text).not.toContain("selbst geantwortet");
    expect(email.text).not.toContain("/comments");
  });

  it("names what the catch-up left out and asks for a look on the Kommentare page", () => {
    const email = buildAllClearEmail(
      input({
        skipped: { ...EMPTY_SKIPPED, olderPosts: true, postsNotRead: 2, postsFailed: 1, tooOld: 4, notQueued: 5 },
      })
    );
    expect(email.text).toContain("Beiträge, die älter sind als deine neuesten 300, hat OpenReply nicht durchgesehen.");
    expect(email.text).toContain("Bei 3 Beiträgen konnte OpenReply die Kommentare nicht vollständig lesen.");
    expect(email.text).toContain("4 Kommentare waren älter als 7 Tage. Darauf erlaubt Instagram keine DM mehr.");
    expect(email.text).toContain("5 weitere Kommentare hat OpenReply nicht mehr eingeplant, weil es schon zu viele waren.");
    expect(email.text).toContain(
      "Schau auf der Seite „Kommentare“ nach, ob noch jemand auf eine DM wartet: https://dm.example.test/comments"
    );
    expect(buildAllClearEmail(input({ skipped: { ...EMPTY_SKIPPED, gaveUp: true } })).text).toContain(
      "OpenReply hat es nach 24 Stunden beendet"
    );
  });

  it("lists 50 comments by name and counts the rest, and escapes what it puts into HTML", () => {
    const many = Array.from({ length: 53 }, (_, index) => ({
      ...ANNA,
      commentId: `c${index}`,
      text: index === 0 ? "<script>alert(1)</script> & mehr" : `Kommentar ${index}`,
    }));
    const email = buildAllClearEmail(input({ ownerAnswered: many, ownerAnsweredTotal: 60 }));
    expect(email.text.match(/^- @anna/gm)).toHaveLength(50);
    expect(email.text).toContain("… und 10 weitere, die du in der Diagnose von OpenReply findest.");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; mehr");
    expect(email.html).not.toContain("<script>");
  });

  it("says how long in words a reader would use", () => {
    expect(formatDowntime(45 * MINUTE, "de")).toBe("45 Minuten");
    expect(formatDowntime(30 * 1000, "de")).toBe("1 Minute");
    expect(formatDowntime(62 * MINUTE, "de")).toBe("1 Stunde");
    expect(formatDowntime(4 * HOUR + 3 * MINUTE, "de")).toBe("4 Stunden und 5 Minuten");
    expect(formatDowntime(50 * HOUR, "de")).toBe("2 Tage und 2 Stunden");
    expect(formatDowntime(72 * HOUR, "en")).toBe("3 days");
    // Across midnight in Berlin: both dates.
    expect(
      buildAllClearEmail(input({ recoveredAt: new Date("2026-11-26T07:10:00.000Z") })).text
    ).toContain("vom 25.11.2026 um 17:45 Uhr bis zum 26.11.2026 um 08:10 Uhr.");
  });
});

describe("once per catch-up", () => {
  it("goes out once when two senders want it at the same moment", async () => {
    const outcomes = await Promise.all([
      sendConnectionAllClear("account_1"),
      sendConnectionAllClear("account_1"),
    ]);
    expect(outcomes.sort()).toEqual(["sent", "taken"]);
    expect(resendCalls).toHaveLength(2);
    // A connection lost again from now on gets its alert at once.
    expect(state.db.account().connectionAllClearSentAt).toEqual(new Date(NOW));
  });

  it("is owed again when Resend does not answer, and the next try uses the same keys", async () => {
    resendAnswer = () => new Response(JSON.stringify({ message: "busy" }), { status: 503 });
    expect(await sendConnectionAllClear("account_1")).toBe("failed");
    expect(state.db.account().connectionAllClearDueAt).toEqual(FINISHED);
    // Only an all-clear that reached someone counts for the next alert.
    expect(state.db.account().connectionAllClearSentAt).toBeNull();
    expect(warnings().at(-1)?.message).toContain("the next sweep tries again");
    const keys = resendCalls.map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"]);

    resendAnswer = (call) => Response.json({ id: `email_${call}` });
    vi.setSystemTime(NOW + 30 * MINUTE);
    expect(await sendConnectionAllClear("account_1")).toBe("sent");
    expect(
      resendCalls.slice(2).map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"])
    ).toEqual(keys);
  });

  it("is not tried again after a refusal", async () => {
    resendAnswer = () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 });
    expect(await sendConnectionAllClear("account_1")).toBe("failed");
    expect(state.db.account().connectionAllClearDueAt).toBeNull();
    expect(state.db.account().connectionAllClearSentAt).toBeNull();
    expect(await sendConnectionAllClear("account_1")).toBe("not-due");
    expect(resendCalls).toHaveLength(2);
  });

  it("without e-mail settings warns once per process and keeps it owed until they are there", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendConnectionAllClear("account_1")).toBe("no-mail");
    expect(await sendConnectionAllClear("account_1")).toBe("no-mail");
    expect(warnings().filter((event) => event.payload?.kind === "mail-unconfigured")).toHaveLength(1);
    expect(state.db.account().connectionAllClearDueAt).toEqual(FINISHED);

    vi.stubEnv("RESEND_API_KEY", "re_test_only");
    expect(await sendConnectionAllClear("account_1")).toBe("sent");
  });

  it("keeps it owed when nobody can be e-mailed, and says so once", async () => {
    state.db.members = state.db.members.filter((member) => member.role === "MEMBER");
    state.db.users.find((user) => user.id === "u_owner")!.email = null;
    expect(await sendConnectionAllClear("account_1")).toBe("no-recipients");
    expect(await sendConnectionAllClear("account_1")).toBe("no-recipients");
    expect(warnings()).toHaveLength(1);
    expect(state.db.account().connectionAllClearDueAt).toEqual(FINISHED);
    expect(resendCalls).toHaveLength(0);
  });

  it("is dropped after 24 hours, when the connection is lost again, or without a catch-up to report", async () => {
    vi.setSystemTime(FINISHED.getTime() + 25 * HOUR);
    expect(await sendConnectionAllClear("account_1")).toBe("dropped");
    expect(state.db.account().connectionAllClearDueAt).toBeNull();
    expect(warnings().at(-1)?.message).toContain("it could not go out within 24 hours");

    vi.setSystemTime(NOW);
    Object.assign(state.db.account(), {
      connectionAllClearDueAt: FINISHED,
      connectionLostAt: new Date(NOW - MINUTE),
    });
    expect(await sendConnectionAllClear("account_1")).toBe("dropped");
    expect(warnings().at(-1)?.message).toContain("the connection is lost again");

    Object.assign(state.db.account(), {
      connectionAllClearDueAt: FINISHED,
      connectionLostAt: null,
      connectionCatchUpResult: { something: "else" },
    });
    expect(await sendConnectionAllClear("account_1")).toBe("dropped");
    expect(resendCalls).toHaveLength(0);
  });
});
