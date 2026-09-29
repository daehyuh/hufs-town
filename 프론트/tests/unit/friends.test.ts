import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiMutate } from "../../src/auth/client";
import {
  friendRelationship,
  isAccountId,
  saveFriendPreferences,
  searchFriends,
  type FriendOverview,
  type FriendSearchRelationship,
} from "../../src/social/friends";

vi.mock("../../src/auth/client", () => ({
  apiGet: vi.fn(),
  apiMutate: vi.fn(),
}));

const overview: FriendOverview = {
  friends: [
    {
      userId: "friend-id",
      displayName: "친구",
      since: "2026-09-26T00:00:00Z",
      online: false,
    },
  ],
  incoming: [
    {
      id: "incoming-request",
      userId: "incoming-id",
      displayName: "요청한 사람",
      requestedAt: "2026-09-26T00:00:00Z",
    },
  ],
  outgoing: [
    {
      id: "outgoing-request",
      userId: "outgoing-id",
      displayName: "상대",
      requestedAt: "2026-09-26T00:00:00Z",
    },
  ],
};

describe("friend relationship state", () => {
  it("maps accepted, incoming, outgoing, and unknown accounts", () => {
    expect(friendRelationship(overview, "friend-id")).toEqual({
      state: "FRIEND",
    });
    expect(friendRelationship(overview, "incoming-id")).toEqual({
      state: "INCOMING",
      requestId: "incoming-request",
    });
    expect(friendRelationship(overview, "outgoing-id")).toEqual({
      state: "OUTGOING",
    });
    expect(friendRelationship(overview, "unknown-id")).toEqual({
      state: "NONE",
    });
    expect(friendRelationship(null, "unknown-id")).toEqual({
      state: "NONE",
    });
  });

  it("only enables friend actions for UUID account identifiers", () => {
    expect(isAccountId("3dd9f5b4-136a-42c8-8a42-7e8b3100fd13")).toBe(true);
    expect(isAccountId("guest-123")).toBe(false);
    expect(isAccountId("not-a-uuid")).toBe(false);
  });
});

describe("friend search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the encoded prefix query and returns relationship states", async () => {
    const relationships: FriendSearchRelationship[] = [
      "FRIEND",
      "INCOMING",
      "OUTGOING",
      "COOLDOWN",
      "AVAILABLE",
      "UNAVAILABLE",
    ];
    const response = relationships.map((relationship, index) => ({
      userId: `internal-id-${index}`,
      displayName: `참가자 ${index}`,
      relationship,
    }));
    vi.mocked(apiGet).mockResolvedValue(response);

    await expect(searchFriends("  홍 길동  ")).resolves.toEqual(response);
    expect(apiGet).toHaveBeenCalledWith(
      "me/friends/search?q=%ED%99%8D%20%EA%B8%B8%EB%8F%99",
    );
  });

  it("persists the request and notification preferences together", async () => {
    const preferences = {
      allowFriendRequests: true,
      allowFriendNotifications: false,
      sharePresenceWithFriends: true,
    };
    vi.mocked(apiMutate).mockResolvedValue(preferences);

    await expect(saveFriendPreferences(preferences)).resolves.toEqual(
      preferences,
    );
    expect(apiMutate).toHaveBeenCalledWith(
      "me/friends/preferences",
      preferences,
      "PUT",
    );
  });
});
