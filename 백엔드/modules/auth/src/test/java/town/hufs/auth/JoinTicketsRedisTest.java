package town.hufs.auth;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.*;

@Testcontainers
class JoinTicketsRedisTest {
    @Container
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4-alpine").withExposedPorts(6379);

    private static final LettuceConnectionFactory CONNECTIONS = new LettuceConnectionFactory();
    private static StringRedisTemplate redis;
    private JoinTickets first;
    private JoinTickets second;

    @org.junit.jupiter.api.BeforeAll
    static void connect() {
        CONNECTIONS.setHostName(REDIS.getHost());
        CONNECTIONS.setPort(REDIS.getMappedPort(6379));
        CONNECTIONS.afterPropertiesSet();
        CONNECTIONS.start();
        redis = new StringRedisTemplate(CONNECTIONS);
        redis.afterPropertiesSet();
    }

    @BeforeEach
    void reset() {
        redis.getConnectionFactory().getConnection().serverCommands().flushDb();
        first = new JoinTickets(redis);
        second = new JoinTickets(redis);
    }

    @AfterAll
    static void close() { CONNECTIONS.destroy(); }

    @Test
    void twoInstancesShareCapacityAcrossMaps() {
        String a = first.issue("user-a", "session-a", "shared-space", "map-a", 2);
        String b = second.issue("user-b", "session-b", "shared-space", "map-b", 2);
        assertThat(first.consume(a, "user-a", "session-a").mapId()).isEqualTo("map-a");
        assertThat(second.consume(b, "user-b", "session-b").mapId()).isEqualTo("map-b");
        assertThatThrownBy(() -> first.issue("user-c", "session-c", "shared-space", "map-a", 2))
            .isInstanceOf(JoinTickets.Full.class);
        assertThatCode(() -> second.issue("user-d", "session-d", "another-space", "map-a", 2))
            .doesNotThrowAnyException();
    }

    @Test
    void reconnectReusesItsSeatAtCapacityAndIsBoundToTheSession() {
        String original = first.issue("user-a", "session-a", "shared-space", "map-a", 1);
        JoinTickets.Admission admission = first.consume(original, "user-a", "session-a");
        String resumeToken = "resume-token-a";
        JoinTickets.Ownership ownerA = first.claimSeat("shared-space", admission.seatId(), resumeToken,
            "user-a", "session-a", "node-a");
        assertThat(ownerA).isNotNull();
        assertThat(ownerA.newlyClaimed()).isTrue();
        assertThat(first.renewSeats("shared-space", List.of(lease(admission, resumeToken, ownerA, "user-a", "session-a")))
            .rejectedSeatIds()).isEmpty();

        assertThatThrownBy(() -> second.issue("user-b", "session-b", "shared-space", "map-a", 1))
            .isInstanceOf(JoinTickets.Full.class);
        String reconnect = second.issue("user-a", "session-a", "shared-space", "map-a", 1,
            -1, -1, resumeToken);
        JoinTickets.Admission resumed = second.consume(reconnect, "user-a", "session-a");
        assertThat(resumed.seatId()).isEqualTo(admission.seatId());
        assertThat(resumed.reusedSeat()).isTrue();
        assertThat(second.claimSeat("shared-space", resumed.seatId(), resumeToken,
            "user-a", "session-a", "node-b")).isNull();
        assertThatThrownBy(() -> second.issue("user-a", "different-session", "shared-space", "map-a", 1,
            -1, -1, resumeToken)).isInstanceOf(JoinTickets.Full.class);

        redis.expire("hufs-town:seat-owner:shared-space:" + admission.seatId(), java.time.Duration.ZERO);
        JoinTickets.Ownership ownerB = second.claimSeat("shared-space", resumed.seatId(), resumeToken,
            "user-a", "session-a", "node-b");
        assertThat(ownerB).isNotNull();
        assertThat(ownerB.fence()).isGreaterThan(ownerA.fence());
        assertThat(first.renewSeats("shared-space", List.of(lease(admission, resumeToken, ownerA, "user-a", "session-a")))
            .rejectedSeatIds()).containsExactly(admission.seatId());
        first.releaseSeat("shared-space", admission.seatId(), resumeToken, ownerA.nodeId(), ownerA.fence());
        assertThat(second.renewSeats("shared-space", List.of(lease(resumed, resumeToken, ownerB, "user-a", "session-a")))
            .rejectedSeatIds()).isEmpty();
    }

