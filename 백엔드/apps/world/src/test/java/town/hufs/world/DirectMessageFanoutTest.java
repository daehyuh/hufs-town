package town.hufs.world;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.RETURNS_DEFAULTS;
import static org.mockito.Mockito.mock;

@Testcontainers(disabledWithoutDocker = true)
class DirectMessageFanoutTest {
    @Container
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4.8-alpine")
        .withExposedPorts(6379);

    @Test
    void redisPublishesOnlyACompactWakeUpHintWithoutMessageContent() throws Exception {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
        factory.afterPropertiesSet();
        factory.start();
        StringRedisTemplate redis = new StringRedisTemplate(factory);
        redis.afterPropertiesSet();
        JdbcTemplate db = mock(JdbcTemplate.class, invocation -> {
            if (invocation.getMethod().getName().equals("queryForObject")) return 0L;
            if (invocation.getMethod().getName().equals("query")) return java.util.List.of();
            return RETURNS_DEFAULTS.answer(invocation);
        });
        ObjectMapper json = new ObjectMapper();
        DirectMessageFanout fanout = new DirectMessageFanout(factory, redis, db, json);
        RedisMessageListenerContainer observer = new RedisMessageListenerContainer();
        observer.setConnectionFactory(factory);
        CountDownLatch received = new CountDownLatch(1);
        AtomicReference<JsonNode> published = new AtomicReference<>();
        MessageListener listener = (Message message, byte[] pattern) -> {
            try {
                published.set(json.readTree(new String(message.getBody(), StandardCharsets.UTF_8)));
                received.countDown();
            } catch (Exception ignored) { }
        };
        observer.addMessageListener(listener, new ChannelTopic(DirectMessageFanout.CHANNEL));
        observer.afterPropertiesSet();
        observer.start();
        try {
            Thread.sleep(200);
            fanout.publish(42);
            assertThat(received.await(5, TimeUnit.SECONDS)).isTrue();
            JsonNode hint = published.get();
            assertThat(hint.path("originNodeId").asText()).isEqualTo(fanout.nodeId());
            assertThat(hint.path("eventId").asLong()).isEqualTo(42);
            assertThat(hint.size()).isEqualTo(2);
            assertThat(hint.toString()).doesNotContain("body", "message", "recipient");
        } finally {
            fanout.shutdown();
            observer.stop();
            observer.destroy();
            factory.destroy();
        }
    }
}
