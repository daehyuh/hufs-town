package town.hufs.api.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.api.space.SpaceAssets;

import java.util.List;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
final class AccountDeletionService {
    record OwnedSpace(String id, String name) {}
    record Impact(List<OwnedSpace> ownedSpaces) {}

    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final SpaceAssets spaceAssets;

    AccountDeletionService(JdbcTemplate db, TransactionTemplate transactions, SpaceAssets spaceAssets) {
        this.db = db;
        this.transactions = transactions;
        this.spaceAssets = spaceAssets;
    }

    Impact impact(String userId) {
        requireActive(userId, false);
        return new Impact(ownedSpaces(userId, false));
    }

    void delete(String userId, String confirmation, Runnable revokeSessions) {
        if (!"탈퇴".equals(confirmation))
            throw new AuthFailure(HttpStatus.BAD_REQUEST, "ACCOUNT_DELETE_CONFIRMATION_REQUIRED", "확인란에 ‘탈퇴’를 입력해 주세요.");
        List<SpaceAssets.ErasedPendingFile> filesToDelete = transactions.execute(status -> {
            requireActive(userId, true);
            List<OwnedSpace> owned = ownedSpaces(userId, true);
            if (!owned.isEmpty())
                throw new AuthFailure(HttpStatus.CONFLICT, "ACCOUNT_OWNS_SPACES", "소유권을 다른 멤버에게 이전한 뒤 다시 탈퇴해 주세요.");

            // Revoke every indexed browser session before changing the account. If Redis is
            // unavailable, the transaction rolls back instead of leaving a half-deleted user.
            revokeSessions.run();

            List<SpaceAssets.ErasedPendingFile> pendingFiles = spaceAssets.rejectPendingUploadsForAccountErasure(userId);
            transferGroupOwnership(userId);
            removePersonalContent(userId);
            removeMemberships(userId);
            anonymizeRetainedRecords(userId);

            db.update("""
                UPDATE app_user
                SET status='DELETED',deleted_at=CURRENT_TIMESTAMP(6),display_name='탈퇴한 사용자',
                    avatar_preset=0,avatar_skin='light',avatar_clothing='casual_white',avatar_hair='hair_short_black',
                    profile_bio='',profile_links='',allow_pokes=FALSE,version=version+1
                WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL
                """, userId);
            db.update("DELETE FROM oauth_identity WHERE user_id=?", userId);
            db.update("DELETE FROM public_password_account WHERE user_id=?", userId);
            return pendingFiles;
        });
        if (filesToDelete != null) spaceAssets.deleteErasedPendingFiles(filesToDelete);
    }

    private void requireActive(String userId, boolean lock) {
        String sql = "SELECT id FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL" + (lock ? " FOR UPDATE" : "");
        if (db.queryForList(sql, String.class, userId).isEmpty())
            throw new AuthFailure(HttpStatus.FORBIDDEN, "ACCOUNT_UNAVAILABLE", "탈퇴했거나 사용할 수 없는 계정이에요.");
    }

    private List<OwnedSpace> ownedSpaces(String userId, boolean lock) {
        String sql = "SELECT id,name FROM town_space WHERE owner_id=? ORDER BY id" + (lock ? " FOR UPDATE" : "");
        return db.query(sql, (rs, row) -> new OwnedSpace(rs.getString("id"), rs.getString("name")), userId);
    }

    private void transferGroupOwnership(String userId) {
        List<String> ownedGroups = db.queryForList("""
            SELECT id FROM direct_conversation
            WHERE conversation_kind='GROUP' AND owner_user_id=?
            ORDER BY id FOR UPDATE
            """, String.class, userId);
        for (String conversationId : ownedGroups) {
            List<String> successors = db.queryForList("""
                SELECT member.user_id
                FROM direct_conversation_member member
                JOIN app_user account ON account.id=member.user_id
                    AND account.status='ACTIVE' AND account.deleted_at IS NULL
                WHERE member.conversation_id=? AND member.user_id<>?
                ORDER BY member.joined_at,member.user_id
                LIMIT 1 FOR UPDATE
                """, String.class, conversationId, userId);
            if (successors.isEmpty()) {
                db.update("DELETE FROM direct_conversation WHERE id=?", conversationId);
            } else {
                db.update("UPDATE direct_conversation SET owner_user_id=?,creation_key=CONCAT('deleted:',id) WHERE id=? AND owner_user_id=?",
                    successors.getFirst(), conversationId, userId);
            }
        }
    }

