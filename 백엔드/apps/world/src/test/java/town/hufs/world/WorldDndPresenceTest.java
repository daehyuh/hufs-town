package town.hufs.world;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@Testcontainers(disabledWithoutDocker = true)
class WorldDndPresenceTest {
    @Container
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4.8-alpine")
        .withExposedPorts(6379);

    @Test
    void preservesDndFromAnotherWorldWhenOneWorldSessionLeavesDnd() throws Exception {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
        factory.afterPropertiesSet();
        factory.start();
        StringRedisTemplate redis = new StringRedisTemplate(factory);
        redis.afterPropertiesSet();
        JdbcTemplate db = mock(JdbcTemplate.class);
        when(db.queryForList(anyString(), eq(String.class), any(Object[].class))).thenReturn(List.of("account-1"));
        WorldDndPresence firstWorld = new WorldDndPresence(db, redis);
        WorldDndPresence secondWorld = new WorldDndPresence(db, redis);
        String key = WorldDndPresence.KEY_PREFIX + "account-1";
        String sharedKey = WorldDndPresence.SHARED_KEY_PREFIX + "account-1";
        try {
            firstWorld.replace(List.of(new WorldDndPresence.Entry("account-1", "world-1-tab", "DND")));
            secondWorld.replace(List.of(new WorldDndPresence.Entry("account-1", "world-2-tab", "DND")));
            awaitActiveCount(redis, key, 2);
            awaitActiveCount(redis, sharedKey, 2);

            firstWorld.replace(List.of());
            awaitActiveCount(redis, key, 1);
            awaitActiveCount(redis, sharedKey, 1);

            long now = System.currentTimeMillis();
            redis.opsForZSet().add(key, "expired-tab", now - 1_000);
            assertThat(redis.opsForZSet().count(key, (double) now, Double.POSITIVE_INFINITY)).isEqualTo(1L);
        } finally {
            firstWorld.shutdown();
            secondWorld.shutdown();
            factory.destroy();
        }
    }

    @Test
    void removesSharedPresenceWhenAccountTurnsVisibilityOff() throws Exception {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
        factory.afterPropertiesSet();
        factory.start();
        StringRedisTemplate redis = new StringRedisTemplate(factory);
        redis.afterPropertiesSet();
        AtomicReference<List<String>> sharingUsers = new AtomicReference<>(List.of("account-2"));
        JdbcTemplate db = mock(JdbcTemplate.class);
        when(db.queryForList(anyString(), eq(String.class), any(Object[].class)))
            .thenAnswer(invocation -> sharingUsers.get());
        WorldDndPresence world = new WorldDndPresence(db, redis);
        String key = WorldDndPresence.SHARED_KEY_PREFIX + "account-2";
        try {
            world.replace(List.of(new WorldDndPresence.Entry("account-2", "world-tab", "AWAY")));
            awaitActiveCount(redis, key, 1);

            sharingUsers.set(List.of());
            awaitActiveCount(redis, key, 0);
        } finally {
            world.shutdown();
            factory.destroy();
        }
    }

    private static void awaitActiveCount(StringRedisTemplate redis, String key, long expected) throws InterruptedException {
        long deadline = System.nanoTime() + 5_000_000_000L;
        Long count = null;
        while (System.nanoTime() < deadline) {
            count = redis.opsForZSet().count(key, (double) System.currentTimeMillis(), Double.POSITIVE_INFINITY);
            if (count != null && count == expected) return;
            Thread.sleep(25);
        }
        assertThat(count).isEqualTo(expected);
    }
}
