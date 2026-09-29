// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record MapDefinition(long schemaVersion, String id, String revision, String name, long width, long height, double spawnX, double spawnY, java.util.List<Rect> collisions, java.util.List<MapObject> objects, java.util.List<Zone> zones, java.util.List<FloorPatch> floors, java.util.List<Wall> walls, java.util.List<MapLabel> labels, java.util.List<Portal> portals) {}
