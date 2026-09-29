package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

/** Removes ended event records, including attendance and Q&A/poll details, after the published retention window. */
@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
public class EventResultsRetention {
    public static final int RETENTION_DAYS = 180;
    private static final int DELETE_BATCH_SIZE = 1_000;
    private static final int MAX_BATCHES_PER_RUN = 20;

    private final JdbcTemplate db;

    EventResultsRetention(JdbcTemplate db) {
        this.db = db;
    }

    @Scheduled(cron = "0 35 4 * * *", zone = "UTC")
    void purgeExpiredResults() {
        int removed = purgeBefore(Instant.now().minus(RETENTION_DAYS, ChronoUnit.DAYS));
        if (removed > 0)
            org.slf4j.LoggerFactory.getLogger(getClass()).info("Expired {} event result records", removed);
    }

    /** Exposed for an integration check; active events are never removed. */
    public int purgeBefore(Instant cutoff) {
        int removed = 0;
        for (int batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
            int batchRemoved = db.update("""
                DELETE FROM town_event
                WHERE ended_at IS NOT NULL AND ended_at < ?
                ORDER BY ended_at
                LIMIT 1000
                """, Timestamp.from(cutoff));
            removed += batchRemoved;
            if (batchRemoved < DELETE_BATCH_SIZE) break;
        }
        return removed;
    }
}
