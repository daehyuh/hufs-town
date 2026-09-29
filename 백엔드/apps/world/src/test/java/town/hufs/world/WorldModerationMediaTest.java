package town.hufs.world;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import town.hufs.auth.PublishedMaps;
import town.hufs.auth.TownPrincipal;
import town.hufs.domain.MediaPolicy;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.Rect;

import java.sql.Timestamp;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class WorldModerationMediaTest {
    private static final String MODERATION_USER_ID = "00000000-0000-4000-8000-000000000111";
    private final ObjectMapper json = new ObjectMapper();
    private final BlockingQueue<JsonNode> output = new LinkedBlockingQueue<>();
    private final AtomicLong mutedUntil = new AtomicLong();
    private final AtomicLong blockedUntil = new AtomicLong();
    private final AtomicReference<PublishedMaps.Published> published = new AtomicReference<>();
    private WorldHandler handler;
    private UserModerationStore moderationStore;
    private WebSocketSession socket;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws Exception {
        JdbcTemplate db = mock(JdbcTemplate.class);
        doAnswer(call -> {
            Map<String, Object> row = new HashMap<>();
            row.put("moderation_subject", "user:" + MODERATION_USER_ID);
            long until = mutedUntil.get();
            row.put("media_muted_until", until > System.currentTimeMillis() ? new Timestamp(until) : null);
            long blockUntil = blockedUntil.get();
            row.put("world_blocked_until", blockUntil > System.currentTimeMillis() ? new Timestamp(blockUntil) : null);
            return List.of(row);
        }).when(db).queryForList(anyString(), any(Object[].class));
        moderationStore = new UserModerationStore(db);

        MediaGateway media = mock(MediaGateway.class);
        when(media.enabled()).thenReturn(true);
        doAnswer(call -> {
            List<MediaPolicy.Person> people = call.getArgument(0);
            MediaPolicy.Decision decision = call.getArgument(1);
            ((java.util.function.Consumer<List<MediaGateway.Applied>>) call.getArgument(2)).accept(
                people.stream().filter(MediaPolicy.Person::enabled)
                    .map(person -> new MediaGateway.Applied(person.id(), person.policyEpoch(), "test-worker",
                        List.copyOf(decision.peers().get(person.id())), List.of()))
                    .toList());
            return null;
        }).when(media).publish(anyList(), any(), any());

        var auth = mock(WorldAuthentication.class);
        when(auth.map(anyString())).thenAnswer(call -> published.get());
        when(auth.map(anyString(), anyString())).thenAnswer(call -> published.get());
        when(auth.active(anyString(), any())).thenReturn(true);
        published.set(new PublishedMaps.Published(1, map()));
        handler = new WorldHandler(auth, media, moderationStore);

        socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn(UUID.randomUUID().toString());
        when(socket.isOpen()).thenReturn(true);
        when(socket.getAttributes()).thenReturn(Map.of(
            WorldAuthentication.MAP, published.get(),
            WorldAuthentication.PRINCIPAL, new TownPrincipal(MODERATION_USER_ID, "moderation-test", 0),
            WorldAuthentication.SESSION_ID, "moderation-test-session"));
        doAnswer(call -> {
            JsonNode event = json.readTree(((TextMessage) call.getArgument(0)).getPayload());
            output.add(event);
            if (event.path("type").asText().equals("snapshot"))
                handler.handleTextMessage(socket, new TextMessage("{\"type\":\"snapshotAck\",\"tick\":"
                    + event.path("tick").asLong() + ",\"applied\":true}"));
            return null;
        }).when(socket).sendMessage(any());

        handler.afterConnectionEstablished(socket);
        send("{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"moderation-test\",\"avatar\":0,"
            + "\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\"\"}");
    }

    @AfterEach
    void close() {
        if (handler != null) handler.shutdown();
        if (moderationStore != null) moderationStore.shutdown();
    }

    @Test
    void mediaModerationRevokesAndRestoresScreenAndSharedAudioTogether() throws Exception {
        JsonNode available = await(node -> node.path("type").asText().equals("mediaState")
            && node.path("available").asBoolean() && node.path("moderatedSources").isEmpty());
        long initialEpoch = available.path("policyEpoch").asLong();

        mutedUntil.set(System.currentTimeMillis() + 60_000);
        JsonNode muted = await(node -> node.path("type").asText().equals("mediaState")
            && node.path("moderatedSources").size() == MediaPolicy.Source.values().length);
        assertThat(muted.path("moderatedSources").toString())
            .contains("SCREEN", "SCREEN_AUDIO", "CAMERA", "MICROPHONE");
        assertThat(muted.path("policyEpoch").asLong()).isGreaterThan(initialEpoch);

        mutedUntil.set(0);
        JsonNode restored = await(node -> node.path("type").asText().equals("mediaState")
            && node.path("moderatedSources").isEmpty()
            && node.path("policyEpoch").asLong() > muted.path("policyEpoch").asLong());
        assertThat(restored.path("available").asBoolean()).isTrue();
    }

    @Test
    void activeWorldModerationEjectsConnectedUser() throws Exception {
        await(node -> node.path("type").asText().equals("mediaState")
            && node.path("available").asBoolean());

        blockedUntil.set(System.currentTimeMillis() + 60_000);
        JsonNode rejected = await(node -> node.path("type").asText().equals("error")
            && node.path("code").asText().equals("MODERATION_KICKED"));

        assertThat(rejected.path("message").asText()).contains("운영 조치");
    }

    private MapDefinition map() {
        return new MapDefinition(2, "test", "moderation-map", "test", 20, 20, 10, 10,
            List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
    }

    private void send(String message) throws Exception {
        handler.handleTextMessage(socket, new TextMessage(message));
    }

    private JsonNode await(Predicate<JsonNode> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
        while (System.nanoTime() < deadline) {
            JsonNode next = output.poll(100, TimeUnit.MILLISECONDS);
            if (next != null && condition.test(next)) return next;
        }
        throw new AssertionError("Timed out waiting for world moderation media state");
    }
}
