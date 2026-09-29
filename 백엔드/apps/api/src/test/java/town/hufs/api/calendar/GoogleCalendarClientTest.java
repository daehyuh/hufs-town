package town.hufs.api.calendar;

import org.junit.jupiter.api.Test;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.anything;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;
import static org.springframework.http.HttpStatus.NOT_FOUND;
import static org.springframework.http.HttpStatus.PRECONDITION_FAILED;

class GoogleCalendarClientTest {
    private static final GoogleCalendarSettings SETTINGS = new GoogleCalendarSettings(true,
        "client-id", "client-secret", "https://town.example/api/v1/calendar/google/callback",
        Base64.getEncoder().encodeToString(new byte[32]));

    @Test
    void authorizationRequestsOnlyTheAppCreatedCalendarScope() {
        GoogleCalendarClient client = new GoogleCalendarClient(SETTINGS, RestClient.builder().build());

        URI uri = client.authorizationUri("random-state");

        assertThat(UriComponentsBuilder.fromUri(uri).build().getQueryParams())
            .containsEntry("scope", java.util.List.of(GoogleCalendarClient.CALENDAR_SCOPE))
            .containsEntry("state", java.util.List.of("random-state"))
            .containsEntry("access_type", java.util.List.of("offline"));
    }

    @Test
    void patchUsesIfMatchAndOmitsImmutableEventId() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        GoogleCalendarClient client = new GoogleCalendarClient(SETTINGS, builder.build());
        URI eventUri = UriComponentsBuilder.fromUriString("https://www.googleapis.com/calendar/v3")
            .pathSegment("calendars", "team@group.calendar.google.com", "events", "hufstown012345")
            .build().encode().toUri();

        AtomicReference<URI> actualUri = new AtomicReference<>();
        AtomicReference<String> authorization = new AtomicReference<>();
        AtomicReference<String> ifMatch = new AtomicReference<>();
        AtomicReference<String> body = new AtomicReference<>();
        server.expect(anything()).andRespond(request -> {
            actualUri.set(request.getURI());
            authorization.set(request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION));
            ifMatch.set(request.getHeaders().getFirst(HttpHeaders.IF_MATCH));
            body.set(new String(((MockClientHttpRequest) request).getBodyAsBytes(), StandardCharsets.UTF_8));
            return withSuccess("""
                {"id":"hufstown012345","etag":"etag-2","status":"confirmed"}
                """, MediaType.APPLICATION_JSON).createResponse(request);
        });

        GoogleCalendarClient.CalendarEvent result = client.updateEvent("access-token",
            "team@group.calendar.google.com", "hufstown012345", "\"etag-1\"",
            new GoogleCalendarClient.EventDraft("hufstown012345", "Study", null,
                Instant.parse("2026-10-01T09:00:00Z"), Instant.parse("2026-10-01T10:00:00Z"),
                "Asia/Seoul", null, null, "source-key"));

        assertThat(result.etag()).isEqualTo("etag-2");
        assertThat(actualUri.get()).isEqualTo(eventUri);
        assertThat(authorization.get()).isEqualTo("Bearer access-token");
        assertThat(ifMatch.get()).isEqualTo("\"etag-1\"");
        assertThat(body.get()).contains("\"summary\":\"Study\"").doesNotContain("\"id\"");
        server.verify();
    }

    @Test
    void convertsRemoteEtagConflictsWithoutLeakingProviderBody() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        GoogleCalendarClient client = new GoogleCalendarClient(SETTINGS, builder.build());
        URI eventUri = UriComponentsBuilder.fromUriString("https://www.googleapis.com/calendar/v3")
            .pathSegment("calendars", "calendar-id", "events", "event-id").build().toUri();
        server.expect(requestTo(eventUri)).andRespond(withStatus(PRECONDITION_FAILED)
            .contentType(MediaType.APPLICATION_JSON)
            .body("{\"error\":\"private provider diagnostic\"}"));

        assertThatThrownBy(() -> client.getEvent("access-token", "calendar-id", "event-id"))
            .isInstanceOf(CalendarIntegrationFailure.class)
            .hasMessage("CALENDAR_REMOTE_CONFLICT");
        server.verify();
    }

    @Test
    void treatsAnAlreadyDeletedRemoteEventAsSuccess() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        GoogleCalendarClient client = new GoogleCalendarClient(SETTINGS, builder.build());
        URI eventUri = UriComponentsBuilder.fromUriString("https://www.googleapis.com/calendar/v3")
            .pathSegment("calendars", "calendar-id", "events", "event-id").build().toUri();
        server.expect(requestTo(eventUri)).andRespond(withStatus(NOT_FOUND));

        client.deleteEvent("access-token", "calendar-id", "event-id", "\"etag-1\"");

        server.verify();
    }
}
