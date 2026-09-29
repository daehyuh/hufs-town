package town.hufs.api.space;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.PublishedMaps;
import town.hufs.domain.MapRules;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.MapInteraction;
import town.hufs.protocol.MapObject;
import town.hufs.protocol.Portal;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceCloner {
    private static final Logger log = LoggerFactory.getLogger(SpaceCloner.class);
    private final Spaces spaces;
    private final SpaceMaps maps;
    private final SpaceAssets assets;
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final PublishedMaps publishedMaps;
    private final ObjectMapper json = new ObjectMapper();

    SpaceCloner(Spaces spaces, SpaceMaps maps, SpaceAssets assets, JdbcTemplate db,
                TransactionTemplate tx, PublishedMaps publishedMaps) {
        this.spaces = spaces;
        this.maps = maps;
        this.assets = assets;
        this.db = db;
        this.tx = tx;
        this.publishedMaps = publishedMaps;
    }

    Spaces.Space clone(String sourceSpaceId, String ownerId, String requestedName) {
        String name = validName(requestedName);
        List<Path> copiedFiles = new ArrayList<>();
        CloneResult result;
        try {
            result = tx.execute(status -> cloneInTransaction(sourceSpaceId, ownerId, name, copiedFiles));
        } catch (RuntimeException failure) {
            assets.cleanupCloneFiles(copiedFiles);
            throw failure;
        }
        if (result == null) throw new IllegalStateException("Space clone transaction returned no result");
        result.published().forEach((mapId, document) -> {
            try {
                publishedMaps.publish(result.spaceId(), mapId, 1, document);
            } catch (RuntimeException cacheUnavailable) {
                // The SQL outbox retries publication; a transient Redis error must not fail an already committed clone.
                log.warn("Unable to prime published-map cache for cloned space {} map {}", result.spaceId(), mapId, cacheUnavailable);
            }
        });
        return spaces.detail(result.spaceId(), ownerId);
    }

    private CloneResult cloneInTransaction(String sourceSpaceId, String ownerId, String name, List<Path> copiedFiles) {
        spaces.active(ownerId);
        if (db.queryForList("SELECT id FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE", String.class, ownerId).isEmpty())
            throw new SpaceFailure(403, "ACCOUNT_UNAVAILABLE", "이 계정으로 공간을 이용할 수 없어요.");
        SourceSpace source = db.query("""
            SELECT id,name,description,capacity,template_id FROM town_space
            WHERE id=? AND owner_id=? AND archived_at IS NULL FOR UPDATE
            """, (r, n) -> new SourceSpace(r.getString("id"), r.getString("name"), r.getString("description"),
                r.getInt("capacity"), r.getString("template_id")), sourceSpaceId, ownerId)
            .stream().findFirst().orElseThrow(SpaceCloner::notFound);
        spaces.requireOwner(source.id(), ownerId);
        Integer owned = db.queryForObject("SELECT COUNT(*) FROM town_space WHERE owner_id=?", Integer.class, ownerId);
        if (owned != null && owned >= 20)
            throw new SpaceFailure(409, "SPACE_LIMIT", "만들 수 있는 공간은 계정당 20개예요.");

        List<SpaceMaps.CloneMap> sourceMaps = maps.cloneSnapshot(source.id(), ownerId);
        if (sourceMaps.isEmpty() || sourceMaps.size() > 50)
            throw new SpaceFailure(409, "MAP_CLONE_INVALID", "공간의 지도 구성을 확인한 뒤 다시 복제해 주세요.");
        String targetSpaceId = UUID.randomUUID().toString();
        db.update("""
            INSERT INTO town_space(id,name,description,visibility,capacity,approval_required,guest_entry_enabled,owner_id,template_id)
            VALUES (?,?,?,'PRIVATE',?,FALSE,FALSE,?,?)
            """, targetSpaceId, name, source.description(), source.capacity(), ownerId, source.templateId());
        db.update("""
            INSERT INTO space_member(space_id,user_id,role) VALUES (?,?,'OWNER')
            """, targetSpaceId, ownerId);
        db.update("""
            INSERT INTO space_allowed_email_domain(space_id,email_domain)
            SELECT ?,email_domain FROM space_allowed_email_domain WHERE space_id=?
            """, targetSpaceId, source.id());

        Map<String, String> assetIds = assets.copyReadyAssets(source.id(), targetSpaceId, ownerId, copiedFiles);
        Map<String, String> mapIds = new HashMap<>();
        sourceMaps.forEach(map -> mapIds.put(map.mapId(), source.id().equals(map.mapId())
            ? targetSpaceId : UUID.randomUUID().toString()));
        String entryMapId = sourceMaps.stream().filter(SpaceMaps.CloneMap::entry)
            .map(SpaceMaps.CloneMap::mapId).findFirst().orElse(sourceMaps.getFirst().mapId());
        Map<String, String> publishedDocuments = new LinkedHashMap<>();

        for (SpaceMaps.CloneMap sourceMap : sourceMaps) {
            String newMapId = mapIds.get(sourceMap.mapId());
            String revisionId = UUID.randomUUID().toString();
            MapDefinition published = remap(sourceMap.published(), targetSpaceId, newMapId, revisionId,
                source.id(), entryMapId, mapIds, assetIds);
            MapDefinition draft = remap(sourceMap.draft(), targetSpaceId, newMapId, revisionId,
                source.id(), entryMapId, mapIds, assetIds);
            String publishedJson = encode(published);
            String draftJson = encode(draft);
            if (!MapRules.issues(published).isEmpty())
                throw new SpaceFailure(409, "MAP_CLONE_INVALID", "게시된 지도의 오류를 확인한 뒤 다시 복제해 주세요.");

            db.update("""
                INSERT INTO space_map(space_id,map_id,sort_order,is_entry,draft_json,draft_version,published_id,published_sequence)
                VALUES (?,?,?,?,?,1,?,1)
                """, targetSpaceId, newMapId, sourceMap.sortOrder(), sourceMap.entry(), draftJson, revisionId);
            db.update("""
                INSERT INTO map_revision(id,space_id,map_id,sequence_no,document,content_hash,actor_id,reason)
                VALUES (?,?,?,1,?,?,?,'CLONE')
                """, revisionId, targetSpaceId, newMapId, publishedJson, hash(publishedJson), ownerId);
            db.update("""
                INSERT INTO map_outbox(space_id,map_id,revision_id,sequence_no) VALUES (?,?,?,1)
                """, targetSpaceId, newMapId, revisionId);
            publishedDocuments.put(newMapId, publishedJson);
        }
        return new CloneResult(targetSpaceId, Map.copyOf(publishedDocuments));
    }

    private MapDefinition remap(MapDefinition source, String targetSpaceId, String targetMapId, String revisionId,
                                String sourceSpaceId, String sourceEntryMapId, Map<String, String> mapIds,
                                Map<String, String> assetIds) {
        List<MapObject> objects = source.objects() == null ? null : source.objects().stream().map(object -> {
            if (object == null) return null;
            String objectAsset = assetId(object.asset(), assetIds);
            MapInteraction interaction = object.interaction();
            if (interaction != null) {
                interaction = new MapInteraction(interaction.kind(), interaction.title(), interaction.body(), interaction.url(),
                    assetId(interaction.assetId(), assetIds), interaction.radius(), interaction.volume());
            }
            return new MapObject(object.id(), objectAsset, object.x(), object.y(), object.scale(), object.direction(), interaction);
        }).toList();
        List<Portal> portals = source.portals() == null ? null : source.portals().stream().map(portal -> {
            if (portal == null || !sourceSpaceId.equals(portal.targetSpaceId())) return portal;
            String originalTargetMap = portal.targetMapId() == null || portal.targetMapId().isBlank()
                ? mapIds.get(sourceEntryMapId) : portal.targetMapId();
            String clonedTargetMap = mapIds.get(originalTargetMap);
            if (clonedTargetMap == null)
                throw new SpaceFailure(409, "MAP_CLONE_INVALID", "원본 공간의 포털 연결을 확인한 뒤 다시 복제해 주세요.");
            return new Portal(portal.id(), portal.name(), portal.bounds(), targetSpaceId, clonedTargetMap,
                portal.targetSpawnX(), portal.targetSpawnY());
        }).toList();
        MapDefinition rewritten = new MapDefinition(source.schemaVersion(), targetMapId, revisionId, source.name(),
            source.width(), source.height(), source.spawnX(), source.spawnY(), source.collisions(), objects,
            source.zones(), source.floors(), source.walls(), source.labels(), portals);
        try {
            return MapRules.normalize(rewritten, targetMapId, revisionId,
                assets.definitions(targetSpaceId, rewritten)::get);
        } catch (MapRules.Invalid invalid) {
            throw new SpaceFailure(409, "MAP_CLONE_INVALID", "원본 지도의 오류를 확인한 뒤 다시 복제해 주세요.");
        }
    }

    private static String assetId(String value, Map<String, String> assetIds) {
        if (!MapRules.customAssetId(value)) return value;
        String replacement = assetIds.get(value);
        if (replacement == null)
            throw new SpaceFailure(409, "MAP_CLONE_INVALID", "지도에서 참조하는 승인 에셋을 복제할 수 없어요.");
        return replacement;
    }

    private String encode(MapDefinition map) {
        try {
            String value = json.writeValueAsString(map);
            if (value.length() > 512_000)
                throw new SpaceFailure(409, "MAP_CLONE_INVALID", "복제할 지도 데이터가 너무 커요.");
            return value;
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("Unable to serialize cloned map", failure);
        }
    }

    private static String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String validName(String value) {
        String name = value == null ? "" : value.strip();
        if (name.isEmpty() || name.length() > 60
            || name.codePoints().anyMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT))
            throw new SpaceFailure(400, "INVALID_SPACE", "복제할 공간 이름을 확인해 주세요.");
        return name;
    }

    private static SpaceFailure notFound() {
        return new SpaceFailure(404, "SPACE_NOT_FOUND", "공간을 찾을 수 없거나 소유자 권한이 없어요.");
    }

    private record SourceSpace(String id, String name, String description, int capacity, String templateId) {}
    private record CloneResult(String spaceId, Map<String, String> published) {}
}
