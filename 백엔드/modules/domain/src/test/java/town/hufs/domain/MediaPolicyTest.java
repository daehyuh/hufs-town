package town.hufs.domain;

import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.stream.IntStream;
import static org.assertj.core.api.Assertions.*;

class MediaPolicyTest {
    private MediaPolicy.Domain domain(String space, String map, String revision, String zone,
                                     MediaPolicy.Scope scope, String eventId) {
        return new MediaPolicy.Domain(space, map, revision, zone, scope, eventId);
    }

    private MediaPolicy.Person person(String id, double x, String zone, String kind, long policyEpoch) {
        var scope = switch (kind) {
            case "PRIVATE" -> MediaPolicy.Scope.PRIVATE_ROOM;
            case "SILENT" -> MediaPolicy.Scope.SILENT;
            default -> MediaPolicy.Scope.NEARBY;
        };
        return new MediaPolicy.Person(id, domain("space", "map", "revision", zone, scope, ""), kind,
            x, 2, policyEpoch, true, Set.of(), false, Set.of(), false);
    }

    @Test void pairwiseDistanceNeverConnectsFriendsOfFriendsAndUsesHysteresis() {
        var policy = new MediaPolicy();
        var people = List.of(person("a", 0, "", "PUBLIC", 1), person("b", 4, "", "PUBLIC", 1),
            person("c", 8, "", "PUBLIC", 1));
        assertThat(policy.update(people, 0).peers().get("b")).isEmpty();
        var result = policy.update(people, 200);
        assertThat(result.peers().get("a")).containsExactly("b");
        assertThat(result.peers().get("b")).containsExactly("a", "c");
        assertThat(policy.update(List.of(people.getFirst(), person("b", 6, "", "PUBLIC", 1)), 250)
            .peers().get("a")).containsExactly("b");
        assertThat(policy.update(List.of(people.getFirst(), person("b", 7.1, "", "PUBLIC", 1)), 300)
            .peers().get("a")).isEmpty();
    }

    @Test void nearbyCellBucketsCoverPositiveAndNegativeBoundariesAndKeepHysteresis() {
        var domain = domain("space", "map", "revision", "", MediaPolicy.Scope.NEARBY, "");
        var positiveLeft = new MediaPolicy.Person("positive-left", domain, "PUBLIC", 6.8, 0, 1,
            true, Set.of(), false, Set.of(), false);
        var positiveRight = new MediaPolicy.Person("positive-right", domain, "PUBLIC", 11.7, 0, 1,
            true, Set.of(), false, Set.of(), false);
        var negativeLeft = new MediaPolicy.Person("negative-left", domain, "PUBLIC", -0.2, 100, 1,
            true, Set.of(), false, Set.of(), false);
        var negativeRight = new MediaPolicy.Person("negative-right", domain, "PUBLIC", 4.7, 100, 1,
            true, Set.of(), false, Set.of(), false);
        var policy = new MediaPolicy();
        var people = List.of(positiveLeft, positiveRight, negativeLeft, negativeRight);

        assertThat(policy.update(people, 0).peers().values()).allSatisfy(peers -> assertThat(peers).isEmpty());
        var connected = policy.update(people, 200);
        assertThat(connected.peers().get("positive-left")).containsExactly("positive-right");
        assertThat(connected.peers().get("negative-left")).containsExactly("negative-right");

        var retained = policy.update(List.of(positiveLeft,
            new MediaPolicy.Person("positive-right", domain, "PUBLIC", 13.7, 0, 1,
                true, Set.of(), false, Set.of(), false), negativeLeft, negativeRight), 250);
        assertThat(retained.peers().get("positive-left")).containsExactly("positive-right");
        var outsideExitRadius = policy.update(List.of(positiveLeft,
            new MediaPolicy.Person("positive-right", domain, "PUBLIC", 13.81, 0, 1,
                true, Set.of(), false, Set.of(), false), negativeLeft, negativeRight), 300);
        assertThat(outsideExitRadius.peers().get("positive-left")).isEmpty();
    }

    @Test void privacyBoundariesAndBlockChangesRevokeWithoutDistanceGrace() {
        var policy = new MediaPolicy();
        var a = person("a", 1, "room", "PRIVATE", 1);
        var b = person("b", 30, "room", "PRIVATE", 1);
        assertThat(policy.update(List.of(a, b), 0).peers().get("a")).containsExactly("b");
        assertThat(policy.update(List.of(a, person("b", 1, "other", "PRIVATE", 2)), 50)
            .peers().get("a")).isEmpty();
        assertThat(policy.update(List.of(a, person("b", 1, "", "PUBLIC", 3)), 100)
            .peers().get("a")).isEmpty();
        var blocked = new MediaPolicy.Person("b", domain("space", "map", "revision", "room",
            MediaPolicy.Scope.PRIVATE_ROOM, ""), "PRIVATE", 2, 2, 4, true, Set.of("a"), false, Set.of(), false);
        assertThat(policy.update(List.of(a, blocked), 150).peers().get("a")).isEmpty();
        assertThat(policy.update(List.of(person("a", 1, "", "PUBLIC", 1),
            person("b", 1, "focus", "SILENT", 1)), 1000).peers().get("a")).isEmpty();
    }

