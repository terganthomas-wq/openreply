/**
 * An in-memory stand-in for the few tables the connection check (A1), its
 * alert e-mail and the catch-up after it use: InstagramAccount,
 * OperationalEvent, Workspace, WorkspaceMember, User, Automation, DmLog, and
 * the ad copies of posts the sweep finds in WebhookEvent ($queryRaw).
 *
 * Unlike a plain mock it evaluates the where clauses of updateMany, because
 * that is where the check's, the e-mail's and the catch-up's guarantees live:
 * every write is conditional on the state it was decided on. It knows exactly
 * the conditions those modules use (equality, null, Date, `not`, `in`, `lt`,
 * `OR`) and refuses any other, so a test notices when new logic needs more.
 * JSON values are copied when written, as the database stores them.
 */

import { Prisma } from "../../app/generated/prisma/client";

type Row = Record<string, unknown>;

export interface FakeAccount {
  id: string;
  workspaceId: string;
  instagramId: string;
  username: string;
  provider: "META" | "ZERNIO";
  metaLogin: "INSTAGRAM" | "UNIFIED";
  accessToken: string;
  zernioAccountId: string | null;
  connectedAt: Date;
  connectionCheckFailedAt: Date | null;
  connectionLostAt: Date | null;
  connectionLostReason: string | null;
  connectionAlertSentAt: Date | null;
  connectionAlertCount: number;
  connectionRecoveredAt: Date | null;
  connectionCatchUpFrom: Date | null;
  connectionCatchUpClaimedAt: Date | null;
  connectionCatchUpProgress: unknown;
  connectionCatchUpResult: unknown;
  connectionAllClearDueAt: Date | null;
}

export interface FakeEvent {
  workspaceId: string | null;
  source: string;
  level: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface FakeCampaign {
  id: string;
  instagramAccountId: string;
  name: string;
  postId: string | null;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  ignoreQuestionComments: boolean;
  isActive: boolean;
  createdAt: Date;
}

export interface FakeDmLog {
  instagramAccountId: string;
  automationId: string;
  commentId: string;
  status: string;
}

function same(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) {
    return value instanceof Date && value.getTime() === condition.getTime();
  }
  return value === condition;
}

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as Record<string, unknown>[]).some((branch) => matches(row, branch));
    }
    const value = row[key];
    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const operators = condition as Record<string, unknown>;
      if ("not" in operators) return !same(value, operators.not);
      if ("in" in operators) return (operators.in as unknown[]).includes(value);
      if ("lt" in operators) {
        return (
          value instanceof Date &&
          operators.lt instanceof Date &&
          value.getTime() < operators.lt.getTime()
        );
      }
      throw new Error(`FakeConnectionDb: unsupported condition on ${key}`);
    }
    return same(value, condition);
  });
}

// What the database stores for a written value: a copy, JSON copied in full,
// Prisma's JSON null as null.
function stored(value: unknown): unknown {
  if (value === Prisma.DbNull || value === Prisma.JsonNull) return null;
  if (value instanceof Date) return new Date(value.getTime());
  if (value !== null && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

function copy<T extends Row>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, stored(value)])
  ) as T;
}

export function fakeAccount(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id: "account_1",
    workspaceId: "workspace_1",
    instagramId: "ig_1",
    username: "thomas.tergan",
    provider: "META",
    metaLogin: "UNIFIED",
    accessToken: "encrypted",
    zernioAccountId: null,
    connectedAt: new Date("2026-11-01T00:00:00.000Z"),
    connectionCheckFailedAt: null,
    connectionLostAt: null,
    connectionLostReason: null,
    connectionAlertSentAt: null,
    connectionAlertCount: 0,
    connectionRecoveredAt: null,
    connectionCatchUpFrom: null,
    connectionCatchUpClaimedAt: null,
    connectionCatchUpProgress: null,
    connectionCatchUpResult: null,
    connectionAllClearDueAt: null,
    ...overrides,
  };
}

export function fakeCampaign(overrides: Partial<FakeCampaign> = {}): FakeCampaign {
  return {
    id: "campaign_1",
    instagramAccountId: "account_1",
    name: "Guide",
    postId: null,
    matchAnyPost: true,
    keywords: ["guide"],
    matchAnyWord: false,
    wholeWordMatch: true,
    ignoreQuestionComments: false,
    isActive: true,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    ...overrides,
  };
}

export class FakeConnectionDb {
  accounts: FakeAccount[] = [];
  events: FakeEvent[] = [];
  users: { id: string; email: string | null }[] = [];
  workspaces: { id: string; ownerId: string }[] = [];
  members: {
    workspaceId: string;
    userId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    createdAt: Date;
  }[] = [];
  campaigns: FakeCampaign[] = [];
  dmLogs: FakeDmLog[] = [];
  /** Ad copies of a post, as the sweep finds them in webhooks: post id → ad ids. */
  ads: Record<string, string[]> = {};
  /** Every updateMany, for tests that check what was asked. */
  updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];

  account(id = "account_1"): FakeAccount {
    const account = this.accounts.find((row) => row.id === id);
    if (!account) throw new Error(`FakeConnectionDb: no account ${id}`);
    return account;
  }

  /** The Prisma client shape the modules use. */
  readonly prisma = {
    instagramAccount: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        this.accounts
          .filter((row) => matches(row as unknown as Row, where))
          .sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime())
          .map((row) => copy(row as unknown as Row)),
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const row = this.accounts.find((account) =>
          matches(account as unknown as Row, where)
        );
        return row ? copy(row as unknown as Row) : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        this.updates.push({ where, data });
        let count = 0;
        for (const row of this.accounts) {
          if (!matches(row as unknown as Row, where)) continue;
          Object.assign(row, copy(data));
          count += 1;
        }
        return { count };
      },
    },
    operationalEvent: {
      create: async ({ data }: { data: FakeEvent }) => {
        this.events.push(data);
        return { id: `event_${this.events.length}`, ...data };
      },
    },
    workspace: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const workspace = this.workspaces.find((row) => row.id === where.id);
        if (!workspace) return null;
        const owner = this.users.find((user) => user.id === workspace.ownerId);
        return {
          owner: owner
            ? {
                email: owner.email,
                workspaceMembers: this.members
                  .filter(
                    (member) =>
                      member.userId === owner.id && member.workspaceId === workspace.id
                  )
                  .map((member) => ({ role: member.role })),
              }
            : null,
        };
      },
    },
    workspaceMember: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        this.members
          .filter((member) => matches(member as unknown as Row, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((member) => ({
            user: {
              email: this.users.find((user) => user.id === member.userId)?.email ?? null,
            },
          })),
    },
    automation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        this.campaigns
          .filter((campaign) => matches(campaign as unknown as Row, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((campaign) => copy(campaign as unknown as Row)),
    },
    dmLog: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        this.dmLogs
          .filter((log) => matches(log as unknown as Row, where))
          .map((log) => copy(log as unknown as Row)),
    },
    // adMediaFor (lib/polling/comment-reconciler.ts): the post id is its one value.
    $queryRaw: async (_sql: TemplateStringsArray, postId: string) =>
      (this.ads[postId] ?? []).map((mediaId) => ({ mediaId })),
  };
}
