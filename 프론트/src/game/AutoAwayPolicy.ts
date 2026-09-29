export type PresenceStatus = "AVAILABLE" | "AWAY" | "DND";

export const AUTO_AWAY_IDLE_LIMIT_MS = 5 * 60 * 1000;
export const AUTO_AWAY_CHECK_INTERVAL_MS = 10 * 1000;
export const AUTO_AWAY_RESTORE_DELAY_MS = 800;
const AUTO_AWAY_REQUEST_TIMEOUT_MS = 10 * 1000;

/** Tracks only automatic presence changes; manually selected states stay in control. */
export class AutoAwayPolicy {
  private lastActivityAt: number;
  private requestedAt: number | undefined;

  constructor(startedAt: number) {
    this.lastActivityAt = startedAt;
  }

  reset(now: number) {
    this.lastActivityAt = now;
    this.requestedAt = undefined;
  }

  startMonitoring(now: number) {
    if (!this.hasAutomaticAwayRequest) this.lastActivityAt = now;
  }

  get hasAutomaticAwayRequest() {
    return this.requestedAt !== undefined;
  }

  recordActivity(now: number) {
    this.lastActivityAt = now;
  }

  manualChange(now: number) {
    const wasAutomaticAway = this.hasAutomaticAwayRequest;
    this.reset(now);
    return wasAutomaticAway;
  }

  canRestore(status: PresenceStatus | undefined, now: number) {
    return (
      this.hasAutomaticAwayRequest &&
      status === "AWAY" &&
      this.lastActivityAt > this.requestedAt! &&
      now - this.lastActivityAt < AUTO_AWAY_IDLE_LIMIT_MS
    );
  }

  restoreDelayRemaining(now: number) {
    return this.requestedAt === undefined
      ? 0
      : Math.max(0, this.requestedAt + AUTO_AWAY_RESTORE_DELAY_MS - now);
  }

  tick(
    status: PresenceStatus | undefined,
    now: number,
    setPresence: (status: PresenceStatus) => boolean,
  ): "away-requested" | "restore" | null {
    if (this.hasAutomaticAwayRequest) {
      if (this.canRestore(status, now)) return "restore";
      if (
        status === "DND" ||
        (status === "AVAILABLE" &&
          now - this.requestedAt! > AUTO_AWAY_REQUEST_TIMEOUT_MS)
      )
        this.requestedAt = undefined;
      return null;
    }

    if (
      status === "AVAILABLE" &&
      now - this.lastActivityAt >= AUTO_AWAY_IDLE_LIMIT_MS &&
      setPresence("AWAY")
    ) {
      this.requestedAt = now;
      return "away-requested";
    }
    return null;
  }

  restore(
    status: PresenceStatus | undefined,
    now: number,
    setPresence: (status: PresenceStatus) => boolean,
  ) {
    if (
      !this.canRestore(status, now) ||
      this.restoreDelayRemaining(now) > 0 ||
      !setPresence("AVAILABLE")
    )
      return false;
    this.requestedAt = undefined;
    return true;
  }
}
