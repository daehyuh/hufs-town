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
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** Verifies that a rejected approval request can be retried without duplicating pending requests. */
@Testcontainers
@Tag("infrastructure")
@SpringBootTest(classes = {ApiApplication.class, SsoIntegrationTest.TransportConfig.class},
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpaceJoinRequestRetryIntegrationTest {
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
    void resetSsoTransport() {
        transport.server().verify();
        transport.server().reset();
    }

    @Test
    void requesterCanRetryAfterRejectionAndRepeatedPendingPollDoesNotCreateAnotherRequest() throws Exception {
        Browser owner = signedIn();
        Browser requester = signedIn();
        var created = owner.post("/spaces", Map.of("name", "입장 승인 재요청", "description", "",
            "visibility", "PUBLIC", "capacity", 10, "approvalRequired", true));
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        String spaceId = json.readTree(created.body()).path("id").asText();
        String requestPath = "/spaces/" + spaceId + "/join-requests";

        var firstResponse = requester.post(requestPath, Map.of());
        assertThat(firstResponse.statusCode()).as(firstResponse.body()).isEqualTo(200);
        JsonNode first = json.readTree(firstResponse.body());
        assertThat(first.path("status").asText()).isEqualTo("PENDING");
        JsonNode firstOwnerList = json.readTree(owner.get(requestPath).body());
        assertThat(firstOwnerList).hasSize(1);
        String requestId = firstOwnerList.get(0).path("id").asText();

        var rejected = owner.post(requestPath + "/" + requestId + "/resolve", Map.of("decision", "REJECT"));
        assertThat(rejected.statusCode()).as(rejected.body()).isEqualTo(200);
        assertThat(json.readTree(owner.get(requestPath).body())).isEmpty();
        assertThat(json.readTree(requester.get("/spaces/" + spaceId).body())
            .path("joinRequestStatus").asText()).isEqualTo("REJECTED");

        Thread.sleep(5);
        var retriedResponse = requester.post(requestPath, Map.of());
        assertThat(retriedResponse.statusCode()).as(retriedResponse.body()).isEqualTo(200);
        JsonNode retried = json.readTree(retriedResponse.body());
        assertThat(retried.path("status").asText()).isEqualTo("PENDING");
        assertThat(retried.path("requestedAt").asLong()).isGreaterThan(first.path("requestedAt").asLong());

        var duplicatePollResponse = requester.post(requestPath, Map.of());
        assertThat(duplicatePollResponse.statusCode()).as(duplicatePollResponse.body()).isEqualTo(200);
        JsonNode duplicatePoll = json.readTree(duplicatePollResponse.body());
        assertThat(duplicatePoll.path("status").asText()).isEqualTo("PENDING");
        assertThat(duplicatePoll.path("requestedAt").asLong()).isEqualTo(retried.path("requestedAt").asLong());

        JsonNode retriedOwnerList = json.readTree(owner.get(requestPath).body());
        assertThat(retriedOwnerList).hasSize(1);
        assertThat(retriedOwnerList.get(0).path("userId").asText())
            .isEqualTo(json.readTree(requester.get("me").body()).path("userId").asText());
    }

    private Browser signedIn() throws Exception {
        Browser browser = new Browser();
        String state = browser.start();
        String subject = UUID.randomUUID().toString();
        transport.server().verify();
        transport.server().reset();
        transport.server().expect(requestTo("https://api.gdghufs.com/v1/sso/userinfo"))
            .andRespond(withSuccess("{\"data\":{\"uuid\":\"" + subject
                + "\",\"name\":\"입장 검증\",\"status\":\"ATTENDING\",\"email\":\"tester@hufs.ac.kr\"},\"error_code\":null}",
                MediaType.APPLICATION_JSON));
        var exchanged = browser.post("exchange", Map.of("code", UUID.randomUUID().toString(), "state", state));
        assertThat(exchanged.statusCode()).as(exchanged.body()).isEqualTo(200);
        transport.server().verify();
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

        private HttpResponse<String> post(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                .header("X-CSRF-TOKEN", csrf)
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),
                HttpResponse.BodyHandlers.ofString());
        }

        private String start() throws Exception {
            var response = post("start", Map.of());
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            String authorizationUrl = json.readTree(response.body()).path("authorizationUrl").asText();
            return Arrays.stream(URI.create(authorizationUrl).getRawQuery().split("&"))
                .filter(value -> value.startsWith("state="))
                .findFirst().orElseThrow().substring("state=".length());
        }
    }
}
