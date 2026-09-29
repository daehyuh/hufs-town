package town.hufs.world;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class WorldMapPublicationStore {
    record AppliedMap(String spaceId, String mapId, long sequence) {}

    private final JdbcTemplate db;
    private final TransactionTemplate tx;

    WorldMapPublicationStore(JdbcTemplate db, TransactionTemplate tx) {
        this.db = db;
        this.tx = tx;
    }

    void heartbeat(String nodeId, Collection<AppliedMap> appliedMaps) {
        Map<String, AppliedMap> unique = new LinkedHashMap<>();
        for (AppliedMap map : appliedMaps) {
            String key = map.spaceId() + "\u0000" + map.mapId();
            unique.merge(key, map, (left, right) -> left.sequence() >= right.sequence() ? left : right);
        }
        tx.executeWithoutResult(status -> {
            db.update("UPDATE world_map_node_map SET active=FALSE,last_seen_at=CURRENT_TIMESTAMP(6) WHERE node_id=?", nodeId);
            for (AppliedMap map : unique.values()) {
                db.update("""
                    INSERT INTO world_map_node_map(node_id,space_id,map_id,applied_sequence,active,last_seen_at)
                    VALUES (?,?,?,?,TRUE,CURRENT_TIMESTAMP(6))
                    ON DUPLICATE KEY UPDATE
                        applied_sequence=GREATEST(applied_sequence,VALUES(applied_sequence)),
                        active=TRUE,last_seen_at=VALUES(last_seen_at)
                    """, nodeId, map.spaceId(), map.mapId(), map.sequence());
                db.update("""
                    UPDATE map_outbox_node_target target
                    JOIN map_outbox event ON event.id=target.outbox_id
                    SET target.acknowledged_at=COALESCE(target.acknowledged_at,CURRENT_TIMESTAMP(6)),target.expired_at=NULL
                    WHERE target.node_id=? AND event.space_id=? AND event.map_id=? AND event.sequence_no<=?
                    """, nodeId, map.spaceId(), map.mapId(), map.sequence());
            }
        });
    }

    void removeNode(String nodeId) {
        tx.executeWithoutResult(status -> {
            db.update("UPDATE world_map_node_map SET active=FALSE,last_seen_at=CURRENT_TIMESTAMP(6) WHERE node_id=?", nodeId);
            db.update("UPDATE map_outbox_node_target SET expired_at=CURRENT_TIMESTAMP(6) WHERE node_id=? AND acknowledged_at IS NULL", nodeId);
        });
    }
}
