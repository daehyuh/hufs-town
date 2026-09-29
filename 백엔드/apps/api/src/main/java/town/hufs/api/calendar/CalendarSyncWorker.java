package town.hufs.api.calendar;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

@Component
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class CalendarSyncWorker {
    private static final String TIME_ZONE = "Asia/Seoul";
    private static final String READABLE_SPACE = """
        AND NOT EXISTS (SELECT 1 FROM space_access_block b WHERE b.space_id=s.id AND b.user_id=?)
        AND (EXISTS (SELECT 1 FROM space_member m WHERE m.space_id=s.id AND m.user_id=?)
          OR (s.visibility<>'PRIVATE' AND (
            NOT EXISTS (SELECT 1 FROM space_allowed_email_domain d WHERE d.space_id=s.id)
            OR EXISTS (
                SELECT 1 FROM oauth_identity identity
                JOIN space_allowed_email_domain allowed ON allowed.space_id=s.id
                  AND allowed.email_domain=LOWER(SUBSTRING_INDEX(identity.verified_email,'@',-1))
                WHERE identity.user_id=? AND identity.verified_email IS NOT NULL
                  AND identity.verified_email LIKE '%@%'
            )
          )))
        """;

    private final JdbcTemplate db;
    private final GoogleCalendarSettings settings;
    private final GoogleCalendarClient google;
    private final CalendarConnectionStore connections;
    private final CalendarSyncOutbox outbox;
    private final CalendarSyncItems items;
    private final CalendarTokenCipher cipher;

    CalendarSyncWorker(JdbcTemplate db, GoogleCalendarSettings settings, GoogleCalendarClient google,
                       CalendarConnectionStore connections, CalendarSyncOutbox outbox,
                       CalendarSyncItems items, CalendarTokenCipher cipher) {
        this.db = db;
        this.settings = settings;
        this.google = google;
        this.connections = connections;
        this.outbox = outbox;
        this.items = items;
        this.cipher = cipher;
    }

    @Scheduled(fixedDelayString = "${town.calendar.google.poll-ms:1000}", initialDelayString = "${town.calendar.google.initial-delay-ms:5000}")
    void dispatch() {
        if (!settings.configured()) return;
        for (CalendarSyncOutbox.Claim claim : outbox.claimBatch(10)) {
            try {
                synchronize(claim);
            } catch (CalendarIntegrationFailure failure) {
                if ("CALENDAR_REMOTE_CONFLICT".equals(failure.code())) {
                    items.markConflict(claim.userId(), claim.sourceKind(), claim.sourceId());
                    outbox.finish(claim);
                } else if ("CALENDAR_RECONNECT_REQUIRED".equals(failure.code())) {
                    connections.requireReconnect(claim.userId());
                    outbox.retry(claim, failure.code());
                } else {
                    outbox.retry(claim, failure.code());
                }
            } catch (RuntimeException failure) {
                outbox.retry(claim, "CALENDAR_SYNC_FAILED");
            }
        }
    }

    @Scheduled(fixedDelayString = "${town.calendar.google.reconcile-ms:60000}", initialDelayString = "${town.calendar.google.reconcile-initial-delay-ms:15000}")
    void reconcile() {
        if (settings.configured()) outbox.reconcileConnectedUsers();
    }

    private void synchronize(CalendarSyncOutbox.Claim claim) {
        CalendarConnectionStore.Connection connection = connections.find(claim.userId()).orElse(null);
        if (connection == null || !"CONNECTED".equals(connection.connectionState())) {
            outbox.finish(claim);
            return;
        }
        GoogleCalendarClient.Tokens token = google.refresh(cipher.decrypt(connection.encryptedRefreshToken()));
        if (!outbox.isCurrent(claim)) return;

        Source source = loadSource(claim.userId(), claim.sourceKind(), claim.sourceId()).orElse(null);
        CalendarSyncItems.Item item = items.find(claim.userId(), claim.sourceKind(), claim.sourceId()).orElse(null);
        if (item != null && "CONFLICT".equals(item.state()) && !claim.forceApply()) {
            outbox.finish(claim);
            return;
        }

        if (source == null) {
            deleteRemote(claim, connection, token.accessToken(), item);
            return;
        }

        String syncKey = syncKey(claim.userId(), claim.sourceKind(), claim.sourceId());
        GoogleCalendarClient.EventDraft draft = source.toDraft(remoteEventId(claim.userId(), claim.sourceKind(), claim.sourceId()), syncKey);
        String sourceHash = sourceHash(source);
        if (item != null && "SYNCED".equals(item.state()) && item.sourceHash().equals(sourceHash)
            && !claim.forceApply()) {
            outbox.finish(claim);
            return;
        }

        if (!outbox.isCurrent(claim)) return;
        GoogleCalendarClient.CalendarEvent saved;
        if (item != null) {
            if (claim.forceApply()) {
                GoogleCalendarClient.CalendarEvent current = safeGet(token.accessToken(), connection.remoteCalendarId(), item.remoteEventId());
                if (current == null) {
                    items.delete(claim.userId(), claim.sourceKind(), claim.sourceId());
                    if (!outbox.isCurrent(claim)) return;
                    saved = google.insertEvent(token.accessToken(), connection.remoteCalendarId(), draft);
                } else {
                    requireOwned(current, syncKey);
                    if (!outbox.isCurrent(claim)) return;
                    saved = google.updateEvent(token.accessToken(), connection.remoteCalendarId(), item.remoteEventId(),
                        requireEtag(current.etag()), draft);
                }
            } else {
                try {
                    saved = google.updateEvent(token.accessToken(), connection.remoteCalendarId(), item.remoteEventId(),
                        requireEtag(item.remoteEtag()), draft);
                } catch (CalendarIntegrationFailure failure) {
                    if (!"CALENDAR_REMOTE_NOT_FOUND".equals(failure.code())) throw failure;
                    items.delete(claim.userId(), claim.sourceKind(), claim.sourceId());
                    if (!outbox.isCurrent(claim)) return;
                    saved = google.insertEvent(token.accessToken(), connection.remoteCalendarId(), draft);
                }
            }
        } else {
            GoogleCalendarClient.CalendarEvent current = safeGet(token.accessToken(), connection.remoteCalendarId(), draft.eventId());
            if (current == null) {
                if (!outbox.isCurrent(claim)) return;
                saved = google.insertEvent(token.accessToken(), connection.remoteCalendarId(), draft);
            } else {
                requireOwned(current, syncKey);
                // Persist the verified remote version before patching so a racing remote edit
                // becomes a durable conflict even when this source had no saved mapping yet.
                items.save(claim.userId(), claim.sourceKind(), claim.sourceId(), current.id(),
                    requireEtag(current.etag()), sha256("REMOTE_BASELINE\n" + current.etag()));
                if (!outbox.isCurrent(claim)) return;
                saved = google.updateEvent(token.accessToken(), connection.remoteCalendarId(), draft.eventId(),
                    requireEtag(current.etag()), draft);
            }
        }
        if (saved == null || blank(saved.etag()))
            throw new CalendarIntegrationFailure("CALENDAR_PROVIDER_REJECTED", 502);
        items.save(claim.userId(), claim.sourceKind(), claim.sourceId(), saved.id(), saved.etag(), sourceHash);
        outbox.finish(claim);
    }

    private void deleteRemote(CalendarSyncOutbox.Claim claim, CalendarConnectionStore.Connection connection,
                              String accessToken, CalendarSyncItems.Item item) {
        if (item != null) {
            if (!outbox.isCurrent(claim)) return;
            if (claim.forceApply()) {
                GoogleCalendarClient.CalendarEvent current = safeGet(accessToken, connection.remoteCalendarId(), item.remoteEventId());
                if (current != null) {
                    requireOwned(current, syncKey(claim.userId(), claim.sourceKind(), claim.sourceId()));
                    if (!outbox.isCurrent(claim)) return;
                    google.deleteEvent(accessToken, connection.remoteCalendarId(), item.remoteEventId(), requireEtag(current.etag()));
                }
            } else {
                google.deleteEvent(accessToken, connection.remoteCalendarId(), item.remoteEventId(), requireEtag(item.remoteEtag()));
            }
            items.delete(claim.userId(), claim.sourceKind(), claim.sourceId());
        }
        outbox.finish(claim);
    }

    private GoogleCalendarClient.CalendarEvent safeGet(String accessToken, String calendarId, String eventId) {
        try { return google.getEvent(accessToken, calendarId, eventId); }
        catch (CalendarIntegrationFailure failure) {
            if ("CALENDAR_REMOTE_NOT_FOUND".equals(failure.code())) return null;
            throw failure;
        }
    }

    private OptionalSource loadSource(String userId, String kind, String id) {
        return switch (kind) {
            case "SCHEDULED_EVENT" -> loadScheduledEvent(userId, id);
            case "ROOM_RESERVATION" -> loadReservation(userId, id);
            default -> OptionalSource.empty();
        };
    }

    private OptionalSource loadScheduledEvent(String userId, String eventId) {
        List<Source> rows = db.query("""
            SELECT e.title,e.description,e.resource_url,s.name,e.starts_at,
                COALESCE(e.ends_at,TIMESTAMPADD(HOUR,1,e.starts_at)) AS ends_at
            FROM town_scheduled_event e
            JOIN town_scheduled_event_rsvp response ON response.event_id=e.id
              AND response.user_id=? AND response.response='GOING'
            JOIN town_space s ON s.id=e.space_id AND s.archived_at IS NULL
            JOIN app_user account ON account.id=? AND account.status='ACTIVE' AND account.deleted_at IS NULL
            WHERE e.id=? AND e.cancelled_at IS NULL
            """ + READABLE_SPACE, (row, index) -> new Source("SCHEDULED_EVENT", eventId,
                row.getString("title"), row.getString("description"), row.getString("name"),
                row.getString("resource_url"), row.getTimestamp("starts_at").toInstant(),
                row.getTimestamp("ends_at").toInstant()), userId, userId, eventId, userId, userId, userId);
        return OptionalSource.of(rows);
    }

    private OptionalSource loadReservation(String userId, String reservationId) {
        List<Source> rows = db.query("""
            SELECT reservation.title,s.name,reservation.starts_at,reservation.ends_at
            FROM town_room_reservation reservation
            JOIN town_space s ON s.id=reservation.space_id AND s.archived_at IS NULL
            JOIN app_user account ON account.id=? AND account.status='ACTIVE' AND account.deleted_at IS NULL
            WHERE reservation.id=? AND reservation.organizer_user_id=? AND reservation.cancelled_at IS NULL
            """ + READABLE_SPACE, (row, index) -> new Source("ROOM_RESERVATION", reservationId,
                row.getString("title"), "HUFS Town meeting room reservation", row.getString("name"), "",
                row.getTimestamp("starts_at").toInstant(), row.getTimestamp("ends_at").toInstant()),
            userId, reservationId, userId, userId, userId, userId);
        return OptionalSource.of(rows);
    }

    private static String remoteEventId(String userId, String kind, String sourceId) {
        return "hufs" + sha256(userId + "\n" + kind + "\n" + sourceId);
    }

    private static String syncKey(String userId, String kind, String sourceId) {
        return sha256("HUFS_TOWN\n" + userId + "\n" + kind + "\n" + sourceId);
    }

    private static String sourceHash(Source source) {
        return sha256(String.join("\n", source.kind(), source.id(), source.title(), source.description(),
            source.location(), source.url(), source.startsAt().toString(), source.endsAt().toString()));
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void requireOwned(GoogleCalendarClient.CalendarEvent event, String syncKey) {
        Map<String, Map<String, String>> properties = event.extendedProperties();
        Map<String, String> privateProperties = properties == null ? null : properties.get("private");
        if (privateProperties == null || !syncKey.equals(privateProperties.get("hufsTownSyncKey")))
            throw new CalendarIntegrationFailure("CALENDAR_REMOTE_OWNERSHIP_CONFLICT", 409);
    }

    private static String requireEtag(String etag) {
        if (blank(etag)) throw new CalendarIntegrationFailure("CALENDAR_REMOTE_CONFLICT", 409);
        return etag;
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }

    private record Source(String kind, String id, String title, String description, String location, String url,
                          Instant startsAt, Instant endsAt) {
        GoogleCalendarClient.EventDraft toDraft(String eventId, String syncKey) {
            return new GoogleCalendarClient.EventDraft(eventId, title, description, startsAt, endsAt,
                TIME_ZONE, location, blank(url) ? null : url, syncKey);
        }
    }

    private record OptionalSource(Source value) {
        static OptionalSource empty() { return new OptionalSource(null); }
        static OptionalSource of(List<Source> rows) { return new OptionalSource(rows.stream().findFirst().orElse(null)); }
        Source orElse(Source fallback) { return value == null ? fallback : value; }
    }
}
