export type AvatarTextureChanges = {
  acquired: string[];
  released: string[];
};

/** Tracks only texture keys currently used by active world avatars. */
export class AvatarTextureReferences {
  private readonly players = new Map<string, Set<string>>();
  private readonly users = new Map<string, number>();

  sync(playerId: string, textureKeys: readonly string[]): AvatarTextureChanges {
    if (!playerId) throw new TypeError("참가자 ID가 필요합니다.");
    const previous = this.players.get(playerId) ?? new Set<string>();
    const next = new Set(textureKeys);
    const acquired = [...next].filter((key) => !previous.has(key));
    const released: string[] = [];

    for (const key of previous) {
      if (next.has(key)) continue;
      const count = this.users.get(key) ?? 0;
      if (count <= 1) {
        this.users.delete(key);
        released.push(key);
      } else this.users.set(key, count - 1);
    }
    for (const key of acquired)
      this.users.set(key, (this.users.get(key) ?? 0) + 1);

    if (next.size) this.players.set(playerId, next);
    else this.players.delete(playerId);
    return { acquired, released };
  }

  removePlayer(playerId: string): AvatarTextureChanges {
    return this.sync(playerId, []);
  }

  releaseAll(): string[] {
    const released = [...this.users.keys()];
    this.players.clear();
    this.users.clear();
    return released;
  }

  hasUsers(textureKey: string): boolean {
    return (this.users.get(textureKey) ?? 0) > 0;
  }

  get activeTextureCount(): number {
    return this.users.size;
  }
}
