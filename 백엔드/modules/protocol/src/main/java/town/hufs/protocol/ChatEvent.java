// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record ChatEvent(String type, String messageId, String clientMessageId, String channel, String conversationId, String senderId, String senderName, long avatar, String skin, String clothing, String hair, String text, long sentAt, String zoneId, long revision, long editedAt, boolean deleted) {}
