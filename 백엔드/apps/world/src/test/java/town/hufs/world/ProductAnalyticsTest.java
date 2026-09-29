package town.hufs.world;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.LocalDate;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class ProductAnalyticsTest {
    @Test
    void persistsOnlyUtcDayAndFixedMetricKeys() {
        JdbcTemplate db = mock(JdbcTemplate.class);
        ProductAnalytics analytics = new ProductAnalytics(db);

        assertThat(analytics.record(ProductAnalytics.Metric.SPACE_JOINED)).isTrue();
        assertThat(analytics.record(ProductAnalytics.Metric.EVENT_PARTICIPATION)).isTrue();
        assertThat(analytics.record(ProductAnalytics.Metric.WORLD_REJECTION)).isTrue();
        analytics.shutdown();

        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        verify(db).update(contains("town_product_analytics_daily"), eq(today), eq("space_joined"));
        verify(db).update(contains("town_product_analytics_daily"), eq(today), eq("event_participation"));
        verify(db).update(contains("town_product_analytics_daily"), eq(today), eq("world_rejection"));
    }
}
