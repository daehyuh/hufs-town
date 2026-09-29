package town.hufs.api.space;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.TownPrincipal;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.MapObject;

import java.util.*;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceBoardPosts {
    record Post(String id, String authorName, String body, long createdAt, boolean own, boolean deletable) {}
    record Draft(String body) {}
    private final Spaces spaces;
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final ObjectMapper json;

    SpaceBoardPosts(Spaces spaces, JdbcTemplate db, TransactionTemplate tx, ObjectMapper json) {
        this.spaces = spaces;
        this.db = db;
        this.tx = tx;
        this.json = json;
    }

    List<Post> list(String spaceId, String boardId, TownPrincipal principal) {
        if (principal == null || !validSpaceId(spaceId) || !validBoardId(boardId)) throw invalid();
        var space = spaces.detail(spaceId, principal.userId());
        requirePublishedBoard(spaceId, boardId);
        boolean manager = Set.of("OWNER", "ADMIN").contains(space.role());
        var posts = db.query("""
            SELECT post.id,post.author_user_id,account.display_name,post.body,post.created_at
            FROM space_board_post post JOIN app_user account ON account.id=post.author_user_id
            WHERE post.space_id=? AND post.board_id=?
            ORDER BY post.created_at DESC,post.id DESC LIMIT 50
            """, (row, index) -> {
            boolean own = principal.userId().equals(row.getString("author_user_id"));
            return new Post(row.getString("id"), row.getString("display_name"), row.getString("body"),
                row.getTimestamp("created_at").getTime(), own, own || manager);
        }, spaceId, boardId);
        Collections.reverse(posts);
        return posts;
    }

    Post create(String spaceId, String boardId, TownPrincipal principal, Draft draft) {
        if (principal == null || !validSpaceId(spaceId) || !validBoardId(boardId)) throw invalid();
        String body = normalizeBody(draft == null ? null : draft.body());
        return tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.detail(spaceId, principal.userId());
            requirePublishedBoard(spaceId, boardId);
            Integer recent = db.queryForObject("""
                SELECT COUNT(*) FROM space_board_post
                WHERE space_id=? AND author_user_id=? AND created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 MINUTE
                """, Integer.class, spaceId, principal.userId());
            if (recent != null && recent >= 5)
                throw new SpaceFailure(429, "BOARD_RATE_LIMITED", "게시판 글은 1분에 다섯 번까지 등록할 수 있어요.");

            Integer count = db.queryForObject("SELECT COUNT(*) FROM space_board_post WHERE space_id=? AND board_id=?",
                Integer.class, spaceId, boardId);
            if (count != null && count >= 200) {
                String oldest = db.queryForObject("""
                    SELECT id FROM space_board_post WHERE space_id=? AND board_id=?
                    ORDER BY created_at,id LIMIT 1
                    """, String.class, spaceId, boardId);
                db.update("DELETE FROM space_board_post WHERE space_id=? AND board_id=? AND id=?", spaceId, boardId, oldest);
            }

            String id = UUID.randomUUID().toString();
            db.update("INSERT INTO space_board_post(id,space_id,board_id,author_user_id,body) VALUES (?,?,?,?,?)",
                id, spaceId, boardId, principal.userId(), body);
            return db.queryForObject("""
                SELECT post.id,account.display_name,post.body,post.created_at
                FROM space_board_post post JOIN app_user account ON account.id=post.author_user_id
                WHERE post.id=? AND post.space_id=?
                """, (row, index) -> new Post(row.getString("id"), row.getString("display_name"), row.getString("body"),
                row.getTimestamp("created_at").getTime(), true, true), id, spaceId);
        });
    }

    void delete(String spaceId, String boardId, String postId, TownPrincipal principal) {
        if (principal == null || !validSpaceId(spaceId) || !validBoardId(boardId) || !validUuid(postId)) throw invalid();
        tx.executeWithoutResult(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.detail(spaceId, principal.userId());
            requirePublishedBoard(spaceId, boardId);
            boolean manager = db.query("""
                SELECT role,manager FROM space_member WHERE space_id=? AND user_id=? FOR UPDATE
                """, (row, index) -> "OWNER".equals(row.getString("role")) || row.getBoolean("manager"), spaceId, principal.userId())
                .stream().findFirst().orElse(false);
            int changed = db.update("""
                DELETE FROM space_board_post WHERE id=? AND space_id=? AND board_id=?
                    AND (author_user_id=? OR ?=TRUE)
                """, postId, spaceId, boardId, principal.userId(), manager);
            if (changed != 1) throw new SpaceFailure(404, "BOARD_POST_NOT_FOUND", "삭제할 글을 찾을 수 없거나 삭제 권한이 없어요.");
        });
    }

    void removeOrphaned(String spaceId, MapDefinition map) { removeOrphaned(spaceId,spaceId,map); }

    void removeOrphanedAfterMapDeletion(String spaceId,String mapId) { removeOrphaned(spaceId,mapId,null); }

    void removeOrphaned(String spaceId, String mapId, MapDefinition map) {
        var boardIds = new LinkedHashSet<String>(map == null || map.objects() == null ? List.of() : map.objects().stream()
            .filter(Objects::nonNull)
            .filter(object -> object.interaction() != null && "BOARD".equals(object.interaction().kind()))
            .map(MapObject::id).distinct().toList());
        // Board IDs can be shared by maps, so retain posts while any other published map still references them.
        var documents=db.queryForList("""
            SELECT revision.document FROM space_map other_map
            JOIN map_revision revision ON revision.id=other_map.published_id AND revision.space_id=other_map.space_id AND revision.map_id=other_map.map_id
            WHERE other_map.space_id=? AND other_map.map_id<>?
            """,String.class,spaceId,mapId);
        for(var document:documents)try {
            var other=json.readValue(document,MapDefinition.class);
            if(other.objects()!=null)other.objects().stream().filter(Objects::nonNull)
                .filter(object->object.interaction()!=null&&"BOARD".equals(object.interaction().kind()))
                .map(MapObject::id).forEach(boardIds::add);
        } catch(com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException("Published map document is invalid",error);
        }
        if (boardIds.isEmpty()) {
            db.update("DELETE FROM space_board_post WHERE space_id=?", spaceId);
            db.update("DELETE FROM space_board_whiteboard WHERE space_id=?", spaceId);
            return;
        }
        String placeholders = String.join(",", Collections.nCopies(boardIds.size(), "?"));
        var args = new ArrayList<Object>();
        args.add(spaceId);
        args.addAll(boardIds);
        db.update("DELETE FROM space_board_post WHERE space_id=? AND board_id NOT IN (" + placeholders + ")", args.toArray());
        db.update("DELETE FROM space_board_whiteboard WHERE space_id=? AND board_id NOT IN (" + placeholders + ")", args.toArray());
    }

    void requirePublishedBoard(String spaceId, String boardId) {
        var documents = db.queryForList("""
            SELECT revision.document FROM space_map map
            JOIN map_revision revision ON revision.id=map.published_id AND revision.space_id=map.space_id AND revision.map_id=map.map_id
            WHERE map.space_id=?
            """, String.class, spaceId);
        if (documents.isEmpty()) throw notFound();
        try {
            for(var document:documents) {
                MapDefinition map = json.readValue(document, MapDefinition.class);
                boolean found = map.objects() != null && map.objects().stream().filter(Objects::nonNull)
                    .anyMatch(object -> boardId.equals(object.id()) && object.interaction() != null
                        && "BOARD".equals(object.interaction().kind()));
                if(found)return;
            }
            throw notFound();
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException("Published map document is invalid", error);
        }
    }

    private static String normalizeBody(String raw) {
        if (raw == null) throw invalid();
        String body = raw.replace("\r\n", "\n").replace('\r', '\n').strip();
        int length = body.codePointCount(0, body.length());
        if (body.isEmpty() || length > 500 || body.codePoints().anyMatch(code ->
            (Character.isISOControl(code) && code != '\n' && code != '\t') || Character.getType(code) == Character.FORMAT))
            throw new SpaceFailure(400, "INVALID_BOARD_POST", "게시글은 1~500자이며 입력 형식을 확인해 주세요.");
        return body;
    }

    private static boolean validSpaceId(String id) { return validUuid(id); }
    private static boolean validUuid(String id) {
        if (id == null || id.length() > 36) return false;
        try { return UUID.fromString(id).toString().equalsIgnoreCase(id); }
        catch (IllegalArgumentException error) { return false; }
    }
    static boolean validBoardId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{1,80}"); }
    private static SpaceFailure invalid() { return new SpaceFailure(400, "INVALID_BOARD_REQUEST", "게시판 요청 형식을 확인해 주세요."); }
    private static SpaceFailure notFound() { return new SpaceFailure(404, "BOARD_NOT_FOUND", "게시판을 찾을 수 없거나 현재 공간에서 사용할 수 없어요."); }
}
