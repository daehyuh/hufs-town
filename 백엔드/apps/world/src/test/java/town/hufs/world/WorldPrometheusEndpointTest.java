package town.hufs.world;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalManagementPort;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"town.auth.mode=preview", "spring.profiles.active=preview", "town.auth.preview-multimap-enabled=true", "management.server.port=0"})
class WorldPrometheusEndpointTest {
    @LocalServerPort int applicationPort;
    @LocalManagementPort int managementPort;
    final HttpClient client = HttpClient.newHttpClient();

    @Test void exposesWorldAndJvmMetricsOnlyOnTheSeparateManagementPort() throws Exception {
        var metrics = get(managementPort, "/actuator/prometheus");
        assertThat(metrics.statusCode()).as("management endpoint response: %s", metrics.body()).isEqualTo(200);
        assertThat(metrics.body()).contains("hufs_world_players_active", "hufs_world_tick_duration_p95_seconds", "jvm_memory_used_bytes");

        assertThat(get(applicationPort, "/actuator/prometheus").statusCode()).isEqualTo(404);
    }

    private HttpResponse<String> get(int port, String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET().build(),
            HttpResponse.BodyHandlers.ofString());
    }
}
