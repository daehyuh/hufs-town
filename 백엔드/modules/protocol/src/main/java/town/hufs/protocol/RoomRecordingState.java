// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record RoomRecordingState(String type, String recordingId, String zoneId, String status, java.util.List<String> sources, String requestedByPlayerId, String requestedByName, long requestedAt, long startedAt, long endedAt, long retentionDays, long trackCount, String failureCode, boolean transcribe, java.util.List<RoomRecordingParticipant> participants) {}
