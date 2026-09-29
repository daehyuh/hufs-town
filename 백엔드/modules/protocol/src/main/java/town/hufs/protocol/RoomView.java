// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record RoomView(String zoneId, String name, boolean locked, long capacity, long occupants, String hostPlayerId, java.util.List<RoomKnock> pendingKnocks) {}
