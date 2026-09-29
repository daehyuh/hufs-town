// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record RoomNoteState(String type, String zoneId, long revision, String body, long updatedAt, String updatedBy, long meetingEndedAt, long retentionExpiresAt, java.util.List<RoomNoteRevision> history) {}
