package town.hufs.api.space;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import town.hufs.auth.TownPrincipal;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceMapEditPresence {
    private static final Duration PRESENCE_TTL = Duration.ofSeconds(8);
    private static final Duration INDEX_TTL = Duration.ofHours(1);
    private static final Set<String> COLLECTIONS = Set.of("objects", "floors", "walls", "zones", "labels", "portals");

    private final StringRedisTemplate redis;
    private final SpaceMaps maps;
    private final ObjectMapper json = new ObjectMapper();

    SpaceMapEditPresence(StringRedisTemplate redis, SpaceMaps maps) {
        this.redis = redis;
        this.maps = maps;
    }

    record SelectionRef(String collection, String entityId) {}
    record Update(String clientId, List<SelectionRef> selection) {}
    record Participant(String userId, String displayName, String clientId, List<SelectionRef> selection, long updatedAt) {}
    record Snapshot(List<Participant> participants) {}

    void update(String spaceId, String mapId, TownPrincipal principal, Update update) {
        requireCollaborativeEditor(spaceId, mapId, principal.userId());
        String clientId = uuid(update == null ? null : update.clientId());
        List<SelectionRef> selection = update == null || update.selection() == null ? List.of() : update.selection();
        if (selection.size() > 100) throw invalid();
        for (SelectionRef item : selection) {
            if (item == null || item.entityId() == null || item.entityId().isBlank() || item.entityId().length() > 128
                || item.entityId().codePoints().anyMatch(Character::isISOControl) || !COLLECTIONS.contains(item.collection()))
                throw invalid();
        }

        long now = System.currentTimeMillis();
        Participant participant = new Participant(principal.userId(), principal.displayName(), clientId, List.copyOf(selection), now);
        String member = principal.userId() + ":" + clientId;
        redis.opsForValue().set(entryKey(spaceId, mapId, member), write(participant), PRESENCE_TTL);
        redis.opsForZSet().add(indexKey(spaceId, mapId), member, now + PRESENCE_TTL.toMillis());
        redis.expire(indexKey(spaceId, mapId), INDEX_TTL);
    }

    Snapshot list(String spaceId, String mapId, TownPrincipal principal, String excludeClientId) {
        requireCollaborativeEditor(spaceId, mapId, principal.userId());
        String excluded = excludeClientId == null || excludeClientId.isBlank() ? "" : uuid(excludeClientId);
        String index = indexKey(spaceId, mapId);
        long now = System.currentTimeMillis();
        redis.opsForZSet().removeRangeByScore(index, 0, now);
        Set<String> members = redis.opsForZSet().rangeByScore(index, now + 1, Double.POSITIVE_INFINITY);
        List<Participant> participants = new ArrayList<>();
        if (members != null) {
            for (String member : members) {
                int separator = member.indexOf(':');
                if (separator < 1) continue;
                String userId = member.substring(0, separator);
                String clientId = member.substring(separator + 1);
                if (userId.equals(principal.userId()) && clientId.equals(excluded)) continue;
                String value = redis.opsForValue().get(entryKey(spaceId, mapId, member));
                if (value == null) {
                    redis.opsForZSet().remove(index, member);
                    continue;
                }
                try {
                    participants.add(json.readValue(value, Participant.class));
                } catch (JsonProcessingException ignored) {
                    redis.opsForZSet().remove(index, member);
                    redis.delete(entryKey(spaceId, mapId, member));
                }
            }
        }
        participants.sort(Comparator.comparing(Participant::displayName, String.CASE_INSENSITIVE_ORDER)
            .thenComparing(Participant::clientId));
        return new Snapshot(List.copyOf(participants));
    }

    void remove(String spaceId, String mapId, TownPrincipal principal, String clientId) {
        requireCollaborativeEditor(spaceId, mapId, principal.userId());
        String member = principal.userId() + ":" + uuid(clientId);
        redis.opsForZSet().remove(indexKey(spaceId, mapId), member);
        redis.delete(entryKey(spaceId, mapId, member));
    }

    private void requireCollaborativeEditor(String spaceId, String mapId, String userId) {
        if (!"COLLABORATIVE".equals(maps.editMode(spaceId, mapId, userId).mode()))
            throw new SpaceFailure(409, "MAP_EDIT_MODE", "먼저 이 지도의 공동 편집을 켜 주세요.");
    }

    private String uuid(String value) {
        try {
            return UUID.fromString(value).toString();
        } catch (RuntimeException error) {
            throw invalid();
        }
    }

    private String indexKey(String spaceId, String mapId) {
        return "town:map-edit-presence:" + spaceId + ":" + mapId;
    }

    private String entryKey(String spaceId, String mapId, String member) {
        return indexKey(spaceId, mapId) + ":" + member;
    }

    private String write(Participant participant) {
        try {
            return json.writeValueAsString(participant);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Map editor presence could not be encoded", error);
        }
    }

    private static SpaceFailure invalid() {
        return new SpaceFailure(400, "MAP_EDIT_PRESENCE_INVALID", "공동 편집 선택 상태를 확인해 주세요.");
    }
}
