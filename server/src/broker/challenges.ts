import { createHmac, randomBytes } from "node:crypto";
import { digest, safeEqual } from "../auth/tokens.js";
import type { Db } from "../db.js";
import type { AuthChallenge, Prisma } from "../generated/prisma/client.js";
import type { ChallengeState } from "../generated/prisma/enums.js";

// Auth Broker challenges (protocol v1). The page creates one and hands its one-time ticket to the desktop
// broker; the broker claims it for an exchange token and finally completes with the cookies it captured.
// Each capability is stored only as a SHA-256 hash and works once; a row lives 240 seconds.

export const CHALLENGE_TTL_MS = 240_000;
/** Finished rows stay this long after their deadline so the page can still read the outcome. */
const PRUNE_AFTER_MS = 300_000;
const MAX_LIVE_TOTAL = 64;
const MAX_LIVE_PER_USER = 8;
const LIVE: ChallengeState[] = ["WAITING_FOR_USER", "LOGIN_OPENED"];
export const PROTOCOL_VERSION = 1;

/** A broker protocol failure; `code` is the fixed string sent back (for example AUTH_CHALLENGE_INVALID). */
export class ChallengeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface Identity {
  challenge_id: string;
  instance_id: string;
  provider: string;
}

/** Names this server to the broker. Stable across restarts, so a broker's dedicated profiles stay put. */
export function instanceId(sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update("auth-broker-instance").digest("base64url").slice(0, 32);
}

const token = () => randomBytes(32).toString("base64url");
const matches = (stored: string | null, presented: string) => stored !== null && safeEqual(stored, digest(presented));

export class ChallengeStore {
  constructor(
    private readonly db: Db,
    readonly instance: string,
  ) {}

