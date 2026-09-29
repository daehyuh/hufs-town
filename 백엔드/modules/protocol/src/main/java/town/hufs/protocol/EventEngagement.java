// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record EventEngagement(String type, long epoch, String requestId, String action, String questionId, String text, String pollQuestion, java.util.List<String> pollOptions, long optionIndex, long correctOptionIndex) {}
