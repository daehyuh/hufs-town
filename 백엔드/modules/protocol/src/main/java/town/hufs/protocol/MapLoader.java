package town.hufs.protocol;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;

public final class MapLoader {
    private MapLoader() {}
    public static MapDefinition campus() {
        return load("campus-map.json");
    }
    public static MapDefinition template(String id) {
        return switch (id) {
            case "OFFICE" -> campus();
            case "CAMPUS_SQUARE" -> load("campus-square-map.json");
            case "STUDY_SPACE" -> load("study-space-map.json");
            case "MEETUP_HALL" -> load("meetup-hall-map.json");
            default -> throw new IllegalArgumentException("Unknown space map template");
        };
    }
    private static MapDefinition load(String resource) {
        try (var stream = MapLoader.class.getResourceAsStream("/" + resource)) {
            if (stream == null) throw new IllegalStateException("Map resource missing: " + resource + "; run scripts/prepare-assets.mjs");
            return new ObjectMapper().readValue(stream, MapDefinition.class);
        } catch (IOException e) { throw new IllegalStateException("Invalid campus map", e); }
    }
}
