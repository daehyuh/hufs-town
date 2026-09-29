package town.hufs.world;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import town.hufs.auth.JoinTickets;
import town.hufs.auth.PublishedMaps;
import town.hufs.protocol.MapDefinition;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class WorldAoiWebSocketTest {
    private final ObjectMapper json = new ObjectMapper();
    private WorldHandler handler;

    @AfterEach void stopWorldActor() {
        if (handler != null) handler.shutdown();
    }

    @Test void leavingAoiProducesAnIncrementalSnapshotRemoval() throws Exception {
        var map = new MapDefinition(2, "aoi-map", "r1", "AOI test", 64, 40, 31.5, 20,
            List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
        var published = new PublishedMaps.Published(1, map);
        var auth = mock(WorldAuthentication.class);
        when(auth.active(any(), any())).thenReturn(true);
        when(auth.map(any(String.class))).thenReturn(published);
        var media = mock(MediaGateway.class);
        when(media.enabled()).thenReturn(false);
        handler = new WorldHandler(auth, media, new SimpleMeterRegistry());

        var viewer = connect(published, "seat-viewer", 31.5, 20);
        var moving = connect(published, "seat-moving", 47.7, 20);
        String viewerId = viewer.await(n -> n.path("type").asText().equals("welcome")).path("playerId").asText();
        String movingId = moving.await(n -> n.path("type").asText().equals("welcome")).path("playerId").asText();

        JsonNode nearby = viewer.await(n -> n.path("type").asText().equals("snapshot")
            && n.path("players").isArray()
            && containsPlayer(n.path("players"), movingId));
        assertThat(nearby.path("players")).anyMatch(player -> player.path("id").asText().equals(viewerId));

        moving.send("{\"type\":\"move\",\"epoch\":1,\"seq\":0,\"dx\":1,\"dy\":0,\"running\":true}");
        JsonNode leftInterest = viewer.await(n -> n.path("type").asText().equals("snapshot")
            && !n.path("full").asBoolean()
            && n.path("removedPlayerIds").isArray()
            && containsText(n.path("removedPlayerIds"), movingId));

        assertThat(leftInterest.path("players")).noneMatch(player -> player.path("id").asText().equals(movingId));
        JsonNode moverSnapshot = moving.await(n -> n.path("type").asText().equals("snapshot")
            && n.path("players").isArray() && containsPlayer(n.path("players"), movingId));
        assertThat(moverSnapshot.path("players")).anyMatch(player -> player.path("id").asText().equals(movingId));
    }

    private Probe connect(PublishedMaps.Published map, String seatId, double x, double y) throws Exception {
        var session = mock(WebSocketSession.class);
        String sessionId = UUID.randomUUID().toString();
        when(session.getId()).thenReturn(sessionId);
        when(session.isOpen()).thenReturn(true);
        when(session.getAttributes()).thenReturn(Map.of(
            WorldAuthentication.MAP, map,
            WorldAuthentication.ADMISSION, new JoinTickets.Admission("ticket", "test-user", sessionId,
                "aoi-space", map.map().id(), 100, x, y, seatId, false, "")));
        var probe = new Probe(session);
        doAnswer(call -> {
            var event = json.readTree(((TextMessage)call.getArgument(0)).getPayload());
            probe.messages.add(event);
            if (event.path("type").asText().equals("snapshot"))
                handler.handleTextMessage(session, new TextMessage("{\"type\":\"snapshotAck\",\"tick\":"
                    + event.path("tick").asLong() + ",\"applied\":true}"));
            return null;
        }).when(session).sendMessage(any());
        handler.afterConnectionEstablished(session);
        handler.handleTextMessage(session, new TextMessage("{\"type\":\"join\",\"protocolVersion\":2,"
            + "\"name\":\"" + seatId + "\",\"avatar\":0,\"skin\":\"light\","
            + "\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\"\"}"));
        return probe;
    }

    private static boolean containsPlayer(JsonNode nodes, String id) {
        for (JsonNode node : nodes) if (node.path("id").asText().equals(id)) return true;
        return false;
    }

    private static boolean containsText(JsonNode nodes, String value) {
        for (JsonNode node : nodes) if (node.asText().equals(value)) return true;
        return false;
    }

    private final class Probe {
        private final WebSocketSession session;
        private final BlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        private Probe(WebSocketSession session) { this.session = session; }
        void send(String value) throws Exception { handler.handleTextMessage(session, new TextMessage(value)); }
        JsonNode await(Predicate<JsonNode> predicate) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline) {
                JsonNode node = messages.poll(100, TimeUnit.MILLISECONDS);
                if (node != null && predicate.test(node)) return node;
            }
            throw new AssertionError("Expected world WebSocket message did not arrive");
        }
    }
}
