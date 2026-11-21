/**
 * An in-memory stand-in for the few Redis commands the account pause and the
 * usage warnings use, with expiry on the (possibly faked) clock.
 *
 * `eval` runs the account pause's script (lib/queue/account-pause.ts) the way
 * its Lua does: set or extend, never shorten. It refuses any other script, so
 * a test notices when new Redis logic needs a stand-in of its own.
 */

type Entry = { value: string; expiresAt: number | null };

export class FakeRedis {
  readonly strings = new Map<string, Entry>();
  readonly sortedSets = new Map<
    string,
    { members: Map<string, number>; expiresAt: number | null }
  >();
  /** Every command, for tests that check what was asked. */
  readonly commands: string[] = [];

  private live(key: string): Entry | undefined {
    const entry = this.strings.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    this.commands.push(`GET ${key}`);
    return this.live(key)?.value ?? null;
  }

  /** The time left on a key in ms, like PTTL (-2 missing, -1 no expiry). */
  pttl(key: string): number {
    const entry = this.live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - Date.now();
  }

  async set(key: string, value: string, ...args: (string | number)[]) {
    this.commands.push(`SET ${key} ${value} ${args.join(" ")}`.trim());
    const options = args.map(String).map((a) => a.toUpperCase());
    if (options.includes("NX") && this.live(key)) return null;
    let expiresAt: number | null = null;
    const px = options.indexOf("PX");
    if (px !== -1) expiresAt = Date.now() + Number(args[px + 1]);
    const ex = options.indexOf("EX");
    if (ex !== -1) expiresAt = Date.now() + Number(args[ex + 1]) * 1000;
    this.strings.set(key, { value: String(value), expiresAt });
    return "OK";
  }

  async del(key: string) {
    this.commands.push(`DEL ${key}`);
    return this.strings.delete(key) ? 1 : 0;
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]) {
    if (
      numKeys !== 1 ||
      !script.includes('redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[3])')
    ) {
      throw new Error("FakeRedis: unknown script");
    }
    const [key, wanted, now, ttl] = args.map(String);
    this.commands.push(`EVAL pause ${key} ${wanted} ${now} ${ttl}`);
    const current = this.live(key)?.value;
    const currentAt = Number(current ?? 0) || 0;
    if (currentAt >= Number(wanted)) return [0, current];
    this.strings.set(key, { value: wanted, expiresAt: Date.now() + Number(ttl) });
    return currentAt > Number(now) ? [2, wanted] : [1, wanted];
  }

  private sortedSet(key: string) {
    let set = this.sortedSets.get(key);
    if (set && set.expiresAt !== null && set.expiresAt <= Date.now()) {
      this.sortedSets.delete(key);
      set = undefined;
    }
    if (!set) {
      set = { members: new Map(), expiresAt: null };
      this.sortedSets.set(key, set);
    }
    return set;
  }

  async zcount(key: string, min: string | number, max: string | number) {
    this.commands.push(`ZCOUNT ${key} ${min} ${max}`);
    const set = this.sortedSet(key);
    const low = String(min);
    const exclusive = low.startsWith("(");
    const from = low === "-inf" ? -Infinity : Number(exclusive ? low.slice(1) : low);
    const to = String(max) === "+inf" ? Infinity : Number(max);
    return [...set.members.values()].filter(
      (score) => (exclusive ? score > from : score >= from) && score <= to
    ).length;
  }

  pipeline() {
    const steps: Array<() => void> = [];
    const chain = {
      zadd: (key: string, score: number, member: string) => {
        steps.push(() => this.sortedSet(key).members.set(member, Number(score)));
        return chain;
      },
      zremrangebyscore: (key: string, min: string | number, max: string | number) => {
        steps.push(() => {
          const set = this.sortedSet(key);
          const from = String(min) === "-inf" ? -Infinity : Number(min);
          for (const [member, score] of set.members) {
            if (score >= from && score <= Number(max)) set.members.delete(member);
          }
        });
        return chain;
      },
      pexpireat: (key: string, at: number) => {
        steps.push(() => {
          this.sortedSet(key).expiresAt = Number(at);
        });
        return chain;
      },
      exec: async () => {
        this.commands.push(`PIPELINE ${steps.length}`);
        for (const step of steps) step();
        return steps.map(() => [null, 1]);
      },
    };
    return chain;
  }
}
