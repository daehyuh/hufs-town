package town.hufs.world;

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

/**
 * Writes only anonymous daily counters. No account, guest, message, event, map,
 * or request identifiers are stored in the product analytics table.
 */
@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class ProductAnalytics {
    enum Metric {
        SPACE_JOINED("space_joined"),
        EVENT_PARTICIPATION("event_participation"),
        WORLD_REJECTION("world_rejection");

        private final String key;

        Metric(String key) {
            this.key = key;
        }
    }

    private static final Logger log = LoggerFactory.getLogger(ProductAnalytics.class);
    private final JdbcTemplate db;
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(1024), task -> {
            Thread thread = new Thread(task, "town-product-analytics");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    ProductAnalytics(JdbcTemplate db) {
        this.db = db;
    }

    boolean record(Metric metric) {
        LocalDate day = LocalDate.now(ZoneOffset.UTC);
        try {
            writer.execute(() -> {
                try {
                    db.update("""
                        INSERT INTO town_product_analytics_daily(metric_date,metric_key,event_count)
                        VALUES (?,?,1)
                        ON DUPLICATE KEY UPDATE event_count=event_count+1,updated_at=CURRENT_TIMESTAMP(6)
                        """, day, metric.key);
                } catch (RuntimeException failure) {
                    log.warn("Product analytics write failed: {}", failure.getClass().getSimpleName());
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            log.warn("Product analytics queue is full");
            return false;
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
