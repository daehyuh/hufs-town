import { describe, expect, it, vi } from "vitest";
import {
  AutoAwayPolicy,
  AUTO_AWAY_IDLE_LIMIT_MS,
} from "../../src/game/AutoAwayPolicy";

describe("automatic away policy", () => {
  it("requests AWAY at five idle minutes and does not duplicate an unacknowledged request", () => {
    const startedAt = 1_000;
    const setPresence = vi.fn(() => true);
    const policy = new AutoAwayPolicy(startedAt);

    expect(
      policy.tick(
        "AVAILABLE",
        startedAt + AUTO_AWAY_IDLE_LIMIT_MS - 1,
        setPresence,
      ),
    ).toBeNull();
    expect(setPresence).not.toHaveBeenCalled();

    const requestedAt = startedAt + AUTO_AWAY_IDLE_LIMIT_MS;
    expect(policy.tick("AVAILABLE", requestedAt, setPresence)).toBe(
      "away-requested",
    );
    expect(policy.hasAutomaticAwayRequest).toBe(true);
    expect(policy.tick("AVAILABLE", requestedAt + 1, setPresence)).toBeNull();
    expect(setPresence).toHaveBeenCalledTimes(1);
    expect(setPresence).toHaveBeenCalledWith("AWAY");
  });

  it("returns to AVAILABLE only for a recent activity after automatic AWAY", () => {
    const startedAt = 5_000;
    const setPresence = vi.fn(() => true);
    const policy = new AutoAwayPolicy(startedAt);
    const requestedAt = startedAt + AUTO_AWAY_IDLE_LIMIT_MS;
    policy.tick("AVAILABLE", requestedAt, setPresence);
    policy.startMonitoring(requestedAt + 500);

    expect(policy.hasAutomaticAwayRequest).toBe(true);
    expect(policy.tick("AWAY", requestedAt + 501, setPresence)).toBeNull();
    expect(policy.tick("AWAY", requestedAt + 1_000, setPresence)).toBeNull();
    const activityAt = requestedAt + 2_000;
    policy.recordActivity(activityAt);
    expect(policy.canRestore("AWAY", activityAt)).toBe(true);
    expect(policy.tick("AWAY", activityAt, setPresence)).toBe("restore");
    expect(policy.restore("AWAY", activityAt, setPresence)).toBe(true);
    expect(policy.hasAutomaticAwayRequest).toBe(false);
    expect(setPresence).toHaveBeenLastCalledWith("AVAILABLE");
  });

  it("keeps an early return activity queued until the presence cooldown ends", () => {
    const policy = new AutoAwayPolicy(0);
    const setPresence = vi.fn(() => true);
    const requestedAt = AUTO_AWAY_IDLE_LIMIT_MS;
    policy.tick("AVAILABLE", requestedAt, setPresence);
    policy.recordActivity(requestedAt + 200);

    expect(policy.canRestore("AWAY", requestedAt + 200)).toBe(true);
    expect(policy.restoreDelayRemaining(requestedAt + 200)).toBe(600);
    expect(policy.restore("AWAY", requestedAt + 200, setPresence)).toBe(false);
    expect(policy.restore("AWAY", requestedAt + 799, setPresence)).toBe(false);
    expect(policy.restore("AWAY", requestedAt + 800, setPresence)).toBe(true);
    expect(setPresence).toHaveBeenLastCalledWith("AVAILABLE");
  });

  it("does not override a manually selected AWAY or DND status", () => {
    const setPresence = vi.fn(() => true);
    const policy = new AutoAwayPolicy(0);
    policy.manualChange(10);

    expect(
      policy.tick("AWAY", AUTO_AWAY_IDLE_LIMIT_MS + 10, setPresence),
    ).toBeNull();
    expect(policy.canRestore("AWAY", AUTO_AWAY_IDLE_LIMIT_MS + 10)).toBe(false);

    policy.tick("AVAILABLE", AUTO_AWAY_IDLE_LIMIT_MS + 11, setPresence);
    expect(policy.manualChange(AUTO_AWAY_IDLE_LIMIT_MS + 12)).toBe(true);
    expect(policy.tick("DND", AUTO_AWAY_IDLE_LIMIT_MS * 2, setPresence)).toBe(
      null,
    );
    expect(setPresence).toHaveBeenCalledTimes(1);
    expect(policy.hasAutomaticAwayRequest).toBe(false);
  });

  it("retries an AWAY request only after a failed send or an expired unanswered request", () => {
    const startedAt = 0;
    const policy = new AutoAwayPolicy(startedAt);
    const firstSend = vi.fn(() => false);
    expect(
      policy.tick("AVAILABLE", AUTO_AWAY_IDLE_LIMIT_MS, firstSend),
    ).toBeNull();
    expect(policy.hasAutomaticAwayRequest).toBe(false);

    const successfulSend = vi.fn(() => true);
    const requestedAt = AUTO_AWAY_IDLE_LIMIT_MS + 10;
    expect(policy.tick("AVAILABLE", requestedAt, successfulSend)).toBe(
      "away-requested",
    );
    expect(
      policy.tick("AVAILABLE", requestedAt + 10_001, successfulSend),
    ).toBeNull();
    expect(policy.hasAutomaticAwayRequest).toBe(false);
    expect(policy.tick("AVAILABLE", requestedAt + 10_002, successfulSend)).toBe(
      "away-requested",
    );
    expect(successfulSend).toHaveBeenCalledTimes(2);
  });
});
