package town.hufs.world;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import town.hufs.protocol.RoomNoteState;

import javax.sql.DataSource;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@Testcontainers(disabledWithoutDocker = true)
class RoomNotesStoreTest {
    @Container
    static final GenericContainer<?> MARIADB = new GenericContainer<>("mariadb:11.4")
        .withEnv("MARIADB_DATABASE", "town")
        .withEnv("MARIADB_USER", "town")
        .withEnv("MARIADB_PASSWORD", "test-password")
        .withEnv("MARIADB_ROOT_PASSWORD", "root-password")
        .withExposedPorts(3306);

    @Container
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4.8-alpine")
        .withExposedPorts(6379);

    private static DataSource dataSource;
    private JdbcTemplate db;
    private TransactionTemplate tx;
    private LettuceConnectionFactory redisFactory;
    private RoomNotesStore store;
    private RoomNotesStore peerStore;
    private String spaceId;
    private String mapId;
    private String authorA;
    private String authorB;

    @BeforeAll
    static void migrateRoomNoteSchema() {
        dataSource = source();
        JdbcTemplate db = new JdbcTemplate(dataSource);
        db.execute("""
            CREATE TABLE app_user (
                id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
                display_name VARCHAR(80) NOT NULL,
                status VARCHAR(16) NOT NULL,
                deleted_at TIMESTAMP(6) NULL
            ) ENGINE=InnoDB
            """);
        db.execute("CREATE TABLE town_space (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY) ENGINE=InnoDB");
        db.execute("CREATE TABLE space_map (map_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY) ENGINE=InnoDB");
        Flyway.configure().dataSource(dataSource).locations("classpath:db/migration")
            .baselineOnMigrate(true).baselineVersion(MigrationVersion.fromVersion("50"))
            .target(MigrationVersion.fromVersion("52"))
            .load().migrate();
    }

    @BeforeEach
    void setUp() {
        db = new JdbcTemplate(dataSource);
        tx = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        redisFactory = new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
        redisFactory.afterPropertiesSet();
        redisFactory.start();
        StringRedisTemplate redis = new StringRedisTemplate(redisFactory);
        redis.afterPropertiesSet();
        store = new RoomNotesStore(redisFactory, db, tx, redis, new com.fasterxml.jackson.databind.ObjectMapper());
        peerStore = new RoomNotesStore(redisFactory, db, tx, redis, new com.fasterxml.jackson.databind.ObjectMapper());

        spaceId = UUID.randomUUID().toString();
        mapId = UUID.randomUUID().toString();
        authorA = UUID.randomUUID().toString();
        authorB = UUID.randomUUID().toString();
        db.update("INSERT INTO town_space(id) VALUES (?)", spaceId);
        db.update("INSERT INTO space_map(map_id) VALUES (?)", mapId);
        db.update("INSERT INTO app_user(id,display_name,status) VALUES (?,?, 'ACTIVE')", authorA, "Minji");
        db.update("INSERT INTO app_user(id,display_name,status) VALUES (?,?, 'ACTIVE')", authorB, "Jiwon");
    }

    @AfterEach
    void tearDown() {
        if (store != null) store.shutdown();
        if (peerStore != null) peerStore.shutdown();
        if (redisFactory != null) redisFactory.destroy();
    }