    @Test void newConnectionCannotReuseDistanceGraceAndMapsRemainIsolatedOutsideEvents() {
        var policy = new MediaPolicy();
        var a = person("a", 1, "", "PUBLIC", 1);
        var b = person("b", 2, "", "PUBLIC", 1);
        policy.update(List.of(a, b), 0);
        policy.update(List.of(a, b), 200);
        assertThat(policy.update(List.of(a, person("b", 7, "", "PUBLIC", 2)), 250).peers().get("a")).isEmpty();
        var foreignMap = new MediaPolicy.Person("b", domain("space", "other-map", "revision", "",
            MediaPolicy.Scope.NEARBY, ""), "PUBLIC", 1, 2, 1, true, Set.of(), false, Set.of(), false);
        assertThat(policy.update(List.of(a, foreignMap), 1000).peers().get("a")).isEmpty();
    }

    @Test void approvedEventConnectsAcrossMapsOnlyWithinTheSameSpaceAndEvent() {
        var policy = new MediaPolicy();
        var speaker = new MediaPolicy.Person("speaker", domain("space", "map-a", "rev-a", "",
            MediaPolicy.Scope.EVENT, "event-1"), "EVENT", 1, 1, 7, true, Set.of(), false, Set.of(), true);
        var listener = new MediaPolicy.Person("listener", domain("space", "map-b", "rev-b", "",
            MediaPolicy.Scope.EVENT, "event-1"), "EVENT", 90, 90, 3, true, Set.of(), false, Set.of(), false);
        var otherSpace = new MediaPolicy.Person("other-space", domain("other-space", "map-b", "rev-b", "",
            MediaPolicy.Scope.EVENT, "event-1"), "EVENT", 1, 1, 1, true, Set.of(), false, Set.of(), false);
        var otherEvent = new MediaPolicy.Person("other-event", domain("space", "map-c", "rev-c", "",
            MediaPolicy.Scope.EVENT, "event-2"), "EVENT", 1, 1, 1, true, Set.of(), false, Set.of(), false);

        assertThat(speaker.domain()).isEqualTo(listener.domain());
        assertThat(speaker.domain()).isNotEqualTo(otherSpace.domain());
        var participants = List.of(speaker, listener, otherSpace, otherEvent);
        policy.update(participants, 0);
        var result = policy.update(participants, 200);
        assertThat(result.peers().get("speaker")).containsExactly("listener");
        assertThat(result.peers().get("listener")).containsExactly("speaker");
    }

    @Test void eventAudienceSupportsOneHundredListenersAcrossMapsAndKeepsPrivateRoomsIsolated() {
        var policy = new MediaPolicy();
        var speaker = new MediaPolicy.Person("speaker", domain("space", "stage-map", "stage-rev", "",
            MediaPolicy.Scope.EVENT, "event-1"), "EVENT", 1, 1, 1, true, Set.of(), false, Set.of(), true);
        var listeners = IntStream.range(0, 100).mapToObj(index -> new MediaPolicy.Person(
            String.format(Locale.ROOT, "listener-%03d", index), domain("space", "audience-map", "audience-rev", "",
                MediaPolicy.Scope.EVENT, "event-1"), "EVENT", 90, 90, 1, true, Set.of(), false, Set.of(), false)).toList();
        var privateRoom = new MediaPolicy.Person("private", domain("space", "audience-map", "audience-rev", "meeting",
            MediaPolicy.Scope.PRIVATE_ROOM, ""), "PRIVATE", 90, 90, 1, true, Set.of(), false, Set.of(), false);
        var people = new ArrayList<MediaPolicy.Person>();
        people.add(speaker);
        people.addAll(listeners);
        people.add(privateRoom);

        policy.update(people, 0);
        var connected = policy.update(people, 200);
        assertThat(connected.peers().get("speaker")).hasSize(100).containsAll(
            listeners.stream().map(MediaPolicy.Person::id).toList());
        assertThat(connected.peers().get("private")).isEmpty();
        assertThat(connected.limited()).isEmpty();
        listeners.forEach(listener -> assertThat(connected.peers().get(listener.id())).containsExactly("speaker"));

        var overflow = new MediaPolicy.Person("listener-100", domain("space", "audience-map", "audience-rev", "",
            MediaPolicy.Scope.EVENT, "event-1"), "EVENT", 90, 90, 1, true, Set.of(), false, Set.of(), false);
        var expanded = new ArrayList<>(people);
        expanded.add(overflow);
        var notYetConnected = policy.update(expanded, 400);
        var capped = policy.update(expanded, 600);
        assertThat(notYetConnected.peers().get("speaker")).hasSize(100);
        assertThat(capped.peers().get("speaker")).hasSize(100).doesNotContain("listener-100");
        assertThat(capped.peers().get("listener-100")).isEmpty();
        assertThat(capped.limited()).contains("speaker", "listener-100");

        var reversed = new ArrayList<>(expanded);
        Collections.reverse(reversed);
        var reorderedPolicy = new MediaPolicy();
        reorderedPolicy.update(reversed, 0);
        assertThat(reorderedPolicy.update(reversed, 200)).isEqualTo(capped);
    }

