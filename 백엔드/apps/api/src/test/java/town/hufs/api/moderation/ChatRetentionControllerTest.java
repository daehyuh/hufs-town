package town.hufs.api.moderation;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;
import town.hufs.auth.TownPrincipal;

import java.sql.Timestamp;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ChatRetentionControllerTest {
    private static final String ADMIN_ID = "11111111-1111-4111-8111-111111111111";
    private final JdbcTemplate db = mock(JdbcTemplate.class);
    private final ChatRetentionController controller = new ChatRetentionController(db, 30, ADMIN_ID);
    private final TownPrincipal admin = new TownPrincipal(ADMIN_ID, "retention-admin", 0);

    @Test
    void returnsEnvironmentDefaultUntilAnOperatorSavesAPolicy() {
        when(db.queryForList(anyString())).thenReturn(List.of());

        assertThat(controller.get(admin)).isEqualTo(
            new ChatRetentionController.Policy(30, "ENVIRONMENT", null, null));
    }

    @Test
    void savesAndReturnsTheAdminPolicy() {
        Map<String, Object> row = new HashMap<>();
        row.put("retention_days", 90);
        row.put("updated_at", Timestamp.from(java.time.Instant.parse("2026-09-24T00:00:00Z")));
        row.put("updated_by_user_id", ADMIN_ID);
        when(db.queryForList(anyString())).thenReturn(List.of(row));
        when(db.update(anyString(), any(Object[].class))).thenReturn(1);

        ChatRetentionController.Policy saved = controller.update(admin, new ChatRetentionController.Update(90));

        assertThat(saved.retentionDays()).isEqualTo(90);
        assertThat(saved.source()).isEqualTo("DATABASE");
        assertThat(saved.updatedBy()).isEqualTo(ADMIN_ID);
        assertThat(saved.updatedAt()).isEqualTo(Timestamp.from(java.time.Instant.parse("2026-09-24T00:00:00Z")).getTime());
        verify(db).update(anyString(), any(Object[].class));
    }

    @Test
    void rejectsUnauthenticatedAndNonAdministratorRequests() {
        assertThatThrownBy(() -> controller.get(null))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
            .isEqualTo(401);
        assertThatThrownBy(() -> controller.get(new TownPrincipal(UUID.randomUUID().toString(), "member", 0)))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
            .isEqualTo(403);
    }

    @Test
    void rejectsRetentionOutsideOneTo365Days() {
        assertThatThrownBy(() -> controller.update(admin, new ChatRetentionController.Update(0)))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
            .isEqualTo(400);
    }
}