    @Test
    void freshTabForTheSameLoginSessionReusesAndFencesItsExistingSeat() {
        String original = first.issue("user-a", "session-a", "shared-space", "map-a", 1);
        JoinTickets.Admission admission = first.consume(original, "user-a", "session-a");
        JoinTickets.Ownership oldOwner = first.claimSeat("shared-space", admission.seatId(), admission.resumeToken(),
            "user-a", "session-a", "node-a");
        assertThat(oldOwner).isNotNull();

        String freshTab = second.issue("user-a", "session-a", "shared-space", "map-b", 1);
        JoinTickets.Admission handedOff = second.consume(freshTab, "user-a", "session-a");
        assertThat(handedOff.reusedSeat()).isTrue();
        assertThat(handedOff.seatId()).isEqualTo(admission.seatId());
        assertThat(handedOff.resumeToken()).isEqualTo(admission.resumeToken());

        JoinTickets.Ownership newOwner = second.claimSeat("shared-space", handedOff.seatId(), handedOff.resumeToken(),
            "user-a", "session-a", "node-a", true);
        assertThat(newOwner).isNotNull();
        assertThat(newOwner.fence()).isGreaterThan(oldOwner.fence());
        assertThat(first.renewSeats("shared-space", List.of(lease(admission, admission.resumeToken(), oldOwner,
            "user-a", "session-a"))).rejectedSeatIds()).containsExactly(admission.seatId());
        assertThat(second.renewSeats("shared-space", List.of(lease(handedOff, handedOff.resumeToken(), newOwner,
            "user-a", "session-a"))).rejectedSeatIds()).isEmpty();
        assertThat(redis.opsForZSet().zCard("hufs-town:seats:shared-space")).isEqualTo(1L);
    }

    @Test
    void simultaneousAdmissionsNeverExceedTheSharedLimit() throws Exception {
        int requests = 160;
        ExecutorService workers = Executors.newFixedThreadPool(24);
        try {
            List<Future<AdmissionAttempt>> results = new ArrayList<>();
            for (int i = 0; i < requests; i++) {
                final int request = i;
                results.add(workers.submit(() -> {
                    String userId = "user-" + request;
                    String sessionId = "session-" + request;
                    try {
                        String token = (request % 2 == 0 ? first : second).issue(userId, sessionId,
                            "busy-space", "map-" + (request % 3), 100);
                        return new AdmissionAttempt(userId, sessionId, token);
                    } catch (JoinTickets.Full full) {
                        return new AdmissionAttempt(userId, sessionId, "");
                    }
                }));
            }
            List<AdmissionAttempt> attempts = new ArrayList<>();
            for (Future<AdmissionAttempt> result : results)
                attempts.add(result.get(20, TimeUnit.SECONDS));
            List<AdmissionAttempt> accepted = attempts.stream()
                .filter(attempt -> !attempt.token().isBlank()).toList();
            assertThat(accepted).hasSize(100);
            assertThat(attempts.stream().filter(attempt -> attempt.token().isBlank())).hasSize(60);
            assertThat(redis.opsForZSet().zCard("hufs-town:seats:busy-space")).isEqualTo(100L);

            List<JoinTickets.SeatLease> leases = new ArrayList<>(100);
            for (AdmissionAttempt attempt : accepted) {
                int request = Integer.parseInt(attempt.userId().substring("user-".length()));
                JoinTickets tickets = request % 2 == 0 ? first : second;
                JoinTickets.Admission admission = tickets.consume(
                    attempt.token(), attempt.userId(), attempt.sessionId());
                assertThat(admission).isNotNull();
                JoinTickets.Ownership owner = tickets.claimSeat("busy-space", admission.seatId(),
                    admission.resumeToken(), attempt.userId(), attempt.sessionId(), "world-node-a");
                assertThat(owner).isNotNull();
                leases.add(new JoinTickets.SeatLease(admission.spaceId(), admission.seatId(),
                    admission.resumeToken(), attempt.userId(), attempt.sessionId(), owner.nodeId(), owner.fence()));
            }
            assertThat(leases).hasSize(100);
            assertThat(first.renewSeats("busy-space", leases).rejectedSeatIds()).isEmpty();
            assertThat(redis.opsForZSet().zCard("hufs-town:seats:busy-space")).isEqualTo(100L);
            assertThatThrownBy(() -> second.issue("user-160", "session-160", "busy-space", "map-a", 100))
                .isInstanceOf(JoinTickets.Full.class);
        } finally {
            workers.shutdownNow();
        }
    }

    private record AdmissionAttempt(String userId, String sessionId, String token) {}

    @Test
    void cleanReleaseMakesTheSeatImmediatelyAvailable() {
        String ticket = first.issue("user-a", "session-a", "shared-space", "map-a", 1);
        JoinTickets.Admission admission = first.consume(ticket, "user-a", "session-a");
        first.release(admission);
        assertThatCode(() -> second.issue("user-b", "session-b", "shared-space", "map-a", 1))
            .doesNotThrowAnyException();
    }

    private static JoinTickets.SeatLease lease(JoinTickets.Admission admission, String resumeToken,
                                                JoinTickets.Ownership owner, String userId, String sessionId) {
        return new JoinTickets.SeatLease(admission.spaceId(), admission.seatId(), resumeToken,
            userId, sessionId, owner.nodeId(), owner.fence());
    }
}
