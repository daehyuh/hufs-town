package town.hufs.world;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import town.hufs.protocol.Snapshot;
import town.hufs.protocol.PlayerView;

import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/** Encodes snapshots while sharing equal immutable player arrays within a world tick. */
final class WorldSnapshotEncoder {
    private final ObjectMapper json;
    private final Map<List<PlayerView>, String> playerArrays = new HashMap<>();
    private final Map<List<PlayerView>, String> playerArraysByIdentity = new IdentityHashMap<>();
    private final Map<SnapshotKey, String> snapshots = new HashMap<>();

    WorldSnapshotEncoder(ObjectMapper json) { this.json = json; }

    String encode(Snapshot snapshot) {
        return snapshots.computeIfAbsent(SnapshotKey.of(snapshot), ignored -> encodeUncached(snapshot));
    }

    private String encodeUncached(Snapshot snapshot) {
        List<PlayerView> playerViews = snapshot.players();
        String players = playerArraysByIdentity.get(playerViews);
        if (players == null) {
            players = playerArrays.computeIfAbsent(playerViews, this::encodePlayers);
            playerArraysByIdentity.put(playerViews, players);
        }
        try {
            return "{\"type\":" + json.writeValueAsString(snapshot.type())
                + ",\"tick\":" + snapshot.tick()
                + ",\"serverTime\":" + snapshot.serverTime()
                + ",\"full\":" + snapshot.full()
                + ",\"baseTick\":" + snapshot.baseTick()
                + ",\"inputAckSeq\":" + snapshot.inputAckSeq()
                + ",\"players\":" + players
                + ",\"removedPlayerIds\":" + json.writeValueAsString(snapshot.removedPlayerIds())
                + ",\"mapRevision\":" + json.writeValueAsString(snapshot.mapRevision())
                + ",\"rooms\":" + json.writeValueAsString(snapshot.rooms()) + "}";
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("Unable to encode world snapshot", failure);
        }
    }

    private String encodePlayers(List<PlayerView> players) {
        try {
            return json.writeValueAsString(players);
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("Unable to encode world snapshot players", failure);
        }
    }

    int encodedPlayerArrayCount() { return playerArrays.size(); }
    int encodedSnapshotCount() { return snapshots.size(); }

    private record SnapshotKey(String type, long tick, long serverTime, boolean full, long baseTick,
                               long inputAckSeq, PlayerListIdentity players, List<String> removedPlayerIds,
                               String mapRevision, List<town.hufs.protocol.RoomView> rooms) {
        static SnapshotKey of(Snapshot snapshot) {
            return new SnapshotKey(snapshot.type(), snapshot.tick(), snapshot.serverTime(), snapshot.full(),
                snapshot.baseTick(), snapshot.inputAckSeq(), new PlayerListIdentity(snapshot.players()),
                snapshot.removedPlayerIds(), snapshot.mapRevision(), snapshot.rooms());
        }
    }

    private static final class PlayerListIdentity {
        private final List<PlayerView> reference;

        PlayerListIdentity(List<PlayerView> reference) { this.reference = reference; }

        @Override public boolean equals(Object other) {
            return other instanceof PlayerListIdentity identity && reference == identity.reference;
        }

        @Override public int hashCode() { return System.identityHashCode(reference); }
    }
}
