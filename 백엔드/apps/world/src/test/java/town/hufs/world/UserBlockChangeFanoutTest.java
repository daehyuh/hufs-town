package town.hufs.world;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@Testcontainers(disabledWithoutDocker = true)
class UserBlockChangeFanoutTest {
    @Container
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4.8-alpine")
        .withExposedPorts(6379);

    @Test
    void redisHintCarriesOnlyAccountIdAndReachesWorldSubscriber() throws Exception {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
        factory.afterPropertiesSet();
        factory.start();
        StringRedisTemplate redis = new StringRedisTemplate(factory);
        redis.afterPropertiesSet();
        UserBlockChangeFanout sender = new UserBlockChangeFanout(factory, redis);
        UserBlockChangeFanout receiver = new UserBlockChangeFanout(factory, redis);
        String accountId = UUID.randomUUID().toString();
        CountDownLatch received = new CountDownLatch(1);
        AtomicReference<String> notification = new AtomicReference<>();
        receiver.receiver(userId -> {
            notification.set(userId);
            received.countDown();
        });
        try {
            Thread.sleep(200);
            sender.publish(accountId);

            assertThat(received.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(notification.get()).isEqualTo(accountId);
        } finally {
            sender.shutdown();
            receiver.shutdown();
            factory.destroy();
        }
    }
}
