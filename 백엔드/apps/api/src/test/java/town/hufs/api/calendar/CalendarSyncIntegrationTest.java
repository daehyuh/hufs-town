package town.hufs.api.calendar;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.MariaDBContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import town.hufs.api.ApiApplication;
import town.hufs.auth.TownPrincipal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;
import static org.springframework.http.HttpStatus.NOT_FOUND;
import static org.springframework.http.HttpStatus.PRECONDITION_FAILED;
import static org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE;
import static org.hamcrest.Matchers.containsString;

@Testcontainers
@Tag("infrastructure")
@SpringBootTest(classes = {ApiApplication.class, CalendarSyncIntegrationTest.GoogleMockConfiguration.class},
    webEnvironment = SpringBootTest.WebEnvironment.MOCK)
class CalendarSyncIntegrationTest {
    private static final String USER_ID = "11111111-1111-4111-8111-111111111111";
    private static final String SPACE_ID = "22222222-2222-4222-8222-222222222222";
    private static final String EVENT_ID = "33333333-3333-4333-8333-333333333333";
    private static final String CALENDAR_ID = "hufs-town-test-calendar";
    private static final String KEY = Base64.getEncoder().encodeToString(new byte[32]);
    private static final String SOURCE_KIND = "SCHEDULED_EVENT";

    @Container static MariaDBContainer<?> database = new MariaDBContainer<>("mariadb:11.4.10");
    @Container static GenericContainer<?> redis = new GenericContainer<>("redis:7.4.8-alpine").withExposedPorts(6379);

