package town.hufs.world;

import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.annotation.DirtiesContext;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.*;
import java.util.concurrent.*;
import java.util.function.Predicate;
import static org.assertj.core.api.Assertions.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"town.auth.mode=preview", "spring.profiles.active=preview", "town.auth.preview-multimap-enabled=true", "town.allowed-origins=http://localhost:5173,http://100.87.52.42:5173"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class WorldIntegrationTest {
    @LocalServerPort int port;
    final ObjectMapper json = new ObjectMapper();
    final HttpClient client = HttpClient.newHttpClient();

    @Test void acceptsWebSocketConnectionsFromAnExplicitTailnetOrigin() throws Exception {
        var probe = connectWithOrigin("http://100.87.52.42:5173");
        try {
            probe.send(joinMessage("tailscale"));
            assertThat(probe.await(n -> n.path("type").asText().equals("welcome")).path("playerId").asText())
                .isNotBlank();
        } finally {
            probe.socket.abort();
        }
    }

    @Test void publishesLiveParticipantProfilesAcrossMapsAndRemovesDisconnectedPlayers() throws Exception {
        var campus = connect("campus-map");
        var studyRoom = connect("study-room");
        try {
            campus.send(joinMessage("캠퍼스 사람"));
            JsonNode campusWelcome = campus.await(n -> n.path("type").asText().equals("welcome"));
            String campusId = campusWelcome.path("playerId").asText();
            campus.await(n -> n.path("type").asText().equals("spaceParticipants")
                && n.path("participants").size() == 1);

            studyRoom.send(joinMessage("스터디룸 사람"));
            JsonNode studyWelcome = studyRoom.await(n -> n.path("type").asText().equals("welcome"));
            String studyId = studyWelcome.path("playerId").asText();
            JsonNode campusRoster = campus.await(n -> n.path("type").asText().equals("spaceParticipants")
                && n.path("participants").size() == 2
                && n.path("participants").findValuesAsText("playerId").contains(studyId));
            JsonNode remote = java.util.stream.StreamSupport.stream(campusRoster.path("participants").spliterator(), false)
                .filter(item -> item.path("playerId").asText().equals(studyId)).findFirst().orElseThrow();
            assertThat(remote.path("mapId").asText()).isEqualTo("study-room");
            assertThat(remote.path("name").asText()).isEqualTo("스터디룸 사람");
            assertThat(remote.has("bio")).isFalse();
            assertThat(remote.has("links")).isFalse();
            studyRoom.await(n -> n.path("type").asText().equals("spaceParticipants")
                && n.path("participants").size() == 2);

            studyRoom.send("{\"type\":\"profileUpdate\",\"epoch\":" + studyWelcome.path("epoch").asLong()
                + ",\"name\":\"이름 바뀜\",\"avatar\":1,\"skin\":\"blue\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"bio\":\"자기소개\",\"links\":[\"https://example.org/study\"]}");
            JsonNode updatedRoster = campus.await(n -> n.path("type").asText().equals("spaceParticipants")
                && n.path("participants").size() == 2
                && n.path("participants").findValuesAsText("name").contains("이름 바뀜"));
            assertThat(updatedRoster.path("revision").asLong()).isGreaterThan(campusRoster.path("revision").asLong());
            assertThat(updatedRoster.path("participants").findValuesAsText("playerId")).contains(campusId, studyId);

            campus.send("{\"type\":\"profileRequest\",\"epoch\":" + campusWelcome.path("epoch").asLong()
                + ",\"requestId\":\"remote-profile-1\",\"targetId\":\"" + studyId + "\"}");
            JsonNode details = campus.await(n -> n.path("type").asText().equals("profileDetails")
                && n.path("requestId").asText().equals("remote-profile-1"));
            assertThat(details.path("accepted").asBoolean()).isTrue();
            assertThat(details.path("playerId").asText()).isEqualTo(studyId);
            assertThat(details.path("bio").asText()).isEqualTo("자기소개");
            assertThat(details.path("links")).hasSize(1);
            assertThat(details.path("links").get(0).asText()).isEqualTo("https://example.org/study");

            studyRoom.socket.sendClose(1000, "leave test").join();
            JsonNode remaining = campus.await(n -> n.path("type").asText().equals("spaceParticipants")
                && n.path("participants").size() == 1);
            assertThat(remaining.path("participants").get(0).path("playerId").asText()).isEqualTo(campusId);
        } finally {
            campus.socket.abort();
            studyRoom.socket.abort();
        }
    }

    @Test void resumesIdentityWithANewEpochAndStopsMovementWithoutFreshInput() throws Exception {
        var first = connect();
        try {
            first.send("{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"resume-test\",\"avatar\":0,\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\"\"}");
            JsonNode welcome = first.await(n -> n.path("type").asText().equals("welcome"));
            String id = welcome.path("playerId").asText();
            long epoch = welcome.path("epoch").asLong();
            first.send("{\"type\":\"move\",\"epoch\":"+epoch+",\"seq\":0,\"dx\":1,\"dy\":0,\"running\":true}");
            JsonNode moved = first.await(n -> n.path("type").asText().equals("snapshot")
                && first.visiblePlayers.values().stream().anyMatch(player -> player.path("x").asDouble() > 20.2));
            JsonNode stopped = first.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("tick").asLong() > moved.path("tick").asLong()+10
                && first.visiblePlayers.values().stream().noneMatch(player -> player.path("moving").asBoolean()));
            assertThat(first.visiblePlayers.values()).allMatch(player -> !player.path("moving").asBoolean());
            double x = first.visiblePlayers.get(id).path("x").asDouble();
            first.socket.sendClose(1000,"test reconnect").join();
            first.closed.get(10, TimeUnit.SECONDS);
            // A new socket can be accepted before the next room tick; allow the ordinary detach tick to pass.
            Thread.sleep(100);
            var resumed = connect();
            try {
                resumed.send("{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"resume-test\",\"avatar\":0,\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\""+welcome.path("resumeToken").asText()+"\"}");
                JsonNode again = resumed.await(n -> n.path("type").asText().equals("welcome"));
                assertThat(again.path("playerId").asText()).isEqualTo(id);
                assertThat(again.path("epoch").asLong()).isEqualTo(epoch+1);
                resumed.await(n -> n.path("type").asText().equals("snapshot"));
                assertThat(resumed.visiblePlayers).hasSize(1);
                assertThat(resumed.visiblePlayers.get(id).path("x").asDouble()).isEqualTo(x);
            } finally { resumed.socket.abort(); }
        } finally { first.socket.abort(); }
    }
    @Test void keepsPrivateRoomChatInsideItsZoneAndRejectsPublicRoomMessages() throws Exception {
        var insideA = connect();
        var insideB = connect();
        var outside = connect();
        var probes = java.util.List.of(insideA, insideB, outside);
        try {
            insideA.send(joinMessage("room-a"));
            insideB.send(joinMessage("room-b"));
            outside.send(joinMessage("public"));
            JsonNode map = insideA.await(n -> n.path("type").asText().equals("mapChanged")).path("map");
            JsonNode welcomeA = insideA.await(n -> n.path("type").asText().equals("welcome"));
            JsonNode welcomeB = insideB.await(n -> n.path("type").asText().equals("welcome"));
            JsonNode welcomeOutside = outside.await(n -> n.path("type").asText().equals("welcome"));
            String idA = welcomeA.path("playerId").asText();
            String idB = welcomeB.path("playerId").asText();
            String idOutside = welcomeOutside.path("playerId").asText();
            JsonNode room = java.util.stream.StreamSupport.stream(map.path("zones").spliterator(), false)
                .filter(zone -> zone.path("kind").asText().equals("PRIVATE")).findFirst().orElse(null);
            assertThat(room).as("preview fixture needs a private meeting zone").isNotNull();
            double targetX = room.path("bounds").path("x").asDouble() + room.path("bounds").path("width").asDouble() / 2;
            double targetY = room.path("bounds").path("y").asDouble() + room.path("bounds").path("height").asDouble() / 2;
            String roomId = room.path("id").asText();
            moveTo(insideA, idA, welcomeA.path("epoch").asLong(), roomId, targetX, targetY);
            moveTo(insideB, idB, welcomeB.path("epoch").asLong(), roomId, targetX, targetY);
            assertThat(insideA.visiblePlayers.get(idA).path("zoneId").asText()).isEqualTo(roomId);
            assertThat(insideB.visiblePlayers.get(idB).path("zoneId").asText()).isEqualTo(roomId);
            assertThat(insideA.visiblePlayers.get(idA).path("x").asDouble()).isBetween(
                room.path("bounds").path("x").asDouble(), room.path("bounds").path("x").asDouble() + room.path("bounds").path("width").asDouble());
            assertThat(insideB.visiblePlayers.get(idB).path("y").asDouble()).isBetween(
                room.path("bounds").path("y").asDouble(), room.path("bounds").path("y").asDouble() + room.path("bounds").path("height").asDouble());

            String privateMessageId = "private-room-message";
            insideA.send(chatMessage(welcomeA.path("epoch").asLong(), "room", privateMessageId, "회의실 안에서만 보여요"));
            insideA.await(n -> n.path("type").asText().equals("chatEvent") && n.path("clientMessageId").asText().equals(privateMessageId));
            insideB.await(n -> n.path("type").asText().equals("chatEvent") && n.path("clientMessageId").asText().equals(privateMessageId));
            Thread.sleep(300);
            assertThat(outside.messages.stream().noneMatch(n -> n.path("type").asText().equals("chatEvent")
                && n.path("clientMessageId").asText().equals(privateMessageId))).isTrue();

            String publicMessageId = "public-space-message";
            outside.send(chatMessage(welcomeOutside.path("epoch").asLong(), "space", publicMessageId, "공개 공간 메시지"));
            outside.await(n -> n.path("type").asText().equals("chatAck") && n.path("clientMessageId").asText().equals(publicMessageId));
            Thread.sleep(300);
            for (var privatePeer : java.util.List.of(insideA, insideB))
                assertThat(privatePeer.messages.stream().noneMatch(n -> n.path("type").asText().equals("chatEvent")
                    && n.path("clientMessageId").asText().equals(publicMessageId))).isTrue();

            String invalidRoomMessageId = "public-room-message";
            outside.send(chatMessage(welcomeOutside.path("epoch").asLong(), "room", invalidRoomMessageId, "공개 공간에서는 회의실 채팅 불가"));
            JsonNode rejected = outside.await(n -> n.path("type").asText().equals("chatAck")
                && n.path("clientMessageId").asText().equals(invalidRoomMessageId));
            assertThat(rejected.path("accepted").asBoolean()).isFalse();
            assertThat(rejected.path("code").asText()).isEqualTo("CHAT_NO_ROOM");

            String guestNoteRequest = "room-note-preview-guest";
            insideA.send(roomNoteRequest(welcomeA.path("epoch").asLong(), guestNoteRequest));
            JsonNode guestNoteDenied = insideA.await(n -> n.path("type").asText().equals("roomNoteAck")
                && n.path("requestId").asText().equals(guestNoteRequest));
            assertThat(guestNoteDenied.path("accepted").asBoolean()).isFalse();
            assertThat(guestNoteDenied.path("code").asText()).isEqualTo("ROOM_NOTE_FORBIDDEN");

            String publicNoteRequest = "room-note-preview-public";
            outside.send(roomNoteRequest(welcomeOutside.path("epoch").asLong(), publicNoteRequest));
            JsonNode publicNoteDenied = outside.await(n -> n.path("type").asText().equals("roomNoteAck")
                && n.path("requestId").asText().equals(publicNoteRequest));
            assertThat(publicNoteDenied.path("accepted").asBoolean()).isFalse();
            assertThat(publicNoteDenied.path("code").asText()).isEqualTo("ROOM_NOTE_FORBIDDEN");
            Thread.sleep(300);
            for (var probe : probes)
                assertThat(probe.messages.stream().noneMatch(n -> n.path("type").asText().equals("roomNoteState"))).isTrue();
        } finally {
            for (var probe : probes) probe.socket.abort();
        }
    }

    @Test void joinRequestsRespectPrivateRoomsAndTargetCanDeclineWithoutMovingRequester() throws Exception {
        var requester = connect();
        var target = connect();
        try {
            requester.send(joinMessage("join-requester"));
            target.send(joinMessage("join-target"));
            JsonNode map = target.await(n -> n.path("type").asText().equals("mapChanged")).path("map");
            JsonNode requesterWelcome = requester.await(n -> n.path("type").asText().equals("welcome"));
            JsonNode targetWelcome = target.await(n -> n.path("type").asText().equals("welcome"));
            String requesterId = requesterWelcome.path("playerId").asText();
            String targetId = targetWelcome.path("playerId").asText();
            long requesterEpoch = requesterWelcome.path("epoch").asLong();
            long targetEpoch = targetWelcome.path("epoch").asLong();

            JsonNode privateRoom = java.util.stream.StreamSupport.stream(map.path("zones").spliterator(), false)
                .filter(zone -> zone.path("kind").asText().equals("PRIVATE")).findFirst().orElseThrow();
            double roomX = privateRoom.path("bounds").path("x").asDouble()
                + privateRoom.path("bounds").path("width").asDouble() / 2;
            double roomY = privateRoom.path("bounds").path("y").asDouble()
                + privateRoom.path("bounds").path("height").asDouble() / 2;
            String roomId = privateRoom.path("id").asText();
            moveTo(target, targetId, targetEpoch, roomId, roomX, roomY);
            assertThat(target.visiblePlayers.get(targetId).path("zoneId").asText()).isEqualTo(roomId);
            assertThat(requester.visiblePlayers.get(requesterId).path("zoneId").asText()).isNotEqualTo(roomId);

            requester.send("{\"type\":\"joinRequest\",\"requestId\":\"private-room-join-denied\",\"epoch\":"
                + requesterEpoch + ",\"targetId\":\"" + targetId + "\"}");
            JsonNode privateDenied = requester.await(n -> n.path("type").asText().equals("joinRequestAck")
                && n.path("requestId").asText().equals("private-room-join-denied"));
            assertThat(privateDenied.path("accepted").asBoolean()).isFalse();
            assertThat(privateDenied.path("code").asText()).isEqualTo("JOIN_PRIVATE");
            assertThat(target.messages.stream().noneMatch(n -> n.path("type").asText().equals("joinRequestEvent")
                && n.path("requestId").asText().equals("private-room-join-denied"))).isTrue();

            int requesterStopSeq = moveTo(requester, requesterId, requesterEpoch, roomId, roomX, roomY);
            requester.send("{\"type\":\"move\",\"epoch\":" + requesterEpoch + ",\"seq\":"
                + requesterStopSeq + ",\"dx\":0,\"dy\":0,\"running\":false}");
            requester.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("inputAckSeq").asInt(-1) >= requesterStopSeq
                && requester.visiblePlayers.containsKey(requesterId)
                && !requester.visiblePlayers.get(requesterId).path("moving").asBoolean());
            JsonNode requesterBeforeDecline = requester.visiblePlayers.get(requesterId).deepCopy();
            requester.send("{\"type\":\"joinRequest\",\"requestId\":\"private-room-join-declined\",\"epoch\":"
                + requesterEpoch + ",\"targetId\":\"" + targetId + "\"}");
            JsonNode acceptedForReview = requester.await(n -> n.path("type").asText().equals("joinRequestAck")
                && n.path("requestId").asText().equals("private-room-join-declined"));
            assertThat(acceptedForReview.path("accepted").asBoolean()).isTrue();
            target.await(n -> n.path("type").asText().equals("joinRequestEvent")
                && n.path("requestId").asText().equals("private-room-join-declined"));

            target.send("{\"type\":\"joinResponse\",\"requestId\":\"private-room-join-declined\",\"epoch\":"
                + targetEpoch + ",\"accepted\":false}");
            JsonNode declined = requester.await(n -> n.path("type").asText().equals("joinResult")
                && n.path("requestId").asText().equals("private-room-join-declined"));
            assertThat(declined.path("accepted").asBoolean()).isFalse();
            assertThat(declined.path("moved").asBoolean()).isFalse();
            assertThat(declined.path("code").asText()).isEqualTo("JOIN_DECLINED");
            JsonNode requesterAfterDecline = requester.visiblePlayers.get(requesterId);
            assertThat(requesterAfterDecline.path("x").asDouble()).isEqualTo(requesterBeforeDecline.path("x").asDouble());
            assertThat(requesterAfterDecline.path("y").asDouble()).isEqualTo(requesterBeforeDecline.path("y").asDouble());
        } finally {
            requester.socket.abort();
            target.socket.abort();
        }
    }

    @Test void rateLimitsWorldChatAndAcknowledgesEachAcceptedOrRejectedMessage() throws Exception {
        var sender = connect();
        try {
            sender.send(joinMessage("chat-rate-limit"));
            JsonNode welcome = sender.await(node -> node.path("type").asText().equals("welcome"));
            long epoch = welcome.path("epoch").asLong();
            for (int index = 1; index <= 9; index++) {
                String id = "chat-rate-%02d".formatted(index);
                sender.send(chatMessage(epoch, "space", id, "요청 " + index));
                JsonNode ack = sender.await(node -> node.path("type").asText().equals("chatAck")
                    && node.path("clientMessageId").asText().equals(id));
                if (index <= 8) {
                    assertThat(ack.path("accepted").asBoolean()).as("message %d", index).isTrue();
                } else {
                    assertThat(ack.path("accepted").asBoolean()).isFalse();
                    assertThat(ack.path("code").asText()).isEqualTo("CHAT_RATE_LIMIT");
                }
            }
            assertThat(sender.messages.stream().noneMatch(node -> node.path("type").asText().equals("chatEvent")
                && node.path("clientMessageId").asText().equals("chat-rate-09"))).isTrue();
        } finally { sender.socket.abort(); }
    }

    @Test void pokesAreTargetOnlyRespectOptOutAndAllowRepeatedPokes() throws Exception {
        var sender = connect();
        var target = connect();
        var bystander = connect();
        var probes = java.util.List.of(sender, target, bystander);
        try {
            sender.send(joinMessage("poke-sender"));
            target.send(joinMessage("poke-target"));
            bystander.send(joinMessage("poke-bystander"));
            var senderWelcome = sender.await(node -> node.path("type").asText().equals("welcome"));
            var targetWelcome = target.await(node -> node.path("type").asText().equals("welcome"));
            bystander.await(node -> node.path("type").asText().equals("welcome"));
            long senderEpoch = senderWelcome.path("epoch").asLong();
            long targetEpoch = targetWelcome.path("epoch").asLong();
            String targetId = targetWelcome.path("playerId").asText();

            target.send("{\"type\":\"pokePreference\",\"epoch\":" + targetEpoch + ",\"enabled\":false}");
            var optedOut = target.await(node -> node.path("type").asText().equals("pokePreferenceState")
                && !node.path("enabled").asBoolean());
            assertThat(optedOut.path("enabled").asBoolean()).isFalse();

            sender.send(pokeMessage(senderEpoch, "poke-opted-out", targetId));
            var refused = sender.await(node -> node.path("type").asText().equals("pokeAck")
                && node.path("requestId").asText().equals("poke-opted-out"));
            assertThat(refused.path("accepted").asBoolean()).isFalse();
            assertThat(refused.path("code").asText()).isEqualTo("POKE_DISABLED");

            target.send("{\"type\":\"pokePreference\",\"epoch\":" + targetEpoch + ",\"enabled\":true}");
            target.await(node -> node.path("type").asText().equals("pokePreferenceState")
                && node.path("enabled").asBoolean());

            sender.send(pokeMessage(senderEpoch, "poke-delivered", targetId));
            var accepted = sender.await(node -> node.path("type").asText().equals("pokeAck")
                && node.path("requestId").asText().equals("poke-delivered"));
            assertThat(accepted.path("accepted").asBoolean()).isTrue();
            var event = target.await(node -> node.path("type").asText().equals("pokeEvent")
                && node.path("requestId").asText().equals("poke-delivered"));
            assertThat(event.path("senderName").asText()).isEqualTo("poke-sender");
            Thread.sleep(200);
            assertThat(sender.messages.stream().noneMatch(node -> node.path("type").asText().equals("pokeEvent")
                && node.path("requestId").asText().equals("poke-delivered"))).isTrue();
            assertThat(bystander.messages.stream().noneMatch(node -> node.path("type").asText().equals("pokeEvent")
                && node.path("requestId").asText().equals("poke-delivered"))).isTrue();

            sender.send(pokeMessage(senderEpoch, "poke-after-delivery", targetId));
            var afterDelivery = sender.await(node -> node.path("type").asText().equals("pokeAck")
                && node.path("requestId").asText().equals("poke-after-delivery"));
            assertThat(afterDelivery.path("accepted").asBoolean()).isTrue();
            var repeatedEvent = target.await(node -> node.path("type").asText().equals("pokeEvent")
                && node.path("requestId").asText().equals("poke-after-delivery"));
            assertThat(repeatedEvent.path("targetId").asText()).isEqualTo(targetId);
        } finally {
            for (var probe : probes) probe.socket.abort();
        }
    }

    @Test void enforcesPrivateRoomLockKnockCapacityAndHostRoleTransitions() throws Exception {
        var host = connect();
        var guestA = connect();
        var guestB = connect();
        var outsider = connect();
        var probes = java.util.List.of(host, guestA, guestB, outsider);
        try {
            host.send(joinMessage("room-host"));
            guestA.send(joinMessage("room-guest-a"));
            guestB.send(joinMessage("room-guest-b"));
            outsider.send(joinMessage("room-outsider"));
            JsonNode map = host.await(n -> n.path("type").asText().equals("mapChanged")).path("map");
            JsonNode hostWelcome = host.await(n -> n.path("type").asText().equals("welcome"));
            JsonNode guestAWelcome = guestA.await(n -> n.path("type").asText().equals("welcome"));
            JsonNode guestBWelcome = guestB.await(n -> n.path("type").asText().equals("welcome"));
            JsonNode outsiderWelcome = outsider.await(n -> n.path("type").asText().equals("welcome"));
            String hostId = hostWelcome.path("playerId").asText();
            String guestAId = guestAWelcome.path("playerId").asText();
            String guestBId = guestBWelcome.path("playerId").asText();
            String outsiderId = outsiderWelcome.path("playerId").asText();
            long hostEpoch = hostWelcome.path("epoch").asLong();
            long guestAEpoch = guestAWelcome.path("epoch").asLong();
            long guestBEpoch = guestBWelcome.path("epoch").asLong();
            long outsiderEpoch = outsiderWelcome.path("epoch").asLong();
            JsonNode room = java.util.stream.StreamSupport.stream(map.path("zones").spliterator(), false)
                .filter(zone -> zone.path("kind").asText().equals("PRIVATE")).findFirst().orElseThrow();
            String roomId = room.path("id").asText();
            double targetX = room.path("bounds").path("x").asDouble() + room.path("bounds").path("width").asDouble() / 2;
            double targetY = room.path("bounds").path("y").asDouble() + room.path("bounds").path("height").asDouble() / 2;

            int hostSeq = moveTo(host, hostId, hostEpoch, roomId, targetX, targetY);
            JsonNode initialRoom = host.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("rooms").isArray() && !n.path("rooms").isEmpty()
                && n.path("rooms").get(0).path("hostPlayerId").asText().equals(hostId));
            assertThat(initialRoom.path("rooms").get(0).path("occupants").asInt()).isEqualTo(1);

            var nonHostAction = roomAction(outsiderEpoch, roomId, "outsider-lock", "LOCK", 3, "");
            outsider.send(nonHostAction);
            assertThat(outsider.await(n -> n.path("type").asText().equals("roomActionAck")
                && n.path("requestId").asText().equals("outsider-lock")).path("code").asText()).isEqualTo("ROOM_FORBIDDEN");

            host.send(roomAction(hostEpoch, roomId, "capacity-three", "SET_CAPACITY", 3, ""));
            assertThat(host.await(n -> n.path("type").asText().equals("roomActionAck")
                && n.path("requestId").asText().equals("capacity-three")).path("accepted").asBoolean()).isTrue();
            host.send(roomAction(hostEpoch, roomId, "lock-room", "LOCK", 3, ""));
            assertThat(host.await(n -> n.path("type").asText().equals("roomActionAck")
                && n.path("requestId").asText().equals("lock-room")).path("locked").asBoolean()).isTrue();

            int guestASeq = moveUntilRoomResult(guestA, guestAId, guestAEpoch, roomId, targetX, targetY, "ROOM_KNOCKED");
            JsonNode knockA = host.await(n -> n.path("type").asText().equals("roomKnockEvent")
                && n.path("playerId").asText().equals(guestAId));
            JsonNode hostRoomWithKnock = host.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("rooms").isArray() && !n.path("rooms").isEmpty()
                && n.path("rooms").get(0).path("pendingKnocks").size() == 1);
            JsonNode guestRoomWithoutKnock = guestA.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("tick").asLong() > hostRoomWithKnock.path("tick").asLong()
                && n.path("rooms").isArray() && !n.path("rooms").isEmpty());
            assertThat(guestRoomWithoutKnock.path("rooms").get(0).path("pendingKnocks")).isEmpty();
            assertThat(guestA.visiblePlayers.get(guestAId).path("zoneId").asText()).isNotEqualTo(roomId);
            host.send(roomKnockResponse(hostEpoch, roomId, knockA.path("knockId").asText(), "approve-a", true));
            assertThat(guestA.await(n -> n.path("type").asText().equals("roomKnockResult")
                && n.path("requestId").asText().equals(knockA.path("knockId").asText())).path("code").asText()).isEqualTo("ROOM_APPROVED");
            moveTo(guestA, guestAId, guestAEpoch, roomId, targetX, targetY, guestASeq);

            int guestBSeq = moveUntilRoomResult(guestB, guestBId, guestBEpoch, roomId, targetX, targetY, "ROOM_KNOCKED");
            JsonNode knockB = host.await(n -> n.path("type").asText().equals("roomKnockEvent")
                && n.path("playerId").asText().equals(guestBId));
            host.send(roomKnockResponse(hostEpoch, roomId, knockB.path("knockId").asText(), "approve-b", true));
            assertThat(guestB.await(n -> n.path("type").asText().equals("roomKnockResult")
                && n.path("requestId").asText().equals(knockB.path("knockId").asText())).path("code").asText()).isEqualTo("ROOM_APPROVED");
            moveTo(guestB, guestBId, guestBEpoch, roomId, targetX, targetY, guestBSeq);

            JsonNode fullRoom = host.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("rooms").isArray() && !n.path("rooms").isEmpty()
                && n.path("rooms").get(0).path("occupants").asInt() == 3);
            assertThat(fullRoom.path("rooms").get(0).path("hostPlayerId").asText()).isEqualTo(hostId);
            host.send(roomAction(hostEpoch, roomId, "capacity-below-use", "SET_CAPACITY", 2, ""));
            JsonNode refusedCapacity = host.await(n -> n.path("type").asText().equals("roomActionAck")
                && n.path("requestId").asText().equals("capacity-below-use"));
            assertThat(refusedCapacity.path("accepted").asBoolean()).isFalse();
            assertThat(refusedCapacity.path("code").asText()).isEqualTo("ROOM_CAPACITY_IN_USE");

            host.send(roomAction(hostEpoch, roomId, "unlock-room", "UNLOCK", 3, ""));
            assertThat(host.await(n -> n.path("type").asText().equals("roomActionAck")
                && n.path("requestId").asText().equals("unlock-room")).path("locked").asBoolean()).isFalse();
            moveUntilRoomResult(outsider, outsiderId, outsiderEpoch, roomId, targetX, targetY, "ROOM_FULL");
            assertThat(outsider.visiblePlayers.get(outsiderId).path("zoneId").asText()).isNotEqualTo(roomId);

            host.socket.abort();
            JsonNode handedOff = guestA.await(n -> n.path("type").asText().equals("snapshot")
                && n.path("rooms").isArray() && !n.path("rooms").isEmpty()
                && n.path("rooms").get(0).path("hostPlayerId").asText().equals(guestAId));
            assertThat(handedOff.path("rooms").get(0).path("occupants").asInt()).isGreaterThanOrEqualTo(2);
            guestB.send(roomAction(guestBEpoch, roomId, "former-guest-lock", "LOCK", 3, ""));
            assertThat(guestB.await(n -> n.path("type").asText().equals("roomActionAck")
                && n.path("requestId").asText().equals("former-guest-lock")).path("code").asText()).isEqualTo("ROOM_FORBIDDEN");
            guestA.send(roomAction(guestAEpoch, roomId, "successor-lock", "LOCK", 3, ""));
            assertThat(guestA.await(n -> n.path("type").asText().equals("roomActionAck")
                && n.path("requestId").asText().equals("successor-lock")).path("accepted").asBoolean()).isTrue();
        } finally {
            for (var probe : probes) if (probe.socket != null) probe.socket.abort();
        }
    }

    @Test void admitsOneHundredConcurrentPlayersAndRejectsTheNextSocket(org.junit.jupiter.api.TestReporter reporter) throws Exception {
        int capacity = 100;
        var probes = new CopyOnWriteArrayList<Probe>();
        var pool = Executors.newFixedThreadPool(32);
        try {
            long processCpuAtStart = processCpuTime();
            long connectStarted = System.nanoTime();
            var connects = new java.util.ArrayList<Future<Probe>>(capacity);
            for (int i = 0; i < capacity; i++) connects.add(pool.submit(() -> connect()));
            for (var future : connects) probes.add(future.get(15, TimeUnit.SECONDS));
            long connectedAt = System.nanoTime();

            long joinStarted = System.nanoTime();
            var joins = new java.util.ArrayList<Future<?>>(capacity);
            for (int i = 0; i < capacity; i++) {
                int player = i;
                joins.add(pool.submit(() -> probes.get(player).send(joinMessage("load-%03d".formatted(player)))));
            }
            for (var join : joins) join.get(30, TimeUnit.SECONDS);
            try {
                CompletableFuture.allOf(probes.stream().map(probe -> probe.welcome).toArray(CompletableFuture[]::new))
                    .get(30, TimeUnit.SECONDS);
            } catch (TimeoutException timeout) {
                long welcomed = probes.stream().filter(probe -> probe.welcome.isDone() && !probe.welcome.isCompletedExceptionally()).count();
                var errors = probes.stream().flatMap(probe -> probe.errors.stream()).toList();
                throw new AssertionError("Only " + welcomed + "/" + capacity + " sockets welcomed; world errors=" + errors, timeout);
            }
            try {
                CompletableFuture.allOf(probes.stream().map(probe -> probe.populationReady).toArray(CompletableFuture[]::new))
                    .get(30, TimeUnit.SECONDS);
            } catch (TimeoutException timeout) {
                var counts = probes.stream().collect(java.util.stream.Collectors.groupingBy(
                    probe -> probe.visiblePlayerIds.size(), java.util.stream.Collectors.counting()));
                long closed = probes.stream().filter(probe -> probe.closed.isDone()).count();
                var errors = probes.stream().flatMap(probe -> probe.errors.stream()).toList();
                throw new AssertionError("100-player snapshot convergence failed; player-count distribution=" + counts
                    + "; closed=" + closed + "; errors=" + errors, timeout);
            }
            long convergedAt = System.nanoTime();
            for (var probe : probes) assertThat(probe.visiblePlayerIds).hasSize(capacity);

            JsonNode playerMetric = metric("hufs.world.players.active");
            JsonNode connectionMetric = metric("hufs.world.connections.active");
            JsonNode tickMetric = metric("hufs.world.tick.duration");
            JsonNode overrunMetric = metric("hufs.world.tick.overruns");
            JsonNode queueMetric = metric("hufs.world.command.queue.size");
            JsonNode queueCapacityMetric = metric("hufs.world.command.queue.capacity");
            assertThat(measurement(playerMetric, "VALUE")).isEqualTo(capacity);
            assertThat(measurement(connectionMetric, "VALUE")).isEqualTo(capacity);
            long processCpuNanos = processCpuTime() - processCpuAtStart;
            long elapsedNanos = convergedAt - connectStarted;
            double processCpuPercent = processCpuNanos < 0 ? -1 : processCpuNanos * 100.0 / elapsedNanos;
            long heapUsedBytes = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();

            double mapPrepareBeforeOverflow = measurement(
                metric("hufs.world.join.phase.duration?tag=phase%3Amap_prepare"), "COUNT");
            double capacityRejectBeforeOverflow = measurement(
                metric("hufs.world.join.phase.duration?tag=phase%3Acapacity_reject"), "COUNT");
            var overflow = connect();
            probes.add(overflow);
            overflow.send(joinMessage("overflow"));
            assertThat(overflow.await(node -> node.path("code").asText().equals("FULL")).path("type").asText()).isEqualTo("error");
            assertThat(measurement(metric("hufs.world.join.phase.duration?tag=phase%3Amap_prepare"), "COUNT"))
                .as("a guaranteed full rejection skips map preparation")
                .isEqualTo(mapPrepareBeforeOverflow);
            assertThat(measurement(metric("hufs.world.join.phase.duration?tag=phase%3Acapacity_reject"), "COUNT"))
                .as("a guaranteed full rejection is measured on its fast path")
                .isEqualTo(capacityRejectBeforeOverflow + 1);
            overflow.socket.abort();

            probes.get(0).socket.abort();
            long disconnectDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < disconnectDeadline
                && measurement(metric("hufs.world.connections.active"), "VALUE") != capacity - 1) Thread.sleep(50);
            assertThat(measurement(metric("hufs.world.connections.active"), "VALUE")).isEqualTo(capacity - 1);
            assertThat(measurement(metric("hufs.world.players.active"), "VALUE")).isEqualTo(capacity);

            var reconnectDuringGrace = connect();
            probes.add(reconnectDuringGrace);
            reconnectDuringGrace.send(joinMessage("grace-capacity"));
            assertThat(reconnectDuringGrace.await(node -> node.path("code").asText().equals("FULL")).path("type").asText())
                .isEqualTo("error");
            reconnectDuringGrace.socket.abort();
            long reconnectCloseDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < reconnectCloseDeadline
                && measurement(metric("hufs.world.connections.active"), "VALUE") != capacity - 1) Thread.sleep(50);
            var resumeDuringGrace = connect();
            probes.add(resumeDuringGrace);
            String resumeToken = probes.get(0).welcome.get(10, TimeUnit.SECONDS).path("resumeToken").asText();
            resumeDuringGrace.send(joinMessage("resume-at-capacity", resumeToken));
            JsonNode resumed = resumeDuringGrace.await(node -> node.path("type").asText().equals("welcome"));
            assertThat(resumed.path("playerId").asText()).isEqualTo(probes.get(0).welcome.join().path("playerId").asText());
            assertThat(measurement(metric("hufs.world.players.active"), "VALUE")).isEqualTo(capacity);
            assertThat(measurement(metric("hufs.world.connections.active"), "VALUE")).isEqualTo(capacity);
            resumeDuringGrace.socket.abort();
            long resumeCloseDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < resumeCloseDeadline
                && measurement(metric("hufs.world.connections.active"), "VALUE") != capacity - 1) Thread.sleep(50);
            assertThat(measurement(metric("hufs.world.connections.active"), "VALUE")).isEqualTo(capacity - 1);
            assertThat(measurement(metric("hufs.world.players.active"), "VALUE")).isEqualTo(capacity);
            Thread.sleep(15_500);

            var afterGrace = connect();
            probes.add(afterGrace);
            afterGrace.send(joinMessage("after-grace-capacity"));
            assertThat(afterGrace.welcome.get(10, TimeUnit.SECONDS).path("type").asText()).isEqualTo("welcome");
            String result = "accepted=100; all 100 clients observed the full player set; 101st=FULL; connectMs="
                + TimeUnit.NANOSECONDS.toMillis(connectedAt - connectStarted) + "; joinAndStateMs="
                + TimeUnit.NANOSECONDS.toMillis(convergedAt - joinStarted)
                + "; players=" + measurement(playerMetric, "VALUE")
                + "; connections=" + measurement(connectionMetric, "VALUE")
                + "; tickMeanMs=" + measurement(tickMetric, "TOTAL_TIME") * 1000.0 / measurement(tickMetric, "COUNT")
                + "; tickMaxMs=" + measurement(tickMetric, "max") * 1000.0
                + "; tickOverruns=" + measurement(overrunMetric, "COUNT")
                + "; queueSize=" + measurement(queueMetric, "VALUE")
                + "; queueCapacity=" + measurement(queueCapacityMetric, "VALUE")
                + "; heapUsedMiB=" + heapUsedBytes / (1024.0 * 1024.0)
                + "; testJvmCpuPercent=" + processCpuPercent;
            Path resultPath = Path.of(System.getProperty("hufs.projectRoot"), "..", ".build", "backend", "world-load", "latest.txt").normalize();
            Files.createDirectories(resultPath.getParent());
            Files.writeString(resultPath, result, StandardCharsets.UTF_8);
            reporter.publishEntry("world-100-socket-smoke", result);
            System.out.println("WORLD_LOAD_RESULT " + result);
        } finally {
            for (var probe : probes) if (probe.socket != null) probe.socket.abort();
            pool.shutdownNow();
            pool.awaitTermination(5, TimeUnit.SECONDS);
            Thread.sleep(300);
        }
    }
    private String joinMessage(String name) {
        return joinMessage(name, "");
    }
    private String joinMessage(String name, String resumeToken) {
        return "{\"type\":\"join\",\"protocolVersion\":2,\"name\":\"" + name
            + "\",\"avatar\":0,\"skin\":\"light\",\"clothing\":\"casual_white\",\"hair\":\"hair_short_black\",\"resumeToken\":\""
            + resumeToken + "\"}";
    }
    private String chatMessage(long epoch, String channel, String clientMessageId, String message) {
        return "{\"type\":\"chatSend\",\"clientMessageId\":\"" + clientMessageId + "\",\"epoch\":" + epoch
            + ",\"channel\":\"" + channel + "\",\"conversationId\":\"\",\"text\":\"" + message + "\"}";
    }
    private String roomNoteRequest(long epoch, String requestId) {
        return "{\"type\":\"roomNoteRequest\",\"requestId\":\"" + requestId + "\",\"epoch\":" + epoch
            + ",\"action\":\"LOAD\",\"baseRevision\":0,\"body\":\"\"}";
    }
    private String pokeMessage(long epoch, String requestId, String targetId) {
        return "{\"type\":\"poke\",\"requestId\":\"" + requestId + "\",\"epoch\":" + epoch
            + ",\"targetId\":\"" + targetId + "\"}";
    }
    private String roomAction(long epoch, String zoneId, String requestId, String action, int capacity, String targetPlayerId) {
        return "{\"type\":\"roomAction\",\"requestId\":\"" + requestId + "\",\"epoch\":" + epoch
            + ",\"zoneId\":\"" + zoneId + "\",\"action\":\"" + action + "\",\"capacity\":" + capacity
            + ",\"targetPlayerId\":\"" + targetPlayerId + "\"}";
    }
    private String roomKnockResponse(long epoch, String zoneId, String knockId, String requestId, boolean accepted) {
        return "{\"type\":\"roomKnockResponse\",\"requestId\":\"" + requestId + "\",\"epoch\":" + epoch
            + ",\"zoneId\":\"" + zoneId + "\",\"knockId\":\"" + knockId + "\",\"accepted\":" + accepted + "}";
    }
    private int moveTo(Probe probe, String playerId, long epoch, String targetZoneId, double targetX, double targetY) throws Exception {
        return moveTo(probe, playerId, epoch, targetZoneId, targetX, targetY, 0);
    }
    private int moveTo(Probe probe, String playerId, long epoch, String targetZoneId, double targetX, double targetY, int firstSeq) throws Exception {
        for (int seq = firstSeq; seq < firstSeq + 300; seq++) {
            JsonNode player = probe.visiblePlayers.get(playerId);
            if (player == null) { Thread.sleep(50); continue; }
            if (targetZoneId.equals(player.path("zoneId").asText())) {
                probe.send("{\"type\":\"move\",\"epoch\":" + epoch + ",\"seq\":" + seq + ",\"dx\":0,\"dy\":0,\"running\":false}");
                return seq + 1;
            }
            double dx = targetX - player.path("x").asDouble(), dy = targetY - player.path("y").asDouble();
            if (Math.hypot(dx, dy) < 0.45) {
                probe.send("{\"type\":\"move\",\"epoch\":" + epoch + ",\"seq\":" + seq + ",\"dx\":0,\"dy\":0,\"running\":false}");
                return seq + 1;
            }
            int stepX = Math.abs(dx) < 0.12 ? 0 : dx > 0 ? 1 : -1;
            int stepY = Math.abs(dy) < 0.12 ? 0 : dy > 0 ? 1 : -1;
            probe.send("{\"type\":\"move\",\"epoch\":" + epoch + ",\"seq\":" + seq + ",\"dx\":" + stepX
                + ",\"dy\":" + stepY + ",\"running\":true}");
            Thread.sleep(75);
        }
        JsonNode current = probe.visiblePlayers.get(playerId);
        throw new AssertionError("Player could not reach the private room: " + current);
    }
    private int moveUntilRoomResult(Probe probe, String playerId, long epoch, String targetZoneId,
                                    double targetX, double targetY, String expectedCode) throws Exception {
        int firstSeq = 0;
        for (int seq = firstSeq; seq < firstSeq + 300; seq++) {
            JsonNode player = probe.visiblePlayers.get(playerId);
            if (player == null) { Thread.sleep(50); continue; }
            if (targetZoneId.equals(player.path("zoneId").asText()))
                throw new AssertionError("Player crossed the room boundary before " + expectedCode + ": " + player);
            double dx = targetX - player.path("x").asDouble(), dy = targetY - player.path("y").asDouble();
            int stepX = Math.abs(dx) < 0.12 ? 0 : dx > 0 ? 1 : -1;
            int stepY = Math.abs(dy) < 0.12 ? 0 : dy > 0 ? 1 : -1;
            probe.send("{\"type\":\"move\",\"epoch\":" + epoch + ",\"seq\":" + seq + ",\"dx\":" + stepX
                + ",\"dy\":" + stepY + ",\"running\":true}");
            JsonNode result = probe.awaitWithin(n -> n.path("type").asText().equals("roomKnockResult")
                && n.path("code").asText().equals(expectedCode), 75);
            if (result != null) return seq + 1;
        }
        throw new AssertionError("Expected room entry result was not received: " + expectedCode);
    }
    private Probe connect() throws Exception {
        return connect("");
    }
    private Probe connect(String mapId) throws Exception {
        return connect(mapId, "http://localhost:5173");
    }
    private Probe connectWithOrigin(String origin) throws Exception {
        return connect("", origin);
    }
    private Probe connect(String mapId, String origin) throws Exception {
        Probe probe = new Probe();
        probe.socket = client.newWebSocketBuilder().header("Origin", origin)
            .buildAsync(URI.create("ws://127.0.0.1:"+port+"/world/socket"+(mapId.isEmpty()?"":"?townMapId="+mapId)),probe).get(10,TimeUnit.SECONDS);
        return probe;
    }
    private JsonNode metric(String name) throws Exception {
        var response = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/actuator/metrics/" + name))
            .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("Actuator metric %s is available", name).isEqualTo(200);
        return json.readTree(response.body());
    }
    private double measurement(JsonNode metric, String statistic) {
        for (JsonNode item : metric.path("measurements"))
            if (statistic.equalsIgnoreCase(item.path("statistic").asText())) return item.path("value").asDouble();
        throw new AssertionError("Metric measurement not found: " + statistic + " in " + metric);
    }
    private long processCpuTime() {
        var bean = ManagementFactory.getOperatingSystemMXBean();
        return bean instanceof com.sun.management.OperatingSystemMXBean os ? os.getProcessCpuTime() : -1;
    }
    private class Probe implements WebSocket.Listener {
        WebSocket socket;
        final BlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        final CompletableFuture<Void> closed = new CompletableFuture<>();
        final CompletableFuture<JsonNode> welcome = new CompletableFuture<>();
        final CompletableFuture<Void> populationReady = new CompletableFuture<>();
        final java.util.Set<String> visiblePlayerIds = ConcurrentHashMap.newKeySet();
        final ConcurrentMap<String, JsonNode> visiblePlayers = new ConcurrentHashMap<>();
        final CopyOnWriteArrayList<String> errors = new CopyOnWriteArrayList<>();
        final StringBuilder text = new StringBuilder();
        private CompletableFuture<?> sendTail = CompletableFuture.completedFuture(null);
        @Override public void onOpen(WebSocket ws) { ws.request(1); }
        @Override public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            text.append(data);
            if(last) {
                try {
                    JsonNode node = json.readTree(text.toString());
                    messages.add(node);
                    if (node.path("type").asText().equals("welcome")) welcome.complete(node);
                    if (node.path("type").asText().equals("error")) errors.add(node.path("code").asText());
                    if (node.path("type").asText().equals("snapshot")) {
                        if (node.path("full").asBoolean()) { visiblePlayerIds.clear(); visiblePlayers.clear(); }
                        node.path("players").forEach(player -> {
                            String id = player.path("id").asText();
                            visiblePlayerIds.add(id);
                            visiblePlayers.put(id, player.deepCopy());
                        });
                        node.path("removedPlayerIds").forEach(id -> {
                            visiblePlayerIds.remove(id.asText());
                            visiblePlayers.remove(id.asText());
                        });
                        if (visiblePlayerIds.size() == 100) populationReady.complete(null);
                        // Never block the HttpClient callback while the 100-client load is active.
                        // sendText completes asynchronously; joining here can starve callbacks for
                        // other sockets on the same selector executor.
                        queueSend(ws, "{\"type\":\"snapshotAck\",\"tick\":" + node.path("tick").asLong() + ",\"applied\":true}");
                    }
                } catch(Exception e) { throw new IllegalStateException(e); }
                text.setLength(0);
            }
            ws.request(1);return null;
        }
        @Override public CompletionStage<?> onClose(WebSocket ws, int code, String reason) { closed.complete(null); return null; }
        synchronized CompletableFuture<?> queueSend(WebSocket ws, String value) {
            sendTail = sendTail.handle((ignored, failure) -> null)
                .thenCompose(ignored -> ws.sendText(value, true));
            return sendTail;
        }
        void send(String value) { queueSend(socket, value).join(); }
        JsonNode await(Predicate<JsonNode> condition) throws Exception {
            long deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<deadline) { var node=messages.poll(100,TimeUnit.MILLISECONDS);if(node!=null&&condition.test(node))return node; }
            throw new AssertionError("Expected WebSocket event did not arrive");
        }
        JsonNode awaitWithin(Predicate<JsonNode> condition, long timeoutMs) throws Exception {
            long deadline = System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeoutMs);
            while (System.nanoTime()<deadline) {
                var node=messages.poll(10,TimeUnit.MILLISECONDS);
                if(node!=null&&condition.test(node))return node;
            }
            return null;
        }
    }
}
