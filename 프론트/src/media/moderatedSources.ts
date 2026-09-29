import type { MediaOffer } from "../generated/protocol";

type Source = MediaOffer["source"];

export function completeModeratedSources(sources: readonly Source[]): Source[] {
  const complete = new Set(sources);
  if (complete.has("SCREEN") || complete.has("SCREEN_AUDIO")) {
    complete.add("SCREEN");
    complete.add("SCREEN_AUDIO");
  }
  return [...complete].sort();
}