    @Autowired JdbcTemplate db;
    @Autowired GoogleCalendarHttpMock googleHttp;
    @Autowired CalendarTokenCipher cipher;
    @Autowired CalendarSyncOutbox outbox;
    @Autowired CalendarSyncItems items;
    @Autowired CalendarSyncWorker worker;
    @Autowired CalendarConnectionStore connections;
    @Autowired GoogleCalendarController controller;

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
        registry.add("town.public-origin", () -> "http://localhost:5173");
        registry.add("town.calendar.google.enabled", () -> true);
        registry.add("town.calendar.google.client-id", () -> "test-client-id");
        registry.add("town.calendar.google.client-secret", () -> "test-client-secret");
        registry.add("town.calendar.google.redirect-uri", () -> "http://localhost:5173/api/v1/calendar/google/callback");
        registry.add("town.calendar.google.token-encryption-key", () -> KEY);
        registry.add("town.calendar.google.initial-delay-ms", () -> 3_600_000);
        registry.add("town.calendar.google.reconcile-initial-delay-ms", () -> 3_600_000);
    }

    @BeforeEach
    void resetProvider() {
        googleHttp.server().reset();
    }

    @Test
    void syncIsIdempotentAndRemoteEditsNeedExplicitEtagProtectedResolution() {
        seedConnectedEvent();
        String remoteEventId = "hufs" + sha256(USER_ID + "\n" + SOURCE_KIND + "\n" + EVENT_ID);
        String syncKey = sha256("HUFS_TOWN\n" + USER_ID + "\n" + SOURCE_KIND + "\n" + EVENT_ID);
        String eventUri = "https://www.googleapis.com/calendar/v3/calendars/" + CALENDAR_ID + "/events/" + remoteEventId;

        expectRefresh();
        googleHttp.server().expect(requestTo(eventUri)).andExpect(method(HttpMethod.GET))
            .andRespond(withStatus(NOT_FOUND));
        googleHttp.server().expect(requestTo(eventUri.substring(0, eventUri.lastIndexOf('/'))))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().json("""
                {"id":"%s","summary":"Orientation","extendedProperties":{"private":{"hufsTownSyncKey":"%s"}}}
                """.formatted(remoteEventId, syncKey), false))
            .andRespond(withSuccess("""
                {"id":"%s","etag":"etag-1","status":"confirmed",
                 "extendedProperties":{"private":{"hufsTownSyncKey":"%s"}}}
                """.formatted(remoteEventId, syncKey), MediaType.APPLICATION_JSON));

        worker.dispatch();
        googleHttp.server().verify();
        CalendarSyncItems.Item first = items.find(USER_ID, SOURCE_KIND, EVENT_ID).orElseThrow();
        assertThat(first.remoteEventId()).isEqualTo(remoteEventId);
        assertThat(first.remoteEtag()).isEqualTo("etag-1");
        assertThat(first.state()).isEqualTo("SYNCED");
        assertThat(outbox.pendingCount(USER_ID, false)).isZero();
        googleHttp.server().reset();

        db.update("UPDATE town_scheduled_event SET title='Orientation · Updated',description='Updated details' WHERE id=?", EVENT_ID);
        outbox.enqueue(USER_ID, SOURCE_KIND, EVENT_ID, "UPSERT");
        expectRefresh();
        googleHttp.server().expect(requestTo(eventUri)).andExpect(method(HttpMethod.PATCH))
            .andExpect(header(HttpHeaders.IF_MATCH, "etag-1"))
            .andRespond(withStatus(SERVICE_UNAVAILABLE));

        worker.dispatch();

        assertThat(db.queryForObject("SELECT attempts FROM calendar_sync_outbox WHERE user_id=? AND source_id=?",
            Integer.class, USER_ID, EVENT_ID)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT last_error_code FROM calendar_sync_outbox WHERE user_id=? AND source_id=?",
            String.class, USER_ID, EVENT_ID)).isEqualTo("CALENDAR_PROVIDER_UNAVAILABLE");
        assertThat(items.find(USER_ID, SOURCE_KIND, EVENT_ID).orElseThrow().remoteEtag()).isEqualTo("etag-1");
        db.update("UPDATE calendar_sync_outbox SET available_at=CURRENT_TIMESTAMP(6) WHERE user_id=? AND source_id=?",
            USER_ID, EVENT_ID);
        googleHttp.server().verify();
        googleHttp.server().reset();

        expectRefresh();
        googleHttp.server().expect(requestTo(eventUri)).andExpect(method(HttpMethod.PATCH))
            .andExpect(header(HttpHeaders.IF_MATCH, "etag-1"))
            .andExpect(content().string(containsString("Orientation · Updated")))
            .andRespond(withSuccess("""
                {"id":"%s","etag":"etag-2","status":"confirmed"}
                """.formatted(remoteEventId), MediaType.APPLICATION_JSON));

        worker.dispatch();

        assertThat(items.find(USER_ID, SOURCE_KIND, EVENT_ID).orElseThrow().state()).isEqualTo("SYNCED");
        assertThat(items.find(USER_ID, SOURCE_KIND, EVENT_ID).orElseThrow().remoteEtag()).isEqualTo("etag-2");
        assertThat(outbox.pendingCount(USER_ID, false)).isZero();
        googleHttp.server().verify();
        googleHttp.server().reset();

        db.update("UPDATE town_scheduled_event SET title='Orientation · Updated again' WHERE id=?", EVENT_ID);
        outbox.enqueue(USER_ID, SOURCE_KIND, EVENT_ID, "UPSERT");
        expectRefresh();
        googleHttp.server().expect(requestTo(eventUri)).andExpect(method(HttpMethod.PATCH))
            .andExpect(header(HttpHeaders.IF_MATCH, "etag-2"))
            .andRespond(withStatus(PRECONDITION_FAILED));

        worker.dispatch();

        assertThat(items.find(USER_ID, SOURCE_KIND, EVENT_ID).orElseThrow().state()).isEqualTo("CONFLICT");
        assertThat(items.conflicts(USER_ID)).hasSize(1);
        assertThat(outbox.pendingCount(USER_ID, false)).isZero();
        googleHttp.server().verify();
        googleHttp.server().reset();

        outbox.enqueueConflictOverwrite(USER_ID, SOURCE_KIND, EVENT_ID);
        expectRefresh();
        googleHttp.server().expect(requestTo(eventUri)).andExpect(method(HttpMethod.GET))
            .andRespond(withSuccess("""
                {"id":"%s","etag":"etag-3","status":"confirmed",
                 "extendedProperties":{"private":{"hufsTownSyncKey":"%s"}}}
                """.formatted(remoteEventId, syncKey), MediaType.APPLICATION_JSON));
        googleHttp.server().expect(requestTo(eventUri)).andExpect(method(HttpMethod.PATCH))
            .andExpect(header(HttpHeaders.IF_MATCH, "etag-3"))
            .andExpect(content().string(containsString("Orientation · Updated again")))
            .andRespond(withSuccess("""
                {"id":"%s","etag":"etag-4","status":"confirmed"}
                """.formatted(remoteEventId), MediaType.APPLICATION_JSON));

        worker.dispatch();

        CalendarSyncItems.Item resolved = items.find(USER_ID, SOURCE_KIND, EVENT_ID).orElseThrow();
        assertThat(resolved.state()).isEqualTo("SYNCED");
        assertThat(resolved.remoteEtag()).isEqualTo("etag-4");
        assertThat(items.conflicts(USER_ID)).isEmpty();
        assertThat(outbox.pendingCount(USER_ID, false)).isZero();
        googleHttp.server().verify();
        googleHttp.server().reset();

        googleHttp.server().expect(requestTo("https://oauth2.googleapis.com/revoke"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().string(containsString("token=test-refresh-token")))
            .andRespond(request -> {
                assertThat(connections.find(USER_ID)).isEmpty();
                assertThat(db.queryForObject("SELECT COUNT(*) FROM calendar_sync_outbox WHERE user_id=?",
                    Integer.class, USER_ID)).isZero();
                return withStatus(SERVICE_UNAVAILABLE).createResponse(request);
            });
        assertThat(controller.disconnect(new TownPrincipal(USER_ID, "Calendar tester", 0)))
            .containsEntry("connected", false);
        assertThat(connections.find(USER_ID)).isEmpty();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM calendar_sync_outbox WHERE user_id=?",
            Integer.class, USER_ID)).isZero();
        worker.dispatch();
        googleHttp.server().verify();
    }

    private void seedConnectedEvent() {
        db.update("INSERT INTO app_user(id,display_name,status) VALUES (?,?,'ACTIVE')", USER_ID, "Calendar tester");
        db.update("""
            INSERT INTO town_space(id,name,description,visibility,capacity,owner_id)
            VALUES (?,?,?,'PUBLIC',100,?)
            """, SPACE_ID, "Test space", "Public calendar sync fixture", USER_ID);
        db.update("""
            INSERT INTO town_scheduled_event(id,space_id,created_by,title,description,resource_url,starts_at,ends_at)
            VALUES (?,?,?,?,?,?,?,?)
            """, EVENT_ID, SPACE_ID, USER_ID, "Orientation", "First details", "https://example.edu/orientation",
            Timestamp.from(Instant.now().plusSeconds(7200)), Timestamp.from(Instant.now().plusSeconds(10_800)));
        db.update("INSERT INTO town_scheduled_event_rsvp(event_id,user_id,response) VALUES (?,?,'GOING')", EVENT_ID, USER_ID);
        db.update("""
            INSERT INTO user_calendar_connection(user_id,provider,remote_calendar_id,refresh_token_ciphertext)
            VALUES (?,'GOOGLE',?,?)
            """, USER_ID, CALENDAR_ID, cipher.encrypt("test-refresh-token"));
        outbox.enqueue(USER_ID, SOURCE_KIND, EVENT_ID, "UPSERT");
    }

    private void expectRefresh() {
        googleHttp.server().expect(requestTo("https://oauth2.googleapis.com/token"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().string(containsString("grant_type=refresh_token")))
            .andRespond(withSuccess("""
                {"access_token":"test-access-token","expires_in":3600,"token_type":"Bearer"}
                """, MediaType.APPLICATION_JSON));
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class GoogleMockConfiguration {
        @Bean GoogleCalendarHttpMock googleCalendarHttpMock() {
            RestClient.Builder builder = RestClient.builder();
            MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
            return new GoogleCalendarHttpMock(builder.build(), server);
        }

        @Bean
        @Primary
        RestClient testGoogleCalendarRestClient(GoogleCalendarHttpMock mock) {
            return mock.client();
        }
    }

    static class GoogleCalendarHttpMock {
        private final RestClient client;
        private final MockRestServiceServer server;
        GoogleCalendarHttpMock(RestClient client, MockRestServiceServer server) {
            this.client = client;
            this.server = server;
        }
        RestClient client() { return client; }
        MockRestServiceServer server() { return server; }
    }
}
