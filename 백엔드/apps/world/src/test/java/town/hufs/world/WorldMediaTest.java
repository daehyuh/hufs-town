package town.hufs.world;

import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.*;
import org.springframework.web.socket.*;
import town.hufs.auth.PublishedMaps;
import town.hufs.domain.MediaPolicy;
import town.hufs.protocol.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Predicate;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class WorldMediaTest {
    final ObjectMapper json = new ObjectMapper();
    final BlockingQueue<JsonNode> output = new LinkedBlockingQueue<>();
    final AtomicReference<Runnable> revokeAck = new AtomicReference<>();
    final AtomicReference<PublishedMaps.Published> published = new AtomicReference<>();
    final AtomicReference<JsonNode> visiblePlayer = new AtomicReference<>();
    MediaGateway gateway; WorldHandler handler; WebSocketSession socket; String id; long epoch;

    @BeforeEach @SuppressWarnings("unchecked") void setUp() throws Exception {
        gateway = mock(MediaGateway.class); when(gateway.enabled()).thenReturn(true);
        doAnswer(call -> {
            List<MediaPolicy.Person> people = call.getArgument(0);
            var decision = (MediaPolicy.Decision)call.getArgument(1);
            ((Consumer<List<MediaGateway.Applied>>)call.getArgument(2)).accept(people.stream().filter(MediaPolicy.Person::enabled)
                .map(p -> new MediaGateway.Applied(p.id(), p.policyEpoch(), "test-worker", List.copyOf(decision.peers().get(p.id())), List.of())).toList());
            return null;
        }).when(gateway).publish(anyList(), any(), any());
        doAnswer(call -> { revokeAck.set(call.getArgument(2)); return null; }).when(gateway).revoke(anyString(), anyLong(), any());
        var auth = mock(WorldAuthentication.class); when(auth.map(anyString())).thenAnswer(call -> published.get());
        when(auth.map(anyString(),anyString())).thenAnswer(call -> published.get()); when(auth.active(anyString(),any())).thenReturn(true);
        handler = new WorldHandler(auth, gateway);
        socket = mock(WebSocketSession.class); when(socket.getId()).thenReturn(UUID.randomUUID().toString()); when(socket.isOpen()).thenReturn(true);
        when(socket.getAttributes()).thenReturn(Map.of(WorldAuthentication.MAP, new PublishedMaps.Published(1, map("first", List.of())), WorldAuthentication.PRINCIPAL, new town.hufs.auth.TownPrincipal("test-user","media-test",0), WorldAuthentication.SESSION_ID,"test-session"));
        doAnswer(call -> {
            JsonNode event = json.readTree(((TextMessage) call.getArgument(0)).getPayload());
            output.add(event);
            if (event.path("type").asText().equals("snapshot")) {
                if (event.path("full").asBoolean()) visiblePlayer.set(null);
                event.path("players").forEach(player -> visiblePlayer.set(player.deepCopy()));
                handler.handleTextMessage(socket, new TextMessage("{\"type\":\"snapshotAck\",\"tick\":"
                    + event.path("tick").asLong() + ",\"applied\":true}"));
            }
            return null;
        }).when(socket).sendMessage(any());
        handler.afterConnectionEstablished(socket);
        send(Map.of("type","join","protocolVersion",2,"name","media-test","avatar",0,"skin","light","clothing","casual_white","hair","hair_short_black","resumeToken",""));
        var welcome = await(n -> n.path("type").asText().equals("welcome")); id = welcome.path("playerId").asText(); epoch = welcome.path("epoch").asLong();
        assertThat(welcome.path("features").toString()).contains("MICROPHONE_PRESENCE");
        await(n -> n.path("type").asText().equals("mediaState") && n.path("available").asBoolean());
    }
    @AfterEach void close() { handler.shutdown(); }
    MapDefinition map(String revision, List<Rect> collisions) {
        return new MapDefinition(2,"test",revision,"test",20,20,10,10,collisions,List.of(),List.of(new Zone("meeting","회의실","PRIVATE",new Rect(10.2,1,8,18),6L)),List.of(),List.of(),List.of(),List.of());
    }
    void move() throws Exception { send(Map.of("type","move","epoch",epoch,"seq",1,"dx",1,"dy",0,"running",false)); }
    void request(long mediaEpoch) throws Exception { send(Map.of("type","mediaRequest","requestId","request-1","policyEpoch",mediaEpoch,"method","capabilities","dataJson","{}")); }

    @Test void privacyBoundaryWaitsForRevocationAndRejectsRequestsDuringTransition() throws Exception {
        move(); var switching = await(n -> n.path("type").asText().equals("mediaState") && n.path("transitioning").asBoolean());
        long nextEpoch = switching.path("policyEpoch").asLong();
        request(nextEpoch);
        assertThat(await(n -> n.path("type").asText().equals("mediaReply")).path("code").asText()).isEqualTo("MEDIA_STALE");
        verify(gateway, never()).request(anyString(),anyLong(),anyString(),anyString(),any());
        for (int i=0;i<3;i++) {
            await(n -> n.path("type").asText().equals("snapshot"));
            assertThat(visiblePlayer.get().path("x").asDouble()).isLessThan(10.2);
        }
        assertThat(revokeAck.get()).isNotNull(); revokeAck.get().run();
        var state = await(n -> n.path("type").asText().equals("mediaState") && n.path("available").asBoolean());
        assertThat(state.path("kind").asText()).isEqualTo("PRIVATE"); assertThat(state.path("policyEpoch").asLong()).isEqualTo(nextEpoch);
        request(nextEpoch - 1); assertThat(await(n -> n.path("type").asText().equals("mediaReply")).path("code").asText()).isEqualTo("MEDIA_STALE");
        request(nextEpoch); verify(gateway, timeout(2000)).request(eq(id),eq(nextEpoch),eq("capabilities"),eq("{}"),any());

        revokeAck.set(null);
        send(Map.of("type","move","epoch",epoch,"seq",2,"dx",-1,"dy",0,"running",false));
        var leaving = await(n -> n.path("type").asText().equals("mediaState") && n.path("transitioning").asBoolean());
        long publicEpoch = leaving.path("policyEpoch").asLong();
        assertThat(publicEpoch).isGreaterThan(nextEpoch);
        request(nextEpoch);
        assertThat(await(n -> n.path("type").asText().equals("mediaReply")).path("code").asText()).isEqualTo("MEDIA_STALE");
        assertThat(revokeAck.get()).isNotNull();
        revokeAck.get().run();
        var publicState = await(n -> n.path("type").asText().equals("mediaState") && n.path("available").asBoolean()
            && n.path("kind").asText().equals("PUBLIC"));
        assertThat(publicState.path("policyEpoch").asLong()).isEqualTo(publicEpoch);
        assertThat(visiblePlayer.get().path("zoneId").asText()).isNotEqualTo("meeting");
    }
    @Test void missingRevocationAcknowledgementWaitsForBoundedLeaseExpiry() throws Exception {
        move(); await(n -> n.path("type").asText().equals("mediaState") && n.path("transitioning").asBoolean());
        long started = System.nanoTime();
        var state = await(n -> n.path("type").asText().equals("mediaState") && n.path("available").asBoolean());
        assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)).isGreaterThanOrEqualTo(1900);
        assertThat(state.path("kind").asText()).isEqualTo("PRIVATE");
    }
    @Test void publicationAlsoWaitsForRevocationBeforeExposingTheNewMap() throws Exception {
        published.set(new PublishedMaps.Published(2, map("second",List.of())));
        await(n -> n.path("type").asText().equals("mediaState") && n.path("transitioning").asBoolean());
        assertThat(output.stream().noneMatch(n -> n.path("type").asText().equals("mapChanged") && n.path("map").path("revision").asText().equals("second"))).isTrue();
        while(revokeAck.get()==null)Thread.sleep(5);
        revokeAck.get().run();
        await(n -> n.path("type").asText().equals("mapChanged") && n.path("map").path("revision").asText().equals("second"));
        var state = await(n -> n.path("type").asText().equals("mediaState") && n.path("available").asBoolean());
        assertThat(state.path("domain").asText()).contains("/second/");
    }
    void send(Object value) throws Exception { handler.handleTextMessage(socket, new TextMessage(json.writeValueAsString(value))); }
    @Test void microphonePresenceIsIncludedInSnapshotsAndTurnsOffWhenMuted() throws Exception {
        send(Map.of("type", "microphoneSet", "epoch", epoch, "enabled", true));
        var enabled = await(n -> n.path("type").asText().equals("snapshot")
            && n.path("players").isArray() && n.path("players").toString().contains(id)
            && n.path("players").get(0).path("microphoneOn").asBoolean());
        assertThat(enabled.path("players").get(0).path("microphoneOn").asBoolean()).isTrue();

        send(Map.of("type", "microphoneSet", "epoch", epoch, "enabled", false));
        var muted = await(n -> n.path("type").asText().equals("snapshot")
            && n.path("players").isArray() && n.path("players").toString().contains(id)
            && !n.path("players").get(0).path("microphoneOn").asBoolean());
        assertThat(muted.path("players").get(0).path("microphoneOn").asBoolean()).isFalse();
    }
    @Test void roomSnapshotUsesCapacityConfiguredOnTheMap() throws Exception {
        var snapshot = await(n -> n.path("type").asText().equals("snapshot") && n.path("rooms").isArray() && !n.path("rooms").isEmpty());
        assertThat(snapshot.path("rooms").get(0).path("capacity").asInt()).isEqualTo(6);
    }
    @Test void eventSpeakersMustBeInsideTheConfiguredStage() {
        var stageMap = new MapDefinition(2,"space","revision","test",20,20,10,10,List.of(),List.of(),
            List.of(new Zone("stage","무대","STAGE",new Rect(2,2,4,3),null)),List.of(),List.of(),List.of(),List.of());
        assertThat(WorldHandler.eventSpeakerAllowed(stageMap,"STAGE",true)).isTrue();
        assertThat(WorldHandler.eventSpeakerAllowed(stageMap,"PUBLIC",true)).isFalse();
        assertThat(WorldHandler.eventSpeakerAllowed(stageMap,"STAGE",false)).isFalse();
        assertThat(WorldHandler.eventSpeakerAllowed(map("legacy",List.of()),"PUBLIC",true)).isTrue();
    }
    JsonNode await(Predicate<JsonNode> condition) throws Exception {
        long deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(System.nanoTime()<deadline) { var n = output.poll(50,TimeUnit.MILLISECONDS); if(n!=null&&condition.test(n))return n; }
        throw new AssertionError("World event did not arrive");
    }
}
