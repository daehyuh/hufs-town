package town.hufs.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import town.hufs.protocol.MapDefinition;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.*;

class MapRulesSharedFixturesTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test void JavaRulesAgreeWithSharedMapValidationCases() throws Exception {
        Path fixtures = Path.of(System.getProperty("hufs.projectRoot"), "contracts", "fixtures");
        ObjectNode base = (ObjectNode) JSON.readTree(fixtures.resolve("campus-map.json").toFile());
        JsonNode cases = JSON.readTree(fixtures.resolve("map-validation-cases.json").toFile()).path("cases");

        for (JsonNode testCase : cases) {
            ObjectNode map = base.deepCopy();
            JsonNode patch = testCase.path("patch");
            patch.fields().forEachRemaining(entry -> map.set(entry.getKey(), entry.getValue().deepCopy()));
            switch (testCase.path("mutation").asText()) {
                case "duplicate-first-floor-id" -> {
                    JsonNode firstFloor = map.path("floors").get(0).deepCopy();
                    ((ArrayNode) map.get("floors")).add(firstFloor);
                }
                case "add-out-of-bounds-zone" -> ((ArrayNode) map.get("zones")).add(JSON.valueToTree(
                    zone("outside-zone", "맵 밖 구역", 97, 2, 2, 2, 12L)));
                case "replace-with-overlapping-zones" -> map.set("zones", JSON.valueToTree(List.of(
                    zone("zone-a", "구역 A", 2, 2, 4, 4, 12L),
                    zone("zone-b", "구역 B", 5, 5, 4, 4, null)
                )));
                case "replace-with-touching-zones" -> map.set("zones", JSON.valueToTree(List.of(
                    zone("zone-a", "구역 A", 2, 2, 4, 4, 12L),
                    zone("zone-b", "구역 B", 6, 2, 4, 4, null)
                )));
                case "" -> { }
                default -> throw new AssertionError("Unknown shared map validation case: " + testCase.path("mutation").asText());
            }

            MapDefinition candidate = JSON.treeToValue(map, MapDefinition.class);
            if (testCase.path("valid").asBoolean()) {
                assertThat(MapRules.normalize(candidate, "fixture-space", "fixture-revision"))
                    .as(testCase.path("name").asText()).isNotNull();
            } else {
                assertThatThrownBy(() -> MapRules.normalize(candidate, "fixture-space", "fixture-revision"))
                    .as(testCase.path("name").asText()).isInstanceOf(MapRules.Invalid.class);
            }
        }
    }

    private static Map<String, Object> zone(String id, String name, double x, double y,
                                             double width, double height, Long capacity) {
        var bounds = Map.of("x", x, "y", y, "width", width, "height", height);
        return capacity == null
            ? Map.of("id", id, "name", name, "kind", "SILENT", "bounds", bounds)
            : Map.of("id", id, "name", name, "kind", "PRIVATE", "bounds", bounds, "capacity", capacity);
    }
}
