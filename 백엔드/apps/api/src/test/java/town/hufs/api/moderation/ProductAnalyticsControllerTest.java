package town.hufs.api.moderation;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.web.server.ResponseStatusException;
import town.hufs.auth.TownPrincipal;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

class ProductAnalyticsControllerTest {
    private static final String ADMIN_ID = "11111111-1111-4111-8111-111111111111";
    private final JdbcTemplate db = mock(JdbcTemplate.class);
    private final ProductAnalyticsController controller = new ProductAnalyticsController(db, ADMIN_ID);
    private final TownPrincipal admin = new TownPrincipal(ADMIN_ID, "analytics-admin", 0);

    @Test
    void returnsThirtyUtcDaysOfAnonymousCountsAndZeroFillsMissingDays() {
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        List<ProductAnalyticsController.StoredMetric> metrics = List.of(
            new ProductAnalyticsController.StoredMetric(today, "space_joined", 5),
            new ProductAnalyticsController.StoredMetric(today, "event_participation", 3),
            new ProductAnalyticsController.StoredMetric(today, "api_server_error", 1),
            new ProductAnalyticsController.StoredMetric(today.minusDays(1), "world_rejection", 2));
        doReturn(metrics).when(db).query(anyString(),
            any(RowMapper.class), any(Object[].class));

        ProductAnalyticsController.Dashboard dashboard = controller.get(admin);

        assertThat(dashboard.days()).hasSize(30);
        assertThat(dashboard.retentionDays()).isEqualTo(90);
        assertThat(dashboard.totals()).isEqualTo(new ProductAnalyticsController.Counts(5, 3, 2, 1));
        assertThat(dashboard.days().getLast()).isEqualTo(new ProductAnalyticsController.DailyPoint(
            today.toString(), new ProductAnalyticsController.Counts(5, 3, 0, 1)));
        assertThat(dashboard.days().get(0).counts()).isEqualTo(new ProductAnalyticsController.Counts(0, 0, 0, 0));
        assertThat(dashboard.toString()).doesNotContain("userId", "displayName", "message", "conversation");
    }

    @Test
    void rejectsUnauthenticatedAndNonAdministratorRequestsBeforeReadingAnalytics() {
        assertThatThrownBy(() -> controller.get(null))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
            .isEqualTo(401);
        assertThatThrownBy(() -> controller.get(new TownPrincipal(UUID.randomUUID().toString(), "member", 0)))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
            .isEqualTo(403);
        verifyNoInteractions(db);
    }

    @Test
    void deletesCountersOutsideTheNinetyDayRetentionWindow() {
        LocalDate firstRetainedDay = LocalDate.now(ZoneOffset.UTC).minusDays(89);

        controller.expireOldAnalytics();

        verify(db).update(anyString(), eq(firstRetainedDay));
    }
}