    @Test void revokingEventSpeakerImmediatelyRemovesMediaEdgesAndSources() {
        var policy = new MediaPolicy();
        var domain = domain("space", "stage", "rev-1", "", MediaPolicy.Scope.EVENT, "event-1");
        var speaker = new MediaPolicy.Person("speaker", domain, "EVENT", 1, 1, 1,
            true, Set.of(), false, Set.of(), true);
        var listener = new MediaPolicy.Person("listener", domain, "EVENT", 90, 90, 1,
            true, Set.of(), false, Set.of(), false);

        policy.update(List.of(speaker, listener), 0);
        var connected = policy.update(List.of(speaker, listener), 200);
        assertThat(connected.peers().get("listener")).containsExactly("speaker");
        assertThat(MediaPolicy.Source.values()).allSatisfy(source ->
            assertThat(MediaPolicy.sourceAllowed(speaker, source)).isTrue());

        var revoked = new MediaPolicy.Person("speaker", domain, "EVENT", 1, 1, 2,
            true, Set.of(), false, Set.of(), false);
        var disconnected = policy.update(List.of(revoked, listener), 201);
        assertThat(disconnected.peers().get("speaker")).isEmpty();
        assertThat(disconnected.peers().get("listener")).isEmpty();
        assertThat(MediaPolicy.Source.values()).allSatisfy(source ->
            assertThat(MediaPolicy.sourceAllowed(revoked, source)).isFalse());
    }

    @Test void denseCrowdHasSymmetricBoundedEdgesAndVisibleLimit() {
        var people = IntStream.range(0, 100).mapToObj(i -> person("p" + i, 2, "room", "PRIVATE", 1)).toList();
        var policy = new MediaPolicy();
        var result = policy.update(people, 0);
        assertThat(result.peers()).hasSize(100);
        assertThat(result.limited()).isNotEmpty();
        result.peers().forEach((a, peers) -> {
            assertThat(peers.size()).isLessThanOrEqualTo(12);
            for (var b : peers) assertThat(result.peers().get(b)).contains(a);
        });
        var reversed = new ArrayList<>(people);
        Collections.reverse(reversed);
        assertThat(new MediaPolicy().update(reversed, 0)).isEqualTo(result);
    }

    @Test void silentModeAndModerationAlsoApplyToScreenAudio() {
        var silent = person("a", 1, "focus", "SILENT", 1);
        for (var source : MediaPolicy.Source.values()) assertThat(MediaPolicy.sourceAllowed(silent, source)).isFalse();
        var muted = new MediaPolicy.Person("b", domain("space", "map", "revision", "",
            MediaPolicy.Scope.NEARBY, ""), "PUBLIC", 1, 2, 1, true, Set.of(), true, Set.of(), false);
        assertThat(MediaPolicy.sourceAllowed(muted, MediaPolicy.Source.SCREEN_AUDIO)).isFalse();
        assertThat(MediaPolicy.sourceAllowed(muted, MediaPolicy.Source.CAMERA)).isTrue();
    }

    @Test void domainKeysAreStructuredAndSafeForTheSfu() {
        var publicDomain = domain("space", "map", "revision", "", MediaPolicy.Scope.NEARBY, "");
        var privateRoom = domain("space", "map", "revision", "meeting-a", MediaPolicy.Scope.PRIVATE_ROOM, "");
        var eventA = domain("space", "map-a", "rev-a", "", MediaPolicy.Scope.EVENT, "event-1");
        var eventB = domain("space", "map-b", "rev-b", "", MediaPolicy.Scope.EVENT, "event-1");
        assertThat(publicDomain.key()).isEqualTo("space:map/revision/common")
            .matches("[a-zA-Z0-9_./:-]{1,256}");
        assertThat(privateRoom.key()).isEqualTo("space:map/revision/private:meeting-a");
        assertThat(eventA.key()).isEqualTo("space/event/event-1").isEqualTo(eventB.key());
        assertThatThrownBy(() -> domain("space", "map", "revision", "", MediaPolicy.Scope.EVENT, ""))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
