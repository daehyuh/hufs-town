package town.hufs.api.calendar;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.UriComponentsBuilder;
import town.hufs.auth.TownPrincipal;

import java.net.URI;
import java.util.Map;

@RestController
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class GoogleCalendarController {
    private final GoogleCalendarSettings settings;
    private final GoogleCalendarClient google;
    private final GoogleCalendarOAuthState states;
    private final CalendarConnectionStore connections;
    private final CalendarTokenCipher cipher;
    private final CalendarSyncOutbox outbox;
    private final CalendarSyncItems syncItems;

    GoogleCalendarController(GoogleCalendarSettings settings, GoogleCalendarClient google,
                             GoogleCalendarOAuthState states, CalendarConnectionStore connections,
                             CalendarTokenCipher cipher, CalendarSyncOutbox outbox, CalendarSyncItems syncItems) {
        this.settings = settings;
        this.google = google;
        this.states = states;
        this.connections = connections;
        this.cipher = cipher;
        this.outbox = outbox;
        this.syncItems = syncItems;
    }

    @GetMapping("/api/v1/me/calendar/google")
    Status status(@AuthenticationPrincipal TownPrincipal principal) {
        CalendarConnectionStore.Connection connection = connections.find(principal.userId()).orElse(null);
        return new Status(settings.configured(), connection != null,
            connection != null && "RECONNECT_REQUIRED".equals(connection.connectionState()),
            connection == null ? 0 : outbox.pendingCount(principal.userId(), false),
            connection == null ? 0 : outbox.pendingCount(principal.userId(), true),
            connection == null ? java.util.List.of() : syncItems.conflicts(principal.userId()));
    }

    @PostMapping("/api/v1/me/calendar/google/connect")
    Map<String, String> connect(@AuthenticationPrincipal TownPrincipal principal, HttpServletRequest request) {
        settings.requireConfigured();
        String state = states.start(principal.userId(), request.getSession(true).getId());
        return Map.of("authorizationUrl", google.authorizationUri(state).toString());
    }

    @DeleteMapping("/api/v1/me/calendar/google")
    Map<String, Boolean> disconnect(@AuthenticationPrincipal TownPrincipal principal) {
        String userId = principal.userId();
        CalendarConnectionStore.Connection connection = connections.find(userId).orElse(null);
        if (connection == null) return Map.of("connected", false);

        String refreshToken = null;
        try {
            refreshToken = cipher.decrypt(connection.encryptedRefreshToken());
        } catch (CalendarIntegrationFailure ignored) {
            // A damaged or unavailable local token must not prevent unlinking.
        }

        // Remove the worker's claim gate before making the best-effort provider call.
        // Cascading deletion also discards pending jobs and invalidates active leases.
        connections.delete(userId);
        if (refreshToken != null) {
            try {
                google.revoke(refreshToken);
            } catch (CalendarIntegrationFailure ignored) {
                // Local unlink is authoritative even when Google cannot be reached.
            }
        }
        return Map.of("connected", false);
    }

    @PostMapping("/api/v1/me/calendar/google/conflicts/{sourceKind}/{sourceId}/apply-hufs-town")
    Map<String, Boolean> overwriteConflict(@AuthenticationPrincipal TownPrincipal principal,
                                           @PathVariable String sourceKind, @PathVariable String sourceId) {
        outbox.enqueueConflictOverwrite(principal.userId(), sourceKind, sourceId);
        return Map.of("queued", true);
    }

    @GetMapping("/api/v1/calendar/google/callback")
    ResponseEntity<Void> callback(@RequestParam(required = false) String code,
                                  @RequestParam(required = false) String state,
                                  @RequestParam(required = false) String error,
                                  @AuthenticationPrincipal TownPrincipal principal,
                                  HttpServletRequest request) {
        if (principal == null) return redirect("login-required");
        try {
            String sessionId = request.getSession(false) == null ? null : request.getSession(false).getId();
            states.consume(state, principal.userId(), sessionId);
            if (error != null && !error.isBlank()) return redirect("denied");
            if (code == null || code.isBlank() || code.length() > 4096)
                throw new CalendarIntegrationFailure("CALENDAR_AUTH_REJECTED", 400);

            settings.requireConfigured();
            CalendarConnectionStore.Connection existing = connections.find(principal.userId()).orElse(null);
            GoogleCalendarClient.Tokens tokens = google.exchangeCode(code);
            String refreshToken = nonblank(tokens.refreshToken())
                ? tokens.refreshToken()
                : existing == null ? null : cipher.decrypt(existing.encryptedRefreshToken());
            if (!nonblank(refreshToken))
                throw new CalendarIntegrationFailure("CALENDAR_RECONNECT_REQUIRED", 409);

            String calendarId = existing == null
                ? google.createCalendar(tokens.accessToken(), "HUFS Town", "Asia/Seoul").id()
                : existing.remoteCalendarId();
            if (!nonblank(calendarId))
                throw new CalendarIntegrationFailure("CALENDAR_PROVIDER_REJECTED", 502);
            connections.save(principal.userId(), calendarId, cipher.encrypt(refreshToken));
            outbox.reconcileUser(principal.userId());
            return redirect("connected");
        } catch (CalendarIntegrationFailure failure) {
            return redirect(errorResult(failure.code()));
        }
    }

    private ResponseEntity<Void> redirect(String state) {
        URI destination = UriComponentsBuilder.fromUriString(settings.publicOrigin())
            .path("/").queryParam("calendar", state).build().encode().toUri();
        return ResponseEntity.status(302).header(HttpHeaders.LOCATION, destination.toString()).build();
    }

    private static String errorResult(String code) {
        return switch (code) {
            case "CALENDAR_OAUTH_STATE_INVALID" -> "expired";
            case "CALENDAR_RECONNECT_REQUIRED" -> "reconnect";
            case "CALENDAR_NOT_CONFIGURED" -> "unavailable";
            default -> "failed";
        };
    }

    private static boolean nonblank(String value) { return value != null && !value.isBlank(); }

    record Status(boolean enabled, boolean connected, boolean reconnectRequired, int pendingCount,
                  int failedCount, java.util.List<CalendarSyncItems.Conflict> conflicts) {}
}
