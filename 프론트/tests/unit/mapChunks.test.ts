import { describe, expect, it } from "vitest";
import {
  MAP_RENDER_CHUNK_TILES,
  mapRenderChunks,
} from "../../src/game/renderMap";

describe("map render chunks", () => {
  it("covers a 96 by 96 map exactly with 16-tile chunks", () => {
    const chunks = mapRenderChunks(96, 96);
    const coverage = new Uint8Array(96 * 96);

    expect(chunks).toHaveLength(36);
    for (const chunk of chunks) {
      expect(chunk.width).toBeLessThanOrEqual(MAP_RENDER_CHUNK_TILES);
      expect(chunk.height).toBeLessThanOrEqual(MAP_RENDER_CHUNK_TILES);
      for (let y = chunk.y; y < chunk.y + chunk.height; y++)
        for (let x = chunk.x; x < chunk.x + chunk.width; x++)
          coverage[y * 96 + x]++;
    }
    expect([...coverage].every((count) => count === 1)).toBe(true);
  });

  it("clips the final row and column for maps that do not divide evenly", () => {
    const chunks = mapRenderChunks(35, 19);
    const coverage = new Uint8Array(35 * 19);

    expect(chunks).toHaveLength(6);
    expect(chunks).toContainEqual({ x: 32, y: 0, width: 3, height: 16 });
    expect(chunks).toContainEqual({ x: 32, y: 16, width: 3, height: 3 });
    for (const chunk of chunks)
      for (let y = chunk.y; y < chunk.y + chunk.height; y++)
        for (let x = chunk.x; x < chunk.x + chunk.width; x++)
          coverage[y * 35 + x]++;
    expect([...coverage].every((count) => count === 1)).toBe(true);
  });

  it("rejects invalid dimensions rather than returning partial geometry", () => {
    expect(() => mapRenderChunks(0, 10)).toThrow(RangeError);
    expect(() => mapRenderChunks(10, 10, 1.5)).toThrow(RangeError);
  });
});
