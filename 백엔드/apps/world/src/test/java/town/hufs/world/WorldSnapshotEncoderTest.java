package town.hufs.world;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import town.hufs.protocol.PlayerView;
import town.hufs.protocol.RoomView;
import town.hufs.protocol.Snapshot;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

class WorldSnapshotEncoderTest {
    private final PlayerView player = new PlayerView(
        "player-1", "Guest", 0, "skin", "clothing", "hair", 3, 4, "down", true,
        "", "", 0, false, "AVAILABLE", false, false, "", List.of(), false);

    @Test void reusesEncodedArrayWhenClientDeltaListsHaveEqualContents() {
        WorldSnapshotEncoder encoder = new WorldSnapshotEncoder(new ObjectMapper());
        List<PlayerView> firstClientDelta = List.of(player);
        List<PlayerView> secondClientDelta = new ArrayList<>(firstClientDelta);

        String first = encoder.encode(snapshot(firstClientDelta, 10));
        String second = encoder.encode(snapshot(secondClientDelta, 11));

        assertNotEquals(first, second, "client ACK sequence remains specific to each snapshot");
        assertEquals(1, encoder.encodedPlayerArrayCount());
        assertEquals(2, encoder.encodedSnapshotCount());
    }

    @Test void reusesEncodedArrayForTheSameSharedInterestListWithoutChangingSnapshotIdentity() {
        WorldSnapshotEncoder encoder = new WorldSnapshotEncoder(new ObjectMapper());
        List<PlayerView> sharedInterestList = List.of(player);

        String first = encoder.encode(snapshot(sharedInterestList, 10));
        String second = encoder.encode(snapshot(sharedInterestList, 11));

        assertNotEquals(first, second, "each snapshot retains its own client ACK sequence");
        assertEquals(1, encoder.encodedPlayerArrayCount());
        assertEquals(2, encoder.encodedSnapshotCount());
    }

    @Test void encodesDifferentPlayerChangesSeparately() {
        WorldSnapshotEncoder encoder = new WorldSnapshotEncoder(new ObjectMapper());
        PlayerView movedPlayer = new PlayerView(
            "player-1", "Guest", 0, "skin", "clothing", "hair", 3.25, 4, "right", true,
            "", "", 0, false, "AVAILABLE", false, false, "", List.of(), false);

        encoder.encode(snapshot(List.of(player), 10));
        encoder.encode(snapshot(List.of(movedPlayer), 11));

        assertEquals(2, encoder.encodedPlayerArrayCount());
    }

    private static Snapshot snapshot(List<PlayerView> players, long inputAckSeq) {
        List<RoomView> rooms = List.of();
        return new Snapshot("snapshot", 2, 100, false, 1, inputAckSeq, players, List.of(), "revision-1", rooms);
    }
}
