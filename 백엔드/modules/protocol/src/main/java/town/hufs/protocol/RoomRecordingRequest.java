// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record RoomRecordingRequest(String type, String requestId, long epoch, String zoneId, String action, String recordingId, java.util.List<String> sources, boolean transcribe, boolean accepted) {}
