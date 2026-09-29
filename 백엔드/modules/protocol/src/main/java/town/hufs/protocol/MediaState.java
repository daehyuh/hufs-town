// Generated from contracts/world.schema.json. Do not edit.
package town.hufs.protocol;
public record MediaState(String type, long policyEpoch, String domain, String kind, boolean available, boolean transitioning, boolean limited, double proximityEnterDistance, double proximityExitDistance, java.util.List<String> moderatedSources, java.util.List<String> peers, java.util.List<MediaOffer> offers, String engineId, boolean eventMode, boolean eventSpeaker, String eventTitle) {}
