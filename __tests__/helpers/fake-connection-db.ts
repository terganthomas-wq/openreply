/**
 * An in-memory stand-in for the few tables the connection check (A1) and its
 * alert e-mail use: InstagramAccount, OperationalEvent, Workspace,
 * WorkspaceMember and User.
 *
 * Unlike a plain mock it evaluates the where clauses of updateMany, because
 * that is where the check's and the e-mail's guarantees live: every write is
 * conditional on the state it was decided on. It knows exactly the conditions
 * those modules use (equality, null, Date, `not`, `in`) and refuses any
 * other, so a test notices when new logic needs more.
 */

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
}

export interface FakeEvent {
  workspaceId: string | null;
  source: string;
  level: string;
  message: string;
  payload?: Record<string, unknown>;
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
    const value = row[key];
    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const operators = condition as Record<string, unknown>;
      if ("not" in operators) return !same(value, operators.not);
      if ("in" in operators) return (operators.in as unknown[]).includes(value);
      throw new Error(`FakeConnectionDb: unsupported condition on ${key}`);
    }
    return same(value, condition);
  });
}

function copy<T extends Row>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? new Date(value.getTime()) : value,
    ])
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
  };
}
