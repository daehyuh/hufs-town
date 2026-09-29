package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import town.hufs.protocol.ChatEvent;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class DirectMessageStore {
    record OpenResult(boolean ok, String conversationId, String code, String message) {}
    record InviteResult(boolean ok, boolean shouldNotify, String invitationId, String conversationId,
                        String inviteeUserId, String groupName, long expiresAt, String code, String message) {}
    record StoreResult(boolean ok, boolean inserted, ChatEvent event, List<String> recipientUserIds, long fanoutEventId,
                       String code, String message) {}
    record MutationResult(boolean ok, ChatEvent event, List<String> memberUserIds, long fanoutEventId,
                          String code, String message) {}
    record ReadResult(boolean ok, String conversationId, String messageId, long sentAt,
                      String readerMembershipId, List<String> memberUserIds, long fanoutEventId,
                      String code, String message) {}
    private record Existing(ChatEvent event, String contentHash, String senderUserId) {}
    private record ExistingMutation(String messageId, String requestHash) {}
    private record GroupRow(String conversationId, String contentHash) {}

    private static final RowMapper<Existing> MESSAGE = (rs, row) -> {
        Timestamp editedAt = rs.getTimestamp("edited_at");
        boolean deleted = rs.getTimestamp("deleted_at") != null;
        ChatEvent event = new ChatEvent("chatEvent", rs.getString("message_id"), rs.getString("client_message_id"), "dm",
            rs.getString("conversation_id"), rs.getString("sender_player_id"), rs.getString("sender_name"),
            rs.getLong("sender_avatar"), rs.getString("sender_skin"), rs.getString("sender_clothing"),
            rs.getString("sender_hair"), deleted ? "" : rs.getString("body"), rs.getTimestamp("sent_at").getTime(), "",
            rs.getLong("revision"), editedAt == null ? 0 : editedAt.getTime(), deleted);
        return new Existing(event, rs.getString("content_hash"), rs.getString("sender_user_id"));
    };

    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final ChatRetentionPolicy retentionPolicy;
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-direct-message-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService retention = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "town-direct-message-retention");
        thread.setDaemon(true);
        return thread;
    });

    DirectMessageStore(JdbcTemplate db, TransactionTemplate tx, ChatRetentionPolicy retentionPolicy) {
        this.db = db;
        this.tx = tx;
        this.retentionPolicy = retentionPolicy;
        retention.scheduleWithFixedDelay(this::queuePurge, 1, 1, TimeUnit.HOURS);
    }

    boolean open(String requesterUserId, String targetUserId, Consumer<OpenResult> completed) {
        return submit(() -> tx.execute(status -> openConversation(requesterUserId, targetUserId)),
            result -> completed.accept(result == null ? unavailableOpen() : result), unavailableOpen());
    }

    boolean openGroup(String requesterUserId, List<String> memberUserIds, String requestId, String groupName,
                      Consumer<OpenResult> completed) {
        return submit(() -> tx.execute(status -> openGroupConversation(requesterUserId, memberUserIds, requestId, groupName)),
            result -> completed.accept(result == null ? unavailableOpen() : result), unavailableOpen());
    }

    boolean inviteGroupMember(String inviterUserId, String inviteeUserId, String conversationId, String requestId,
                              Consumer<InviteResult> completed) {
        return submit(() -> tx.execute(status -> createGroupInvitation(inviterUserId, inviteeUserId, conversationId, requestId)),
            result -> completed.accept(result == null ? unavailableInvite(conversationId) : result), unavailableInvite(conversationId));
    }

    boolean enqueue(String originNodeId, String senderUserId, ChatEvent event, Consumer<StoreResult> completed) {
        return submit(() -> tx.execute(status -> persist(originNodeId, senderUserId, event)),
            result -> completed.accept(result == null ? unavailableStore() : result), unavailableStore());
    }

    boolean mutate(String originNodeId, String actorUserId, String conversationId, String messageId, String requestId,
                   String action, String text, Consumer<MutationResult> completed) {
        return submit(() -> tx.execute(status -> mutateMessage(originNodeId, actorUserId, conversationId, messageId,
                requestId, action, text)),
            result -> completed.accept(result == null ? unavailableMutation(conversationId, messageId) : result),
            unavailableMutation(conversationId, messageId));
    }

    boolean markRead(String originNodeId, String actorUserId, String conversationId, String messageId, Consumer<ReadResult> completed) {
        return submit(() -> tx.execute(status -> advanceReadCursor(originNodeId, actorUserId, conversationId, messageId)),
            result -> completed.accept(result == null ? unavailableRead(conversationId, messageId) : result),
            unavailableRead(conversationId, messageId));
    }

    private <T> boolean submit(Callable<T> work, Consumer<T> completed, T unavailable) {
        try {
            writer.execute(() -> {
                T result;
                try {
                    result = work.call();
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("Direct message storage failed: {}", failure.getClass().getSimpleName());
                    result = unavailable;
                } catch (Exception impossible) {
                    result = unavailable;
                }
                completed.accept(result);
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    private OpenResult openConversation(String requesterUserId, String targetUserId) {
        if (requesterUserId.equals(targetUserId)) return new OpenResult(false, "", "DM_SELF", "자기 자신에게 대화를 시작할 수 없어요.");
        List<String> users = orderedUsers(requesterUserId, targetUserId);
        lockActiveUsers(users);
        if (hasAnyBlocked(users))
            return new OpenResult(false, "", "DM_BLOCKED", "차단 설정 때문에 대화를 시작할 수 없어요.");

        String pairKey = users.getFirst() + ":" + users.getLast();
        String candidateId = UUID.randomUUID().toString();
        db.update("INSERT IGNORE INTO direct_conversation(id,pair_key) VALUES (?,?)", candidateId, pairKey);
        String conversationId = db.queryForObject("SELECT id FROM direct_conversation WHERE pair_key=?", String.class, pairKey);
        db.update("INSERT IGNORE INTO direct_conversation_member(membership_id,conversation_id,user_id) VALUES (UUID(),?,?)", conversationId, users.getFirst());
        db.update("INSERT IGNORE INTO direct_conversation_member(membership_id,conversation_id,user_id) VALUES (UUID(),?,?)", conversationId, users.getLast());
        return new OpenResult(true, conversationId, "", "");
    }

    private OpenResult openGroupConversation(String requesterUserId, List<String> requestedUsers, String requestId, String rawName) {
        var users = new TreeSet<>(requestedUsers);
        users.add(requesterUserId);
        if (users.size() < 3 || users.size() > 12 || rawName == null || rawName.isBlank())
            return new OpenResult(false, "", "GROUP_INVALID", "그룹 이름과 참가자를 확인해 주세요.");
        List<String> ordered = List.copyOf(users);
        lockActiveUsers(ordered);
        if (hasAnyBlocked(ordered))
            return new OpenResult(false, "", "GROUP_BLOCKED", "참가자 간 차단 설정 때문에 그룹 대화를 만들 수 없어요.");

        String groupName = rawName.strip();
        String contentHash = groupCreationHash(groupName, ordered);
        String creationKey = requesterUserId + ":" + requestId;
        String candidateId = UUID.randomUUID().toString();
        db.update("""
            INSERT IGNORE INTO direct_conversation(id,pair_key,conversation_kind,group_name,creation_key,creation_hash,owner_user_id)
            VALUES (?,NULL,'GROUP',?,?,?,?)
            """, candidateId, groupName, creationKey, contentHash, requesterUserId);
        GroupRow row = db.query("SELECT id,creation_hash FROM direct_conversation WHERE creation_key=?",
            rs -> rs.next() ? new GroupRow(rs.getString("id"), rs.getString("creation_hash")) : null, creationKey);
        if (row == null) throw new IllegalStateException("Group conversation could not be created");
        if (!MessageDigest.isEqual(row.contentHash().getBytes(StandardCharsets.US_ASCII), contentHash.getBytes(StandardCharsets.US_ASCII)))
            return new OpenResult(false, "", "GROUP_REQUEST_CONFLICT", "이미 사용한 그룹 요청입니다. 다시 시도해 주세요.");
        for (String userId : ordered)
            db.update("INSERT IGNORE INTO direct_conversation_member(membership_id,conversation_id,user_id) VALUES (UUID(),?,?)",
                row.conversationId(), userId);
        return new OpenResult(true, row.conversationId(), "", "");
    }

    private InviteResult createGroupInvitation(String inviterUserId, String inviteeUserId, String conversationId, String requestId) {
        if (inviterUserId.equals(inviteeUserId)) return deniedInvite(conversationId, "GROUP_INVITE_SELF", "자기 자신을 초대할 수 없어요.");
        List<String> initialMembers = db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id",
            String.class, conversationId);
        if (initialMembers.isEmpty() || !initialMembers.contains(inviterUserId))
            return deniedInvite(conversationId, "GROUP_NOT_MEMBER", "그룹 대화 참가자만 초대할 수 있어요.");
        List<String> lockUsers = new TreeSet<>(initialMembers).stream().toList();
        var allUsers = new TreeSet<>(lockUsers);
        allUsers.add(inviteeUserId);
        lockActiveUsers(List.copyOf(allUsers));
        List<String> group = db.queryForList("SELECT id FROM direct_conversation WHERE id=? AND conversation_kind='GROUP' FOR UPDATE",
            String.class, conversationId);
        if (group.isEmpty()) return deniedInvite(conversationId, "GROUP_NOT_FOUND", "그룹 대화를 찾을 수 없어요.");
        List<String> members = db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id FOR UPDATE",
            String.class, conversationId);
        if (!members.equals(initialMembers) || !members.contains(inviterUserId))
            return deniedInvite(conversationId, "GROUP_MEMBERS_CHANGED", "그룹 구성이 바뀌었어요. 다시 시도해 주세요.");
        if (members.contains(inviteeUserId)) return deniedInvite(conversationId, "GROUP_ALREADY_MEMBER", "이미 그룹 대화 참가자예요.");
        if (members.size() >= 12) return deniedInvite(conversationId, "GROUP_FULL", "그룹 대화는 최대 12명까지 참여할 수 있어요.");
        var previous = db.query("""
            SELECT id,content_hash,conversation_id,invitee_user_id,expires_at,status
            FROM direct_conversation_invite WHERE inviter_user_id=? AND request_id=? FOR UPDATE
            """, rs -> rs.next() ? new Object[] { rs.getString("id"), rs.getString("content_hash"),
                rs.getString("conversation_id"), rs.getString("invitee_user_id"), rs.getTimestamp("expires_at"), rs.getString("status") } : null,
            inviterUserId, requestId);
        String hash = invitationHash(conversationId, inviteeUserId);
        if (previous != null) {
            if (!MessageDigest.isEqual(((String)previous[1]).getBytes(StandardCharsets.US_ASCII), hash.getBytes(StandardCharsets.US_ASCII)))
                return deniedInvite(conversationId, "GROUP_INVITE_REQUEST_CONFLICT", "이미 사용한 초대 요청입니다. 다시 시도해 주세요.");
            Timestamp expires = (Timestamp)previous[4];
            boolean stillPending = "PENDING".equals(previous[5]) && expires.after(Timestamp.from(Instant.now()));
            return new InviteResult(true, false, (String)previous[0], conversationId, inviteeUserId, "",
                expires.getTime(), "", stillPending ? "초대를 이미 보냈어요." : "이 초대 요청은 이미 처리되었어요.");
        }
        var participants = new ArrayList<>(members);
        participants.add(inviteeUserId);
        if (hasAnyBlocked(participants))
            return deniedInvite(conversationId, "GROUP_BLOCKED", "차단 설정 때문에 초대할 수 없어요.");
        var pending = db.query("""
            SELECT id,inviter_user_id,expires_at FROM direct_conversation_invite
            WHERE conversation_id=? AND invitee_user_id=? AND status='PENDING' AND expires_at>CURRENT_TIMESTAMP(6)
            FOR UPDATE
            """, rs -> rs.next() ? new Object[] { rs.getString("id"), rs.getString("inviter_user_id"),
                rs.getTimestamp("expires_at") } : null, conversationId, inviteeUserId);
        if (pending != null) {
            if (!inviterUserId.equals(pending[1]))
                return deniedInvite(conversationId, "GROUP_INVITE_PENDING", "이미 이 참가자에게 보낸 초대가 있어요.");
            String currentGroupName = db.queryForObject("SELECT group_name FROM direct_conversation WHERE id=?", String.class, conversationId);
            return new InviteResult(true, false, (String)pending[0], conversationId, inviteeUserId,
                currentGroupName, ((Timestamp)pending[2]).getTime(), "", "이미 초대를 보냈어요.");
        }
        String groupName = db.queryForObject("SELECT group_name FROM direct_conversation WHERE id=?", String.class, conversationId);
        String inviteId = UUID.randomUUID().toString();
        Timestamp expiresAt = Timestamp.from(Instant.now().plus(7, ChronoUnit.DAYS));
        db.update("""
            INSERT INTO direct_conversation_invite(id,conversation_id,inviter_user_id,invitee_user_id,request_id,content_hash,expires_at)
            VALUES (?,?,?,?,?,?,?)
            """, inviteId, conversationId, inviterUserId, inviteeUserId, requestId, hash, expiresAt);
        return new InviteResult(true, true, inviteId, conversationId, inviteeUserId, groupName,
            expiresAt.getTime(), "", "그룹 초대를 보냈어요.");
    }

    private StoreResult persist(String originNodeId, String senderUserId, ChatEvent event) {
        List<String> members = db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id",
            String.class, event.conversationId());
        if (members.size() < 2 || !members.contains(senderUserId)) return denied("DM_NOT_MEMBER", "대화에 참여 중인 계정이 아니에요.");
        lockActiveUsers(members);
        if (isChatRestricted(senderUserId)) return denied("CHAT_RESTRICTED", "운영 조치로 채팅이 일시 제한된 계정이에요.");
        List<String> conversation = db.queryForList(
            "SELECT id FROM direct_conversation WHERE id=? FOR UPDATE", String.class, event.conversationId());
        if (conversation.isEmpty()) return denied("DM_NOT_FOUND", "대화를 찾을 수 없어요.");
        List<String> currentMembers = db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id FOR UPDATE",
            String.class, event.conversationId());
        if (!currentMembers.equals(members)) {
            if (!currentMembers.contains(senderUserId)) return denied("DM_NOT_MEMBER", "대화에 참여 중인 계정이 아니에요.");
            return denied("DM_MEMBERS_CHANGED", "그룹 구성이 바뀌었어요. 메시지를 다시 보내 주세요.");
        }
        members = currentMembers;
        List<String> recipientUserIds = members.stream().filter(id -> !id.equals(senderUserId)).toList();
        if (hasAnyBlocked(members))
            return denied("DM_BLOCKED", "차단 설정 때문에 메시지를 보낼 수 없어요.");

        String hash = contentHash(event);
        var old = db.query("""
            SELECT message_id,client_message_id,conversation_id,sender_player_id,sender_user_id,sender_name,sender_avatar,
                   sender_skin,sender_clothing,sender_hair,body,sent_at,content_hash,revision,edited_at,deleted_at
            FROM direct_message WHERE conversation_id=? AND sender_user_id=? AND client_message_id=? FOR UPDATE
            """, MESSAGE, event.conversationId(), senderUserId, event.clientMessageId());
        if (!old.isEmpty()) return duplicate(old.getFirst(), hash, recipientUserIds,
            findFanoutEventId(old.getFirst().event().messageId(), "MESSAGE"));

        Timestamp sentAt = new Timestamp(event.sentAt());
        Timestamp expiresAt = Timestamp.from(Instant.ofEpochMilli(event.sentAt())
            .plus(retentionPolicy.days(), ChronoUnit.DAYS));
        int inserted = db.update("""
            INSERT IGNORE INTO direct_message(message_id,conversation_id,sender_user_id,sender_player_id,
                client_message_id,sender_name,sender_avatar,sender_skin,sender_clothing,sender_hair,body,
                content_hash,sent_at,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, event.messageId(), event.conversationId(), senderUserId, event.senderId(), event.clientMessageId(),
            event.senderName(), event.avatar(), event.skin(), event.clothing(), event.hair(), event.text(), hash,
            sentAt, expiresAt);
        if (inserted == 0) {
            var existing = db.query("""
                SELECT message_id,client_message_id,conversation_id,sender_player_id,sender_user_id,sender_name,sender_avatar,
                       sender_skin,sender_clothing,sender_hair,body,sent_at,content_hash,revision,edited_at,deleted_at
                FROM direct_message WHERE conversation_id=? AND sender_user_id=? AND client_message_id=? FOR UPDATE
                """, MESSAGE, event.conversationId(), senderUserId, event.clientMessageId());
            if (existing.isEmpty()) throw new IllegalStateException("Message ID collision");
            return duplicate(existing.getFirst(), hash, recipientUserIds,
                findFanoutEventId(existing.getFirst().event().messageId(), "MESSAGE"));
        }
        for (String recipientUserId : recipientUserIds) {
            db.update("INSERT IGNORE INTO direct_message_push_outbox(id,message_id,recipient_user_id) VALUES (?,?,?)",
                UUID.randomUUID().toString(), event.messageId(), recipientUserId);
        }
        db.update("UPDATE direct_conversation SET updated_at=CURRENT_TIMESTAMP(6) WHERE id=?", event.conversationId());
        long fanoutEventId = insertFanout("MESSAGE", originNodeId, event.conversationId(), event.messageId(),
            senderUserId, null);
        return new StoreResult(true, true, event, recipientUserIds, fanoutEventId, "", "");
    }

    private boolean isChatRestricted(String userId) {
        return db.queryForObject("""
            SELECT COUNT(*) FROM user_chat_restriction
            WHERE user_id=? AND muted_until>CURRENT_TIMESTAMP(6)
            """, Integer.class, userId) > 0;
    }

    private MutationResult mutateMessage(String originNodeId, String actorUserId, String conversationId, String messageId,
                                        String requestId, String action, String text) {
        List<String> members = db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id",
            String.class, conversationId);
        if (members.size() < 2 || !members.contains(actorUserId))
            return deniedMutation("DM_NOT_MEMBER", "대화에 참여 중인 계정이 아니에요.");
        lockActiveUsers(members);
        List<String> conversation = db.queryForList(
            "SELECT id FROM direct_conversation WHERE id=? FOR UPDATE", String.class, conversationId);
        if (conversation.isEmpty()) return deniedMutation("DM_NOT_FOUND", "대화를 찾을 수 없어요.");
        List<String> currentMembers = db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id FOR UPDATE",
            String.class, conversationId);
        if (!currentMembers.equals(members))
            return deniedMutation("DM_MEMBERS_CHANGED", "그룹 구성이 바뀌었어요. 다시 시도해 주세요.");
        if (hasAnyBlocked(currentMembers))
            return deniedMutation("DM_BLOCKED", "차단 설정 때문에 메시지를 변경할 수 없어요.");

        List<Existing> rows = db.query("""
            SELECT message_id,client_message_id,conversation_id,sender_player_id,sender_user_id,sender_name,sender_avatar,
                   sender_skin,sender_clothing,sender_hair,body,sent_at,content_hash,revision,edited_at,deleted_at
            FROM direct_message WHERE conversation_id=? AND message_id=? AND expires_at>CURRENT_TIMESTAMP(6) FOR UPDATE
            """, MESSAGE, conversationId, messageId);
        if (rows.isEmpty()) return deniedMutation("DM_MESSAGE_NOT_FOUND", "메시지를 찾을 수 없어요.");
        Existing existing = rows.getFirst();
        ChatEvent current = existing.event();
        if (!actorUserId.equals(existing.senderUserId()))
            return deniedMutation("DM_NOT_AUTHOR", "내가 보낸 메시지만 수정하거나 삭제할 수 있어요.");
        String requestHash = mutationHash(conversationId, messageId, action, text);
        ExistingMutation previous = db.query("""
            SELECT message_id,request_hash FROM direct_message_mutation
            WHERE actor_user_id=? AND request_id=? FOR UPDATE
            """, (rs, row) -> new ExistingMutation(rs.getString("message_id"), rs.getString("request_hash")),
            actorUserId, requestId).stream().findFirst().orElse(null);
        if (previous != null) {
            if (!messageId.equals(previous.messageId()) || !MessageDigest.isEqual(
                previous.requestHash().getBytes(StandardCharsets.US_ASCII), requestHash.getBytes(StandardCharsets.US_ASCII)))
                return deniedMutation("DM_MUTATION_REQUEST_CONFLICT", "이미 사용한 변경 요청입니다. 다시 시도해 주세요.");
            return new MutationResult(true, current, currentMembers, 0, "", "변경을 반영했어요.");
        }
        if (current.deleted())
            return deniedMutation("DM_MESSAGE_DELETED", "삭제된 메시지는 다시 변경할 수 없어요.");
        if ("EDIT".equals(action)) {
            // MariaDB is the source of truth for message timestamps. Comparing its TIMESTAMP value
            // with the world's JVM clock can shift the 15-minute window when their time zones differ.
            boolean editExpired = Boolean.TRUE.equals(db.queryForObject("""
                SELECT sent_at < CURRENT_TIMESTAMP(6) - INTERVAL 15 MINUTE
                FROM direct_message WHERE conversation_id=? AND message_id=?
                """, Boolean.class, conversationId, messageId));
            if (editExpired)
                return deniedMutation("DM_EDIT_EXPIRED", "메시지는 보낸 뒤 15분 안에만 수정할 수 있어요.");
        }
        if ("EDIT".equals(action)) {
            if (text == null || text.isBlank() || text.codePointCount(0, text.length()) > 500
                || text.chars().anyMatch(Character::isISOControl))
                return deniedMutation("DM_INVALID_TEXT", "메시지는 1자 이상 500자 이하로 입력해 주세요.");
            int savedVersions = db.queryForObject(
                "SELECT COUNT(*) FROM direct_message_revision WHERE message_id=?", Integer.class, messageId);
            if (savedVersions >= 50)
                return deniedMutation("DM_REVISION_LIMIT", "메시지 수정 이력은 최대 50개까지 저장할 수 있어요.");
            Timestamp versionAt = Timestamp.from(Instant.ofEpochMilli(
                current.editedAt() > 0 ? current.editedAt() : current.sentAt()));
            db.update("""
                INSERT INTO direct_message_revision(message_id,revision,body,version_at)
                VALUES (?,?,?,?)
                """, messageId, current.revision(), current.text(), versionAt);
            db.update("""
                UPDATE direct_message SET body=?,edited_at=CURRENT_TIMESTAMP(3),revision=revision+1
                WHERE conversation_id=? AND message_id=? AND deleted_at IS NULL
                """, text, conversationId, messageId);
        } else if ("DELETE".equals(action)) {
            db.update("""
                UPDATE direct_message SET body='',deleted_at=CURRENT_TIMESTAMP(3),revision=revision+1
                WHERE conversation_id=? AND message_id=? AND deleted_at IS NULL
                """, conversationId, messageId);
            db.update("DELETE FROM direct_message_revision WHERE message_id=?", messageId);
        } else {
            return deniedMutation("DM_INVALID_ACTION", "메시지 변경 요청을 확인해 주세요.");
        }
        Existing updated = db.query("""
            SELECT message_id,client_message_id,conversation_id,sender_player_id,sender_user_id,sender_name,sender_avatar,
                   sender_skin,sender_clothing,sender_hair,body,sent_at,content_hash,revision,edited_at,deleted_at
            FROM direct_message WHERE conversation_id=? AND message_id=? FOR UPDATE
            """, MESSAGE, conversationId, messageId).getFirst();
        db.update("""
            INSERT INTO direct_message_mutation(id,message_id,actor_user_id,request_id,request_hash,action,revision)
            VALUES (UUID(),?,?,?,?,?,?)
            """, messageId, actorUserId, requestId, requestHash, action, updated.event().revision());
        db.update("UPDATE direct_conversation SET updated_at=CURRENT_TIMESTAMP(6) WHERE id=?", conversationId);
        long fanoutEventId = insertFanout("MUTATION", originNodeId, conversationId, messageId, actorUserId, null);
        return new MutationResult(true, updated.event(), currentMembers, fanoutEventId, "",
            "EDIT".equals(action) ? "메시지를 수정했어요." : "메시지를 삭제했어요.");
    }

    private ReadResult advanceReadCursor(String originNodeId, String actorUserId, String conversationId, String messageId) {
        List<String> conversation = db.queryForList("SELECT id FROM direct_conversation WHERE id=? FOR UPDATE",
            String.class, conversationId);
        if (conversation.isEmpty()) return deniedRead(conversationId, messageId, "DM_NOT_FOUND", "대화를 찾을 수 없어요.");
        List<String> members = db.queryForList(
            "SELECT user_id FROM direct_conversation_member WHERE conversation_id=? ORDER BY user_id FOR UPDATE",
            String.class, conversationId);
        if (members.size() < 2 || !members.contains(actorUserId))
            return deniedRead(conversationId, messageId, "DM_NOT_MEMBER", "대화에 참여 중인 계정이 아니에요.");
        Timestamp requestedAt = db.query("""
            SELECT sent_at FROM direct_message
            WHERE conversation_id=? AND message_id=? AND expires_at>CURRENT_TIMESTAMP(6)
            """, rs -> rs.next() ? rs.getTimestamp("sent_at") : null, conversationId, messageId);
        if (requestedAt == null)
            return deniedRead(conversationId, messageId, "DM_MESSAGE_NOT_FOUND", "읽음 상태를 반영할 메시지를 찾을 수 없어요.");

        db.update("""
            UPDATE direct_conversation_member SET last_read_at=?,last_read_message_id=?
            WHERE conversation_id=? AND user_id=?
              AND (last_read_at IS NULL OR last_read_at<? OR (last_read_at=? AND
                (last_read_message_id IS NULL OR last_read_message_id<?)))
            """, requestedAt, messageId, conversationId, actorUserId, requestedAt, requestedAt, messageId);

        ReadCursor cursor = db.query("""
            SELECT membership_id,last_read_message_id,last_read_at FROM direct_conversation_member
            WHERE conversation_id=? AND user_id=?
            """, rs -> rs.next() ? new ReadCursor(rs.getString("membership_id"),
                rs.getString("last_read_message_id"), rs.getTimestamp("last_read_at")) : null,
            conversationId, actorUserId);
        if (cursor == null || cursor.messageId() == null || cursor.readAt() == null)
            return deniedRead(conversationId, messageId, "DM_READ_UNAVAILABLE", "읽음 상태를 저장하지 못했어요.");
        long fanoutEventId = insertFanout("READ", originNodeId, conversationId, cursor.messageId(), actorUserId,
            cursor.membershipId());
        return new ReadResult(true, conversationId, cursor.messageId(), cursor.readAt().getTime(),
            cursor.membershipId(), members, fanoutEventId, "", "");
    }

    private long insertFanout(String type, String originNodeId, String conversationId, String messageId,
                              String actorUserId, String readerMembershipId) {
        Long nextId = db.queryForObject("SELECT next_id FROM direct_message_event_sequence WHERE singleton_id=1 FOR UPDATE",
            Long.class);
        if (nextId == null) throw new IllegalStateException("Direct message event sequence is unavailable");
        db.update("UPDATE direct_message_event_sequence SET next_id=? WHERE singleton_id=1", nextId + 1);
        db.update("""
            INSERT INTO direct_message_event_outbox(id,event_type,origin_node_id,conversation_id,message_id,
                actor_user_id,reader_membership_id)
            VALUES (?,?,?,?,?,?,?)
            """, nextId, type, originNodeId, conversationId, messageId, actorUserId, readerMembershipId);
        db.update("""
            INSERT INTO direct_message_event_recipient(event_id,membership_id)
            SELECT ?,membership_id FROM direct_conversation_member WHERE conversation_id=?
            """, nextId, conversationId);
        return nextId;
    }

    private long findFanoutEventId(String messageId, String type) {
        Long id = db.query("""
            SELECT id FROM direct_message_event_outbox WHERE message_id=? AND event_type=? ORDER BY id LIMIT 1
            """, rs -> rs.next() ? rs.getLong(1) : null, messageId, type);
        return id == null ? 0 : id;
    }

    private record ReadCursor(String membershipId, String messageId, Timestamp readAt) {}

    private void lockActiveUsers(List<String> users) {
        String placeholders = String.join(",", Collections.nCopies(users.size(), "?"));
        Object[] parameters = users.toArray();
        List<String> locked = db.queryForList("SELECT id FROM app_user WHERE id IN (" + placeholders + ") ORDER BY id FOR UPDATE",
            String.class, parameters);
        if (locked.size() != users.size()) throw new IllegalStateException("Direct message account is unavailable");
        int active = db.queryForObject("SELECT COUNT(*) FROM app_user WHERE id IN (" + placeholders + ") AND status='ACTIVE' AND deleted_at IS NULL",
            Integer.class, parameters);
        if (active != users.size()) throw new IllegalStateException("Direct message account is unavailable");
    }

    private boolean hasAnyBlocked(List<String> users) {
        String placeholders = String.join(",", Collections.nCopies(users.size(), "?"));
        Object[] parameters = new Object[users.size() * 2];
        for (int index = 0; index < users.size(); index++) {
            parameters[index] = users.get(index);
            parameters[index + users.size()] = users.get(index);
        }
        return db.queryForObject("SELECT COUNT(*) FROM user_block WHERE blocker_user_id IN (" + placeholders
            + ") AND blocked_user_id IN (" + placeholders + ")", Integer.class, parameters) > 0;
    }

    private static List<String> orderedUsers(String first, String second) {
        return first.compareTo(second) < 0 ? List.of(first, second) : List.of(second, first);
    }

    private static StoreResult duplicate(Existing existing, String receivedHash, List<String> recipientUserIds,
                                         long fanoutEventId) {
        if (!MessageDigest.isEqual(existing.contentHash().getBytes(StandardCharsets.US_ASCII), receivedHash.getBytes(StandardCharsets.US_ASCII)))
            return new StoreResult(false, false, null, recipientUserIds, 0, "CHAT_IDEMPOTENCY_CONFLICT", "이미 사용한 요청 ID예요. 다시 보내 주세요.");
        return new StoreResult(true, false, existing.event(), recipientUserIds, fanoutEventId, "", "");
    }

    private static String groupCreationHash(String groupName, List<String> users) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                (groupName + "\n" + String.join("\n", users)).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String invitationHash(String conversationId, String inviteeUserId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                (conversationId + "\n" + inviteeUserId).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String contentHash(ChatEvent event) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                (event.conversationId() + "\n" + event.text()).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String mutationHash(String conversationId, String messageId, String action, String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                (conversationId + "\n" + messageId + "\n" + action + "\n" + text).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private void queuePurge() {
        try {
            writer.execute(() -> {
                try {
                    for (int page = 0; page < 10; page++) {
                        int removed = db.update("DELETE FROM direct_message WHERE expires_at<=CURRENT_TIMESTAMP(6) LIMIT 1000");
                        if (removed < 1000) break;
                    }
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("Direct message retention cleanup failed: {}", failure.getClass().getSimpleName());
                }
            });
        } catch (RejectedExecutionException full) {
            LoggerFactory.getLogger(getClass()).warn("Direct message retention cleanup deferred because storage queue is full");
        }
    }

    private static OpenResult unavailableOpen() {
        return new OpenResult(false, "", "DM_STORAGE_UNAVAILABLE", "대화를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }

    private static StoreResult unavailableStore() {
        return new StoreResult(false, false, null, List.of(), 0, "DM_STORAGE_UNAVAILABLE", "메시지를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }

    private static StoreResult denied(String code, String message) {
        return new StoreResult(false, false, null, List.of(), 0, code, message);
    }

    private static MutationResult unavailableMutation(String conversationId, String messageId) {
        return deniedMutation("DM_STORAGE_UNAVAILABLE", "메시지를 변경하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }

    private static MutationResult deniedMutation(String code, String message) {
        return new MutationResult(false, null, List.of(), 0, code, message);
    }

    private static ReadResult unavailableRead(String conversationId, String messageId) {
        return deniedRead(conversationId, messageId, "DM_STORAGE_UNAVAILABLE", "읽음 상태를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }

    private static ReadResult deniedRead(String conversationId, String messageId, String code, String message) {
        return new ReadResult(false, conversationId, messageId, 0, "", List.of(), 0, code, message);
    }

    private static InviteResult unavailableInvite(String conversationId) {
        return deniedInvite(conversationId, "DM_STORAGE_UNAVAILABLE", "그룹 초대를 보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    }

    private static InviteResult deniedInvite(String conversationId, String code, String message) {
        return new InviteResult(false, false, "", conversationId, "", "", 0, code, message);
    }

    @PreDestroy
    void shutdown() {
        retention.shutdownNow();
        writer.shutdown();
        try {
            if (!writer.awaitTermination(2, TimeUnit.SECONDS)) writer.shutdownNow();
        } catch (InterruptedException interrupted) {
            writer.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
