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
import org.springframework.jdbc.core.JdbcTemplate;
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
import java.time.Instant;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** Exercises scheduled-event persistence and management rights against real MariaDB and Redis. */
@Testcontainers
@Tag("infrastructure")
@SpringBootTest(classes = {ApiApplication.class, SsoIntegrationTest.TransportConfig.class},
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ScheduledEventsIntegrationTest {
    private static final String SPACE_PATH = "/spaces/";

    @Container
    static MariaDBContainer<?> database = new MariaDBContainer<>("mariadb:11.4.10");
    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7.4.8-alpine").withExposedPorts(6379);

    @LocalServerPort
    int port;
    @Autowired
    SsoIntegrationTest.Transport transport;
    @Autowired JdbcTemplate db;
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
    void resetTransport() {
        transport.server().reset();
    }

    @Test
    void managersCanPublishAndEditEventsThatAttendeesCanReadButNotManage() throws Exception {
        expectSsoUserInfo(UUID.randomUUID().toString());
        expectSsoUserInfo(UUID.randomUUID().toString());
        Browser owner = signedIn();
        Browser attendee = signedIn();
        transport.server().verify();
        Browser anonymous = new Browser();
        String spaceId = createPublicSpace(owner);
        String eventPath = SPACE_PATH + spaceId + "/scheduled-events";
        var original = Map.of(
            "title", "HUFS 오픈 밋업",
            "description", "처음 안내",
            "instructions", "광장에 모여 주세요.",
            "resourceUrl", "https://example.edu/meetup",
            "startsAt", Instant.now().plusSeconds(3600).toString(),
            "endsAt", Instant.now().plusSeconds(7200).toString()
        );

        assertThat(anonymous.get(eventPath).statusCode()).isEqualTo(401);
        var created = owner.post(eventPath, original);
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        String eventId = json.readTree(created.body()).path("id").asText();
        assertThat(eventId).isNotBlank();

        JsonNode attendeeList = json.readTree(attendee.get(eventPath).body());
        assertThat(attendeeList).hasSize(1);
        assertThat(attendeeList.get(0).path("title").asText()).isEqualTo("HUFS 오픈 밋업");
        assertThat(attendee.patch(eventPath + "/" + eventId, original).statusCode()).isEqualTo(403);

        var changed = Map.of(
            "title", "HUFS 오픈 밋업 · 장소 변경",
            "description", "운영자가 갱신한 설명",
            "instructions", "도트 광장 무대 앞으로 모여 주세요.",
            "resourceUrl", "https://example.edu/meetup-updated",
            "startsAt", Instant.now().plusSeconds(5400).toString(),
            "endsAt", Instant.now().plusSeconds(9000).toString()
        );
        var updated = owner.patch(eventPath + "/" + eventId, changed);
        assertThat(updated.statusCode()).as(updated.body()).isEqualTo(200);
        JsonNode visibleChange = json.readTree(attendee.get(eventPath).body()).get(0);
        assertThat(visibleChange.path("title").asText()).isEqualTo("HUFS 오픈 밋업 · 장소 변경");
        assertThat(visibleChange.path("instructions").asText()).isEqualTo("도트 광장 무대 앞으로 모여 주세요.");
        assertThat(visibleChange.path("resourceUrl").asText()).isEqualTo("https://example.edu/meetup-updated");

        var cancelled = owner.delete(eventPath + "/" + eventId, Map.of());
        assertThat(cancelled.statusCode()).as(cancelled.body()).isEqualTo(200);
        assertThat(json.readTree(attendee.get(eventPath).body()).get(0).path("cancelled").asBoolean()).isTrue();
    }

    @Test
    void rsvpAndEventChangesCoalesceCalendarWorkInsideTheDatabaseTransaction() throws Exception {
        String ownerId = UUID.randomUUID().toString();
        String attendeeId = UUID.randomUUID().toString();
        expectSsoUserInfo(ownerId);
        expectSsoUserInfo(attendeeId);
        Browser owner = signedIn();
        Browser attendee = signedIn();
        transport.server().verify();
        String attendeeAccountId = json.readTree(attendee.get("me").body()).path("userId").asText();
        assertThat(attendeeAccountId).isNotBlank();
        String spaceId = createPublicSpace(owner);
        String eventPath = SPACE_PATH + spaceId + "/scheduled-events";
        var eventDraft = Map.of("title", "캘린더 동기화 검증", "description", "공개 행사 안내",
            "instructions", "", "resourceUrl", "", "startsAt", Instant.now().plusSeconds(3600).toString(),
            "endsAt", Instant.now().plusSeconds(7200).toString());
        var created = owner.post(eventPath, eventDraft);
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        String eventId = json.readTree(created.body()).path("id").asText();
        connectCalendar(attendeeAccountId);

        var going = attendee.put(eventPath + "/" + eventId + "/rsvp", Map.of("response", "GOING"));
        assertThat(going.statusCode()).as(going.body()).isEqualTo(200);
        assertOutbox(attendeeAccountId, eventId, "UPSERT");

        var interested = attendee.put(eventPath + "/" + eventId + "/rsvp", Map.of("response", "INTERESTED"));
        assertThat(interested.statusCode()).as(interested.body()).isEqualTo(200);
        assertOutbox(attendeeAccountId, eventId, "DELETE");

        attendee.put(eventPath + "/" + eventId + "/rsvp", Map.of("response", "GOING"));
        var updated = owner.patch(eventPath + "/" + eventId, Map.of("title", "행사 일정 변경",
            "description", "변경된 안내", "instructions", "", "resourceUrl", "",
            "startsAt", Instant.now().plusSeconds(5400).toString(), "endsAt", Instant.now().plusSeconds(9000).toString()));
        assertThat(updated.statusCode()).as(updated.body()).isEqualTo(200);
        assertOutbox(attendeeAccountId, eventId, "UPSERT");

        var cancelled = owner.delete(eventPath + "/" + eventId, Map.of());
        assertThat(cancelled.statusCode()).as(cancelled.body()).isEqualTo(200);
        assertOutbox(attendeeAccountId, eventId, "DELETE");
        assertThat(db.queryForObject("SELECT attempts FROM calendar_sync_outbox WHERE user_id=? AND source_kind='SCHEDULED_EVENT' AND source_id=?",
            Integer.class, attendeeAccountId, eventId)).isZero();
    }

    private void connectCalendar(String userId) {
        db.update("""
            INSERT INTO user_calendar_connection(user_id,provider,remote_calendar_id,refresh_token_ciphertext)
            VALUES (?,'GOOGLE','unit-test-calendar',?)
            """, userId, "v1.test-ciphertext");
    }

    private void assertOutbox(String userId, String eventId, String operation) {
        assertThat(db.queryForObject("""
            SELECT operation FROM calendar_sync_outbox
            WHERE user_id=? AND source_kind='SCHEDULED_EVENT' AND source_id=?
            """, String.class, userId, eventId)).isEqualTo(operation);
    }

    private String createPublicSpace(Browser owner) throws Exception {
        var response = owner.post("/spaces", Map.of(
            "name", "행사 일정 통합 검증",
            "description", "참가자용 행사 공지를 확인해요.",
            "visibility", "PUBLIC",
            "capacity", 20
        ));
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return json.readTree(response.body()).path("id").asText();
    }

    private Browser signedIn() throws Exception {
        Browser browser = new Browser();
        String state = browser.start();
        var exchanged = browser.post("exchange", Map.of("code", UUID.randomUUID().toString(), "state", state));
        assertThat(exchanged.statusCode()).as(exchanged.body()).isEqualTo(200);
        return browser;
    }

    private void expectSsoUserInfo(String subject) {
        transport.server().expect(requestTo("https://api.gdghufs.com/v1/sso/userinfo"))
            .andRespond(withSuccess("{\"data\":{\"uuid\":\"" + subject
                + "\",\"name\":\"행사 테스터\",\"status\":\"ATTENDING\",\"email\":\"tester@hufs.ac.kr\"},\"error_code\":null}",
                MediaType.APPLICATION_JSON));
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

        private HttpResponse<String> patch(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                .header("X-CSRF-TOKEN", csrf)
                .method("PATCH", HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),
                HttpResponse.BodyHandlers.ofString());
        }

        private HttpResponse<String> put(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                .header("X-CSRF-TOKEN", csrf)
                .PUT(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),
                HttpResponse.BodyHandlers.ofString());
        }

        private HttpResponse<String> delete(String path, Object body) throws Exception {
            String csrf = json.readTree(get("csrf").body()).path("token").asText();
            return client.send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                .header("X-CSRF-TOKEN", csrf)
                .method("DELETE", HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),
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
