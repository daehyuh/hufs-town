package town.hufs.api.space;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.TownPrincipal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceWhiteboards {
    private static final int MAX_STROKES = 300;
    private static final int MAX_POINTS = 120;

    record Point(int x, int y) {}
    record Stroke(String id, String color, int width, List<Point> points) {}
    record Document(long revision, List<Stroke> strokes, long updatedAt, boolean canClear) {}
    record StrokeDraft(String color, int width, List<Point> points) {}
    record Mutation(String operationId, String kind, long expectedRevision, StrokeDraft stroke) {}

    private final Spaces spaces;
    private final SpaceBoardPosts boards;
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final ObjectMapper json;

    SpaceWhiteboards(Spaces spaces, SpaceBoardPosts boards, JdbcTemplate db, TransactionTemplate tx, ObjectMapper json) {
        this.spaces = spaces;
        this.boards = boards;
        this.db = db;
        this.tx = tx;
        this.json = json;
    }

    Document get(String spaceId, String boardId, TownPrincipal principal) {
        validatePath(spaceId, boardId, principal);
        var space = spaces.detail(spaceId, principal.userId());
        requireMember(space.role());
        boards.requirePublishedBoard(spaceId, boardId);
        boolean manager = isManager(space.role());
        var rows = db.query("SELECT revision,strokes_json,updated_at FROM space_board_whiteboard WHERE space_id=? AND board_id=?",
            (row, index) -> document(row.getLong("revision"), row.getString("strokes_json"),
                row.getTimestamp("updated_at").getTime(), manager), spaceId, boardId);
        return rows.isEmpty() ? new Document(0, List.of(), 0, manager) : rows.getFirst();
    }

    Document mutate(String spaceId, String boardId, TownPrincipal principal, Mutation mutation) {
        validatePath(spaceId, boardId, principal);
        if (mutation == null || !validUuid(mutation.operationId()) || mutation.expectedRevision() < 0)
            throw invalid();
        boolean add = "ADD_STROKE".equals(mutation.kind());
        boolean clear = "CLEAR".equals(mutation.kind());
        if ((!add && !clear) || (add && !validStroke(mutation.stroke())) || (clear && mutation.stroke() != null))
            throw invalid();
        final String fingerprint = fingerprint(mutation);

        return tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            var space = spaces.detail(spaceId, principal.userId());
            requireMember(space.role());
            boards.requirePublishedBoard(spaceId, boardId);
            if (clear && !isManager(space.role()))
                throw new SpaceFailure(403, "WHITEBOARD_CLEAR_FORBIDDEN", "화이트보드 전체 지우기는 공간 관리자만 할 수 있어요.");

            db.update("INSERT IGNORE INTO space_board_whiteboard(space_id,board_id,revision,strokes_json) VALUES (?,?,0,'[]')",
                spaceId, boardId);
            var state = db.queryForObject("SELECT revision,strokes_json,updated_at FROM space_board_whiteboard WHERE space_id=? AND board_id=? FOR UPDATE",
                (row, index) -> new Stored(row.getLong("revision"), row.getString("strokes_json"),
                    row.getTimestamp("updated_at").getTime()), spaceId, boardId);
            var duplicate = db.query("SELECT request_hash FROM space_board_whiteboard_operation WHERE space_id=? AND board_id=? AND operation_id=?",
                (row, index) -> row.getString("request_hash"), spaceId, boardId, mutation.operationId());
            if (!duplicate.isEmpty()) {
                if (!MessageDigest.isEqual(duplicate.getFirst().getBytes(StandardCharsets.US_ASCII), fingerprint.getBytes(StandardCharsets.US_ASCII)))
                    throw new SpaceFailure(409, "WHITEBOARD_OPERATION_CONFLICT", "이미 처리한 작업 ID를 다른 내용으로 사용할 수 없어요.");
                return document(state.revision(), state.strokesJson(), state.updatedAt(), isManager(space.role()));
            }

            List<Stroke> strokes = decode(state.strokesJson());
            if (clear) {
                if (mutation.expectedRevision() != state.revision())
                    throw new SpaceFailure(409, "WHITEBOARD_REVISION_CONFLICT", "다른 사람이 먼저 수정했어요. 최신 화이트보드를 다시 불러왔어요.");
                strokes = List.of();
            } else {
                if (strokes.size() >= MAX_STROKES)
                    throw new SpaceFailure(409, "WHITEBOARD_FULL", "화이트보드에는 그림을 300개까지 보관할 수 있어요. 관리자가 지운 뒤 다시 그려 주세요.");
                var stroke = mutation.stroke();
                strokes = new ArrayList<>(strokes);
                strokes.add(new Stroke(mutation.operationId(), stroke.color().toUpperCase(Locale.ROOT), stroke.width(),
                    List.copyOf(stroke.points())));
            }

            long revision = state.revision() + 1;
            String strokesJson = encode(strokes);
            db.update("UPDATE space_board_whiteboard SET revision=?,strokes_json=?,updated_at=CURRENT_TIMESTAMP(6) WHERE space_id=? AND board_id=?",
                revision, strokesJson, spaceId, boardId);
            db.update("INSERT INTO space_board_whiteboard_operation(space_id,board_id,operation_id,request_hash) VALUES (?,?,?,?)",
                spaceId, boardId, mutation.operationId(), fingerprint);
            return new Document(revision, List.copyOf(strokes), System.currentTimeMillis(), isManager(space.role()));
        });
    }

    void removeOrphaned(String spaceId, Set<String> retainedBoardIds) {
        if (retainedBoardIds.isEmpty()) {
            db.update("DELETE FROM space_board_whiteboard WHERE space_id=?", spaceId);
            return;
        }
        String placeholders = String.join(",", Collections.nCopies(retainedBoardIds.size(), "?"));
        var args = new ArrayList<Object>();
        args.add(spaceId);
        args.addAll(retainedBoardIds);
        db.update("DELETE FROM space_board_whiteboard WHERE space_id=? AND board_id NOT IN (" + placeholders + ")", args.toArray());
    }

    @Scheduled(cron = "0 17 4 * * *", zone = "UTC")
    void expireOperationKeys() {
        db.update("DELETE FROM space_board_whiteboard_operation WHERE created_at<CURRENT_TIMESTAMP(6)-INTERVAL 180 DAY");
    }

    private Document document(long revision, String raw, long updatedAt, boolean canClear) {
        return new Document(revision, decode(raw), updatedAt, canClear);
    }

    private List<Stroke> decode(String raw) {
        try { return json.readValue(raw, json.getTypeFactory().constructCollectionType(List.class, Stroke.class)); }
        catch (JsonProcessingException error) { throw new IllegalStateException("Stored whiteboard document is invalid", error); }
    }

    private String encode(List<Stroke> strokes) {
        try { return json.writeValueAsString(strokes); }
        catch (JsonProcessingException error) { throw new IllegalStateException("Could not encode whiteboard document", error); }
    }

    private String fingerprint(Mutation mutation) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(mutation));
            return HexFormat.of().formatHex(bytes);
        } catch (Exception error) { throw new IllegalStateException("Could not fingerprint whiteboard operation", error); }
    }

    private static boolean validStroke(StrokeDraft stroke) {
        return stroke != null && stroke.color() != null && stroke.color().matches("#[0-9a-fA-F]{6}")
            && stroke.width() >= 1 && stroke.width() <= 24 && stroke.points() != null
            && !stroke.points().isEmpty() && stroke.points().size() <= MAX_POINTS
            && stroke.points().stream().allMatch(point -> point != null && point.x() >= 0 && point.x() <= 1000
                && point.y() >= 0 && point.y() <= 1000);
    }

    private static void validatePath(String spaceId, String boardId, TownPrincipal principal) {
        if (principal == null || !validUuid(spaceId) || !SpaceBoardPosts.validBoardId(boardId)) throw invalid();
    }

    private static boolean isManager(String role) { return "OWNER".equals(role) || "ADMIN".equals(role); }
    private static void requireMember(String role) {
        if (role == null || role.isBlank())
            throw new SpaceFailure(404, "WHITEBOARD_NOT_FOUND", "공간에 가입한 계정만 공동 화이트보드를 사용할 수 있어요.");
    }
    private static boolean validUuid(String id) {
        if (id == null || id.length() > 36) return false;
        try { return UUID.fromString(id).toString().equalsIgnoreCase(id); }
        catch (IllegalArgumentException error) { return false; }
    }
    private static SpaceFailure invalid() { return new SpaceFailure(400, "INVALID_WHITEBOARD_REQUEST", "화이트보드 요청 형식을 확인해 주세요."); }
    private record Stored(long revision, String strokesJson, long updatedAt) {}
}
