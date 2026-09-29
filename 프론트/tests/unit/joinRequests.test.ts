import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/auth/client", () => ({
  apiGet: vi.fn(),
  apiMutate: vi.fn(),
}));

describe("account-targeted meetup request client", () => {
  let apiGet: (typeof import("../../src/auth/client"))["apiGet"];
  let apiMutate: (typeof import("../../src/auth/client"))["apiMutate"];
  let requests: typeof import("../../src/social/joinRequests");

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal("location", { pathname: "/", search: "", hash: "" });
    ({ apiGet, apiMutate } = await import("../../src/auth/client"));
    requests = await import("../../src/social/joinRequests");
  });

  it("loads incoming and outgoing requests from the signed-in account", async () => {
    vi.mocked(apiGet).mockResolvedValue([] as never);

    await requests.listIncomingSocialJoinRequests();
    await requests.listOutgoingSocialJoinRequests();

    expect(apiGet).toHaveBeenNthCalledWith(1, "me/join-requests");
    expect(apiGet).toHaveBeenNthCalledWith(2, "me/join-requests/outgoing");
  });

  it("selects a recipient by direct conversation and shared destination, never an account id", async () => {
    vi.mocked(apiMutate).mockResolvedValue(undefined as never);

    await requests.createSocialJoinRequest("conversation-123", "space-456");

    expect(apiMutate).toHaveBeenCalledWith("me/join-requests", {
      conversationId: "conversation-123",
      destinationSpaceId: "space-456",
    });
  });

  it("uses the documented response and cancellation actions", async () => {
    vi.mocked(apiMutate).mockResolvedValue(undefined as never);

    await requests.respondToSocialJoinRequest("request/1", "APPROVE");
    await requests.respondToSocialJoinRequest("request/2", "DECLINE");
    await requests.cancelSocialJoinRequest("request/3");

    expect(apiMutate).toHaveBeenNthCalledWith(
      1,
      "me/join-requests/request%2F1/respond",
      { decision: "APPROVE" },
    );
    expect(apiMutate).toHaveBeenNthCalledWith(
      2,
      "me/join-requests/request%2F2/respond",
      { decision: "DECLINE" },
    );
    expect(apiMutate).toHaveBeenNthCalledWith(
      3,
      "me/join-requests/request%2F3/cancel",
    );
  });
});
