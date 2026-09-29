package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.api.calendar.CalendarSyncOutbox;
import town.hufs.auth.TownPrincipal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class RoomReservations {
    private static final DefaultRedisScript<Long> LIMIT = new DefaultRedisScript<>(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", Long.class);
    private static final DefaultRedisScript<Long> RELEASE_LOCK = new DefaultRedisScript<>(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", Long.class);
    private static final Duration MIN_LEAD = Duration.ofMinutes(2);
    private static final Duration MAX_LEAD = Duration.ofDays(365);
    private static final Duration MIN_DURATION = Duration.ofMinutes(15);
    private static final Duration MAX_DURATION = Duration.ofHours(8);
    private static final Duration ENTRY_LEAD = Duration.ofMinutes(15);

    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final StringRedisTemplate redis;
    private final Spaces spaces;
    private final SpaceMaps maps;
    private final CalendarSyncOutbox calendarSync;

    RoomReservations(JdbcTemplate db, TransactionTemplate tx, StringRedisTemplate redis, Spaces spaces, SpaceMaps maps,
                     CalendarSyncOutbox calendarSync) {
        this.db = db;
        this.tx = tx;
        this.redis = redis;
        this.spaces = spaces;
        this.maps = maps;
        this.calendarSync = calendarSync;
    }

    Snapshot list(String spaceId, TownPrincipal principal) {
        String userId = userId(principal);
        spaces.detail(spaceId, userId);
        List<SpaceMaps.ReservationRoom> rooms = maps.reservationRooms(spaceId, userId);
        Map<String, SpaceMaps.ReservationRoom> roomByKey = rooms.stream()
            .collect(java.util.stream.Collectors.toMap(room -> roomKey(room.mapId(), room.zoneId()), room -> room));
        boolean member = isMember(spaceId, userId);
        boolean manager = member && managerRole(spaceId, userId);
        List<Reservation> reservations = db.query("""
            SELECT id,map_id,zone_id,organizer_user_id,organizer_name,title,starts_at,ends_at,cancelled_at,created_at,updated_at
            FROM town_room_reservation
            WHERE space_id=?
              AND starts_at<CURRENT_TIMESTAMP(6)+INTERVAL 365 DAY
              AND ((cancelled_at IS NULL AND ends_at>CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY)
                   OR cancelled_at>CURRENT_TIMESTAMP(6)-INTERVAL 30 DAY)
            ORDER BY (cancelled_at IS NOT NULL),starts_at,map_id,zone_id
            LIMIT 500
            """, (row, index) -> reservation(row, userId, manager, roomByKey), spaceId);
        return new Snapshot(rooms, reservations, member);
    }

    Reservation create(String spaceId, TownPrincipal principal, Draft draft) {
        rateLimit(principal);
        String userId = userId(principal);
        Normalized value = normalize(draft, Instant.now());
        return withSpaceWriteLock(spaceId, () -> tx.execute(status -> {
            lockSpace(spaceId, userId);
            MemberRole role = requireMember(spaceId, userId);
            SpaceMaps.ReservationRoom room = requireRoom(spaceId, userId, value.mapId(), value.zoneId());
            String requestHash = fingerprint(value);
            List<ExistingRequest> retries = db.query("""
                SELECT id,request_hash FROM town_room_reservation
                WHERE space_id=? AND organizer_user_id=? AND request_id=? FOR UPDATE
                """, (row, index) -> new ExistingRequest(row.getString("id"), row.getString("request_hash")),
                spaceId, userId, value.requestId());
            if (!retries.isEmpty()) {
                ExistingRequest previous = retries.getFirst();
                if (!MessageDigest.isEqual(previous.hash().getBytes(StandardCharsets.US_ASCII),
                    requestHash.getBytes(StandardCharsets.US_ASCII)))
                    throw new SpaceFailure(409, "ROOM_RESERVATION_REQUEST_CONFLICT", "같은 요청 번호로 다른 예약을 만들 수 없어요.");
                return find(spaceId, previous.id(), userId, role.manager());
            }
            Integer activeReservations = db.queryForObject("""
                SELECT COUNT(*) FROM town_room_reservation
                WHERE organizer_user_id=? AND cancelled_at IS NULL AND ends_at>CURRENT_TIMESTAMP(6)
                """, Integer.class, userId);
            if (activeReservations != null && activeReservations >= 5)
                throw new SpaceFailure(409, "ROOM_RESERVATION_LIMIT", "진행 중인 회의실 예약은 5개까지 만들 수 있어요.");
            ensureAvailable(spaceId, value.mapId(), value.zoneId(), value.startsAt(), value.endsAt(), null);
            String id = UUID.randomUUID().toString();
            String organizerName = db.queryForObject("SELECT display_name FROM app_user WHERE id=?", String.class, userId);
            db.update("""
                INSERT INTO town_room_reservation(id,space_id,map_id,zone_id,organizer_user_id,organizer_name,
                    request_id,request_hash,title,starts_at,ends_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, id, spaceId, value.mapId(), value.zoneId(), userId, organizerName, value.requestId(),
                requestHash, value.title(), Timestamp.from(value.startsAt()), Timestamp.from(value.endsAt()));
            calendarSync.enqueue(userId, "ROOM_RESERVATION", id, "UPSERT");
            return reservation(id, spaceId, userId, role.manager(), room);
        }));
    }

    Reservation update(String spaceId, String reservationId, TownPrincipal principal, Draft draft) {
        rateLimit(principal);
        String userId = userId(principal);
        Normalized value = normalize(draft, Instant.now());
        requireUuid(reservationId);
        return withSpaceWriteLock(spaceId, () -> tx.execute(status -> {
            lockSpace(spaceId, userId);
            MemberRole role = requireMember(spaceId, userId);
            Stored current = lockReservation(spaceId, reservationId);
            authorize(current, userId, role);
            if (current.cancelledAt() != null)
                throw new SpaceFailure(409, "ROOM_RESERVATION_CANCELLED", "취소된 예약은 수정할 수 없어요.");
            if (!current.startsAt().isAfter(Instant.now()))
                throw new SpaceFailure(409, "ROOM_RESERVATION_STARTED", "이미 시작한 예약은 수정할 수 없어요.");
            if (draft.expectedUpdatedAt() == null || !draft.expectedUpdatedAt().equals(current.updatedAt().toString()))
                throw new SpaceFailure(409, "ROOM_RESERVATION_CHANGED", "다른 사람이 먼저 바꾼 예약이에요. 새로고침한 뒤 다시 수정해 주세요.");
            SpaceMaps.ReservationRoom room = requireRoom(spaceId, userId, value.mapId(), value.zoneId());
            ensureAvailable(spaceId, value.mapId(), value.zoneId(), value.startsAt(), value.endsAt(), reservationId);
            db.update("""
                UPDATE town_room_reservation
                SET map_id=?,zone_id=?,title=?,starts_at=?,ends_at=?,updated_at=CURRENT_TIMESTAMP(6)
                WHERE id=? AND space_id=?
                """, value.mapId(), value.zoneId(), value.title(), Timestamp.from(value.startsAt()),
                Timestamp.from(value.endsAt()), reservationId, spaceId);
            if (current.organizerUserId() != null)
                calendarSync.enqueue(current.organizerUserId(), "ROOM_RESERVATION", reservationId, "UPSERT");
            return reservation(reservationId, spaceId, userId, role.manager(), room);
        }));
    }

    Reservation cancel(String spaceId, String reservationId, TownPrincipal principal) {
        rateLimit(principal);
        String userId = userId(principal);
        requireUuid(reservationId);
        return withSpaceWriteLock(spaceId, () -> tx.execute(status -> {
            lockSpace(spaceId, userId);
            MemberRole role = requireMember(spaceId, userId);
            Stored current = lockReservation(spaceId, reservationId);
            authorize(current, userId, role);
            if (current.cancelledAt() == null) {
                if (!current.startsAt().isAfter(Instant.now()))
                    throw new SpaceFailure(409, "ROOM_RESERVATION_STARTED", "이미 시작한 예약은 취소할 수 없어요.");
                db.update("""
                    UPDATE town_room_reservation SET cancelled_at=CURRENT_TIMESTAMP(6),updated_at=CURRENT_TIMESTAMP(6)
                    WHERE id=? AND space_id=? AND cancelled_at IS NULL
                    """, reservationId, spaceId);
                if (current.organizerUserId() != null)
                    calendarSync.enqueue(current.organizerUserId(), "ROOM_RESERVATION", reservationId, "DELETE");
            }
            return find(spaceId, reservationId, userId, role.manager());
        }));
    }

    EntryMap entryMap(String spaceId, String reservationId, String userId) {
        requireUuid(reservationId);
        spaces.detail(spaceId, userId);
        Stored reservation = db.query("""
            SELECT id,map_id,zone_id,organizer_user_id,organizer_name,title,starts_at,ends_at,cancelled_at,created_at,updated_at
            FROM town_room_reservation WHERE space_id=? AND id=?
            """, (row, index) -> stored(row), spaceId, reservationId).stream()
            .findFirst().orElseThrow(RoomReservations::hidden);
        Instant now = Instant.now();
        if (reservation.cancelledAt() != null || now.isBefore(reservation.startsAt().minus(ENTRY_LEAD))
            || !now.isBefore(reservation.endsAt()))
            throw new SpaceFailure(409, "ROOM_RESERVATION_NOT_OPEN", "예약 시작 15분 전부터 종료 시각까지만 입장할 수 있어요.");
        requireRoom(spaceId, userId, reservation.mapId(), reservation.zoneId());
        return new EntryMap(reservation.mapId(), reservation.zoneId());
    }

    private void lockSpace(String spaceId, String userId) {
        spaces.detail(spaceId, userId);
        if (db.queryForList("SELECT id FROM town_space WHERE id=? AND archived_at IS NULL FOR UPDATE", String.class, spaceId).isEmpty())
            throw hidden();
        if (db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=? AND user_id=?",
            Integer.class, spaceId, userId) > 0) throw hidden();
    }

    private MemberRole requireMember(String spaceId, String userId) {
        List<MemberRole> roles = db.query("""
            SELECT role,manager FROM space_member WHERE space_id=? AND user_id=? FOR UPDATE
            """, (row, index) -> new MemberRole("OWNER".equals(row.getString("role")) || row.getBoolean("manager")),
            spaceId, userId);
        if (roles.isEmpty()) throw new SpaceFailure(403, "ROOM_RESERVATION_MEMBER_REQUIRED", "공간 멤버만 회의실을 예약할 수 있어요.");
        return roles.getFirst();
    }

    private boolean managerRole(String spaceId, String userId) {
        return db.query("SELECT role,manager FROM space_member WHERE space_id=? AND user_id=?",
            (row, index) -> "OWNER".equals(row.getString("role")) || row.getBoolean("manager"), spaceId, userId)
            .stream().findFirst().orElse(false);
    }

    private boolean isMember(String spaceId, String userId) {
        return db.queryForObject("SELECT COUNT(*) FROM space_member WHERE space_id=? AND user_id=?", Integer.class,
            spaceId, userId) > 0;
    }

    private SpaceMaps.ReservationRoom requireRoom(String spaceId, String userId, String mapId, String zoneId) {
        return maps.reservationRooms(spaceId, userId).stream()
            .filter(room -> room.mapId().equals(mapId) && room.zoneId().equals(zoneId))
            .findFirst().orElseThrow(() -> new SpaceFailure(409, "ROOM_RESERVATION_ROOM_UNAVAILABLE", "현재 게시된 지도에서 예약할 회의실을 찾을 수 없어요."));
    }

    private void ensureAvailable(String spaceId, String mapId, String zoneId, Instant startsAt, Instant endsAt, String exceptId) {
        String except = exceptId == null ? "" : exceptId;
        Integer overlapping = db.queryForObject("""
            SELECT COUNT(*) FROM town_room_reservation
            WHERE space_id=? AND map_id=? AND zone_id=? AND cancelled_at IS NULL
              AND starts_at<? AND ends_at>?
              AND (?='' OR id<>?)
            """, Integer.class, spaceId, mapId, zoneId, Timestamp.from(endsAt), Timestamp.from(startsAt), except, except);
        if (overlapping != null && overlapping > 0)
            throw new SpaceFailure(409, "ROOM_RESERVATION_CONFLICT", "선택한 시간에 이미 예약된 회의실이에요.");
    }

    private Stored lockReservation(String spaceId, String reservationId) {
        return db.query("""
            SELECT id,map_id,zone_id,organizer_user_id,organizer_name,title,starts_at,ends_at,cancelled_at,created_at,updated_at
            FROM town_room_reservation WHERE space_id=? AND id=? FOR UPDATE
            """, (row, index) -> stored(row), spaceId, reservationId).stream()
            .findFirst().orElseThrow(RoomReservations::hidden);
    }

    private void authorize(Stored reservation, String userId, MemberRole role) {
        if (!role.manager() && !userId.equalsIgnoreCase(reservation.organizerUserId()))
            throw new SpaceFailure(403, "ROOM_RESERVATION_FORBIDDEN", "본인 예약이나 운영자 예약만 변경할 수 있어요.");
    }

    private Reservation find(String spaceId, String reservationId, String userId, boolean manager) {
        List<SpaceMaps.ReservationRoom> rooms = maps.reservationRooms(spaceId, userId);
        Map<String, SpaceMaps.ReservationRoom> roomByKey = rooms.stream()
            .collect(java.util.stream.Collectors.toMap(room -> roomKey(room.mapId(), room.zoneId()), room -> room));
        return db.query("""
            SELECT id,map_id,zone_id,organizer_user_id,organizer_name,title,starts_at,ends_at,cancelled_at,created_at,updated_at
            FROM town_room_reservation WHERE space_id=? AND id=?
            """, (row, index) -> reservation(row, userId, manager, roomByKey), spaceId, reservationId)
            .stream().findFirst().orElseThrow(RoomReservations::hidden);
    }

    private Reservation reservation(String id, String spaceId, String userId, boolean manager, SpaceMaps.ReservationRoom room) {
        return db.query("""
            SELECT id,map_id,zone_id,organizer_user_id,organizer_name,title,starts_at,ends_at,cancelled_at,created_at,updated_at
            FROM town_room_reservation WHERE space_id=? AND id=?
            """, (row, index) -> reservation(row, userId, manager,
                Map.of(roomKey(room.mapId(), room.zoneId()), room)), spaceId, id).stream()
            .findFirst().orElseThrow(RoomReservations::hidden);
    }

    private static Reservation reservation(ResultSet row, String userId, boolean manager,
                                           Map<String, SpaceMaps.ReservationRoom> roomByKey) throws SQLException {
        String mapId = row.getString("map_id");
        String zoneId = row.getString("zone_id");
        SpaceMaps.ReservationRoom room = roomByKey.get(roomKey(mapId, zoneId));
        String organizerId = row.getString("organizer_user_id");
        return new Reservation(row.getString("id"), mapId, zoneId,
            room == null ? "삭제된 지도" : room.mapName(), room == null ? "삭제된 회의실" : room.zoneName(),
            room != null, row.getString("title"), row.getString("organizer_name"),
            organizerId != null && organizerId.equalsIgnoreCase(userId), manager || organizerId != null && organizerId.equalsIgnoreCase(userId),
            instant(row.getTimestamp("starts_at")), instant(row.getTimestamp("ends_at")),
            instant(row.getTimestamp("cancelled_at")), instant(row.getTimestamp("created_at")), instant(row.getTimestamp("updated_at")));
    }

    private static Stored stored(ResultSet row) throws SQLException {
        Timestamp cancelled = row.getTimestamp("cancelled_at");
        return new Stored(row.getString("id"), row.getString("map_id"), row.getString("zone_id"),
            row.getString("organizer_user_id"), row.getString("organizer_name"), row.getString("title"),
            row.getTimestamp("starts_at").toInstant(), row.getTimestamp("ends_at").toInstant(),
            cancelled == null ? null : cancelled.toInstant(), row.getTimestamp("created_at").toInstant(),
            row.getTimestamp("updated_at").toInstant());
    }

    private Normalized normalize(Draft draft, Instant now) {
        if (draft == null) throw invalid();
        String requestId = canonicalUuid(draft.requestId());
        String mapId = canonicalUuid(draft.mapId());
        if (draft.zoneId() == null || !draft.zoneId().matches("[A-Za-z0-9_-]{1,64}")) throw invalid();
        String title = text(draft.title(), 80, false);
        Instant startsAt = parseInstant(draft.startsAt());
        Instant endsAt = parseInstant(draft.endsAt());
        if (startsAt.isBefore(now.plus(MIN_LEAD)) || startsAt.isAfter(now.plus(MAX_LEAD)))
            throw new SpaceFailure(400, "ROOM_RESERVATION_TIME_INVALID", "예약은 2분 뒤부터 1년 안으로 지정해 주세요.");
        Duration duration = Duration.between(startsAt, endsAt);
        if (duration.compareTo(MIN_DURATION) < 0 || duration.compareTo(MAX_DURATION) > 0)
            throw new SpaceFailure(400, "ROOM_RESERVATION_DURATION_INVALID", "회의실은 15분부터 8시간까지 예약할 수 있어요.");
        return new Normalized(requestId, mapId, draft.zoneId(), title, startsAt, endsAt);
    }

    private void rateLimit(TownPrincipal principal) {
        String userId = userId(principal);
        Long count = redis.execute(LIMIT, List.of("hufs-town:room-reservation-limit:" + userId));
        if (count == null || count > 60)
            throw new SpaceFailure(429, "ROOM_RESERVATION_RATE_LIMIT", "요청이 많아요. 잠시 뒤 다시 시도해 주세요.");
    }

    private <T> T withSpaceWriteLock(String spaceId, Supplier<T> operation) {
        String key = "hufs-town:room-reservation-write:" + spaceId;
        String token = UUID.randomUUID().toString();
        Instant deadline = Instant.now().plusSeconds(10);
        while (Instant.now().isBefore(deadline)) {
            if (Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, token, Duration.ofMinutes(2)))) {
                try {
                    return operation.get();
                } finally {
                    redis.execute(RELEASE_LOCK, List.of(key), token);
                }
            }
            try {
                Thread.sleep(25);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new SpaceFailure(503, "ROOM_RESERVATION_BUSY", "예약을 처리하고 있어요. 잠시 뒤 다시 시도해 주세요.");
            }
        }
        throw new SpaceFailure(409, "ROOM_RESERVATION_BUSY", "예약을 처리하고 있어요. 잠시 뒤 다시 시도해 주세요.");
    }

    private String userId(TownPrincipal principal) {
        if (principal == null) throw new SpaceFailure(401, "AUTH_REQUIRED", "로그인이 필요해요.");
        return principal.userId();
    }

    private static String text(String value, int max, boolean emptyAllowed) {
        String normalized = value == null ? "" : value.strip();
        if ((!emptyAllowed && normalized.isEmpty()) || normalized.codePointCount(0, normalized.length()) > max
            || normalized.codePoints().anyMatch(ch -> Character.isISOControl(ch) || Character.getType(ch) == Character.FORMAT))
            throw invalid();
        return normalized;
    }

    private static Instant parseInstant(String value) {
        try { return Instant.parse(value); }
        catch (RuntimeException invalid) { throw new SpaceFailure(400, "ROOM_RESERVATION_TIME_INVALID", "날짜와 시간을 확인해 주세요."); }
    }

    private static String canonicalUuid(String value) {
        try {
            UUID id = UUID.fromString(value);
            if (!id.toString().equalsIgnoreCase(value)) throw new IllegalArgumentException();
            return id.toString();
        } catch (RuntimeException invalid) { throw invalid(); }
    }

    private static void requireUuid(String value) { canonicalUuid(value); }
    private static String roomKey(String mapId, String zoneId) { return mapId + "|" + zoneId; }
    private static String instant(Timestamp value) { return value == null ? "" : value.toInstant().toString(); }

    private static String fingerprint(Normalized value) {
        String input = String.join("\n", value.mapId(), value.zoneId(), value.title(), value.startsAt().toString(), value.endsAt().toString());
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static SpaceFailure hidden() { return new SpaceFailure(404, "ROOM_RESERVATION_NOT_FOUND", "공간이나 예약을 찾을 수 없어요."); }
    private static SpaceFailure invalid() { return new SpaceFailure(400, "ROOM_RESERVATION_INVALID", "예약 정보 형식을 확인해 주세요."); }

    record Draft(String requestId, String mapId, String zoneId, String title, String startsAt, String endsAt,
                 String expectedUpdatedAt) {}
    record Snapshot(List<SpaceMaps.ReservationRoom> rooms, List<Reservation> reservations, boolean canReserve) {}
    record Reservation(String id, String mapId, String zoneId, String mapName, String zoneName, boolean roomAvailable,
                       String title, String organizerName, boolean mine, boolean canEdit,
                       String startsAt, String endsAt, String cancelledAt, String createdAt, String updatedAt) {}
    record EntryMap(String mapId, String zoneId) {}
    private record Normalized(String requestId, String mapId, String zoneId, String title, Instant startsAt,
                              Instant endsAt) {}
    private record ExistingRequest(String id, String hash) {}
    private record MemberRole(boolean manager) {}
    private record Stored(String id, String mapId, String zoneId, String organizerUserId, String organizerName,
                          String title, Instant startsAt, Instant endsAt, Instant cancelledAt,
                          Instant createdAt, Instant updatedAt) {}
}
