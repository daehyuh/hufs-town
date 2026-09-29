package town.hufs.world;

import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.*;
import org.springframework.web.socket.*;
import town.hufs.auth.PublishedMaps;
import town.hufs.auth.TownPrincipal;
import town.hufs.protocol.*;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class WorldRecordingTest {
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicReference<PublishedMaps.Published> published = new AtomicReference<>();
    private final AtomicReference<Consumer<MediaGateway.Reply>> startCallback = new AtomicReference<>();
    private final AtomicReference<Consumer<MediaGateway.Reply>> stopCallback = new AtomicReference<>();
    private final ConcurrentLinkedQueue<String> transcript = new ConcurrentLinkedQueue<>();
    private MediaGateway gateway;
    private WorldHandler handler;
    private WebSocketSession hostSocket;
    private BlockingQueue<JsonNode> hostOutput;
    private String hostId;
    private long hostEpoch;

    @BeforeEach void setUp() throws Exception {
        var map = new MapDefinition(2, "recording-test", "revision-1", "test", 20, 20, 2, 2,
            List.of(), List.of(), List.of(new Zone("meeting", "회의실", "PRIVATE", new Rect(0, 0, 20, 20), 12L)),
            List.of(), List.of(), List.of(), List.of());
        published.set(new PublishedMaps.Published(1, map));
        gateway = mock(MediaGateway.class);
        when(gateway.enabled()).thenReturn(true);
        doAnswer(call -> {
            List<town.hufs.domain.MediaPolicy.Person> people = call.getArgument(0);
            var decision = (town.hufs.domain.MediaPolicy.Decision)call.getArgument(1);
            @SuppressWarnings("unchecked") Consumer<List<MediaGateway.Applied>> callback = call.getArgument(2);
            callback.accept(people.stream().filter(town.hufs.domain.MediaPolicy.Person::enabled)
                .map(person -> new MediaGateway.Applied(person.id(), person.policyEpoch(), "recording-worker",
                    List.copyOf(decision.peers().getOrDefault(person.id(), Set.of())), List.of())).toList());
            return null;
        }).when(gateway).publish(anyList(), any(), any());
        doAnswer(call -> { startCallback.set(call.getArgument(10)); return null; })
            .when(gateway).startRecording(anyString(), anyString(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyList(), anyBoolean(), anyList(), any());
        doAnswer(call -> { stopCallback.set(call.getArgument(1)); return null; })
            .when(gateway).stopRecording(anyString(), any());
        var auth = mock(WorldAuthentication.class);
        when(auth.preview()).thenReturn(true);
        when(auth.map(anyString())).thenAnswer(call -> published.get());
        when(auth.map(anyString(), anyString())).thenAnswer(call -> published.get());
        when(auth.active(anyString(), any())).thenReturn(true);
        handler = new WorldHandler(auth, gateway);

        hostOutput = new LinkedBlockingQueue<>();
        hostSocket = socket("recording-host", "Host", hostOutput);
        handler.afterConnectionEstablished(hostSocket);
        send(hostSocket, Map.of("type", "join", "protocolVersion", 2, "name", "Host", "avatar", 0,
            "skin", "light", "clothing", "casual_white", "hair", "hair_short_black", "resumeToken", ""));
        JsonNode welcome = await(hostOutput, event -> "welcome".equals(event.path("type").asText()));
        hostId = welcome.path("playerId").asText();
        hostEpoch = welcome.path("epoch").asLong();
        await(hostOutput, event -> "mediaState".equals(event.path("type").asText()) && event.path("available").asBoolean());
        await(hostOutput, event -> "snapshot".equals(event.path("type").asText())
            && !event.path("rooms").isEmpty() && hostId.equals(event.path("rooms").get(0).path("hostPlayerId").asText()));
    }

    @AfterEach void tearDown() { if (handler != null) handler.shutdown(); }

    @Test void startsOnlyAfterEveryCurrentParticipantConsentsAndStopsWhenConsentIsWithdrawn() throws Exception {
        BlockingQueue<JsonNode> guestOutput = new LinkedBlockingQueue<>();
        WebSocketSession guestSocket = socket("recording-guest", "Guest", guestOutput);
        handler.afterConnectionEstablished(guestSocket);
        send(guestSocket, Map.of("type", "join", "protocolVersion", 2, "name", "Guest", "avatar", 0,
            "skin", "light", "clothing", "casual_white", "hair", "hair_short_black", "resumeToken", ""));
        JsonNode guestWelcome = await(guestOutput, event -> "welcome".equals(event.path("type").asText()));
        String guestId = guestWelcome.path("playerId").asText();
        long guestEpoch = guestWelcome.path("epoch").asLong();
        await(guestOutput, event -> "mediaState".equals(event.path("type").asText()) && event.path("available").asBoolean());

        send(guestSocket, request("guest-start", guestEpoch, "START", "", List.of("MICROPHONE"), false));
        JsonNode forbidden = await(guestOutput, event -> "roomRecordingAck".equals(event.path("type").asText())
            && "guest-start".equals(event.path("requestId").asText()));
        assertThat(forbidden.path("code").asText()).isEqualTo("ROOM_RECORDING_HOST_REQUIRED");

        send(hostSocket, request("start", hostEpoch, "START", "", List.of("MICROPHONE"), false, true));
        JsonNode pending = await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "AWAITING_CONSENT".equals(event.path("status").asText()));
        String recordingId = pending.path("recordingId").asText();
        assertThat(pending.path("participants").size()).isEqualTo(2);
        assertThat(pending.path("transcribe").asBoolean()).isTrue();
        verify(gateway, never()).startRecording(anyString(), anyString(), anyString(), anyString(), anyString(),
            anyString(), anyString(), anyList(), anyBoolean(), anyList(), any());

        send(hostSocket, request("host-consent", hostEpoch, "CONSENT", recordingId, List.of(), true));
        await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "AWAITING_CONSENT".equals(event.path("status").asText())
            && event.path("participants").findValuesAsText("decision").contains("ACCEPTED"));
        verify(gateway, never()).startRecording(anyString(), anyString(), anyString(), anyString(), anyString(),
            anyString(), anyString(), anyList(), anyBoolean(), anyList(), any());

        send(guestSocket, request("guest-consent", guestEpoch, "CONSENT", recordingId, List.of(), true));
        await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "STARTING".equals(event.path("status").asText()));
        awaitCondition(() -> startCallback.get() != null);
        assertThat(startCallback.get()).isNotNull();
        startCallback.get().accept(new MediaGateway.Reply(true,
            "{\"recordingId\":\"" + recordingId + "\",\"active\":true,\"trackCount\":2,\"manifestKey\":\"manifest.json\"}", "", ""));
        await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "RECORDING".equals(event.path("status").asText()));

        send(guestSocket, request("guest-withdraw", guestEpoch, "WITHDRAW", recordingId, List.of(), false));
        await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "STOPPING".equals(event.path("status").asText()));
        awaitCondition(() -> stopCallback.get() != null);
        assertThat(stopCallback.get()).isNotNull();
        stopCallback.get().accept(new MediaGateway.Reply(true,
            "{\"recordingId\":\"" + recordingId + "\",\"active\":false,\"trackCount\":2,\"bytes\":2048,\"sha256\":\"abc\"}", "", ""));
        JsonNode stopped = await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "STOPPED".equals(event.path("status").asText()));
        assertThat(stopped.path("trackCount").asInt()).isEqualTo(2);
        verify(gateway, times(1)).startRecording(eq(recordingId), anyString(),
            eq(RecordingMetadataId.resolve(true, "space", "preview")),
            eq(RecordingMetadataId.resolve(true, "map", "preview")),
            eq(RecordingMetadataId.resolve(true, "revision", "revision-1")), eq("meeting"),
            eq(RecordingMetadataId.resolve(true, "user", "recording-host")),
            eq(List.of("MICROPHONE")), eq(true), argThat(people -> people.size() == 2
                && people.stream().allMatch(person -> person.userId() != null
                    && person.userId().matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                    && person.name() != null && !person.name().isBlank())), any());
        verify(gateway, times(1)).stopRecording(eq(recordingId), any());
    }

    @Test void aDeclineEndsTheRequestWithoutCallingTheMediaRecorder() throws Exception {
        BlockingQueue<JsonNode> guestOutput = new LinkedBlockingQueue<>();
        WebSocketSession guestSocket = socket("declining-guest", "Guest", guestOutput);
        handler.afterConnectionEstablished(guestSocket);
        send(guestSocket, Map.of("type", "join", "protocolVersion", 2, "name", "Guest", "avatar", 0,
            "skin", "light", "clothing", "casual_white", "hair", "hair_short_black", "resumeToken", ""));
        JsonNode guestWelcome = await(guestOutput, event -> "welcome".equals(event.path("type").asText()));
        long guestEpoch = guestWelcome.path("epoch").asLong();
        await(guestOutput, event -> "mediaState".equals(event.path("type").asText()) && event.path("available").asBoolean());

        send(hostSocket, request("start-decline", hostEpoch, "START", "", List.of("MICROPHONE"), false));
        JsonNode pending = await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "AWAITING_CONSENT".equals(event.path("status").asText()));
        send(guestSocket, request("guest-decline", guestEpoch, "CONSENT", pending.path("recordingId").asText(), List.of(), false));
        JsonNode declined = await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "DECLINED".equals(event.path("status").asText()));
        assertThat(declined.path("startedAt").asLong()).isZero();
        verify(gateway, never()).startRecording(anyString(), anyString(), anyString(), anyString(), anyString(),
            anyString(), anyString(), anyList(), anyBoolean(), anyList(), any());
    }

    @Test void aRosterChangeCancelsPendingConsentBeforeMediaStarts() throws Exception {
        send(hostSocket, request("start-roster-change", hostEpoch, "START", "", List.of("MICROPHONE"), false));
        await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "AWAITING_CONSENT".equals(event.path("status").asText()));

        BlockingQueue<JsonNode> guestOutput = new LinkedBlockingQueue<>();
        WebSocketSession guestSocket = socket("joining-guest", "Guest", guestOutput);
        handler.afterConnectionEstablished(guestSocket);
        send(guestSocket, Map.of("type", "join", "protocolVersion", 2, "name", "Guest", "avatar", 0,
            "skin", "light", "clothing", "casual_white", "hair", "hair_short_black", "resumeToken", ""));
        await(guestOutput, event -> "welcome".equals(event.path("type").asText()));

        JsonNode stopped = await(hostOutput, event -> "roomRecordingState".equals(event.path("type").asText())
            && "STOPPED".equals(event.path("status").asText()));
        assertThat(stopped.path("startedAt").asLong()).isZero();
        verify(gateway, never()).startRecording(anyString(), anyString(), anyString(), anyString(), anyString(),
            anyString(), anyString(), anyList(), anyBoolean(), anyList(), any());
    }

    private WebSocketSession socket(String userId, String displayName, BlockingQueue<JsonNode> output) throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn(UUID.randomUUID().toString());
        when(session.isOpen()).thenReturn(true);
        when(session.getAttributes()).thenReturn(Map.of(
            WorldAuthentication.MAP, published.get(), WorldAuthentication.PRINCIPAL,
            new TownPrincipal(userId, displayName, 0), WorldAuthentication.SESSION_ID, "session-" + userId));
        doAnswer(call -> {
            JsonNode event = json.readTree(((TextMessage)call.getArgument(0)).getPayload());
            output.add(event);
            transcript.add(event.path("type").asText());
            if ("snapshot".equals(event.path("type").asText()))
                handler.handleTextMessage(session, new TextMessage("{\"type\":\"snapshotAck\",\"tick\":"
                    + event.path("tick").asLong() + ",\"applied\":true}"));
            return null;
        }).when(session).sendMessage(any());
        return session;
    }

    private Map<String, Object> request(String requestId, long epoch, String action, String recordingId,
                                        List<String> sources, boolean accepted) {
        return request(requestId, epoch, action, recordingId, sources, accepted, false);
    }
    private Map<String, Object> request(String requestId, long epoch, String action, String recordingId,
                                        List<String> sources, boolean accepted, boolean transcribe) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("type", "roomRecordingRequest");
        request.put("requestId", requestId);
        request.put("epoch", epoch);
        request.put("zoneId", "meeting");
        request.put("action", action);
        request.put("recordingId", recordingId);
        request.put("sources", sources);
        if (transcribe) request.put("transcribe", true);
        request.put("accepted", accepted);
        return request;
    }
    private void send(WebSocketSession session, Object message) throws Exception {
        handler.handleTextMessage(session, new TextMessage(json.writeValueAsString(message)));
    }
    private JsonNode await(BlockingQueue<JsonNode> output, Predicate<JsonNode> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
        while (System.nanoTime() < deadline) {
            JsonNode event = output.poll(50, TimeUnit.MILLISECONDS);
            if (event != null && condition.test(event)) return event;
        }
        throw new AssertionError("World recording event did not arrive; received " + transcript);
    }
    private void awaitCondition(Callable<Boolean> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline) {
            if (condition.call()) return;
            Thread.sleep(5);
        }
        throw new AssertionError("Asynchronous media control was not invoked");
    }
}
