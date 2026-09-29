// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record EventState(String type, boolean active, String eventId, long startedAt, boolean attendanceEnabled, boolean attendancePersistent, long attendeeCount, String title, String description, String resourceUrl, String hostPlayerId, java.util.List<String> speakerPlayerIds, java.util.List<String> raisedHandPlayerIds, java.util.List<EventParticipant> participants) {}
