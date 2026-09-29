// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record DirectMessageMutationAck(String type, String requestId, String conversationId, String messageId, boolean accepted, long revision, String code, String message) {}
