package town.hufs.api.moderation;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import town.hufs.auth.TownPrincipal;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/admin/analytics")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
final class ProductAnalyticsController {
    static final int RETENTION_DAYS = 90;
    private static final int REPORT_DAYS = 30;
    private static final Pattern UUID_PATTERN = Pattern.compile(
        "(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

    record Counts(long spaceJoins, long eventParticipations, long worldRejections, long apiServerErrors) {
        Counts plus(Counts other) {
            return new Counts(spaceJoins + other.spaceJoins, eventParticipations + other.eventParticipations,
                worldRejections + other.worldRejections, apiServerErrors + other.apiServerErrors);
        }
    }
    record DailyPoint(String date, Counts counts) {}
    record Dashboard(long generatedAt, int retentionDays, Counts totals, List<DailyPoint> days) {}
    record StoredMetric(LocalDate date, String key, long count) {}

    private final JdbcTemplate db;
    private final Set<String> administratorIds;

    ProductAnalyticsController(JdbcTemplate db,
                               @Value("${town.moderation.admin-user-ids:}") String administratorIds) {
        this.db = db;
        this.administratorIds = Arrays.stream(administratorIds.split(","))
            .map(String::trim).filter(value -> UUID_PATTERN.matcher(value).matches())
            .map(String::toLowerCase).collect(Collectors.toUnmodifiableSet());
    }

    @GetMapping
    Dashboard get(@AuthenticationPrincipal TownPrincipal principal) {
        requireAdministrator(principal);
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        LocalDate start = today.minusDays(REPORT_DAYS - 1L);
        Map<LocalDate, long[]> values = new HashMap<>();
        db.query("""
            SELECT metric_date,metric_key,event_count
            FROM town_product_analytics_daily
            WHERE metric_date>=? AND metric_date<=?
            """, (rs, row) -> new StoredMetric(rs.getDate("metric_date").toLocalDate(),
                rs.getString("metric_key"), rs.getLong("event_count")), start, today)
            .forEach(metric -> {
                long[] counts = values.computeIfAbsent(metric.date(), ignored -> new long[4]);
                switch (metric.key()) {
                    case "space_joined" -> counts[0] += metric.count();
                    case "event_participation" -> counts[1] += metric.count();
                    case "world_rejection" -> counts[2] += metric.count();
                    case "api_server_error" -> counts[3] += metric.count();
                    default -> throw new IllegalStateException("Unknown product analytics metric");
                }
            });

        List<DailyPoint> days = new ArrayList<>(REPORT_DAYS);
        Counts totals = new Counts(0, 0, 0, 0);
        for (int offset = 0; offset < REPORT_DAYS; offset++) {
            LocalDate date = start.plusDays(offset);
            long[] counts = values.getOrDefault(date, new long[4]);
            Counts daily = new Counts(counts[0], counts[1], counts[2], counts[3]);
            days.add(new DailyPoint(date.toString(), daily));
            totals = totals.plus(daily);
        }
        return new Dashboard(System.currentTimeMillis(), RETENTION_DAYS, totals, List.copyOf(days));
    }

    @Scheduled(cron = "0 10 4 * * *", zone = "UTC")
    void expireOldAnalytics() {
        LocalDate firstRetainedDay = LocalDate.now(ZoneOffset.UTC).minusDays(RETENTION_DAYS - 1L);
        db.update("DELETE FROM town_product_analytics_daily WHERE metric_date<?", firstRetainedDay);
    }

    private void requireAdministrator(TownPrincipal principal) {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        if (!administratorIds.contains(principal.userId().toLowerCase()))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }
}
