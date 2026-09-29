package town.hufs.api.calendar;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.time.Instant;
import java.util.Map;

@org.springframework.stereotype.Service
class GoogleCalendarClient {
    static final String CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
    private static final String AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
    private static final String TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
    private static final String REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
    private static final String CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3";

    private final GoogleCalendarSettings settings;
    private final RestClient http;

    GoogleCalendarClient(GoogleCalendarSettings settings, RestClient googleCalendarRestClient) {
        this.settings = settings;
        this.http = googleCalendarRestClient;
    }

    URI authorizationUri(String state) {
        settings.requireConfigured();
        return UriComponentsBuilder.fromUriString(AUTHORIZE_ENDPOINT)
            .queryParam("client_id", settings.clientId())
            .queryParam("redirect_uri", settings.redirectUri())
            .queryParam("response_type", "code")
            .queryParam("scope", CALENDAR_SCOPE)
            .queryParam("access_type", "offline")
            .queryParam("include_granted_scopes", "true")
            .queryParam("prompt", "consent")
            .queryParam("state", state)
            .build().encode().toUri();
    }

    Tokens exchangeCode(String code) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("code", code);
        form.add("client_id", settings.clientId());
        form.add("client_secret", settings.clientSecret());
        form.add("redirect_uri", settings.redirectUri());
        form.add("grant_type", "authorization_code");
        return tokenRequest(form);
    }

    Tokens refresh(String refreshToken) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("client_id", settings.clientId());
        form.add("client_secret", settings.clientSecret());
        form.add("refresh_token", refreshToken);
        form.add("grant_type", "refresh_token");
        return tokenRequest(form);
    }

    void revoke(String token) {
        try {
            http.post().uri(REVOKE_ENDPOINT)
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .body(form("token", token))
                .retrieve()
                .onStatus(HttpStatusCode::isError, (request, response) -> {
                    throw providerFailure(response.getStatusCode());
                }).toBodilessEntity();
        } catch (CalendarIntegrationFailure failure) {
            throw failure;
        } catch (RuntimeException failure) {
            throw new CalendarIntegrationFailure("CALENDAR_PROVIDER_UNAVAILABLE", 503);
        }
    }

    Calendar createCalendar(String accessToken, String summary, String timeZone) {
        return api(() -> http.post().uri(CALENDAR_ENDPOINT + "/calendars")
            .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
            .contentType(MediaType.APPLICATION_JSON)
            .body(new CalendarDraft(summary, "Events and room reservations from HUFS Town", timeZone))
            .retrieve()
            .onStatus(HttpStatusCode::isError, (request, response) -> {
                throw providerFailure(response.getStatusCode());
            }).body(Calendar.class));
    }

    CalendarEvent insertEvent(String accessToken, String calendarId, EventDraft draft) {
        return api(() -> http.post().uri(eventsUri(calendarId))
            .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
            .contentType(MediaType.APPLICATION_JSON)
            .body(toGoogleEvent(draft, true))
            .retrieve()
            .onStatus(HttpStatusCode::isError, (request, response) -> {
                throw providerFailure(response.getStatusCode());
            }).body(CalendarEvent.class));
    }

    CalendarEvent getEvent(String accessToken, String calendarId, String eventId) {
        return api(() -> http.get().uri(eventUri(calendarId, eventId))
            .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
            .retrieve()
            .onStatus(HttpStatusCode::isError, (request, response) -> {
                throw providerFailure(response.getStatusCode());
            }).body(CalendarEvent.class));
    }

    CalendarEvent updateEvent(String accessToken, String calendarId, String eventId,
                              String expectedEtag, EventDraft draft) {
        return api(() -> http.patch().uri(eventUri(calendarId, eventId))
            .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
            .header(HttpHeaders.IF_MATCH, expectedEtag)
            .contentType(MediaType.APPLICATION_JSON)
            .body(toGoogleEvent(draft, false))
            .retrieve()
            .onStatus(HttpStatusCode::isError, (request, response) -> {
                throw providerFailure(response.getStatusCode());
            }).body(CalendarEvent.class));
    }

    void deleteEvent(String accessToken, String calendarId, String eventId, String expectedEtag) {
        api(() -> http.delete().uri(eventUri(calendarId, eventId))
            .header(HttpHeaders.AUTHORIZATION, bearer(accessToken))
            .header(HttpHeaders.IF_MATCH, expectedEtag)
            .retrieve()
            .onStatus(HttpStatusCode::isError, (request, response) -> {
                if (response.getStatusCode().value() == 404 || response.getStatusCode().value() == 410) return;
                throw providerFailure(response.getStatusCode());
            }).toBodilessEntity());
    }

    private Tokens tokenRequest(MultiValueMap<String, String> form) {
        try {
            Tokens tokens = http.post().uri(TOKEN_ENDPOINT)
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .body(form)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (request, response) -> {
                    throw providerFailure(response.getStatusCode());
                }).body(Tokens.class);
            if (tokens == null || blank(tokens.accessToken()))
                throw new CalendarIntegrationFailure("CALENDAR_PROVIDER_REJECTED", 502);
            return tokens;
        } catch (CalendarIntegrationFailure failure) {
            throw failure;
        } catch (RuntimeException failure) {
            throw new CalendarIntegrationFailure("CALENDAR_PROVIDER_UNAVAILABLE", 503);
        }
    }

    private <T> T api(java.util.function.Supplier<T> request) {
        try { return request.get(); }
        catch (CalendarIntegrationFailure failure) { throw failure; }
        catch (RuntimeException failure) { throw new CalendarIntegrationFailure("CALENDAR_PROVIDER_UNAVAILABLE", 503); }
    }

    private static CalendarIntegrationFailure providerFailure(HttpStatusCode status) {
        int value = status.value();
        if (value == 412) return new CalendarIntegrationFailure("CALENDAR_REMOTE_CONFLICT", 409);
        if (value == 401 || value == 403) return new CalendarIntegrationFailure("CALENDAR_RECONNECT_REQUIRED", 409);
        if (value == 404 || value == 410) return new CalendarIntegrationFailure("CALENDAR_REMOTE_NOT_FOUND", 404);
        if (value == 409) return new CalendarIntegrationFailure("CALENDAR_REMOTE_EXISTS", 409);
        if (value == 400) return new CalendarIntegrationFailure("CALENDAR_AUTH_REJECTED", 400);
        if (value == 429 || status.is5xxServerError())
            return new CalendarIntegrationFailure("CALENDAR_PROVIDER_UNAVAILABLE", 503);
        return new CalendarIntegrationFailure("CALENDAR_PROVIDER_REJECTED", 502);
    }

    private static MultiValueMap<String, String> form(String name, String value) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add(name, value);
        return form;
    }

    private static Map<String, Object> toGoogleEvent(EventDraft draft, boolean includeId) {
        var start = Map.<String, Object>of("dateTime", draft.startsAt().toString(), "timeZone", draft.timeZone());
        var end = Map.<String, Object>of("dateTime", draft.endsAt().toString(), "timeZone", draft.timeZone());
        var event = new java.util.LinkedHashMap<String, Object>();
        if (includeId) event.put("id", draft.eventId());
        event.put("summary", draft.summary());
        event.put("description", draft.description());
        event.put("extendedProperties", Map.of("private", Map.of("hufsTownSyncKey", draft.syncKey())));
        event.put("start", start);
        event.put("end", end);
        if (!blank(draft.location())) event.put("location", draft.location());
        if (!blank(draft.url())) event.put("source", Map.of("title", "HUFS Town", "url", draft.url()));
        return event;
    }

    private static URI eventsUri(String calendarId) {
        return UriComponentsBuilder.fromUriString(CALENDAR_ENDPOINT)
            .pathSegment("calendars", calendarId, "events").build().encode().toUri();
    }

    private static URI eventUri(String calendarId, String eventId) {
        return UriComponentsBuilder.fromUriString(CALENDAR_ENDPOINT)
            .pathSegment("calendars", calendarId, "events", eventId).build().encode().toUri();
    }

    private static String bearer(String token) { return "Bearer " + token; }
    private static boolean blank(String value) { return value == null || value.isBlank(); }

    record Tokens(@JsonProperty("access_token") String accessToken,
                  @JsonProperty("refresh_token") String refreshToken,
                  @JsonProperty("expires_in") long expiresIn,
                  String scope,
                  @JsonProperty("token_type") String tokenType) {}
    record Calendar(String id, String summary, String timeZone) {}
    record CalendarDraft(String summary, String description, String timeZone) {}
    record CalendarEvent(String id, String etag, String status, String htmlLink, String summary,
                         String description, String location, Map<String, Object> start,
                         Map<String, Object> end, Map<String, Map<String, String>> extendedProperties) {}
    record EventDraft(String eventId, String summary, String description, Instant startsAt,
                      Instant endsAt, String timeZone, String location, String url, String syncKey) {}
}
