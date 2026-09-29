package town.hufs.protocol;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;

public final class OfficeCatalog {
    public record Asset(String id, String name, double width, double height, Rect footprint) {}
    private static final Map<String, Asset> ASSETS = read();
    private OfficeCatalog() {}
    public static Asset asset(String id) { return ASSETS.get(id); }
    private static Map<String, Asset> read() {
        try (var stream = OfficeCatalog.class.getResourceAsStream("/office-catalog.json")) {
            var result = new LinkedHashMap<String, Asset>();
            var json = new ObjectMapper();
            for (var row : json.readTree(Objects.requireNonNull(stream)).path("items")) {
                Rect footprint = row.path("footprint").isNull() ? null : json.treeToValue(row.path("footprint"), Rect.class);
                result.put(row.path("id").asText(), new Asset(row.path("id").asText(), row.path("name").asText(), row.path("width").asDouble(), row.path("height").asDouble(), footprint));
            }
            return Collections.unmodifiableMap(result);
        } catch (Exception e) { throw new IllegalStateException("Office catalog missing or invalid", e); }
    }
}
