import { expect, it, vi } from "vitest";
import { apiGet, apiMutate } from "../../src/auth/client";
import {
  deleteRecordingArchiveEntry,
  getRecordingTranscript,
  listRecordingArchive,
  recordingArchivePath,
  recordingTrackContentPath,
  type RecordingArchiveResponse,
} from "../../src/media/recordingArchive";

vi.mock("../../src/auth/client", () => ({
  apiGet: vi.fn(),
  apiMutate: vi.fn(),
}));

it("builds space-scoped recording and content routes with encoded IDs", () => {
  expect(recordingArchivePath("space / one")).toBe(
    "spaces/space%20%2F%20one/recordings",
  );
  expect(
    recordingTrackContentPath("space / one", "recording/id", "track/id"),
  ).toBe(
    "/api/v1/spaces/space%20%2F%20one/recordings/recording%2Fid/tracks/track%2Fid/content",
  );
  expect(
    recordingTrackContentPath("space-a", "recording-a", "track-a", true),
  ).toBe(
    "/api/v1/spaces/space-a/recordings/recording-a/tracks/track-a/content?download=true",
  );
});

it("loads archive JSON through the authenticated API client", async () => {
  const response: RecordingArchiveResponse = { recordings: [], usedBytes: 0 };
  vi.mocked(apiGet).mockResolvedValueOnce(response);
  await expect(listRecordingArchive("space-a")).resolves.toEqual(response);
  expect(apiGet).toHaveBeenCalledWith("spaces/space-a/recordings");
});

it("loads only the selected recording transcript through the authenticated API client", async () => {
  const response = {
    recordingId: "recording-a",
    generatedAt: 1,
    notice: "AI",
    segments: [],
  };
  vi.mocked(apiGet).mockResolvedValueOnce(response);
  await expect(
    getRecordingTranscript("space-a", "recording / a"),
  ).resolves.toEqual(response);
  expect(apiGet).toHaveBeenCalledWith(
    "spaces/space-a/recordings/recording%20%2F%20a/transcript",
  );
});

it("deletes a recording through the authenticated CSRF mutation client", async () => {
  vi.mocked(apiMutate).mockResolvedValueOnce({
    recordingId: "recording-a",
    deleted: true,
  });
  await expect(
    deleteRecordingArchiveEntry("space-a", "recording-a"),
  ).resolves.toEqual({
    recordingId: "recording-a",
    deleted: true,
  });
  expect(apiMutate).toHaveBeenCalledWith(
    "spaces/space-a/recordings/recording-a",
    undefined,
    "DELETE",
  );
});
