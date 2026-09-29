// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record BlockAck(String type, String requestId, String targetId, boolean blocked, boolean accepted, String code, String message) {}
