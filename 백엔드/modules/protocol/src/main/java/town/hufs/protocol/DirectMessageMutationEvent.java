// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record DirectMessageMutationEvent(String type, String conversationId, String messageId, String text, long revision, long editedAt, boolean deleted) {}
