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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** Exercises reservation overlap, edit rights, and time-bounded map admission against MariaDB and Redis. */
@Testcontainers
@Tag("infrastructure")
@SpringBootTest(classes = {ApiApplication.class, SsoIntegrationTest.TransportConfig.class},
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RoomReservationsIntegrationTest {
    @Container static MariaDBContainer<?> database = new MariaDBContainer<>("mariadb:11.4.10");
    @Container static GenericContainer<?> redis = new GenericContainer<>("redis:7.4.8-alpine").withExposedPorts(6379);

    @LocalServerPort int port;
    @Autowired SsoIntegrationTest.Transport transport;
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

    @BeforeEach void resetTransport() { transport.server().reset(); }

    @Test
    void serializesOverlappingReservationsAndChecksEditCancelAndAdmissionRules() throws Exception {
        String ownerId = UUID.randomUUID().toString();
        expectSsoUserInfo(ownerId);
        expectSsoUserInfo(UUID.randomUUID().toString());
        Browser owner = signedIn();
        Browser member = signedIn();
        transport.server().verify();
        String ownerAccountId = json.readTree(owner.get("me").body()).path("userId").asText();
        assertThat(ownerAccountId).isNotBlank();
        connectCalendar(ownerAccountId);

        String spaceId = createPublicSpace(owner);
        String mapPath = "/spaces/" + spaceId + "/maps";
        var mapResponse = owner.post(mapPath, Map.of("name", "스터디룸", "templateId", "STUDY_SPACE"));
        assertThat(mapResponse.statusCode()).as(mapResponse.body()).isEqualTo(200);
        String mapId = json.readTree(mapResponse.body()).path("mapId").asText();
        assertThat(mapId).isNotBlank();

        String path = "/spaces/" + spaceId + "/room-reservations";
        var listed = member.get(path);
        assertThat(listed.statusCode()).isEqualTo(200);
        JsonNode initial = json.readTree(listed.body());
        JsonNode room = null;
        for (JsonNode candidate : initial.path("rooms"))
            if (candidate.path("mapId").asText().equals(mapId) && candidate.path("zoneId").asText().equals("group-study")) room = candidate;
        assertThat(room).isNotNull();
        assertThat(initial.path("canReserve").asBoolean()).isFalse();

        var joined = member.post("/spaces/" + spaceId + "/admission", Map.of("mapId", mapId));
        assertThat(joined.statusCode()).as(joined.body()).isEqualTo(200);
        assertThat(json.readTree(member.get(path).body()).path("canReserve").asBoolean()).isTrue();

        Instant start = Instant.now().plusSeconds(600);
        Instant end = start.plusSeconds(3600);
        Map<String, Object> firstDraft = draft(mapId, room.path("zoneId").asText(), "그룹 스터디", start, end);
        var first = owner.post(path, firstDraft);
        assertThat(first.statusCode()).as(first.body()).isEqualTo(200);
        JsonNode firstReservation = json.readTree(first.body());
        String reservationId = firstReservation.path("id").asText();
        assertThat(firstReservation.path("organizerUserId").isMissingNode()).isTrue();
        assertOutbox(ownerAccountId, reservationId, "UPSERT");

        Instant overlappingStart = start.plusSeconds(900);
        Map<String, Object> secondDraft = draft(mapId, room.path("zoneId").asText(), "겹치는 예약", overlappingStart, end.plusSeconds(900));
        var ownerRetry = owner.post(path, firstDraft);
        assertThat(ownerRetry.statusCode()).as(ownerRetry.body()).isEqualTo(200);
        assertThat(json.readTree(ownerRetry.body()).path("id").asText()).isEqualTo(reservationId);

        var deniedWrite = member.patch(path + "/" + reservationId, Map.of(
            "requestId", UUID.randomUUID().toString(), "mapId", mapId, "zoneId", room.path("zoneId").asText(),
            "title", "무단 변경", "startsAt", start.toString(), "endsAt", end.toString(),
            "expectedUpdatedAt", firstReservation.path("updatedAt").asText()));
        assertThat(deniedWrite.statusCode()).isEqualTo(403);

        var reservedEntry = member.post("/spaces/" + spaceId + "/admission", Map.of("reservationId", reservationId));
        assertThat(reservedEntry.statusCode()).as(reservedEntry.body()).isEqualTo(200);
        Instant laterStart = Instant.now().plusSeconds(7200);
        Map<String, Object> laterDraft = draft(mapId, room.path("zoneId").asText(), "아직 이른 예약", laterStart,
            laterStart.plusSeconds(3600));
        var later = owner.post(path, laterDraft);
        assertThat(later.statusCode()).as(later.body()).isEqualTo(200);
        String laterReservationId = json.readTree(later.body()).path("id").asText();
        var earlyEntry = member.post("/spaces/" + spaceId + "/admission", Map.of("reservationId", laterReservationId));
        assertThat(earlyEntry.statusCode()).isEqualTo(409);

        var changed = owner.patch(path + "/" + reservationId, Map.of(
            "requestId", UUID.randomUUID().toString(), "mapId", mapId, "zoneId", room.path("zoneId").asText(),
            "title", "스터디룸 예약 수정", "startsAt", start.toString(), "endsAt", end.toString(),
            "expectedUpdatedAt", firstReservation.path("updatedAt").asText()));
        assertThat(changed.statusCode()).as(changed.body()).isEqualTo(200);
        JsonNode updated = json.readTree(changed.body());
        assertThat(updated.path("title").asText()).isEqualTo("스터디룸 예약 수정");
        assertOutbox(ownerAccountId, reservationId, "UPSERT");

        Instant otherStart = start.plusSeconds(DurationSeconds.ONE_DAY);
        Map<String, Object> leftDraft = draft(mapId, room.path("zoneId").asText(), "동시 예약 A", otherStart, otherStart.plusSeconds(3600));
        Map<String, Object> rightDraft = draft(mapId, room.path("zoneId").asText(), "동시 예약 B", otherStart.plusSeconds(300), otherStart.plusSeconds(3900));
        CompletableFuture<HttpResponse<String>> left = CompletableFuture.supplyAsync(() -> owner.post(path, leftDraft));
        CompletableFuture<HttpResponse<String>> right = CompletableFuture.supplyAsync(() -> member.post(path, rightDraft));
        var outcomes = java.util.List.of(left.get(30, TimeUnit.SECONDS).statusCode(), right.get(30, TimeUnit.SECONDS).statusCode());
        assertThat(outcomes).containsExactlyInAnyOrder(200, 409);

        var cancelled = owner.delete(path + "/" + reservationId);
        assertThat(cancelled.statusCode()).as(cancelled.body()).isEqualTo(200);
        assertThat(json.readTree(cancelled.body()).path("cancelledAt").asText()).isNotBlank();
        assertOutbox(ownerAccountId, reservationId, "DELETE");
        var replacement = member.post(path, secondDraft);
        assertThat(replacement.statusCode()).as(replacement.body()).isEqualTo(200);
    }

    private Map<String, Object> draft(String mapId, String zoneId, String title, Instant startsAt, Instant endsAt) {
        return Map.of("requestId", UUID.randomUUID().toString(), "mapId", mapId, "zoneId", zoneId,
            "title", title, "startsAt", startsAt.toString(), "endsAt", endsAt.toString());
    }

    private void connectCalendar(String userId) {
        db.update("""
            INSERT INTO user_calendar_connection(user_id,provider,remote_calendar_id,refresh_token_ciphertext)
            VALUES (?,'GOOGLE','unit-test-calendar',?)
            """, userId, "v1.test-ciphertext");
    }

    private void assertOutbox(String userId, String reservationId, String operation) {
        assertThat(db.queryForObject("""
            SELECT operation FROM calendar_sync_outbox
            WHERE user_id=? AND source_kind='ROOM_RESERVATION' AND source_id=?
            """, String.class, userId, reservationId)).isEqualTo(operation);
    }

    private String createPublicSpace(Browser owner) throws Exception {
        var response = owner.post("/spaces", Map.of("name", "회의실 예약 검증", "description", "예약을 확인해요.",
            "visibility", "PUBLIC", "capacity", 20));
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
                + "\",\"name\":\"예약 테스터\",\"status\":\"ATTENDING\",\"email\":\"tester@hufs.ac.kr\"},\"error_code\":null}",
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

        private HttpResponse<String> post(String path, Object body) {
            return mutate(path, body, "POST");
        }

        private HttpResponse<String> patch(String path, Object body) {
            return mutate(path, body, "PATCH");
        }

        private HttpResponse<String> delete(String path) {
            return mutate(path, null, "DELETE");
        }

        private HttpResponse<String> mutate(String path, Object body, String method) {
            try {
                String csrf = json.readTree(get("csrf").body()).path("token").asText();
                var request = HttpRequest.newBuilder(uri(path)).header("X-CSRF-TOKEN", csrf)
                    .header("Content-Type", "application/json");
                if ("GET".equals(method)) request.GET();
                else if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
                else request.method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
                return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
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

    private static final class DurationSeconds {
        static final long ONE_DAY = 86_400;
    }
}
