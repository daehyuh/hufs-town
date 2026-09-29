// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record GroupInvitationAck(String type, String requestId, String invitationId, String conversationId, String targetPlayerId, boolean accepted, String code, String message) {}
