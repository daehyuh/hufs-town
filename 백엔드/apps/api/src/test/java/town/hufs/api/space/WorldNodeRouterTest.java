package town.hufs.api.space;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorldNodeRouterTest {
    @Test void routesOneSpaceStablyAndDistributesDifferentSpaces() {
        var router = new WorldNodeRouter("wss://world-b.example/world/socket, wss://world-a.example/world/socket");

        assertThat(router.endpointFor("space-123")).isEqualTo(router.endpointFor("space-123"));
        Set<String> selected = IntStream.range(0, 100).mapToObj(i -> router.endpointFor("space-" + i))
            .collect(java.util.stream.Collectors.toCollection(HashSet::new));
        assertThat(selected).containsExactlyInAnyOrder(
            "wss://world-a.example/world/socket", "wss://world-b.example/world/socket");
    }

    @Test void leavesSingleNodeDeploymentsOnTheSameOriginFallback() {
        assertThat(new WorldNodeRouter("").endpointFor("space-123")).isEmpty();
    }

    @Test void rejectsNonWebSocketOrMalformedNodeEndpoints() {
        assertThatThrownBy(() -> new WorldNodeRouter("https://world.example/world/socket"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorldNodeRouter("wss://world.example"))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
