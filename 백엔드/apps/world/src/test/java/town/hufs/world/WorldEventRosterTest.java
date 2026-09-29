package town.hufs.world;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import town.hufs.auth.JoinTickets;
import town.hufs.auth.PublishedMaps;
import town.hufs.auth.TownPrincipal;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.MapInteraction;
import town.hufs.protocol.MapObject;
import town.hufs.protocol.Rect;
import town.hufs.protocol.Zone;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WorldEventRosterTest {
    private final ObjectMapper json = new ObjectMapper();
    private final BlockingQueue<JsonNode> hostMessages = new LinkedBlockingQueue<>();
    private final BlockingQueue<JsonNode> guestMessages = new LinkedBlockingQueue<>();
    private WorldHandler handler;
    private WorldAuthentication auth;
    private ProductAnalytics analytics;
    private WebSocketSession host;
    private WebSocketSession guest;
    private String hostId;
    private String guestId;
    private long hostEpoch;
    private long guestEpoch;

    @BeforeEach
    void setUp() throws Exception {
        auth = mock(WorldAuthentication.class);
        when(auth.active(any(), any())).thenReturn(true);
        when(auth.claimSeat(anyString(), anyString(), anyString(), anyString(), anyString(), anyString(), anyBoolean()))
            .thenAnswer(invocation -> new JoinTickets.Ownership(
                invocation.getArgument(0), invocation.getArgument(1), invocation.getArgument(2),
                invocation.getArgument(3), invocation.getArgument(4), invocation.getArgument(5), 1, true,
                System.nanoTime() + TimeUnit.SECONDS.toNanos(30)));
        analytics = mock(ProductAnalytics.class);
        when(analytics.record(any())).thenReturn(true);
        handler = new WorldHandler(auth, mock(MediaGateway.class));
        handler.attachProductAnalytics(analytics);
        host = socket("host-session", "main", "메인 홀", hostMessages);
        guest = socket("guest-session", "workshop", "워크숍", guestMessages, "user-guest-session");
        handler.afterConnectionEstablished(host);
        handler.afterConnectionEstablished(guest);
        join(host, "발표 운영자");
        join(guest, "다른 맵 참가자");
        var hostWelcome = await(hostMessages, node -> node.path("type").asText().equals("welcome"));
        var guestWelcome = await(guestMessages, node -> node.path("type").asText().equals("welcome"));
        hostId = hostWelcome.path("playerId").asText();
        guestId = guestWelcome.path("playerId").asText();
        hostEpoch = hostWelcome.path("epoch").asLong();
        guestEpoch = guestWelcome.path("epoch").asLong();
    }

    @AfterEach
    void tearDown() {
        if (handler != null) handler.shutdown();
    }

    @Test
    void countsOnlyPlayersCreatedBySuccessfulJoins() {
        verify(analytics, times(2)).record(ProductAnalytics.Metric.SPACE_JOINED);
    }

    @Test
    void eventRosterAndSpeakerControlsCoverParticipantsOnOtherMaps() throws Exception {
        send(host, Map.of("type", "eventAction", "epoch", hostEpoch, "requestId", "start-event",
            "action", "START", "targetPlayerId", "", "title", "공간 전체 발표", "description", "",
            "resourceUrl", "", "attendanceEnabled", false));

        var started = await(guestMessages, node -> node.path("type").asText().equals("eventState")
            && node.path("active").asBoolean());
        assertThat(started.path("participants")).hasSize(2);
        assertThat(participant(started, guestId).path("name").asText()).isEqualTo("다른 맵 참가자");
        assertThat(participant(started, guestId).path("mapId").asText()).isEqualTo("workshop");
        assertThat(participant(started, guestId).path("mapName").asText()).isEqualTo("워크숍");

        send(guest, Map.of("type", "eventAction", "epoch", guestEpoch, "requestId", "raise-hand",
            "action", "RAISE_HAND", "targetPlayerId", "", "title", "", "description", "",
            "resourceUrl", "", "attendanceEnabled", false));
        var raised = await(hostMessages, node -> node.path("type").asText().equals("eventState")
            && node.path("raisedHandPlayerIds").toString().contains(guestId));
        assertThat(raised.path("raisedHandPlayerIds").toString()).contains(guestId);

        send(host, Map.of("type", "eventAction", "epoch", hostEpoch, "requestId", "grant-speaker",
            "action", "GRANT_SPEAKER", "targetPlayerId", guestId, "title", "", "description", "",
            "resourceUrl", "", "attendanceEnabled", false));
        var granted = await(guestMessages, node -> node.path("type").asText().equals("eventState")
            && node.path("speakerPlayerIds").toString().contains(guestId));
        assertThat(granted.path("speakerPlayerIds").toString()).contains(guestId);
    }

    @Test
    void quizScoresCorrectAnswersAndPreventsDuplicateAccountResponsesAcrossSessions() throws Exception {
        send(host, Map.of("type", "eventAction", "epoch", hostEpoch, "requestId", "quiz-event-start",
            "action", "START", "targetPlayerId", "", "title", "퀴즈 검증", "description", "",
            "resourceUrl", "", "attendanceEnabled", false));
        await(guestMessages, node -> node.path("type").asText().equals("eventState") && node.path("active").asBoolean());

        send(host, engagement("quiz-create", hostEpoch, "CREATE_QUIZ", List.of("정답", "오답"), 0, 0));
        var created = await(guestMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("pollMode").asText().equals("QUIZ") && !node.path("pollId").asText().isBlank());
        String pollId = created.path("pollId").asText();

        BlockingQueue<JsonNode> resumedMessages = new LinkedBlockingQueue<>();
        WebSocketSession resumed = socket("guest-resumed-session", "workshop", "워크숍", resumedMessages, "user-guest-session");
        handler.afterConnectionEstablished(resumed);
        join(resumed, "다른 기기 참가자");
        var resumedWelcome = await(resumedMessages, node -> node.path("type").asText().equals("welcome"));
        long resumedEpoch = resumedWelcome.path("epoch").asLong();
        var resumedState = await(resumedMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("pollId").asText().equals(pollId));
        assertThat(resumedState.path("pollMyOptionIndex").asInt()).isEqualTo(-1);

        CompletableFuture.allOf(
            CompletableFuture.runAsync(() -> sendUnchecked(guest, engagement("quiz-vote", guestEpoch,
                "VOTE_POLL", List.of(), 0, 0))),
            CompletableFuture.runAsync(() -> sendUnchecked(resumed, engagement("quiz-reconnect-vote", resumedEpoch,
                "VOTE_POLL", List.of(), 0, 0)))
        ).get(3, TimeUnit.SECONDS);
        var recorded = await(guestMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("pollId").asText().equals(pollId) && node.path("pollMyOptionIndex").asInt(-1) == 0);
        var resumedRecorded = await(resumedMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("pollId").asText().equals(pollId) && node.path("pollMyOptionIndex").asInt(-1) == 0);
        assertThat(recorded.path("pollCorrectOptionIndex").asInt()).isEqualTo(-1);
        assertThat(recorded.path("pollCounts").isEmpty()).isTrue();
        assertThat(resumedRecorded.path("pollCounts").isEmpty()).isTrue();

        send(resumed, engagement("quiz-duplicate", resumedEpoch, "VOTE_POLL", List.of(), 1, 0));
        var duplicate = await(resumedMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("quiz-duplicate"));
        assertThat(duplicate.path("accepted").asBoolean()).isFalse();
        assertThat(duplicate.path("code").asText()).isEqualTo("POLL_DUPLICATE");

        handler.afterConnectionClosed(resumed, CloseStatus.NORMAL);
        BlockingQueue<JsonNode> reconnectedMessages = new LinkedBlockingQueue<>();
        WebSocketSession reconnected = socket("guest-reconnected-session", "workshop", "워크숍",
            reconnectedMessages, "user-guest-session");
        handler.afterConnectionEstablished(reconnected);
        join(reconnected, "다시 접속한 참가자");
        var reconnectedWelcome = await(reconnectedMessages, node -> node.path("type").asText().equals("welcome"));
        long reconnectedEpoch = reconnectedWelcome.path("epoch").asLong();
        var reconnectedState = await(reconnectedMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("pollId").asText().equals(pollId));
        assertThat(reconnectedState.path("pollMyOptionIndex").asInt()).isZero();
        send(reconnected, engagement("quiz-reconnect-duplicate", reconnectedEpoch, "VOTE_POLL", List.of(), 1, 0));
        var reconnectDuplicate = await(reconnectedMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("quiz-reconnect-duplicate"));
        assertThat(reconnectDuplicate.path("accepted").asBoolean()).isFalse();
        assertThat(reconnectDuplicate.path("code").asText()).isEqualTo("POLL_DUPLICATE");

        send(host, engagement("quiz-close", hostEpoch, "CLOSE_POLL", List.of(), 0, 0));
        var closed = await(guestMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("pollId").asText().equals(pollId) && node.path("pollClosed").asBoolean());
        assertThat(closed.path("pollCorrectOptionIndex").asInt()).isZero();
        assertThat(closed.path("myQuizScore").asInt()).isEqualTo(1);
        assertThat(closed.path("quizScores").get(0).path("score").asInt()).isEqualTo(1);
        assertThat(closed.path("quizScores").get(0).path("name").asText())
            .isIn("다른 맵 참가자", "다른 기기 참가자");
    }

    @Test
    void scavengerHuntRequiresNpcClueCollectsUniqueNearbyItemsAndRestoresAccountProgress() throws Exception {
        BlockingQueue<JsonNode> participantMessages = new LinkedBlockingQueue<>();
        WebSocketSession participant = socket("scavenger-session", "main", "메인 홀",
            participantMessages, "user-scavenger");
        handler.afterConnectionEstablished(participant);
        join(participant, "수집 참가자");
        var clientMap = await(participantMessages, node -> node.path("type").asText().equals("mapChanged"));
        JsonNode clientItem = null;
        for (JsonNode object : clientMap.path("map").path("objects"))
            if (object.path("id").asText().equals("item-one")) clientItem = object;
        assertThat(clientItem).isNotNull();
        assertThat(clientItem.path("interaction").path("body").asText()).isEmpty();
        var participantWelcome = await(participantMessages, node -> node.path("type").asText().equals("welcome"));
        long participantEpoch = participantWelcome.path("epoch").asLong();

        send(host, Map.of("type", "eventAction", "epoch", hostEpoch, "requestId", "scavenger-event-start",
            "action", "START", "targetPlayerId", "", "title", "캠퍼스 수집 행사", "description", "",
            "resourceUrl", "", "attendanceEnabled", false));
        await(participantMessages, node -> node.path("type").asText().equals("eventState")
            && node.path("active").asBoolean());

        send(host, engagement("scavenger-start", hostEpoch, "START_SCAVENGER_HUNT", ""));
        var startAck = await(hostMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-start"));
        assertThat(startAck.path("accepted").asBoolean()).isTrue();
        var started = await(participantMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("scavengerConfigured").asBoolean());
        assertThat(started.path("scavengerActive").asBoolean()).isTrue();
        assertThat(started.path("scavengerUnlocked").asBoolean()).isFalse();
        assertThat(started.path("scavengerItems")).isEmpty();

        send(participant, engagement("scavenger-locked", participantEpoch,
            "COLLECT_SCAVENGER_ITEM", "item-one"));
        var locked = await(participantMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-locked"));
        assertThat(locked.path("accepted").asBoolean()).isFalse();
        assertThat(locked.path("code").asText()).isEqualTo("SCAVENGER_LOCKED");

        send(participant, engagement("scavenger-far-npc", participantEpoch,
            "SCAVENGER_TALK", "npc-far"));
        var farNpc = await(participantMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-far-npc"));
        assertThat(farNpc.path("accepted").asBoolean()).isFalse();
        assertThat(farNpc.path("code").asText()).isEqualTo("SCAVENGER_TOO_FAR");

        send(participant, engagement("scavenger-near-npc", participantEpoch,
            "SCAVENGER_TALK", "npc-near"));
        var unlocked = await(participantMessages,
            node -> node.path("type").asText().equals("eventEngagementState")
                && node.path("scavengerUnlocked").asBoolean());
        assertThat(unlocked.path("scavengerUnlocked").asBoolean()).isTrue();
        assertThat(unlocked.path("scavengerItems")).hasSize(2);
        assertThat(unlocked.path("scavengerItems").get(0).path("clue").asText()).isEqualTo("분수 옆 표식을 찾아보세요.");
        var nearNpc = await(participantMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-near-npc"));
        assertThat(nearNpc.path("accepted").asBoolean()).isTrue();
        assertThat(nearNpc.path("message").asText()).isEqualTo("NPC가 수집 단서를 알려줬어요.");

        send(participant, engagement("scavenger-collect-one", participantEpoch,
            "COLLECT_SCAVENGER_ITEM", "item-one"));
        var firstCollected = await(participantMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("scavengerMyCollectedObjectIds").toString().contains("item-one"));
        assertThat(firstCollected.path("scavengerMyScore").asInt()).isEqualTo(1);

        send(participant, engagement("scavenger-duplicate", participantEpoch,
            "COLLECT_SCAVENGER_ITEM", "item-one"));
        var duplicate = await(participantMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-duplicate"));
        assertThat(duplicate.path("accepted").asBoolean()).isFalse();
        assertThat(duplicate.path("code").asText()).isEqualTo("SCAVENGER_DUPLICATE");

        send(participant, engagement("scavenger-collect-two", participantEpoch,
            "COLLECT_SCAVENGER_ITEM", "item-two"));
        var completed = await(participantMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("scavengerCompleted").asBoolean());
        assertThat(completed.path("scavengerMyScore").asInt()).isEqualTo(7);
        assertThat(completed.path("scavengerMyCollectedObjectIds")).hasSize(2);
        assertThat(completed.path("scavengerScores").get(0).path("score").asInt()).isEqualTo(7);
        assertThat(completed.path("scavengerScores").get(0).path("name").asText()).isEqualTo("다른 맵 참가자");

        handler.afterConnectionClosed(participant, CloseStatus.NORMAL);
        BlockingQueue<JsonNode> reconnectedMessages = new LinkedBlockingQueue<>();
        WebSocketSession reconnected = socket("scavenger-reconnected", "main", "메인 홀",
            reconnectedMessages, "user-scavenger");
        handler.afterConnectionEstablished(reconnected);
        join(reconnected, "다시 접속한 수집 참가자");
        var reconnectedWelcome = await(reconnectedMessages, node -> node.path("type").asText().equals("welcome"));
        long reconnectedEpoch = reconnectedWelcome.path("epoch").asLong();
        var restored = await(reconnectedMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("scavengerCompleted").asBoolean());
        assertThat(restored.path("scavengerUnlocked").asBoolean()).isTrue();
        assertThat(restored.path("scavengerMyCollectedObjectIds")).hasSize(2);
        assertThat(restored.path("scavengerMyScore").asInt()).isEqualTo(7);

        send(reconnected, engagement("scavenger-guest-stop", reconnectedEpoch,
            "STOP_SCAVENGER_HUNT", ""));
        var forbiddenStop = await(reconnectedMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-guest-stop"));
        assertThat(forbiddenStop.path("accepted").asBoolean()).isFalse();
        assertThat(forbiddenStop.path("code").asText()).isEqualTo("EVENT_FORBIDDEN");

        send(host, engagement("scavenger-manager-stop", hostEpoch, "STOP_SCAVENGER_HUNT", ""));
        var managerStop = await(hostMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-manager-stop"));
        assertThat(managerStop.path("accepted").asBoolean()).isTrue();
        var stopped = await(reconnectedMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("scavengerConfigured").asBoolean() && !node.path("scavengerActive").asBoolean());
        assertThat(stopped.path("scavengerMyScore").asInt()).isEqualTo(7);

        send(host, engagement("scavenger-restart", hostEpoch, "START_SCAVENGER_HUNT", ""));
        var restartAck = await(hostMessages, node -> node.path("type").asText().equals("eventEngagementAck")
            && node.path("requestId").asText().equals("scavenger-restart"));
        assertThat(restartAck.path("accepted").asBoolean()).isTrue();
        var restarted = await(reconnectedMessages, node -> node.path("type").asText().equals("eventEngagementState")
            && node.path("scavengerConfigured").asBoolean() && node.path("scavengerActive").asBoolean());
        assertThat(restarted.path("scavengerMyScore").asInt()).isZero();
        assertThat(restarted.path("scavengerUnlocked").asBoolean()).isFalse();
        assertThat(restarted.path("scavengerMyCollectedObjectIds")).isEmpty();
    }

    private WebSocketSession socket(String sessionId, String mapId, String mapName,
                                    BlockingQueue<JsonNode> messages) throws Exception {
        return socket(sessionId, mapId, mapName, messages, null);
    }

    private WebSocketSession socket(String sessionId, String mapId, String mapName,
                                    BlockingQueue<JsonNode> messages, String userId) throws Exception {
        var session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn(sessionId);
        when(session.isOpen()).thenReturn(true);
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(WorldAuthentication.MAP, new PublishedMaps.Published(1, map(mapId, mapName)));
        attributes.put(WorldAuthentication.SESSION_ID, sessionId);
        attributes.put(WorldAuthentication.ADMISSION, new JoinTickets.Admission("ticket-" + sessionId,
            userId == null ? "user-" + sessionId : userId, sessionId, "shared-space", mapId, 100, 5, 5,
            "seat-" + sessionId, false, "resume-" + sessionId));
        if (userId != null) attributes.put(WorldAuthentication.PRINCIPAL,
            new TownPrincipal(userId, "다른 맵 참가자", 0));
        when(session.getAttributes()).thenReturn(attributes);
        doAnswer(call -> {
            messages.add(json.readTree(((TextMessage) call.getArgument(0)).getPayload()));
            return null;
        }).when(session).sendMessage(any());
        return session;
    }

    private MapDefinition map(String id, String name) {
        List<MapObject> objects = id.equals("main") ? List.of(
            new MapObject("npc-near", "desk-monitor", 5, 5, 2, "down",
                new MapInteraction("NPC", "수집 안내원", "먼저 여기에서 단서를 받아가세요.", null, null, 0, 0)),
            new MapObject("npc-far", "desk-monitor", 15, 15, 2, "down",
                new MapInteraction("NPC", "멀리 있는 안내원", "가까이 와서 대화해 주세요.", null, null, 0, 0)),
            new MapObject("item-one", "desk-monitor", 5, 5, 2, "down",
                new MapInteraction("SCAVENGER_ITEM", "첫 번째 표식", "분수 옆 표식을 찾아보세요.", null, null, 0, 0)),
            new MapObject("item-two", "desk-monitor", 6, 5, 2, "down",
                new MapInteraction("SCAVENGER_ITEM", "두 번째 표식", "도서관 입구를 확인하세요.", null, null, 0, 0))) : List.of();
        List<Zone> zones = id.equals("main")
            ? List.of(new Zone("campus", "캠퍼스 광장", "PUBLIC", new Rect(0, 0, 20, 20), null))
            : List.of();
        return new MapDefinition(2, id, "test-revision", name, 20, 20, 5, 5,
            List.of(), objects, zones, List.of(), List.of(), List.of(), List.of());
    }

    private void join(WebSocketSession session, String name) throws Exception {
        send(session, Map.of("type", "join", "protocolVersion", 2, "name", name, "avatar", 0,
            "skin", "light", "clothing", "casual_white", "hair", "hair_short_black", "resumeToken", ""));
    }

    private void send(WebSocketSession session, Object message) throws Exception {
        handler.handleTextMessage(session, new TextMessage(json.writeValueAsString(message)));
    }

    private void sendUnchecked(WebSocketSession session, Object message) {
        try { send(session, message); }
        catch (Exception failure) { throw new IllegalStateException(failure); }
    }

    private Map<String, Object> engagement(String requestId, long epoch, String action, List<String> options,
                                           int optionIndex, int correctOptionIndex) {
        return engagement(requestId, epoch, action, "", options, optionIndex, correctOptionIndex);
    }

    private Map<String, Object> engagement(String requestId, long epoch, String action, String text) {
        return engagement(requestId, epoch, action, text, List.of(), 0, 0);
    }

    private Map<String, Object> engagement(String requestId, long epoch, String action, String text,
                                           List<String> options, int optionIndex, int correctOptionIndex) {
        return Map.of("type", "eventEngagement", "epoch", epoch, "requestId", requestId,
            "action", action, "questionId", "", "text", text, "pollQuestion", "색상은 무엇인가요?",
            "pollOptions", options, "optionIndex", optionIndex, "correctOptionIndex", correctOptionIndex);
    }

    private JsonNode participant(JsonNode state, String playerId) {
        for (JsonNode participant : state.path("participants"))
            if (participant.path("playerId").asText().equals(playerId)) return participant;
        return null;
    }

    private JsonNode await(BlockingQueue<JsonNode> messages, Predicate<JsonNode> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        List<JsonNode> recent = new java.util.ArrayList<>();
        while (System.nanoTime() < deadline) {
            JsonNode message = messages.poll(50, TimeUnit.MILLISECONDS);
            if (message != null) {
                if (condition.test(message)) return message;
                recent.add(message);
                if (recent.size() > 8) recent.removeFirst();
            }
        }
        throw new AssertionError("World event did not arrive; recent messages: " + recent);
    }
}
