package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/** Redis carries only a wake-up hint; each world reloads the authoritative block list from MariaDB. */
@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class UserBlockChangeFanout implements MessageListener {
    static final String CHANNEL = "hufs-town:world:user-blocks:v1";

    private final StringRedisTemplate redis;
    private final RedisMessageListenerContainer listener;
    private final ThreadPoolExecutor publisher = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-user-block-publisher");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
    private final AtomicReference<Consumer<String>> receiver = new AtomicReference<>(ignored -> {});

    UserBlockChangeFanout(RedisConnectionFactory connectionFactory, StringRedisTemplate redis) {
        this.redis = redis;
        listener = new RedisMessageListenerContainer();
        listener.setConnectionFactory(connectionFactory);
        listener.addMessageListener(this, new ChannelTopic(CHANNEL));
        listener.afterPropertiesSet();
        listener.start();
    }

    void receiver(Consumer<String> receiver) {
        this.receiver.set(receiver == null ? ignored -> {} : receiver);
    }

    void publish(String userId) {
        if (!isUserId(userId)) return;
        try {
            publisher.execute(() -> {
                try {
                    redis.convertAndSend(CHANNEL, userId);
                } catch (RuntimeException unavailable) {
                    LoggerFactory.getLogger(getClass()).warn("Block-list refresh hint failed: {}",
                        unavailable.getClass().getSimpleName());
                }
            });
        } catch (RejectedExecutionException full) {
            LoggerFactory.getLogger(getClass()).warn("Block-list hint queue is full; periodic SQL refresh will recover changes");
        }
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String userId = new String(message.getBody(), StandardCharsets.UTF_8);
        if (!isUserId(userId)) return;
        try {
            receiver.get().accept(userId);
        } catch (RuntimeException rejected) {
            LoggerFactory.getLogger(getClass()).warn("Block-list refresh request failed: {}",
                rejected.getClass().getSimpleName());
        }
    }

    private static boolean isUserId(String value) {
        if (value == null || value.length() > 36) return false;
        try {
            UUID.fromString(value);
            return true;
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }

    @PreDestroy
    void shutdown() {
        publisher.shutdownNow();
        listener.stop();
        try {
            listener.destroy();
        } catch (Exception failure) {
            LoggerFactory.getLogger(getClass()).debug("Could not close the Redis block listener cleanly: {}",
                failure.getClass().getSimpleName());
        }
    }
}
