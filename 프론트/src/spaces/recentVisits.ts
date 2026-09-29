export interface RecentSpaceVisit {
  spaceId: string;
  visitedAt: number;
}

const MAX_RECENT_SPACES = 8;
const SPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

function keyFor(userId: string) {
  return `hufs-town.recent-spaces.v1.${encodeURIComponent(userId)}`;
}

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function parseVisits(value: string | null): RecentSpaceVisit[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, RecentSpaceVisit>();
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        "spaceId" in item &&
        "visitedAt" in item &&
        typeof item.spaceId === "string" &&
        SPACE_ID_PATTERN.test(item.spaceId) &&
        typeof item.visitedAt === "number" &&
        Number.isFinite(item.visitedAt) &&
        item.visitedAt > 0
      ) {
        const existing = unique.get(item.spaceId);
        if (!existing || existing.visitedAt < item.visitedAt)
          unique.set(item.spaceId, {
            spaceId: item.spaceId,
            visitedAt: item.visitedAt,
          });
      }
    }
    return [...unique.values()]
      .sort((left, right) => right.visitedAt - left.visitedAt)
      .slice(0, MAX_RECENT_SPACES);
  } catch {
    return [];
  }
}

export function readRecentSpaceVisits(
  userId: string,
  storage: StorageLike | undefined = browserStorage(),
): RecentSpaceVisit[] {
  if (!userId || !storage) return [];
  try {
    return parseVisits(storage.getItem(keyFor(userId)));
  } catch {
    return [];
  }
}

export function writeRecentSpaceVisits(
  userId: string,
  visits: RecentSpaceVisit[],
  storage: StorageLike | undefined = browserStorage(),
) {
  if (!userId || !storage) return;
  try {
    storage.setItem(
      keyFor(userId),
      JSON.stringify(parseVisits(JSON.stringify(visits))),
    );
  } catch {
    // Recent visits are a convenience; private browsing/storage limits must not block entry.
  }
}

export function recordRecentSpaceVisit(
  userId: string,
  spaceId: string,
  visitedAt = Date.now(),
  storage: StorageLike | undefined = browserStorage(),
) {
  if (
    !SPACE_ID_PATTERN.test(spaceId) ||
    !Number.isFinite(visitedAt) ||
    visitedAt <= 0
  )
    return;
  const visits = readRecentSpaceVisits(userId, storage).filter(
    (visit) => visit.spaceId !== spaceId,
  );
  writeRecentSpaceVisits(
    userId,
    [{ spaceId, visitedAt }, ...visits].slice(0, MAX_RECENT_SPACES),
    storage,
  );
}
