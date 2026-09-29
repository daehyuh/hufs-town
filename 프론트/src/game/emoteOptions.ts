export const EMOTE_OPTIONS = [
  ["wave", "👋", "campus.emote.wave"],
  ["heart", "💚", "campus.emote.heart"],
  ["clap", "👏", "campus.emote.clap"],
  ["sparkles", "✨", "campus.emote.sparkles"],
  ["laugh", "😄", "campus.emote.laugh"],
  ["thumbsup", "👍", "campus.emote.thumbsup"],
  ["sad", "😢", "campus.emote.sad"],
  ["sit", "🪑", "campus.emote.sit"],
  ["party", "🎉", "campus.emote.party"],
  ["thinking", "🤔", "campus.emote.thinking"],
  ["hands", "🙌", "campus.emote.hands"],
  ["wow", "😮", "campus.emote.wow"],
  ["fire", "🔥", "campus.emote.fire"],
] as const;

export type EmoteValue = (typeof EMOTE_OPTIONS)[number][0];

export function availableEmotes(worldFeatures: readonly string[]) {
  return EMOTE_OPTIONS.filter(([value]) => {
    if (value === "sit") return worldFeatures.includes("PERSISTENT_SIT");
    if (["thinking", "hands", "wow", "fire"].includes(value))
      return worldFeatures.includes("EXTENDED_EMOTES");
    return true;
  });
}

export function emoteForShortcut(
  code: string,
  worldFeatures: readonly string[],
): EmoteValue | undefined {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!match) return undefined;
  const key = Number(match[1]);
  const index = key === 0 ? 9 : key - 1;
  return availableEmotes(worldFeatures)[index]?.[0];
}
