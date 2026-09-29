package town.hufs.api.push;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.mock;

@ExtendWith(MockitoExtension.class)
class WebPushOutboxDispatcherTest {
    @Mock StringRedisTemplate redis;
    @Mock ZSetOperations<String, String> sortedSets;
    private WebPushOutboxDispatcher dispatcher;

    @BeforeEach
    void setUp() {
        when(redis.opsForZSet()).thenReturn(sortedSets);
        dispatcher = new WebPushOutboxDispatcher(
            mock(JdbcTemplate.class), mock(TransactionTemplate.class), null, new ObjectMapper(), redis);
    }

    @Test
    void activeDndMarkerSuppressesPushForOnlyThatAccount() {
        when(sortedSets.count(eq("hufs-town:presence:dnd:user-a"), anyDouble(), anyDouble())).thenReturn(1L);

        assertTrue(dispatcher.isDnd("user-a"));

        verify(sortedSets).count(eq("hufs-town:presence:dnd:user-a"), anyDouble(), eq(Double.POSITIVE_INFINITY));
    }

    @Test
    void missingOrExpiredDndMarkersAllowPush() {
        when(sortedSets.count(eq("hufs-town:presence:dnd:user-b"), anyDouble(), anyDouble())).thenReturn(0L);

        assertFalse(dispatcher.isDnd("user-b"));
    }
}