    private void removePersonalContent(String userId) {
        db.update("DELETE FROM chat_message_recipient WHERE user_id=?", userId);
        db.update("DELETE FROM chat_message WHERE sender_user_id=?", userId);
        // A member can leave edit/read metadata on another member's DM. These rows
        // have actor foreign keys, but account deletion is a soft delete.
        db.update("DELETE FROM direct_message_event_outbox WHERE actor_user_id=?", userId);
        db.update("DELETE FROM direct_message_mutation WHERE actor_user_id=?", userId);
        db.update("DELETE FROM direct_message WHERE sender_user_id=?", userId);
        db.update("DELETE FROM space_board_post WHERE author_user_id=?", userId);
        db.update("DELETE FROM town_event_question WHERE asker_user_id=?", userId);
        db.update("DELETE FROM town_event_attendance WHERE user_id=?", userId);
        db.update("UPDATE town_event SET host_user_id=NULL WHERE host_user_id=?", userId);
        db.update("""
            UPDATE town_event_poll_option option_row
            JOIN (
                SELECT poll_id,COUNT(*) AS removed_votes
                FROM town_event_poll_vote WHERE user_id=? GROUP BY poll_id
            ) votes ON votes.poll_id=option_row.poll_id
            SET option_row.vote_count=GREATEST(0,option_row.vote_count-votes.removed_votes)
            """, userId);
        db.update("DELETE FROM town_event_poll_vote WHERE user_id=?", userId);
        db.update("DELETE FROM town_scheduled_event_rsvp WHERE user_id=?", userId);
        db.update("DELETE FROM web_push_subscription WHERE user_id=?", userId);
        db.update("DELETE FROM direct_message_push_outbox WHERE recipient_user_id=?", userId);
        db.update("UPDATE user_chat_restriction SET updated_by_user_id=NULL WHERE updated_by_user_id=?", userId);
        db.update("DELETE FROM user_chat_restriction WHERE user_id=?", userId);
        db.update("UPDATE user_world_restriction SET updated_by_user_id=NULL WHERE updated_by_user_id=?", userId);
        db.update("DELETE FROM user_world_restriction WHERE user_id=?", userId);
        db.update("UPDATE user_media_mute SET updated_by_user_id=NULL WHERE updated_by_user_id=?", userId);
        db.update("DELETE FROM user_media_mute WHERE user_id=?", userId);
        db.update("UPDATE guest_moderation_restriction SET updated_by_user_id=NULL WHERE updated_by_user_id=?", userId);
    }

    private void removeMemberships(String userId) {
        db.update("DELETE FROM direct_conversation_invite WHERE inviter_user_id=? OR invitee_user_id=?", userId, userId);
        List<String> conversations = db.queryForList(
            "SELECT conversation_id FROM direct_conversation_member WHERE user_id=? FOR UPDATE", String.class, userId);
        db.update("DELETE FROM direct_conversation_member WHERE user_id=?", userId);
        for (String conversationId : conversations) {
            Integer remaining = db.queryForObject(
                "SELECT COUNT(*) FROM direct_conversation_member WHERE conversation_id=?", Integer.class, conversationId);
            if (remaining != null && remaining < 2)
                db.update("DELETE FROM direct_conversation WHERE id=?", conversationId);
        }

        db.update("DELETE FROM space_favorite WHERE user_id=?", userId);
        db.update("DELETE FROM space_join_request WHERE user_id=?", userId);
        db.update("UPDATE space_join_request SET resolved_by_user_id=NULL WHERE resolved_by_user_id=?", userId);
        db.update("DELETE FROM social_join_request WHERE requester_user_id=? OR target_user_id=?", userId, userId);
        db.update("DELETE FROM user_friendship WHERE user_a_id=? OR user_b_id=?", userId, userId);
        db.update("DELETE FROM user_social_preference WHERE user_id=?", userId);
        db.update("DELETE FROM space_invite WHERE target_user_id=? OR created_by_user_id=?", userId, userId);
        db.update("DELETE FROM space_ownership_transfer WHERE from_user_id=? OR to_user_id=?", userId, userId);
        db.update("DELETE FROM space_access_block WHERE user_id=? OR blocked_by_user_id=?", userId, userId);
        db.update("DELETE FROM user_block WHERE blocker_user_id=? OR blocked_user_id=?", userId, userId);
        db.update("DELETE FROM space_member WHERE user_id=?", userId);
    }

