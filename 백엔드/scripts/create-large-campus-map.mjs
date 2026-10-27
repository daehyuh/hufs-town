import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(
  await readFile(path.join(root, "assets/office-catalog.json"), "utf8"),
).items;
const map = {
  schemaVersion: 2,
  id: "gdg-hufs-large-campus",
  revision: "large-campus-v1",
  name: "GDG HUFS 대형 캠퍼스",
  width: 64,
  height: 48,
  spawnX: 32,
  spawnY: 43.5,
  collisions: [],
  objects: [],
  zones: [],
  floors: [],
  walls: [],
  labels: [],
};
const rect = (x, y, width, height) => ({ x, y, width, height });
const floor = (material, x, y, width, height) =>
  map.floors.push({
    id: `floor-${map.floors.length}`,
    material,
    bounds: rect(x, y, width, height),
  });
const wall = (x, y, width, height, material = "CREAM") => {
  const bounds = rect(x, y, width, height);
  map.walls.push({ id: `wall-${map.walls.length}`, material, bounds });
  map.collisions.push(bounds);
};
const object = (asset, x, y, scale = 2) => {
  const info = catalog.find((item) => item.id === asset);
  if (!info) throw Error(asset);
  map.objects.push({ id: `object-${map.objects.length}`, asset, x, y, scale });
  const footprint = info.footprint;
  const ratio = scale / 2;
  if (footprint)
    map.collisions.push(
      rect(
        x + (footprint.x - info.width / 32) * ratio,
        y + footprint.y * ratio,
        footprint.width * ratio,
        footprint.height * ratio,
      ),
    );
};
const zone = (id, name, kind, x, y, width, height) =>
  map.zones.push({ id, name, kind, bounds: rect(x, y, width, height) });

// A larger 100-person campus: rooms stay at the edges while the center and
// entrance remain open for movement, nearby conversations, and screen sharing.
floor("OAK", 1, 1, 62, 46);
floor("CARPET_BLUE", 1.5, 1.5, 16.5, 12.5);
floor("CARPET_SAGE", 46, 1.5, 16.5, 12.5);
floor("WOOD", 20, 2, 24, 30);
floor("TILE", 1.5, 15, 16.5, 8);
floor("CARPET_SAGE", 1.5, 23, 16.5, 23.5);
floor("CARPET_BLUE", 46, 19, 16.5, 27.5);
floor("CONCRETE", 22, 34, 20, 12.5);

wall(1, 1, 62, 0.5);
wall(1, 1, 0.5, 46);
wall(62.5, 1, 0.5, 46);
wall(1, 46.5, 27, 0.5);
wall(36, 46.5, 27, 0.5);

wall(18, 1, 0.5, 13.5, "GLASS");
wall(1, 14, 6.5, 0.5, "GLASS");
wall(11, 14, 7.5, 0.5, "GLASS");
wall(45.5, 1, 0.5, 13.5, "GLASS");
wall(45.5, 14, 7.5, 0.5, "GLASS");
wall(56.5, 14, 6.5, 0.5, "GLASS");

wall(18, 19, 0.5, 9, "SAGE");
wall(18, 31, 0.5, 16, "SAGE");
wall(1, 22.5, 10, 0.5, "SAGE");
wall(14, 22.5, 4.5, 0.5, "SAGE");
wall(45.5, 18.5, 17.5, 0.5, "GLASS");
wall(45.5, 18.5, 0.5, 10, "GLASS");
wall(45.5, 32, 0.5, 15, "GLASS");

// Meeting rooms
object("whiteboard", 9.5, 4);
object("meeting-table", 9.5, 9.5);
for (const x of [6.2, 9.5, 12.8]) {
  object("chair-back", x, 6.8);
  object("chair-front", x, 11.8);
}
object("plant-large", 3, 5);
object("plant-large", 16.3, 12.5);

object("screen", 54.5, 4);
object("meeting-table", 54.5, 9.5);
for (const x of [51.2, 54.5, 57.8]) {
  object("chair-back", x, 6.8);
  object("chair-front", x, 11.8);
}
object("plant-large", 47.8, 5);
object("bookshelf", 60.5, 5.5);

// Open workspace with wider aisles between desk groups.
for (const y of [9, 17, 25])
  for (const x of [24, 32, 40]) {
    object("desk-monitor", x, y);
    object("chair-front", x, y + 1.5);
    object("plant-small", x + 1.05, y - 0.9);
  }
object("cabinet", 24, 4);
object("cabinet", 40, 4);
object("gdg-sign", 32, 4.2);
object("plant-large", 20.5, 15);
object("plant-large", 43.5, 23);

// Pantry and café lounge
object("pantry", 5, 19.2);
object("water-cooler", 10, 19.5);
object("bookshelf", 15.5, 19.7);
object("original-plant", 3, 22);
object("original-plant", 16.3, 22);
object("rug-sage", 9.5, 42.5);
object("sofa-sage", 9.5, 28);
object("coffee-table", 9.5, 31.5);
object("armchair", 4.5, 32);
object("armchair", 14.5, 32);
object("sofa-sage", 9.5, 37);
object("coffee-table", 9.5, 40);
object("plant-large", 3, 25);
object("original-tree", 16, 44.5);

