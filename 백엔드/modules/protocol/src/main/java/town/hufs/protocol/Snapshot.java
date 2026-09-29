// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record Snapshot(String type, long tick, long serverTime, boolean full, long baseTick, long inputAckSeq, java.util.List<PlayerView> players, java.util.List<String> removedPlayerIds, String mapRevision, java.util.List<RoomView> rooms) {}
