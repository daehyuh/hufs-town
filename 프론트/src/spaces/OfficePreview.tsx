import { useEffect, useRef } from "react";
import { loadOfficeImages, paintMap, TILE } from "../game/renderMap";
import { getPublished } from "../editor/client";
import { listSpaceAssets } from "../editor/assetsClient";
import { registerCustomAssets } from "../game/officeAssets";
export function OfficePreview({ spaceId }: { spaceId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void getPublished(spaceId)
          .then(async (map) => {
            try { registerCustomAssets(await listSpaceAssets(spaceId)); } catch { /* older API or inaccessible asset catalog */ }
            return Promise.all([map, loadOfficeImages(map.objects.map((object) => object.asset))]);
          })
          .then(([map, images]) => {
            if (!live || !canvas.current) return;
            const node = canvas.current,
              ctx = node.getContext("2d")!;
            node.width = 560;
            node.height = Math.round((560 * map.height) / map.width);
            ctx.scale(
              node.width / (map.width * TILE),
              node.height / (map.height * TILE),
            );
            paintMap(ctx, map, images);
          })
          .catch(() => {
            /* The space remains available even if its cover cannot load. */
          });
      },
      { rootMargin: "150px" },
    );
    if (canvas.current) observer.observe(canvas.current);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [spaceId]);
  return <canvas className="office-preview" ref={canvas} aria-hidden="true" />;
}
