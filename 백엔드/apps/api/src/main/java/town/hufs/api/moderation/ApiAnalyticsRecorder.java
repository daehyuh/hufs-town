package town.hufs.api.moderation;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class ApiAnalyticsRecorder {
    private static final Logger log = LoggerFactory.getLogger(ApiAnalyticsRecorder.class);
    private final JdbcTemplate db;
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(512), task -> {
            Thread thread = new Thread(task, "town-api-analytics");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    ApiAnalyticsRecorder(JdbcTemplate db) {
        this.db = db;
    }

    void recordServerError() {
        LocalDate day = LocalDate.now(ZoneOffset.UTC);
        try {
            writer.execute(() -> {
                try {
                    db.update("""
                        INSERT INTO town_product_analytics_daily(metric_date,metric_key,event_count)
                        VALUES (?, 'api_server_error', 1)
                        ON DUPLICATE KEY UPDATE event_count=event_count+1,updated_at=CURRENT_TIMESTAMP(6)
                        """, day);
                } catch (RuntimeException failure) {
                    log.warn("API analytics write failed: {}", failure.getClass().getSimpleName());
                }
            });
        } catch (RejectedExecutionException full) {
            log.warn("API analytics queue is full");
        }
    }

    @PreDestroy
    void shutdown() {
        writer.shutdown();
        try {
            if (!writer.awaitTermination(2, TimeUnit.SECONDS)) writer.shutdownNow();
        } catch (InterruptedException interrupted) {
            writer.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
