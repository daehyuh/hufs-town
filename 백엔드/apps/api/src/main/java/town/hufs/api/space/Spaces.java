package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.auth.SsoIdentityClaims;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class Spaces {
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final SpaceAccessContext accessContext;
    private final SecureRandom random = new SecureRandom();
    Spaces(JdbcTemplate db, TransactionTemplate tx, SpaceAccessContext accessContext) { this.db = db; this.tx = tx; this.accessContext = accessContext; }
    record Space(String id, String name, String description, String visibility, int capacity, String templateId, String role,
                 boolean approvalRequired, boolean guestEntryEnabled, String joinRequestStatus, boolean favorite,
                 List<String> allowedEmailDomains, boolean archived) {}
    record GuestSpace(String id, String name, String description, int capacity) {}
    record SpacePage(List<Space> items, int page, int pageSize, long totalItems, int totalPages,
                     boolean hasNext, boolean hasPrevious) {}
    record Draft(String name, String description, String visibility, Integer capacity, Boolean approvalRequired, String templateId,
                 List<String> allowedEmailDomains, Boolean guestEntryEnabled) {}
    record Edit(String name, String description, String visibility, Boolean approvalRequired, List<String> allowedEmailDomains,
                Boolean guestEntryEnabled) {}
    record Invite(String id, String expiresAt, int maxUses, int useCount, boolean revoked,
                  String targetUserId, String targetDisplayName) {}
    record Member(String userId, String displayName, String role, long joinedAt, Long lastVisitedAt) {}
    record AccessBlock(String userId, String displayName, long blockedAt) {}
    record JoinRequest(String id, String userId, String displayName, long requestedAt) {}
    record JoinRequestPage(List<JoinRequest> items, String nextCursor, boolean hasMore) {}
    record IncomingJoinRequest(String spaceId, String spaceName, JoinRequest request) {}
    record IncomingJoinRequestPage(List<IncomingJoinRequest> items, String nextCursor, boolean hasMore) {}
    record JoinRequestState(String status, long requestedAt) {}
    record FavoriteState(boolean favorite) {}
    record OwnershipTransfer(String spaceId, String targetUserId, String targetDisplayName, long requestedAt, long expiresAt) {}
    record IncomingOwnershipTransfer(String spaceId, String spaceName, String ownerDisplayName, long requestedAt, long expiresAt) {}
    record IncomingSpaceInvite(String inviteId, String spaceId, String spaceName, String inviterDisplayName,
                               String ownerDisplayName, long createdAt, long expiresAt) {}
    private record InviteState(Timestamp expiresAt, boolean revoked, int useCount, int maxUses, String targetUserId) {}
    record OwnershipTransferResult(String status) {}
    record ArchiveState(boolean archived) {}
    record CreatedInvite(Invite invite, String code) { @Override public String toString() { return "CreatedInvite[redacted]"; } }
    void active(String user) {
        if (db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL", Integer.class, user) != 1)
            throw new SpaceFailure(403, "ACCOUNT_UNAVAILABLE", "이 계정으로 공간을 이용할 수 없어요.");
    }
    SpacePage list(String user, String query, String view, int page, int pageSize) {
        active(user);
        String search = query == null ? "" : query.strip();
        if (search.length() > 100 || page < 1 || page > 100_000 || pageSize < 1 || pageSize > 50
            || view == null || !Set.of("browse", "mine", "favorites", "archived").contains(view)) throw invalid();
        int offset = Math.multiplyExact(page - 1, pageSize);
        String from = """
            FROM town_space s
            LEFT JOIN space_member m ON m.space_id=s.id AND m.user_id=?
            LEFT JOIN space_join_request jr ON jr.space_id=s.id AND jr.user_id=?
            """;
        String where;
        List<Object> countArgs;
        if ("archived".equals(view)) {
            where = "WHERE s.owner_id=? AND s.archived_at IS NOT NULL\n";
            countArgs = new ArrayList<>(Arrays.asList(user, user, user));
        } else {
            where = """
            WHERE s.archived_at IS NULL
              AND (m.user_id IS NOT NULL OR s.visibility='PUBLIC' OR jr.status='PENDING'
                OR (s.visibility='UNLISTED' AND EXISTS (
                    SELECT 1 FROM space_favorite visible_saved WHERE visible_saved.user_id=? AND visible_saved.space_id=s.id
                )))
              AND NOT EXISTS (SELECT 1 FROM space_access_block b WHERE b.space_id=s.id AND b.user_id=?)
              AND (m.user_id IS NOT NULL OR NOT EXISTS (
                    SELECT 1 FROM space_allowed_email_domain restricted WHERE restricted.space_id=s.id
                ) OR EXISTS (
                    SELECT 1 FROM space_allowed_email_domain allowed WHERE allowed.space_id=s.id AND allowed.email_domain=?
                ))
            """;
            countArgs = new ArrayList<>(Arrays.asList(user, user, user, user, accessContext.emailDomain()));
        }
        if ("mine".equals(view)) where += " AND m.user_id IS NOT NULL";
        if ("favorites".equals(view)) {
            where += " AND EXISTS (SELECT 1 FROM space_favorite saved WHERE saved.user_id=? AND saved.space_id=s.id)";
            countArgs.add(user);
        }
        if (!search.isEmpty()) {
            where += " AND LOCATE(?, CONCAT(s.name,' ',s.description)) > 0";
            countArgs.add(search);
        }
        where += "\n";
        long totalItems = db.queryForObject("SELECT COUNT(*) " + from + where, Long.class, countArgs.toArray());
        int totalPages = (int) ((totalItems + pageSize - 1) / pageSize);
        if (page > Math.max(1, totalPages))
            return new SpacePage(List.of(), page, pageSize, totalItems, totalPages, false, page > 1);
        List<Object> listArgs = new ArrayList<>();
        listArgs.add(user);
        listArgs.addAll(countArgs);
        listArgs.add(pageSize);
        listArgs.add(offset);
        List<Space> selected = db.query("""
            SELECT s.*, EXISTS (SELECT 1 FROM space_favorite f WHERE f.user_id=? AND f.space_id=s.id) AS favorite,
                CASE WHEN m.user_id IS NULL THEN '' WHEN m.role='OWNER' THEN 'OWNER'
                WHEN m.manager=TRUE THEN 'ADMIN' ELSE 'MEMBER' END AS member_role,
                COALESCE(jr.status, '') AS join_request_status
            """ + from + where + """
            ORDER BY s.archived_at DESC, (m.user_id IS NOT NULL) DESC, m.last_visited_at DESC, s.created_at DESC, s.id
            LIMIT ? OFFSET ?
            """, (r, n) -> new Space(r.getString("id"), r.getString("name"), r.getString("description"),
                r.getString("visibility"), r.getInt("capacity"), r.getString("template_id"), r.getString("member_role"),
                r.getBoolean("approval_required"), r.getBoolean("guest_entry_enabled"), r.getString("join_request_status"),
                r.getBoolean("favorite"), List.of(), r.getTimestamp("archived_at") != null), listArgs.toArray());
        Map<String,List<String>> allowedDomains = loadAllowedDomains(selected.stream().map(Space::id).toList());
        List<Space> items = selected.stream().map(space -> withDomains(space, allowedDomains.getOrDefault(space.id(), List.of()))).toList();
        return new SpacePage(items, page, pageSize, totalItems, totalPages, page < totalPages, page > 1);
    }
    private Space find(String id, String user, boolean lock) {
        var rows = db.query("SELECT s.*, EXISTS (SELECT 1 FROM space_favorite f WHERE f.user_id=? AND f.space_id=s.id) AS favorite FROM town_space s WHERE s.id=? AND s.archived_at IS NULL" + (lock ? " FOR UPDATE" : ""),
            (r, n) -> new Space(r.getString("id"), r.getString("name"), r.getString("description"),
                r.getString("visibility"), r.getInt("capacity"), r.getString("template_id"), "", r.getBoolean("approval_required"),
                r.getBoolean("guest_entry_enabled"), "", r.getBoolean("favorite"), List.of(), false), user, id);
        if (rows.isEmpty()) throw hidden();
        // A locking read must also read membership at the current version, not an older InnoDB snapshot.
        var roles = db.query("SELECT role,manager FROM space_member WHERE space_id=? AND user_id=?" + (lock ? " FOR UPDATE" : ""),
            (r, n) -> roleName(r.getString("role"), r.getBoolean("manager")), id, user);
        var requests = db.queryForList("SELECT status FROM space_join_request WHERE space_id=? AND user_id=?" + (lock ? " FOR UPDATE" : ""), String.class, id, user);
        var s = rows.getFirst();
        return new Space(s.id, s.name, s.description, s.visibility, s.capacity, s.templateId, roles.isEmpty() ? "" : roles.getFirst(),
            s.approvalRequired, s.guestEntryEnabled, requests.isEmpty() ? "" : requests.getFirst(), s.favorite, allowedDomains(id), false);
    }
    Space detail(String id, String user) { active(user); var s = find(id, user, false); accessAllowed(s.id(), user); readable(s); return s; }
    FavoriteState setFavorite(String id, String user, boolean favorite) {
        if (favorite) {
            tx.executeWithoutResult(status -> {
                active(user);
                var space = find(id, user, true);
                accessAllowed(space.id(), user);
                readable(space);
                db.update("INSERT IGNORE INTO space_favorite(user_id,space_id) VALUES (?,?)", user, id);
            });
        } else {
            active(user);
            db.update("DELETE FROM space_favorite WHERE user_id=? AND space_id=?", user, id);
        }
        return new FavoriteState(favorite);
    }
    Space create(String user, Draft draft) {
        String name = text(draft.name, 60, false); String description = text(draft.description, 300, true);
        String visibility = visibility(draft.visibility);
        String templateId = draft.templateId == null ? "OFFICE" : draft.templateId;
        List<String> allowedDomains = normalizeAllowedDomains(draft.allowedEmailDomains);
        boolean guestEntryEnabled = Boolean.TRUE.equals(draft.guestEntryEnabled);
        if (!Set.of("OFFICE", "CAMPUS_SQUARE", "STUDY_SPACE", "MEETUP_HALL").contains(templateId)) throw invalid();
        if (draft.capacity == null || draft.capacity < 1 || draft.capacity > 100) throw invalid();
        boolean approvalRequired = Boolean.TRUE.equals(draft.approvalRequired);
        if (approvalRequired && "PRIVATE".equals(visibility)) throw invalid();
        if (guestEntryEnabled && (!"PUBLIC".equals(visibility) || approvalRequired || !allowedDomains.isEmpty())) throw invalid();
        return tx.execute(status -> {
            // Serialize each owner's create requests so concurrent requests cannot exceed the quota.
            db.queryForList("SELECT id FROM app_user WHERE id=? FOR UPDATE", String.class, user); active(user);
            if (db.queryForObject("SELECT COUNT(*) FROM town_space WHERE owner_id=?", Integer.class, user) >= 20)
                throw new SpaceFailure(409, "SPACE_LIMIT", "만들 수 있는 공간은 계정당 20개예요.");
            String id = UUID.randomUUID().toString();
            db.update("INSERT INTO town_space(id,name,description,visibility,capacity,approval_required,guest_entry_enabled,owner_id,template_id) VALUES (?,?,?,?,?,?,?,?,?)",
                id, name, description, visibility, draft.capacity, approvalRequired, guestEntryEnabled, user, templateId);
            replaceAllowedDomains(id, allowedDomains);
            db.update("INSERT INTO space_member(space_id,user_id,role) VALUES (?,?,'OWNER')", id, user);
            return find(id, user, false);
        });
    }
    ArchiveState archive(String id, String user) {
        return tx.execute(status -> {
            active(user);
            Space space = find(id, user, true);
            owner(space);
            db.update("DELETE FROM space_ownership_transfer WHERE space_id=? AND expires_at<=CURRENT_TIMESTAMP(6)", id);
            if (db.queryForObject("SELECT COUNT(*) FROM space_ownership_transfer WHERE space_id=?", Integer.class, id) > 0)
                throw new SpaceFailure(409, "SPACE_TRANSFER_PENDING", "소유권 이전 요청을 먼저 취소하거나 처리해 주세요.");
            if (db.update("UPDATE town_space SET archived_at=CURRENT_TIMESTAMP(6) WHERE id=? AND owner_id=? AND archived_at IS NULL", id, user) != 1)
                throw new SpaceFailure(409, "SPACE_ARCHIVE_CONFLICT", "공간 상태가 바뀌었어요. 목록을 새로고침해 주세요.");
            return new ArchiveState(true);
        });
    }
    ArchiveState restore(String id, String user) {
        return tx.execute(status -> {
            active(user);
            List<String> rows = db.queryForList("SELECT id FROM town_space WHERE id=? AND owner_id=? AND archived_at IS NOT NULL FOR UPDATE", String.class, id, user);
            if (rows.isEmpty()) throw hidden();
            if (db.update("UPDATE town_space SET archived_at=NULL WHERE id=? AND owner_id=? AND archived_at IS NOT NULL", id, user) != 1)
                throw new SpaceFailure(409, "SPACE_RESTORE_CONFLICT", "공간 상태가 바뀌었어요. 보관함을 새로고침해 주세요.");
            return new ArchiveState(false);
        });
    }
    String template(String id) {
        var templates = db.queryForList("SELECT template_id FROM town_space WHERE id=? AND archived_at IS NULL", String.class, id);
        if (templates.isEmpty()) throw hidden();
        return templates.getFirst();
    }
    GuestSpace guestSpace(String id) {
        String ownerId = guestOwner(id);
        var spaces = db.query("SELECT id,name,description,capacity FROM town_space WHERE id=? AND owner_id=? AND archived_at IS NULL",
            (r, n) -> new GuestSpace(r.getString("id"), r.getString("name"), r.getString("description"), r.getInt("capacity")), id, ownerId);
        if (spaces.isEmpty()) throw guestEntryUnavailable();
        return spaces.getFirst();
    }
    String guestOwner(String id) {
        var rows = db.queryForList("""
            SELECT owner_id FROM town_space s
            WHERE s.id=? AND s.archived_at IS NULL AND s.visibility='PUBLIC' AND s.guest_entry_enabled=TRUE AND s.approval_required=FALSE
              AND s.owner_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM space_allowed_email_domain d WHERE d.space_id=s.id)
            """, String.class, id);
        if (rows.isEmpty()) throw guestEntryUnavailable();
        return rows.getFirst();
    }
    Space edit(String id, String user, Edit draft) {
        String name = text(draft.name, 60, false); String description = text(draft.description, 300, true); String visibility = visibility(draft.visibility);
        return tx.execute(status -> {
            active(user); var current = find(id, user, true); owner(current);
            boolean approvalRequired = draft.approvalRequired == null ? current.approvalRequired : draft.approvalRequired;
            if (approvalRequired && "PRIVATE".equals(visibility)) throw invalid();
            List<String> allowedDomains = draft.allowedEmailDomains == null ? current.allowedEmailDomains() : normalizeAllowedDomains(draft.allowedEmailDomains);
            boolean guestEntryEnabled = draft.guestEntryEnabled == null ? current.guestEntryEnabled : draft.guestEntryEnabled;
            if (guestEntryEnabled && (!"PUBLIC".equals(visibility) || approvalRequired || !allowedDomains.isEmpty())) throw invalid();
            db.update("UPDATE town_space SET name=?, description=?, visibility=?, approval_required=?, guest_entry_enabled=? WHERE id=?",
                name, description, visibility, approvalRequired, guestEntryEnabled, id);
            if (!current.allowedEmailDomains().equals(allowedDomains)) {
                replaceAllowedDomains(id, allowedDomains);
                db.update("UPDATE space_join_request SET status='REJECTED',resolved_at=CURRENT_TIMESTAMP(6),resolved_by_user_id=? WHERE space_id=? AND status='PENDING'", user, id);
            }
            if (current.approvalRequired() && !approvalRequired) {
                db.update("""
                    UPDATE space_join_request SET status='REJECTED',resolved_at=CURRENT_TIMESTAMP(6),resolved_by_user_id=?
                    WHERE space_id=? AND status='PENDING'
                    """, user, id);
            }
            return find(id, user, false);
        });
    }
    void setMemberRole(String id, String user, String targetUserId, String targetRole) {
        if (!validUserId(targetUserId) || user.equalsIgnoreCase(targetUserId)
            || targetRole == null || !Set.of("ADMIN", "MEMBER").contains(targetRole)) throw invalid();
        tx.executeWithoutResult(status -> {
            active(user); owner(find(id, user, true));
            var targets = db.query("SELECT role FROM space_member WHERE space_id=? AND user_id=? FOR UPDATE",
                (r, n) -> r.getString("role"), id, targetUserId);
            if (targets.isEmpty()) throw new SpaceFailure(404,"SPACE_MEMBER_NOT_FOUND","현재 공간 멤버를 찾을 수 없어요.");
            if (!"MEMBER".equals(targets.getFirst()))
                throw new SpaceFailure(403,"SPACE_OWNER_PROTECTED","공간 소유자의 역할은 변경할 수 없어요.");
            db.update("UPDATE space_member SET manager=? WHERE space_id=? AND user_id=? AND role='MEMBER'",
                "ADMIN".equals(targetRole), id, targetUserId);
        });
    }
    List<OwnershipTransfer> ownershipTransfer(String id, String user) {
        active(user); owner(find(id, user, false));
        return db.query("""
            SELECT transfer.space_id,transfer.to_user_id,account.display_name,transfer.requested_at,transfer.expires_at
            FROM space_ownership_transfer transfer JOIN app_user account ON account.id=transfer.to_user_id
            WHERE transfer.space_id=? AND transfer.from_user_id=? AND transfer.expires_at>CURRENT_TIMESTAMP(6)
            """, (r, n) -> new OwnershipTransfer(r.getString("space_id"),r.getString("to_user_id"),r.getString("display_name"),
            r.getTimestamp("requested_at").getTime(),r.getTimestamp("expires_at").getTime()), id, user);
    }
    List<IncomingOwnershipTransfer> incomingOwnershipTransfers(String user) {
        active(user);
        return db.query("""
            SELECT transfer.space_id,space.name,owner.display_name,transfer.requested_at,transfer.expires_at
            FROM space_ownership_transfer transfer
            JOIN town_space space ON space.id=transfer.space_id AND space.owner_id=transfer.from_user_id
            JOIN app_user owner ON owner.id=transfer.from_user_id
            JOIN space_member target ON target.space_id=transfer.space_id AND target.user_id=transfer.to_user_id
            WHERE transfer.to_user_id=? AND transfer.expires_at>CURRENT_TIMESTAMP(6) AND space.archived_at IS NULL
            ORDER BY transfer.requested_at,space.name LIMIT 100
            """, (r, n) -> new IncomingOwnershipTransfer(r.getString("space_id"),r.getString("name"),r.getString("display_name"),
            r.getTimestamp("requested_at").getTime(),r.getTimestamp("expires_at").getTime()), user);
    }
    List<IncomingSpaceInvite> incomingSpaceInvites(String user) {
        active(user);
        return db.query("""
            SELECT invite.id,space.id AS space_id,space.name,
                COALESCE(inviter.display_name,'공간 관리자') AS inviter_display_name,owner.display_name AS owner_display_name,
                invite.created_at,invite.expires_at
            FROM space_invite invite
            JOIN town_space space ON space.id=invite.space_id AND space.archived_at IS NULL
            JOIN app_user owner ON owner.id=space.owner_id
            LEFT JOIN app_user inviter ON inviter.id=invite.created_by_user_id
                AND inviter.status='ACTIVE' AND inviter.deleted_at IS NULL
            WHERE invite.target_user_id=? AND invite.revoked=FALSE
                AND invite.expires_at>CURRENT_TIMESTAMP(6) AND invite.use_count<invite.max_uses
                AND NOT EXISTS (SELECT 1 FROM space_access_block blocked
                    WHERE blocked.space_id=space.id AND blocked.user_id=invite.target_user_id)
                AND NOT EXISTS (SELECT 1 FROM space_member member
                    WHERE member.space_id=space.id AND member.user_id=invite.target_user_id)
            ORDER BY invite.created_at,space.name,invite.id LIMIT 50
            """, (r, n) -> new IncomingSpaceInvite(r.getString("id"),r.getString("space_id"),r.getString("name"),
                r.getString("inviter_display_name"),r.getString("owner_display_name"),
                r.getTimestamp("created_at").getTime(),r.getTimestamp("expires_at").getTime()), user);
    }
    Space acceptIncomingSpaceInvite(String inviteId, String user) {
        if (!validUserId(inviteId)) throw hidden();
        String normalizedInviteId = UUID.fromString(inviteId).toString();
        return tx.execute(status -> {
            active(user);
            // Read the space id without locking, then use the same space-before-invite lock order as redeem/revoke.
            var spaceIds = db.queryForList("SELECT space_id FROM space_invite WHERE id=? AND target_user_id=?", String.class,
                normalizedInviteId, user);
            if (spaceIds.isEmpty()) throw hidden();
            String id = spaceIds.getFirst();
            Space space = find(id, user, true);
            accessAllowed(id, user);
            var invites = db.query("""
                SELECT expires_at,revoked,use_count,max_uses,target_user_id FROM space_invite
                WHERE id=? AND space_id=? AND target_user_id=? FOR UPDATE
                """, (r, n) -> new InviteState(r.getTimestamp("expires_at"),r.getBoolean("revoked"),
                    r.getInt("use_count"),r.getInt("max_uses"),r.getString("target_user_id")),
                normalizedInviteId,id,user);
            if (invites.isEmpty()) throw hidden();
            InviteState invite = invites.getFirst();
            if (!user.equalsIgnoreCase(invite.targetUserId())) throw hidden();
            // A successful accept remains idempotent if the owner later expires or revokes the invite.
            if (!space.role().isEmpty()) return space;
            if (invite.revoked() || !invite.expiresAt().toInstant().isAfter(Instant.now())) throw badInvite();
            if (!domainAllowed(space, accessContext.emailDomain())) throw hidden();
            if (invite.useCount() >= invite.maxUses()) throw badInvite();
            db.update("INSERT INTO space_member(space_id,user_id) VALUES (?,?)", id, user);
            approvePendingJoinRequest(id, user);
            db.update("UPDATE space_invite SET use_count=use_count+1 WHERE id=?", normalizedInviteId);
            return find(id, user, false);
        });
    }
    void declineIncomingSpaceInvite(String inviteId, String user) {
        if (!validUserId(inviteId)) throw hidden();
        String normalizedInviteId = UUID.fromString(inviteId).toString();
        tx.executeWithoutResult(status -> {
            active(user);
            var spaceIds = db.queryForList("SELECT space_id FROM space_invite WHERE id=? AND target_user_id=?", String.class,
                normalizedInviteId, user);
            if (spaceIds.isEmpty()) throw hidden();
            String id = spaceIds.getFirst();
            find(id, user, true);
            db.queryForList("SELECT id FROM space_invite WHERE id=? AND space_id=? AND target_user_id=? FOR UPDATE",
                String.class, normalizedInviteId,id,user);
            if (db.update("""
                UPDATE space_invite SET revoked=TRUE
                WHERE id=? AND space_id=? AND target_user_id=? AND revoked=FALSE
                    AND expires_at>CURRENT_TIMESTAMP(6) AND use_count<max_uses
                """, normalizedInviteId,id,user) != 1) throw hidden();
        });
    }
    OwnershipTransfer requestOwnershipTransfer(String id, String user, String targetUserId) {
        if (!validUserId(targetUserId) || user.equalsIgnoreCase(targetUserId)) throw invalid();
        return tx.execute(status -> {
            active(user); owner(find(id, user, true)); active(targetUserId);
            db.update("""
                DELETE FROM space_ownership_transfer WHERE space_id=? AND
                    (expires_at<=CURRENT_TIMESTAMP(6) OR from_user_id<>? OR NOT EXISTS (
                        SELECT 1 FROM space_member target WHERE target.space_id=? AND target.user_id=space_ownership_transfer.to_user_id
                    ))
                """, id, user, id);
            var targets = db.query("SELECT account.display_name FROM space_member member JOIN app_user account ON account.id=member.user_id WHERE member.space_id=? AND member.user_id=?",
                (r, n) -> r.getString("display_name"), id, targetUserId);
            if (targets.isEmpty()) throw new SpaceFailure(409,"OWNERSHIP_TRANSFER_TARGET_NOT_MEMBER","소유권을 넘길 계정이 현재 공간 멤버가 아니에요.");
            if (db.queryForObject("SELECT COUNT(*) FROM space_ownership_transfer WHERE space_id=?", Integer.class, id) > 0)
                throw new SpaceFailure(409,"OWNERSHIP_TRANSFER_PENDING","이미 처리 중인 소유권 이전 요청이 있어요.");
            Timestamp requested = Timestamp.from(Instant.now());
            Timestamp expires = Timestamp.from(Instant.now().plus(Duration.ofDays(7)));
            db.update("INSERT INTO space_ownership_transfer(space_id,from_user_id,to_user_id,requested_at,expires_at) VALUES (?,?,?,?,?)",
                id,user,targetUserId,requested,expires);
            return new OwnershipTransfer(id,targetUserId,targets.getFirst(),requested.getTime(),expires.getTime());
        });
    }
    void cancelOwnershipTransfer(String id, String user) {
        tx.executeWithoutResult(status -> {
            active(user); owner(find(id, user, true));
            if (db.update("DELETE FROM space_ownership_transfer WHERE space_id=? AND from_user_id=?", id, user) != 1)
                throw new SpaceFailure(404,"OWNERSHIP_TRANSFER_NOT_FOUND","취소할 소유권 이전 요청이 없어요.");
        });
    }
    OwnershipTransferResult respondOwnershipTransfer(String id, String user, String decision) {
        if (decision == null || !Set.of("ACCEPT", "DECLINE").contains(decision)) throw invalid();
        return tx.execute(status -> {
            active(user);
            Space current = find(id, user, true);
            var rows = db.query("""
                SELECT from_user_id,expires_at FROM space_ownership_transfer
                WHERE space_id=? AND to_user_id=? FOR UPDATE
                """, (r, n) -> Map.entry(r.getString("from_user_id"),r.getTimestamp("expires_at")), id, user);
            if (rows.isEmpty()) throw new SpaceFailure(404,"OWNERSHIP_TRANSFER_NOT_FOUND","대기 중인 소유권 이전 요청이 없어요.");
            String previousOwner = rows.getFirst().getKey();
            Timestamp expiresAt = rows.getFirst().getValue();
            if (!expiresAt.toInstant().isAfter(Instant.now())) {
                db.update("DELETE FROM space_ownership_transfer WHERE space_id=?", id);
                return new OwnershipTransferResult("EXPIRED");
            }
            var ownerIds = db.queryForList("SELECT owner_id FROM town_space WHERE id=?", String.class, id);
            if (ownerIds.isEmpty() || !previousOwner.equals(ownerIds.getFirst()) || current.role().isEmpty()) {
                db.update("DELETE FROM space_ownership_transfer WHERE space_id=?", id);
                return new OwnershipTransferResult("UNAVAILABLE");
            }
            if ("DECLINE".equals(decision)) {
                db.update("DELETE FROM space_ownership_transfer WHERE space_id=?", id);
                return new OwnershipTransferResult("DECLINED");
            }
            var previousMembership = db.query("SELECT role FROM space_member WHERE space_id=? AND user_id=? FOR UPDATE",
                (r, n) -> r.getString("role"), id, previousOwner);
            if (previousMembership.isEmpty() || !"OWNER".equals(previousMembership.getFirst())) {
                db.update("DELETE FROM space_ownership_transfer WHERE space_id=?", id);
                return new OwnershipTransferResult("UNAVAILABLE");
            }
            if (db.update("UPDATE town_space SET owner_id=? WHERE id=? AND owner_id=?", user,id,previousOwner) != 1)
                throw new SpaceFailure(409,"OWNERSHIP_TRANSFER_CONFLICT","공간 소유자가 바뀌었어요. 공간 목록을 새로고침해 주세요.");
            db.update("UPDATE space_member SET role='MEMBER',manager=TRUE WHERE space_id=? AND user_id=? AND role='OWNER'", id,previousOwner);
            db.update("UPDATE space_member SET role='OWNER',manager=FALSE WHERE space_id=? AND user_id=?", id,user);
            db.update("DELETE FROM space_ownership_transfer WHERE space_id=?", id);
            return new OwnershipTransferResult("ACCEPTED");
        });
    }
    Space join(String id, String user) {
        return tx.execute(status -> {
            active(user); var s = find(id, user, true); accessAllowed(s.id(), user); readable(s);
            if (s.role().isEmpty() && s.approvalRequired())
                throw new SpaceFailure(403, "JOIN_APPROVAL_REQUIRED", "이 공간은 소유자의 입장 승인이 필요해요.");
            db.update("INSERT INTO space_member(space_id,user_id,last_visited_at) VALUES (?,?,CURRENT_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE last_visited_at=CURRENT_TIMESTAMP(6)", id, user);
            approvePendingJoinRequest(id, user);
            return find(id, user, false);
        });
    }
    JoinRequestState requestJoin(String id, String user) {
        return tx.execute(status -> {
            active(user); var space = find(id, user, true); accessAllowed(id, user); readable(space);
            if (!space.role().isEmpty()) {
                approvePendingJoinRequest(id, user);
                return new JoinRequestState("MEMBER", System.currentTimeMillis());
            }
            if (!space.approvalRequired())
                throw new SpaceFailure(409, "JOIN_APPROVAL_NOT_REQUIRED", "이 공간은 승인 없이 입장할 수 있어요.");
            var existing = db.query("SELECT status,requested_at FROM space_join_request WHERE space_id=? AND user_id=? FOR UPDATE",
                (r, n) -> new JoinRequestState(r.getString("status"), r.getTimestamp("requested_at").getTime()), id, user);
            if (!existing.isEmpty() && "PENDING".equals(existing.getFirst().status())) return existing.getFirst();
            if (existing.isEmpty()) {
                db.update("INSERT INTO space_join_request(id,space_id,user_id,status) VALUES (?,?,?,'PENDING')",
                    UUID.randomUUID().toString(), id, user);
            } else {
                db.update("UPDATE space_join_request SET status='PENDING',requested_at=CURRENT_TIMESTAMP(6),resolved_at=NULL,resolved_by_user_id=NULL WHERE space_id=? AND user_id=?",
                    id, user);
            }
            return db.queryForObject("SELECT status,requested_at FROM space_join_request WHERE space_id=? AND user_id=?",
                (r, n) -> new JoinRequestState(r.getString("status"), r.getTimestamp("requested_at").getTime()), id, user);
        });
    }
    JoinRequestPage joinRequests(String id, String user, String cursor, int limit) {
        active(user); manager(find(id, user, false));
        if (limit < 1 || limit > 100) throw invalid();
        JoinRequestCursor after = decodeJoinRequestCursor(cursor);
        String query = """
            SELECT request.id,request.user_id,account.display_name,request.requested_at
            FROM space_join_request request JOIN app_user account ON account.id=request.user_id
            WHERE request.space_id=? AND request.status='PENDING'
            """;
        List<Object> arguments = new ArrayList<>(List.of(id));
        if (after != null) {
            query += " AND (request.requested_at<? OR (request.requested_at=? AND request.id<?))\n";
            arguments.add(after.requestedAt());
            arguments.add(after.requestedAt());
            arguments.add(after.requestId());
        }
        query += " ORDER BY request.requested_at DESC,request.id DESC LIMIT ?";
        arguments.add(limit + 1);
        List<JoinRequestRow> rows = db.query(query, (r, n) -> {
            Timestamp requestedAt = r.getTimestamp("requested_at");
            return new JoinRequestRow(new JoinRequest(r.getString("id"), r.getString("user_id"), r.getString("display_name"),
                requestedAt.getTime()), requestedAt);
        }, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        List<JoinRequestRow> page = rows.subList(0, Math.min(rows.size(), limit));
        List<JoinRequest> items = page.stream().map(JoinRequestRow::request).toList();
        String nextCursor = hasMore ? encodeJoinRequestCursor(page.getLast().requestedAt(), page.getLast().request().id()) : null;
        return new JoinRequestPage(items, nextCursor, hasMore);
    }
    private record JoinRequestRow(JoinRequest request, Timestamp requestedAt) {}
    IncomingJoinRequestPage incomingJoinRequests(String user, String cursor, int limit) {
        active(user);
        if (limit < 1 || limit > 100) throw invalid();
        JoinRequestCursor after = decodeJoinRequestCursor(cursor);
        String query = """
            SELECT space.id AS space_id,space.name AS space_name,jr.id AS request_id,
                jr.user_id,account.display_name,jr.requested_at
            FROM town_space space
            JOIN space_member member ON member.space_id=space.id AND member.user_id=?
                AND (member.role='OWNER' OR member.manager=TRUE)
            JOIN space_join_request jr ON jr.space_id=space.id AND jr.status='PENDING'
            JOIN app_user account ON account.id=jr.user_id AND account.status='ACTIVE' AND account.deleted_at IS NULL
            WHERE space.archived_at IS NULL AND space.approval_required=TRUE
            """;
        List<Object> arguments = new ArrayList<>(List.of(user));
        if (after != null) {
            query += " AND (jr.requested_at<? OR (jr.requested_at=? AND jr.id<?))\n";
            arguments.add(after.requestedAt());
            arguments.add(after.requestedAt());
            arguments.add(after.requestId());
        }
        query += " ORDER BY jr.requested_at DESC,jr.id DESC LIMIT ?";
        arguments.add(limit + 1);
        List<IncomingJoinRequestRow> rows = db.query(query, (r, n) -> {
            Timestamp requestedAt = r.getTimestamp("requested_at");
            return new IncomingJoinRequestRow(r.getString("space_id"), r.getString("space_name"),
                new JoinRequest(r.getString("request_id"), r.getString("user_id"), r.getString("display_name"),
                    requestedAt.getTime()), requestedAt);
        }, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        List<IncomingJoinRequestRow> page = rows.subList(0, Math.min(rows.size(), limit));
        List<IncomingJoinRequest> items = page.stream().map(IncomingJoinRequestRow::item).toList();
        String nextCursor = hasMore ? encodeJoinRequestCursor(page.getLast().requestedAt(), page.getLast().request().id()) : null;
        return new IncomingJoinRequestPage(items, nextCursor, hasMore);
    }
    private record JoinRequestCursor(Timestamp requestedAt, String requestId) {}
    private record IncomingJoinRequestRow(String spaceId, String spaceName, JoinRequest request, Timestamp requestedAt) {
        IncomingJoinRequest item() { return new IncomingJoinRequest(spaceId, spaceName, request); }
    }
    private static String encodeJoinRequestCursor(Timestamp requestedAt, String requestId) {
        String value = requestedAt.toString() + "|" + requestId;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }
    private static JoinRequestCursor decodeJoinRequestCursor(String value) {
        if (value == null || value.isBlank()) return null;
        if (value.length() > 200) throw invalid();
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
            int separator = decoded.lastIndexOf('|');
            if (separator <= 0) throw invalid();
            Timestamp requestedAt = Timestamp.valueOf(decoded.substring(0, separator));
            String requestId = decoded.substring(separator + 1);
            if (!validUserId(requestId)) throw invalid();
            return new JoinRequestCursor(requestedAt, requestId);
        } catch (IllegalArgumentException malformed) {
            throw invalid();
        }
    }
    void resolveJoinRequest(String id, String user, String requestId, String decision) {
        if (!validUserId(requestId) || decision == null || !Set.of("APPROVE", "REJECT").contains(decision)) throw invalid();
        tx.executeWithoutResult(status -> {
            active(user); manager(find(id, user, true));
            var targets = db.queryForList("SELECT user_id FROM space_join_request WHERE id=? AND space_id=? AND status='PENDING' FOR UPDATE",
                String.class, requestId, id);
            if (targets.isEmpty()) throw new SpaceFailure(404,"JOIN_REQUEST_NOT_FOUND","대기 중인 입장 요청을 찾을 수 없어요.");
            String target = targets.getFirst(); active(target);
            if ("APPROVE".equals(decision)) {
                accessAllowed(id, target);
                db.update("INSERT INTO space_member(space_id,user_id) VALUES (?,?)", id, target);
            }
            db.update("UPDATE space_join_request SET status=?,resolved_at=CURRENT_TIMESTAMP(6),resolved_by_user_id=? WHERE id=? AND status='PENDING'",
                "APPROVE".equals(decision) ? "APPROVED" : "REJECTED", user, requestId);
        });
    }
    List<Member> members(String id, String user) {
        active(user); manager(find(id, user, false));
        return db.query("""
            SELECT member.user_id,account.display_name,member.role,member.manager,member.joined_at,member.last_visited_at
            FROM space_member member JOIN app_user account ON account.id=member.user_id
            WHERE member.space_id=? ORDER BY (member.role='OWNER') DESC,member.manager DESC,account.display_name,member.user_id
            """, (r, n) -> {
                Timestamp lastVisited = r.getTimestamp("last_visited_at");
                return new Member(r.getString("user_id"),r.getString("display_name"),roleName(r.getString("role"),r.getBoolean("manager")),
                    r.getTimestamp("joined_at").getTime(),lastVisited == null ? null : lastVisited.getTime());
            }, id);
    }
    List<AccessBlock> accessBlocks(String id, String user) {
        active(user); manager(find(id, user, false));
        return db.query("""
            SELECT blocked.user_id,account.display_name,blocked.blocked_at
            FROM space_access_block blocked JOIN app_user account ON account.id=blocked.user_id
            WHERE blocked.space_id=? ORDER BY blocked.blocked_at DESC,blocked.user_id LIMIT 200
            """, (r, n) -> new AccessBlock(r.getString("user_id"),r.getString("display_name"),
            r.getTimestamp("blocked_at").getTime()), id);
    }
    void kickMember(String id, String user, String targetUserId) {
        if (!validUserId(targetUserId) || user.equalsIgnoreCase(targetUserId)) throw invalid();
        tx.executeWithoutResult(status -> {
            active(user); manager(find(id, user, true));
            var roles = db.query("SELECT role,manager FROM space_member WHERE space_id=? AND user_id=? FOR UPDATE",
                (r, n) -> Map.entry(r.getString("role"),r.getBoolean("manager")), id, targetUserId);
            if (roles.isEmpty()) throw new SpaceFailure(404,"SPACE_MEMBER_NOT_FOUND","현재 공간 멤버를 찾을 수 없어요.");
            if (!"MEMBER".equals(roles.getFirst().getKey()))
                throw new SpaceFailure(403,"SPACE_OWNER_PROTECTED","공간 소유자는 내보낼 수 없어요.");
            if (roles.getFirst().getValue())
                throw new SpaceFailure(403,"SPACE_ADMIN_PROTECTED","관리자 권한을 먼저 해제해야 내보낼 수 있어요.");
            db.update("""
                UPDATE town_room_reservation
                SET cancelled_at=COALESCE(cancelled_at,CURRENT_TIMESTAMP(6)),updated_at=CURRENT_TIMESTAMP(6)
                WHERE space_id=? AND organizer_user_id=? AND cancelled_at IS NULL
                  AND ends_at>CURRENT_TIMESTAMP(6)
                """, id, targetUserId);
            db.update("""
                INSERT INTO space_access_block(space_id,user_id,blocked_by_user_id)
                VALUES (?,?,?) ON DUPLICATE KEY UPDATE blocked_by_user_id=VALUES(blocked_by_user_id),
                    blocked_at=CURRENT_TIMESTAMP(6)
                """, id, targetUserId, user);
            db.update("DELETE FROM space_ownership_transfer WHERE space_id=? AND to_user_id=?", id, targetUserId);
            db.update("DELETE FROM space_member WHERE space_id=? AND user_id=? AND role='MEMBER'", id, targetUserId);
        });
    }
    void unblockMember(String id, String user, String targetUserId) {
        if (!validUserId(targetUserId)) throw invalid();
        tx.executeWithoutResult(status -> {
            active(user); manager(find(id, user, true));
            if (db.update("DELETE FROM space_access_block WHERE space_id=? AND user_id=?", id, targetUserId) != 1)
                throw new SpaceFailure(404,"SPACE_BLOCK_NOT_FOUND","입장을 제한한 계정을 찾을 수 없어요.");
        });
    }
    List<Invite> invites(String id, String user) {
        active(user); manager(find(id, user, false));
        return db.query("""
            SELECT invite.id,invite.expires_at,invite.max_uses,invite.use_count,invite.revoked,
                invite.target_user_id,account.display_name AS target_display_name
            FROM space_invite invite LEFT JOIN app_user account ON account.id=invite.target_user_id
            WHERE invite.space_id=? ORDER BY invite.created_at DESC LIMIT 50
            """, (r, n) -> new Invite(r.getString("id"), r.getTimestamp("expires_at").toInstant().toString(),
                r.getInt("max_uses"), r.getInt("use_count"), r.getBoolean("revoked"),
                r.getString("target_user_id"), r.getString("target_display_name")), id);
    }
    CreatedInvite invite(String id, String user, Integer hours, Integer maxUses, String requestedTargetUserId) {
        if (hours == null || hours < 1 || hours > 168 || maxUses == null || maxUses < 1 || maxUses > 100) throw invalid();
        String targetUserId = null;
        if (requestedTargetUserId != null && !requestedTargetUserId.isBlank()) {
            if (!validUserId(requestedTargetUserId)) throw invalid();
            targetUserId = UUID.fromString(requestedTargetUserId).toString();
            if (user.equalsIgnoreCase(targetUserId)) throw invalid();
            if (maxUses != 1) throw invalid();
        }
        final String target = targetUserId;
        return tx.execute(status -> {
            active(user); manager(find(id, user, true));
            String targetDisplayName = null;
            if (target != null) {
                active(target);
                targetDisplayName = db.queryForObject("SELECT display_name FROM app_user WHERE id=?", String.class, target);
            }
            if (db.queryForObject("SELECT COUNT(*) FROM space_invite WHERE space_id=? AND revoked=FALSE AND expires_at>CURRENT_TIMESTAMP(6) AND use_count<max_uses FOR UPDATE", Integer.class, id) >= 20)
                throw new SpaceFailure(409, "INVITE_LIMIT", "유효한 초대는 공간당 20개까지 만들 수 있어요. 이전 초대를 취소해 주세요.");
            byte[] bytes = new byte[16]; random.nextBytes(bytes);
            String code = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
            var invite = new Invite(UUID.randomUUID().toString(), Instant.now().plus(Duration.ofHours(hours)).toString(), maxUses, 0, false, target, targetDisplayName);
            db.update("INSERT INTO space_invite(id,space_id,code_hash,expires_at,max_uses,target_user_id,created_by_user_id) VALUES (?,?,?,?,?,?,?)",
                invite.id, id, hash(code), Timestamp.from(Instant.parse(invite.expiresAt)), maxUses, target, user);
            return new CreatedInvite(invite, code);
        });
    }
    void revoke(String id, String inviteId, String user) {
        tx.executeWithoutResult(status -> {
            active(user); manager(find(id, user, true));
            if (db.update("UPDATE space_invite SET revoked=TRUE WHERE id=? AND space_id=?", inviteId, id) != 1) throw hidden();
        });
    }
    Space redeem(String code, String user) {
        if (code == null || !code.matches("[A-Za-z0-9_-]{22}")) throw badInvite();
        return tx.execute(status -> {
            active(user);
            var ids = db.queryForList("SELECT space_id FROM space_invite WHERE code_hash=?", String.class, hash(code));
            if (ids.isEmpty()) throw badInvite();
            String id = ids.getFirst(); var s = find(id, user, true);
            accessAllowed(id, user);
            // All invite changes acquire the space lock first; retries by an existing member consume no use.
            var invites = db.queryForList("SELECT id, expires_at, revoked, use_count, max_uses, target_user_id FROM space_invite WHERE code_hash=? FOR UPDATE", hash(code));
            var invite = invites.getFirst();
            if (((Boolean)invite.get("revoked")) || !((Timestamp)invite.get("expires_at")).toInstant().isAfter(Instant.now())) throw badInvite();
            String targetUserId = (String) invite.get("target_user_id");
            if (targetUserId != null && !targetUserId.equalsIgnoreCase(user)) throw badInvite();
            if (!s.role.isEmpty()) return s;
            // Invites bypass approval for eligible accounts, but never bypass an owner's email-domain policy.
            if (!domainAllowed(s, accessContext.emailDomain())) throw hidden();
            if (((Number)invite.get("use_count")).intValue() >= ((Number)invite.get("max_uses")).intValue()) throw badInvite();
            db.update("INSERT INTO space_member(space_id,user_id) VALUES (?,?)", id, user);
            approvePendingJoinRequest(id, user);
            db.update("UPDATE space_invite SET use_count=use_count+1 WHERE id=?", invite.get("id"));
            return find(id, user, false);
        });
    }
    private void accessAllowed(String spaceId, String userId) {
        if (db.queryForObject("SELECT COUNT(*) FROM space_access_block WHERE space_id=? AND user_id=?", Integer.class,
            spaceId, userId) > 0)
            throw new SpaceFailure(403,"SPACE_ACCESS_REVOKED","공간 소유자가 이 공간 입장을 제한했어요.");
    }
    private void approvePendingJoinRequest(String spaceId, String userId) {
        db.update("""
            UPDATE space_join_request SET status='APPROVED',resolved_at=CURRENT_TIMESTAMP(6),
                resolved_by_user_id=(SELECT owner_id FROM town_space WHERE id=?)
            WHERE space_id=? AND user_id=? AND status='PENDING'
            """, spaceId, spaceId, userId);
    }
    private static boolean validUserId(String value) {
        if (value == null) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException invalid) { return false; }
    }
    void requireManager(String id, String user) { manager(detail(id, user)); }
    void requireOwner(String id, String user) { owner(detail(id, user)); }
    private static String roleName(String role, boolean manager) {
        return "OWNER".equals(role) ? "OWNER" : manager ? "ADMIN" : "MEMBER";
    }
    private void readable(Space s) {
        if ((s.visibility.equals("PRIVATE") || !domainAllowed(s, accessContext.emailDomain())) && s.role.isEmpty()) throw hidden();
    }
    private static void owner(Space s) { if (!s.role.equals("OWNER")) throw new SpaceFailure(403, "OWNER_REQUIRED", "공간을 만든 사람만 설정과 초대를 관리할 수 있어요."); }
    private static void manager(Space s) {
        if (!Set.of("OWNER", "ADMIN").contains(s.role()))
            throw new SpaceFailure(403, "MANAGER_REQUIRED", "공간 소유자 또는 관리자가 필요한 작업이에요.");
    }
    private static SpaceFailure hidden() { return new SpaceFailure(404, "SPACE_NOT_FOUND", "공간을 찾을 수 없거나 입장 권한이 없어요. 초대 코드를 확인해 주세요."); }
    private static SpaceFailure badInvite() { return new SpaceFailure(400, "INVITE_UNAVAILABLE", "유효하지 않거나 만료·취소된 초대예요. 사용 인원이 모두 찼을 수도 있어요."); }
    private static SpaceFailure guestEntryUnavailable() { return new SpaceFailure(404, "GUEST_ENTRY_UNAVAILABLE", "게스트 입장이 허용된 공개 공간을 찾을 수 없어요."); }
    private static SpaceFailure invalid() { return new SpaceFailure(400, "INVALID_SPACE", "공간 이름, 공개 범위와 인원 설정을 확인해 주세요."); }
    private static String text(String input, int max, boolean empty) {
        if (input == null) throw invalid(); String value = input.strip();
        if ((!empty && value.isEmpty()) || value.length() > max || value.codePoints().anyMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT)) throw invalid();
        return value;
    }
    private static String visibility(String v) { if (v == null || !Set.of("PUBLIC", "UNLISTED", "PRIVATE").contains(v)) throw invalid(); return v; }
    private List<String> allowedDomains(String spaceId) {
        return db.queryForList("SELECT email_domain FROM space_allowed_email_domain WHERE space_id=? ORDER BY email_domain", String.class, spaceId);
    }
    private Map<String,List<String>> loadAllowedDomains(List<String> spaceIds) {
        if (spaceIds.isEmpty()) return Map.of();
        String marks = String.join(",", Collections.nCopies(spaceIds.size(), "?"));
        Map<String,List<String>> result = new HashMap<>();
        db.query("SELECT space_id,email_domain FROM space_allowed_email_domain WHERE space_id IN (" + marks + ") ORDER BY email_domain",
            (org.springframework.jdbc.core.RowCallbackHandler) r -> result.computeIfAbsent(r.getString("space_id"), ignored -> new ArrayList<>()).add(r.getString("email_domain")), spaceIds.toArray());
        return result;
    }
    private void replaceAllowedDomains(String spaceId, List<String> domains) {
        db.update("DELETE FROM space_allowed_email_domain WHERE space_id=?", spaceId);
        domains.forEach(domain -> db.update("INSERT INTO space_allowed_email_domain(space_id,email_domain) VALUES (?,?)", spaceId, domain));
    }
    private static boolean domainAllowed(Space space, String emailDomain) {
        return space.allowedEmailDomains().isEmpty() || (emailDomain != null && space.allowedEmailDomains().contains(emailDomain));
    }
    private static Space withDomains(Space s, List<String> domains) {
        return new Space(s.id(), s.name(), s.description(), s.visibility(), s.capacity(), s.templateId(), s.role(),
            s.approvalRequired(), s.guestEntryEnabled(), s.joinRequestStatus(), s.favorite(), domains, s.archived());
    }
    private static List<String> normalizeAllowedDomains(List<String> domains) {
        if (domains == null || domains.isEmpty()) return List.of();
        if (domains.size() > 20) throw invalid();
        TreeSet<String> normalized = new TreeSet<>();
        for (String input : domains) {
            if (input == null || input.length() > 253 || !input.equals(input.strip())) throw invalid();
            String domain = SsoIdentityClaims.emailDomain("member@" + input);
            if (domain == null) throw invalid();
            normalized.add(domain);
        }
        if (normalized.size() != domains.size()) throw invalid();
        return List.copyOf(normalized);
    }
    private static String hash(String code) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(code.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
