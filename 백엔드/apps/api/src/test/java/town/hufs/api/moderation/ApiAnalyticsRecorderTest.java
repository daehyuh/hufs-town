package town.hufs.api.moderation;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.LocalDate;
import java.time.ZoneOffset;

import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class ApiAnalyticsRecorderTest {
    @Test
    void persistsOnlyTheUtcDayForServerErrorCounts() {
        JdbcTemplate db = mock(JdbcTemplate.class);
        ApiAnalyticsRecorder recorder = new ApiAnalyticsRecorder(db);

        recorder.recordServerError();
        recorder.shutdown();

        verify(db).update(contains("town_product_analytics_daily"), eq(LocalDate.now(ZoneOffset.UTC)));
    }
}
