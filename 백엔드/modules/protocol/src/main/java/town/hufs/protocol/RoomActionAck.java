// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record RoomActionAck(String type, String requestId, String zoneId, boolean accepted, boolean locked, long capacity, String code, String message) {}