    @Test
    void serializesConcurrentEditsAndRejectsStaleOrReusedOperationIds() throws Exception {
        String zoneId = "meeting-a";
        RoomNotesStore.SaveResult first = save(store, zoneId, "edit-1", authorA, "Minji", 0, "첫 메모");
        assertThat(first.accepted()).isTrue();
        assertThat(first.state().revision()).isEqualTo(1);

        RoomNotesStore.SaveResult duplicate = save(store, zoneId, "edit-1", authorA, "Minji", 0, "첫 메모");
        assertThat(duplicate.accepted()).isTrue();
        assertThat(duplicate.state().revision()).isEqualTo(1);

        RoomNotesStore.SaveResult reused = save(store, zoneId, "edit-1", authorA, "Minji", 0, "다른 내용");
        assertThat(reused.accepted()).isFalse();
        assertThat(reused.code()).isEqualTo("ROOM_NOTE_IDEMPOTENCY_CONFLICT");

        RoomNotesStore.SaveResult stale = save(store, zoneId, "edit-stale", authorB, "Jiwon", 0, "덮어쓰기 시도");
        assertThat(stale.accepted()).isFalse();
        assertThat(stale.code()).isEqualTo("ROOM_NOTE_CONFLICT");

        CountDownLatch bothSaved = new CountDownLatch(2);
        AtomicReference<RoomNotesStore.SaveResult> left = new AtomicReference<>();
        AtomicReference<RoomNotesStore.SaveResult> right = new AtomicReference<>();
        assertThat(store.save(spaceId, mapId, zoneId, "parallel-a", authorA, "Minji", 1, "왼쪽 수정", result -> {
            left.set(result);
            bothSaved.countDown();
        })).isTrue();
        assertThat(peerStore.save(spaceId, mapId, zoneId, "parallel-b", authorB, "Jiwon", 1, "오른쪽 수정", result -> {
            right.set(result);
            bothSaved.countDown();
        })).isTrue();
        assertThat(bothSaved.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(java.util.stream.Stream.of(left.get(), right.get()).filter(RoomNotesStore.SaveResult::accepted)).hasSize(1);
        assertThat(java.util.stream.Stream.of(left.get(), right.get()).filter(result -> !result.accepted())
            .findFirst().orElseThrow().code()).isEqualTo("ROOM_NOTE_CONFLICT");

        RoomNoteState state = load(store, zoneId);
        assertThat(state.revision()).isEqualTo(2);
        assertThat(state.history()).hasSize(2);
    }

    @Test
    void appliesThirtyDayRetentionFromMeetingEndAndResumeCancelsIt() throws Exception {
        String zoneId = "meeting-retention";
        RoomNotesStore.SaveResult saved = save(store, zoneId, "retained-edit", authorA, "Minji", 0, "기록할 내용");
        assertThat(saved.accepted()).isTrue();

        long endedAt = System.currentTimeMillis();
        store.end(spaceId, mapId, zoneId, endedAt);
        RoomNoteState ended = load(store, zoneId); // FIFO writer guarantees this follows end().
        assertThat(ended.meetingEndedAt()).isCloseTo(endedAt, org.assertj.core.api.Assertions.within(1000L));
        assertThat(ended.retentionExpiresAt() - ended.meetingEndedAt()).isEqualTo(Duration.ofDays(30).toMillis());

        store.resume(spaceId, mapId, zoneId);
        RoomNoteState resumed = load(store, zoneId);
        assertThat(resumed.revision()).isEqualTo(1);
        assertThat(resumed.meetingEndedAt()).isZero();
        assertThat(resumed.retentionExpiresAt()).isZero();

        store.end(spaceId, mapId, zoneId, System.currentTimeMillis() - Duration.ofDays(31).toMillis());
        assertThat(load(store, zoneId).revision()).isZero();
        store.queuePurge();
        load(store, zoneId);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_room_note WHERE space_id=? AND map_id=? AND zone_id=?",
            Integer.class, spaceId, mapId, zoneId)).isZero();
    }

    @Test
    void onlyEndsAndStartsRetentionAfterEveryWorldNodeHasLeft() throws Exception {
        String zoneId = "meeting-presence";
        store.resume(spaceId, mapId, zoneId);
        peerStore.resume(spaceId, mapId, zoneId);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline
            && db.queryForObject("SELECT COUNT(*) FROM space_room_note_presence WHERE space_id=? AND map_id=? AND zone_id=?",
                Integer.class, spaceId, mapId, zoneId) < 2) Thread.sleep(10);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_room_note_presence WHERE space_id=? AND map_id=? AND zone_id=?",
            Integer.class, spaceId, mapId, zoneId)).isEqualTo(2);
        assertThat(save(store, zoneId, "presence-edit", authorA, "Minji", 0, "참가자가 남아 있음").accepted()).isTrue();

        store.end(spaceId, mapId, zoneId, System.currentTimeMillis());
        RoomNoteState stillActive = load(store, zoneId);
        assertThat(stillActive.meetingEndedAt()).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM space_room_note_presence WHERE space_id=? AND map_id=? AND zone_id=?",
            Integer.class, spaceId, mapId, zoneId)).isEqualTo(1);

        peerStore.end(spaceId, mapId, zoneId, System.currentTimeMillis());
        RoomNoteState ended = load(peerStore, zoneId);
        assertThat(ended.meetingEndedAt()).isPositive();
        assertThat(ended.retentionExpiresAt() - ended.meetingEndedAt()).isEqualTo(Duration.ofDays(30).toMillis());
    }

    @Test
    void relaysPersistedStateAcrossWorldNodesAndRetriesWhenReceiverIsBackpressured() throws Exception {
        String zoneId = "meeting-relay";
        CountDownLatch delivered = new CountDownLatch(1);
        AtomicReference<RoomNotesStore.Relay> relay = new AtomicReference<>();
        peerStore.receiver(event -> false);

        RoomNotesStore.SaveResult saved = save(store, zoneId, "relay-edit", authorA, "Minji", 0, "다른 노드에 전달");
        assertThat(saved.accepted()).isTrue();
        Thread.sleep(500); // Give the peer a chance to observe and hold the event at its cursor.
        peerStore.receiver(event -> {
            relay.set(event);
            delivered.countDown();
            return true;
        });

        assertThat(delivered.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(relay.get().spaceId()).isEqualTo(spaceId);
        assertThat(relay.get().mapId()).isEqualTo(mapId);
        assertThat(relay.get().zoneId()).isEqualTo(zoneId);
        assertThat(relay.get().state().body()).isEqualTo("다른 노드에 전달");
    }

    private RoomNotesStore.SaveResult save(RoomNotesStore target, String zoneId, String requestId,
                                           String userId, String name, long baseRevision, String body) throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<RoomNotesStore.SaveResult> result = new AtomicReference<>();
        assertThat(target.save(spaceId, mapId, zoneId, requestId, userId, name, baseRevision, body, saved -> {
            result.set(saved);
            completed.countDown();
        })).isTrue();
        assertThat(completed.await(5, TimeUnit.SECONDS)).isTrue();
        return result.get();
    }

    private RoomNoteState load(RoomNotesStore target, String zoneId) throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<RoomNoteState> result = new AtomicReference<>();
        assertThat(target.load(spaceId, mapId, zoneId, state -> {
            result.set(state);
            completed.countDown();
        })).isTrue();
        assertThat(completed.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(result.get()).isNotNull();
        return result.get();
    }

    private static DataSource source() {
        DriverManagerDataSource source = new DriverManagerDataSource();
        source.setDriverClassName("org.mariadb.jdbc.Driver");
        source.setUrl("jdbc:mariadb://" + MARIADB.getHost() + ":" + MARIADB.getMappedPort(3306) + "/town");
        source.setUsername("town");
        source.setPassword("test-password");
        return source;
    }
}