// Quiet focus room
for (const y of [23.5, 32, 40.5])
  for (const x of [49.5, 54.5, 59.5]) {
    object("desk-laptop", x, y);
    object("chair-front", x, y + 1.6);
  }
object("divider", 51.5, 28);
object("divider", 57.5, 28);
object("divider", 51.5, 36.5);
object("divider", 57.5, 36.5);
object("bookshelf", 48.5, 45.5);
object("cabinet", 60, 45.5);
object("plant-large", 54.5, 45.5);

// Open entrance plaza
object("reception", 32, 38.5);
object("gdg-sign", 32, 38.6, 1);
object("chair-back", 32, 36);
object("plant-large", 23, 41.5);
object("plant-large", 41, 41.5);
object("armchair", 24, 45.5);
object("armchair", 40, 45.5);

zone("meeting-a", "회의실 A", "PRIVATE", 1.5, 1.5, 16.5, 12.5);
zone("meeting-b", "회의실 B", "PRIVATE", 46, 1.5, 16.5, 12.5);
zone("focus", "집중 업무실", "SILENT", 46, 19, 16.5, 27.5);
zone("lounge", "카페 라운지", "PUBLIC", 1.5, 23, 16.5, 23.5);

await writeFile(
  path.join(root, "contracts/fixtures/large-campus-map.json"),
  JSON.stringify(map, null, 2) + "\n",
);
await writeFile(
  path.join(root, "../프론트/public/assets/office/large-campus-map.json"),
  JSON.stringify(map, null, 2) + "\n",
);
const productionSpaceId = "00000000-0000-4000-8000-000000000001";
const productionMapId = "gdg-hufs-large-campus";
const productionRevisionId = "00000000-0000-4000-8000-000000000064";
const productionActorId = "9ef1527a-c01c-438f-b442-3f71467099cf";
const document = JSON.stringify({
  ...map,
  revision: productionRevisionId,
}).replaceAll("'", "''");
await writeFile(
  path.join(
    root,
    "modules/persistence/src/main/resources/db/migration/V64__seed_large_gdg_hufs_campus.sql",
  ),
  `-- Add the larger campus as a separate entry map for the production GDG HUFS space.
-- The existing map and all of its history remain intact. Fresh databases skip
-- this production-only seed until an explicit map is created through the editor.
SET @large_map_space_id = '${productionSpaceId}';
SET @large_map_id = '${productionMapId}';
SET @large_map_revision_id = '${productionRevisionId}';
SET @large_map_actor_id = '${productionActorId}';
SET @large_map_document = '${document}';
SET @large_map_sort_order = (
    SELECT COALESCE(MAX(sort_order) + 1, 0)
    FROM space_map
    WHERE space_id = @large_map_space_id
);

INSERT INTO space_map
    (space_id, map_id, sort_order, is_entry, draft_json, published_id, published_sequence)
SELECT space.id,
       @large_map_id,
       @large_map_sort_order,
       TRUE,
       @large_map_document,
       @large_map_revision_id,
       1
FROM town_space space
JOIN app_user actor ON actor.id = @large_map_actor_id
WHERE space.id = @large_map_space_id
  AND NOT EXISTS (SELECT 1 FROM space_map existing WHERE existing.map_id = @large_map_id);

INSERT INTO map_revision
    (id, space_id, map_id, sequence_no, document, content_hash, actor_id, reason)
SELECT @large_map_revision_id,
       @large_map_space_id,
       @large_map_id,
       1,
       @large_map_document,
       SHA2(@large_map_document, 256),
       @large_map_actor_id,
       'INITIAL'
FROM space_map seeded
WHERE seeded.map_id = @large_map_id
  AND seeded.published_id = @large_map_revision_id
  AND NOT EXISTS (SELECT 1 FROM map_revision revision WHERE revision.id = @large_map_revision_id);

SET @large_map_seeded = (
    SELECT COUNT(*)
    FROM space_map
    WHERE map_id = @large_map_id AND published_id = @large_map_revision_id
);

UPDATE space_map
SET is_entry = (map_id = @large_map_id)
WHERE space_id = @large_map_space_id AND @large_map_seeded = 1;

INSERT INTO map_outbox (space_id, map_id, revision_id, sequence_no)
SELECT @large_map_space_id, @large_map_id, @large_map_revision_id, 1
FROM map_revision revision
WHERE revision.id = @large_map_revision_id
  AND NOT EXISTS (
      SELECT 1 FROM map_outbox pending WHERE pending.revision_id = @large_map_revision_id
  );
`,
);
console.log(
  `Office map: ${map.width}×${map.height}, ${map.objects.length} furniture, ${map.zones.length} zones`,
);
