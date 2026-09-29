package town.hufs.api.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.MariaDBContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import town.hufs.api.ApiApplication;

import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** Verifies extension approvals and context isolation against MariaDB and Redis. */
@Testcontainers
@Tag("infrastructure")
@SpringBootTest(classes = {ApiApplication.class, SsoIntegrationTest.TransportConfig.class},
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpaceExtensionsIntegrationTest {
    private static final int MAX_CONTEXT_REQUESTS = 60;
    @Container
    static MariaDBContainer<?> database = new MariaDBContainer<>("mariadb:11.4.10");
    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7.4.8-alpine").withExposedPorts(6379);

    @LocalServerPort
    int port;
    @Autowired
    SsoIntegrationTest.Transport transport;
    private final ObjectMapper json = new ObjectMapper();

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", database::getJdbcUrl);
        registry.add("spring.datasource.username", database::getUsername);
        registry.add("spring.datasource.password", database::getPassword);
        registry.add("spring.data.redis.host", redis::getHost);
        registry.add("spring.data.redis.port", () -> redis.getMappedPort(6379));
        registry.add("town.auth.mode", () -> "sso");
        registry.add("town.storage-mode", () -> "mariadb-redis");
        registry.add("town.auth.cookie-secure", () -> false);
        registry.add("town.auth.sso.client-id", () -> "test-town");
        registry.add("town.auth.sso.client-secret", () -> "test-secret");
        registry.add("town.public-origin", () -> "http://localhost:5173");
        registry.add("town.world.endpoints", () -> "wss://world-a.test/world/socket,wss://world-b.test/world/socket");
    }

    @BeforeEach
    void resetTransport() { transport.server().reset(); }

    @Test
    void memberGetsOnlyApprovedContextAndManagerCanDisableItImmediately() throws Exception {
        String ownerId = UUID.randomUUID().toString();
        String memberId = UUID.randomUUID().toString();
        String outsiderId = UUID.randomUUID().toString();
        expectSsoUserInfo(ownerId);
        expectSsoUserInfo(memberId);
        expectSsoUserInfo(outsiderId);
        Browser owner = signedIn();
        Browser member = signedIn();
        Browser outsider = signedIn();
        String spaceId = createPublicSpace(owner);
        String path = "/spaces/" + spaceId + "/extensions";
        assertThat(member.post("/spaces/" + spaceId + "/admission", Map.of()).statusCode()).isEqualTo(200);

        var invalidProtocol = owner.post(path, Map.of("name", "Unsafe", "launchUrl", "http://example.org/app",
            "requestedPermissions", List.of("SPACE_SUMMARY_READ")));
        assertThat(invalidProtocol.statusCode()).isEqualTo(400);
        var invalidPermission = owner.post(path, Map.of("name", "Unsafe", "launchUrl", "https://example.org/app",
            "requestedPermissions", List.of("SPACE_RAW_SESSION")));
        assertThat(invalidPermission.statusCode()).isEqualTo(400);

        var created = owner.post(path, Map.of("name", "Space helper", "launchUrl", "https://example.org/app",
            "requestedPermissions", List.of("SPACE_SUMMARY_READ")));
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        String extensionId = json.readTree(created.body()).path("id").asText();
        assertThat(json.readTree(created.body()).path("enabled").asBoolean()).isFalse();
        assertThat(json.readTree(member.get(path).body())).isEmpty();
        assertThat(member.get(path + "/" + extensionId + "/context").statusCode()).isEqualTo(404);
        assertThat(member.post(path, Map.of("name", "Not manager", "launchUrl", "https://example.net/app",
            "requestedPermissions", List.of())).statusCode()).isEqualTo(403);

        var approval = owner.put(path + "/" + extensionId + "/permissions",
            Map.of("approvedPermissions", List.of("SPACE_SUMMARY_READ")));
        assertThat(approval.statusCode()).as(approval.body()).isEqualTo(200);
        assertThat(json.readTree(approval.body()).path("enabled").asBoolean()).isFalse();
        var enabled = owner.post(path + "/" + extensionId + "/enable", Map.of());
        assertThat(enabled.statusCode()).as(enabled.body()).isEqualTo(200);
        assertThat(json.readTree(member.get(path).body())).hasSize(1);

        JsonNode context = json.readTree(member.get(path + "/" + extensionId + "/context").body());
        assertThat(context.path("space").path("id").asText()).isEqualTo(spaceId);
        assertThat(context.path("space").path("name").asText()).isEqualTo("Extension boundary test");
        assertThat(context.path("space").has("allowedEmailDomains")).isFalse();
        assertThat(context.path("permissions").get(0).asText()).isEqualTo("SPACE_SUMMARY_READ");
        assertThat(outsider.get(path + "/" + extensionId + "/context").statusCode()).isEqualTo(403);
        for (int request = 1; request < MAX_CONTEXT_REQUESTS; request++)
            assertThat(member.get(path + "/" + extensionId + "/context").statusCode()).isEqualTo(200);
        assertThat(member.get(path + "/" + extensionId + "/context").statusCode()).isEqualTo(429);

        var disabled = owner.post(path + "/" + extensionId + "/disable", Map.of());
        assertThat(disabled.statusCode()).as(disabled.body()).isEqualTo(200);
        assertThat(member.get(path + "/" + extensionId + "/context").statusCode()).isEqualTo(404);
        assertThat(json.readTree(member.get(path).body())).isEmpty();
    }

    private String createPublicSpace(Browser owner) throws Exception {
        var response = owner.post("/spaces", Map.of("name", "Extension boundary test", "description", "Scoped app context",
            "visibility", "PUBLIC", "capacity", 20));
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return json.readTree(response.body()).path("id").asText();
    }

    private void expectSsoUserInfo(String subject) {
        transport.server().expect(requestTo("https://api.gdghufs.com/v1/sso/userinfo"))
            .andRespond(withSuccess("{\"data\":{\"uuid\":\"" + subject
                + "\",\"name\":\"Extension tester\",\"status\":\"ATTENDING\",\"email\":\"tester@hufs.ac.kr\"},\"error_code\":null}",
                MediaType.APPLICATION_JSON));
    }

    private Browser signedIn() throws Exception {
        Browser browser = new Browser();
        String state = browser.start();
        var exchange = browser.post("exchange", Map.of("code", UUID.randomUUID().toString(), "state", state));
        assertThat(exchange.statusCode()).as(exchange.body()).isEqualTo(200);
        return browser;
    }

    private final class Browser {
        private final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        private final HttpClient client = HttpClient.newBuilder().cookieHandler(cookies).build();

        private URI uri(String path) {
            return URI.create("http://127.0.0.1:" + port + "/api/v1" + (path.startsWith("/") ? path : "/auth/" + path));
        }

        private HttpResponse<String> get(String path) throws Exception {
            return client.send(HttpRequest.newBuilder(uri(path)).GET().build(), HttpResponse.BodyHandlers.ofString());
        }

        private HttpResponse<String> post(String path, Object body) throws Exception { return mutate(path, body, "POST"); }
        private HttpResponse<String> put(String path, Object body) throws Exception { return mutate(path, body, "PUT"); }

        private HttpResponse<String> mutate(String path, Object body, String method) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                .header("X-CSRF-TOKEN", csrf).method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),
                HttpResponse.BodyHandlers.ofString());
        }

        private String start() throws Exception {
            var response = post("start", Map.of());
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            String authorizationUrl = json.readTree(response.body()).path("authorizationUrl").asText();
            return Arrays.stream(URI.create(authorizationUrl).getRawQuery().split("&"))
                .filter(value -> value.startsWith("state=")).findFirst().orElseThrow().substring("state=".length());
        }
    }
}
