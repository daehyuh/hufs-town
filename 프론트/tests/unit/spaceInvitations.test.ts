import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/auth/client", () => ({
  apiGet: vi.fn(),
  apiMutate: vi.fn(),
}));

describe("targeted space invitation client", () => {
  let apiGet: (typeof import("../../src/auth/client"))["apiGet"];
  let apiMutate: (typeof import("../../src/auth/client"))["apiMutate"];
  let invitations: typeof import("../../src/spaces/client");

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal("location", { pathname: "/", search: "", hash: "" });
    ({ apiGet, apiMutate } = await import("../../src/auth/client"));
    invitations = await import("../../src/spaces/client");
  });

  it("loads the signed-in account's incoming invitation inbox", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce([] as never);

    await expect(invitations.listIncomingSpaceInvites()).resolves.toEqual([]);
    expect(apiGet).toHaveBeenCalledWith("spaces/invitations/incoming");
  });

  it("accepts or declines an invitation using an encoded invitation id", async () => {
    vi.mocked(apiMutate).mockResolvedValue(undefined as never);

    await invitations.acceptSpaceInvite("invite/with slash");
    await invitations.declineSpaceInvite("invite/with slash");

    expect(apiMutate).toHaveBeenNthCalledWith(
      1,
      "spaces/invitations/invite%2Fwith%20slash/accept",
    );
    expect(apiMutate).toHaveBeenNthCalledWith(
      2,
      "spaces/invitations/invite%2Fwith%20slash/decline",
    );
  });
});