  /** A new challenge cancels the same user's pending one for the same provider and credential. */
  async create(userId: string, provider: string, operation: string, target: Record<string, unknown>) {
    const now = new Date();
    await this.db.authChallenge.deleteMany({ where: { deadline: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) } } });
    await this.db.authChallenge.updateMany({
      where: { userId, provider, state: { in: LIVE }, target: { path: ["credential_id"], equals: String(target.credential_id ?? "") } },
      data: { state: "CANCELLED", reason: "AUTH_SUPERSEDED", exchangeHash: null },
    });
    const live = { state: { in: LIVE }, deadline: { gt: now } };
    const [total, mine] = await Promise.all([
      this.db.authChallenge.count({ where: live }),
      this.db.authChallenge.count({ where: { ...live, userId } }),
    ]);
    if (total >= MAX_LIVE_TOTAL || mine >= MAX_LIVE_PER_USER) throw new ChallengeError("AUTH_BROKER_BUSY");
    const ticket = token();
    const control = token();
    const row = await this.db.authChallenge.create({
      data: {
        id: randomBytes(24).toString("base64url"),
        userId,
        provider,
        operation,
        target: { ...target, operation } as Prisma.InputJsonValue,
        ticketHash: digest(ticket),
        controlHash: digest(control),
        deadline: new Date(now.getTime() + CHALLENGE_TTL_MS),
      },
    });
    return {
      challenge_id: row.id,
      instance_id: this.instance,
      provider,
      one_time_token: ticket,
      control_token: control,
      expires_in: CHALLENGE_TTL_MS / 1000,
      protocol_version: PROTOCOL_VERSION,
    };
  }

  /** The row for an identity; a live row past its deadline becomes TIMED_OUT here. */
  async row(identity: Identity): Promise<AuthChallenge> {
    if (identity.instance_id.length !== this.instance.length || !safeEqual(identity.instance_id, this.instance)) {
      throw new ChallengeError("AUTH_CHALLENGE_INVALID");
    }
    const row = await this.db.authChallenge.findUnique({ where: { id: identity.challenge_id } });
    if (!row || row.provider !== identity.provider) throw new ChallengeError("AUTH_CHALLENGE_INVALID");
    if (row.deadline <= new Date() && LIVE.includes(row.state)) {
      await this.db.authChallenge.updateMany({
        where: { id: row.id, state: { in: LIVE } },
        data: { state: "TIMED_OUT", reason: "AUTH_CHALLENGE_EXPIRED", exchangeHash: null },
      });
      return { ...row, state: "TIMED_OUT", reason: "AUTH_CHALLENGE_EXPIRED" };
    }
    return row;
  }

  private live(row: AuthChallenge): void {
    if (row.state === "TIMED_OUT") throw new ChallengeError("AUTH_CHALLENGE_EXPIRED");
    if (!LIVE.includes(row.state)) throw new ChallengeError("AUTH_CHALLENGE_INVALID");
  }

  /** The broker trades the one-time ticket for an exchange token, once. */
  async claim(identity: Identity, ticket: string) {
    const row = await this.row(identity);
    this.live(row);
    if (row.claimed || !matches(row.ticketHash, ticket)) throw new ChallengeError("AUTH_CHALLENGE_INVALID");
    const exchange = token();
    const claimed = await this.db.authChallenge.updateMany({
      where: { id: row.id, claimed: false, state: "WAITING_FOR_USER" },
      data: { claimed: true, exchangeHash: digest(exchange), state: "LOGIN_OPENED" },
    });
    if (claimed.count === 0) throw new ChallengeError("AUTH_CHALLENGE_INVALID");
    return {
      ...(row.target as Record<string, unknown>),
      provider: row.provider,
      exchange_token: exchange,
      expires_in: Math.max(0, Math.floor((row.deadline.getTime() - Date.now()) / 1000)),
      protocol_version: PROTOCOL_VERSION,
    };
  }

  /** Starts a completion or failure report; an exchange token is good for exactly one. */
  async beginCompletion(identity: Identity, exchange: string): Promise<AuthChallenge> {
    const row = await this.row(identity);
    this.live(row);
    if (!row.claimed || row.finishing || !matches(row.exchangeHash, exchange)) throw new ChallengeError("AUTH_CHALLENGE_INVALID");
    const started = await this.db.authChallenge.updateMany({
      where: { id: row.id, finishing: false, state: "LOGIN_OPENED" },
      data: { finishing: true },
    });
    if (started.count === 0) throw new ChallengeError("AUTH_CHALLENGE_INVALID");
    return row;
  }

  /**
   * Marks the challenge AUTHENTICATED and publishes its result in the same transaction. The row lock means
   * a cancel either lands first (and nothing is published) or after (and finds it finished).
   */
  async finish(row: AuthChallenge, publish: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const done = await tx.authChallenge.updateMany({
        where: { id: row.id, state: "LOGIN_OPENED", deadline: { gt: new Date() } },
        data: { state: "AUTHENTICATED", exchangeHash: null, reason: null },
      });
      if (done.count === 0) throw new ChallengeError("AUTH_CHALLENGE_EXPIRED");
      await publish(tx);
    });
  }

  async fail(row: AuthChallenge, reason = "AUTH_LOGIN_FAILED"): Promise<void> {
    await this.db.authChallenge.updateMany({
      where: { id: row.id, state: { in: LIVE } },
      data: { state: "FAILED", reason, exchangeHash: null },
    });
  }

  /** The page polls (or cancels) with its control token. Only the user who created the challenge may. */
  async control(userId: string, identity: Identity, control: string, cancel = false) {
    const row = await this.row(identity);
    if (row.userId !== userId || !matches(row.controlHash, control)) throw new ChallengeError("AUTH_CHALLENGE_INVALID");
    if (cancel && LIVE.includes(row.state)) {
      const cancelled = await this.db.authChallenge.updateMany({
        where: { id: row.id, state: { in: LIVE } },
        data: { state: "CANCELLED", reason: "AUTH_USER_CANCELLED", exchangeHash: null },
      });
      if (cancelled.count > 0) return { state: "CANCELLED", reason: "AUTH_USER_CANCELLED", provider: row.provider };
      const now = await this.db.authChallenge.findUniqueOrThrow({ where: { id: row.id } });
      return { state: now.state, reason: now.reason, provider: row.provider };
    }
    return { state: row.state, reason: row.reason, provider: row.provider };
  }
}