    private void anonymizeRetainedRecords(String userId) {
        db.update("""
            UPDATE user_report
            SET reporter_name_snapshot=IF(reporter_user_id=?,'탈퇴한 사용자',reporter_name_snapshot),
                target_name_snapshot=IF(target_user_id=?,'탈퇴한 사용자',target_name_snapshot),
                reviewer_name_snapshot=IF(reviewed_by_user_id=?,'탈퇴한 운영자',reviewer_name_snapshot),
                reporter_user_id=IF(reporter_user_id=?,NULL,reporter_user_id),
                target_user_id=IF(target_user_id=?,NULL,target_user_id),
                reviewed_by_user_id=IF(reviewed_by_user_id=?,NULL,reviewed_by_user_id)
            WHERE reporter_user_id=? OR target_user_id=? OR reviewed_by_user_id=?
            """, userId, userId, userId, userId, userId, userId, userId, userId, userId);
        db.update("""
            UPDATE user_report_review
            SET reviewer_name_snapshot='탈퇴한 운영자',reviewer_user_id=NULL
            WHERE reviewer_user_id=?
            """, userId);
        db.update("""
            UPDATE user_moderation_action
            SET note='계정 탈퇴로 사용자 식별정보가 삭제되었습니다.',
                administrator_user_id=IF(administrator_user_id=?,NULL,administrator_user_id),
                target_user_id=IF(target_user_id=?,NULL,target_user_id)
            WHERE administrator_user_id=? OR target_user_id=?
            """, userId, userId, userId, userId);
        db.update("UPDATE chat_retention_policy SET updated_by_user_id=NULL WHERE updated_by_user_id=?", userId);
        db.update("UPDATE map_revision SET actor_id=NULL WHERE actor_id=?", userId);
        db.update("""
            UPDATE space_room_note
            SET updated_by_user_id=NULL,updated_by_name='탈퇴한 사용자'
            WHERE updated_by_user_id=?
            """, userId);
        db.update("""
            UPDATE space_room_note_revision
            SET author_user_id=NULL,author_name='탈퇴한 사용자'
            WHERE author_user_id=?
            """, userId);
        db.update("""
            UPDATE space_asset
            SET original_name=IF(uploader_user_id=?,'탈퇴한 사용자 업로드',original_name),
                uploader_user_id=IF(uploader_user_id=?,NULL,uploader_user_id),
                reviewed_by_user_id=IF(reviewed_by_user_id=?,NULL,reviewed_by_user_id)
            WHERE uploader_user_id=? OR reviewed_by_user_id=?
            """, userId, userId, userId, userId, userId);
        db.update("UPDATE town_scheduled_event SET created_by=NULL WHERE created_by=?", userId);
        db.update("""
            UPDATE town_room_reservation
            SET cancelled_at=COALESCE(cancelled_at,CURRENT_TIMESTAMP(6)),updated_at=CURRENT_TIMESTAMP(6),
                organizer_user_id=NULL,organizer_name='탈퇴한 사용자'
            WHERE organizer_user_id=?
            """, userId);
    }
}
