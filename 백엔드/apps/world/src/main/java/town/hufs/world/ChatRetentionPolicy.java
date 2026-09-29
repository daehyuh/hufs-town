package town.hufs.world;

import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class ChatRetentionPolicy {
    private static final long REFRESH_NANOS = 5_000_000_000L;

    private record Cached(int days, long refreshAt) {}

    private final JdbcTemplate db;
    private final int defaultDays;
    private final long refreshNanos;
    private volatile Cached cached;

    @Autowired
    ChatRetentionPolicy(JdbcTemplate db, @Value("${town.chat.retention-days:30}") int defaultDays) {
        this(db, defaultDays, REFRESH_NANOS);
    }

    ChatRetentionPolicy(JdbcTemplate db, int defaultDays, long refreshNanos) {
        if (defaultDays < 1 || defaultDays > 365)
            throw new IllegalArgumentException("Chat retention must be between 1 and 365 days");
        if (refreshNanos < 0) throw new IllegalArgumentException("Refresh interval must not be negative");
        this.db = db;
        this.defaultDays = defaultDays;
        this.refreshNanos = refreshNanos;
    }

    int days() {
        long now = System.nanoTime();
        Cached value = cached;
        if (value != null && now < value.refreshAt()) return value.days();
        synchronized (this) {
            value = cached;
            now = System.nanoTime();
            if (value != null && now < value.refreshAt()) return value.days();
            try {
                List<Integer> rows = db.queryForList(
                    "SELECT retention_days FROM chat_retention_policy WHERE policy_id=1", Integer.class);
                int days = rows.isEmpty() ? defaultDays : rows.getFirst();
                if (days < 1 || days > 365) throw new IllegalStateException("Invalid chat retention policy");
                cached = new Cached(days, now + refreshNanos);
                return days;
            } catch (RuntimeException failure) {
                LoggerFactory.getLogger(getClass()).warn("Chat retention policy load failed: {}",
                    failure.getClass().getSimpleName());
                int fallback = value == null ? defaultDays : value.days();
                cached = new Cached(fallback, now + refreshNanos);
                return fallback;
            }
        }
    }
}
