package town.hufs.world;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ChatRetentionPolicyTest {
    private final JdbcTemplate db = mock(JdbcTemplate.class);

    @Test
    void usesEnvironmentDefaultUntilAnOperatorOverrideExists() {
        when(db.queryForList(anyString(), eq(Integer.class))).thenReturn(List.of());

        assertThat(new ChatRetentionPolicy(db, 45).days()).isEqualTo(45);
    }

    @Test
    void usesThePersistedOperatorOverrideForNewMessages() {
        when(db.queryForList(anyString(), eq(Integer.class))).thenReturn(List.of(90));

        assertThat(new ChatRetentionPolicy(db, 30).days()).isEqualTo(90);
    }

    @Test
    void refreshesTheCachedOverrideWhenItsShortTtlExpires() {
        when(db.queryForList(anyString(), eq(Integer.class)))
            .thenReturn(List.of(90), List.of(14));
        ChatRetentionPolicy policy = new ChatRetentionPolicy(db, 30, 0);

        assertThat(policy.days()).isEqualTo(90);
        assertThat(policy.days()).isEqualTo(14);
    }

    @Test
    void fallsBackToTheEnvironmentWhenThePersistedValueIsInvalidOrUnavailable() {
        when(db.queryForList(anyString(), eq(Integer.class))).thenReturn(List.of(0));
        assertThat(new ChatRetentionPolicy(db, 30).days()).isEqualTo(30);

        when(db.queryForList(anyString(), eq(Integer.class))).thenThrow(new IllegalStateException("database unavailable"));
        assertThat(new ChatRetentionPolicy(db, 30).days()).isEqualTo(30);
    }
}
