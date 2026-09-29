package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.concurrent.*;

/**
 * Durable event results writer. WorldHandler remains a single room actor; all
 * MariaDB work is serialized here so a slow database cannot stall movement or
 * WebSocket fan-out.
 */
@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class EventPersistence {
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private volatile ProductAnalytics productAnalytics;
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(512), task -> {
            Thread thread = new Thread(task, "town-event-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    EventPersistence(JdbcTemplate db, TransactionTemplate tx) {
        this.db = db;
        this.tx = tx;
    }

    @Autowired(required = false)
    void attachProductAnalytics(ProductAnalytics analytics) {
        productAnalytics = analytics;
    }

    boolean start(String eventId, String spaceId, String hostUserId, String title, String description,
                  String resourceUrl, long startedAt) {
        return submit(() -> tx.executeWithoutResult(status -> db.update("""
            INSERT INTO town_event(id,space_id,host_user_id,title,description,resource_url,started_at)
            VALUES (?,?,?,?,?,?,?)
            """, eventId, spaceId, blankToNull(hostUserId), title, description, resourceUrl,
            new java.sql.Timestamp(startedAt))));
    }

    boolean stop(String eventId, long endedAt) {
        return submit(() -> tx.executeWithoutResult(status -> {
            closeOpenAttendance(eventId);
            db.update("UPDATE town_event_poll SET closed=TRUE,closed_at=? WHERE event_id=? AND closed=FALSE",
                new java.sql.Timestamp(endedAt), eventId);
            db.update("UPDATE town_event SET ended_at=? WHERE id=? AND ended_at IS NULL",
                new java.sql.Timestamp(endedAt), eventId);
        }));
    }

    boolean enter(String eventId, String playerId, String userId, String displayName) {
        return submit(() -> {
            int changed = db.update("""
            INSERT INTO town_event_attendance(event_id,player_id,user_id,display_name,segment_started_at,segment_count)
            VALUES (?,?,?,?,CURRENT_TIMESTAMP(6),1)
            ON DUPLICATE KEY UPDATE user_id=COALESCE(VALUES(user_id),user_id),
                display_name=VALUES(display_name),last_seen_at=CURRENT_TIMESTAMP(6),left_at=NULL,
                segment_started_at=CURRENT_TIMESTAMP(6),segment_count=segment_count+1
            """, eventId, playerId, blankToNull(userId), displayName);
            ProductAnalytics analytics = productAnalytics;
            if (changed > 0 && analytics != null)
                analytics.record(ProductAnalytics.Metric.EVENT_PARTICIPATION);
        });
    }

    boolean touch(String eventId, String playerId) {
        return submit(() -> db.update("""
            UPDATE town_event_attendance SET last_seen_at=CURRENT_TIMESTAMP(6),left_at=NULL
            WHERE event_id=? AND player_id=?
            """, eventId, playerId));
    }

    boolean leave(String eventId, String playerId) {
        return submit(() -> db.update("""
            UPDATE town_event_attendance
            SET attended_seconds=attended_seconds+GREATEST(0,TIMESTAMPDIFF(SECOND,COALESCE(segment_started_at,last_seen_at),CURRENT_TIMESTAMP(6))),
                left_at=CURRENT_TIMESTAMP(6),segment_started_at=NULL
            WHERE event_id=? AND player_id=? AND left_at IS NULL
            """, eventId, playerId));
    }

    boolean question(String eventId, String questionId, String askerUserId, String askerName, String body) {
        return submit(() -> db.update("""
            INSERT INTO town_event_question(id,event_id,asker_user_id,asker_name,body)
            VALUES (?,?,?,?,?)
            """, questionId, eventId, blankToNull(askerUserId), askerName, body));
    }

    boolean answer(String eventId, String questionId, String answererName, String answer) {
        return submit(() -> db.update("""
            UPDATE town_event_question SET answered=TRUE,answer=?,answerer_name=?,answered_at=CURRENT_TIMESTAMP(6)
            WHERE id=? AND event_id=?
            """, answer, answererName, questionId, eventId));
    }

    boolean poll(String eventId, String pollId, String question, List<String> options,
                 boolean quiz, int correctOptionIndex) {
        return submit(() -> tx.executeWithoutResult(status -> {
            db.update("INSERT INTO town_event_poll(id,event_id,question,kind,correct_option_index) VALUES (?,?,?,?,?)",
                pollId, eventId, question, quiz ? "QUIZ" : "POLL", quiz ? correctOptionIndex : null);
            for (int index = 0; index < options.size(); index++)
                db.update("INSERT INTO town_event_poll_option(poll_id,option_index,label) VALUES (?,?,?)",
                    pollId, index, options.get(index));
        }));
    }

    boolean vote(String pollId, String participantType, String participantId, String userId,
                 int optionIndex, boolean correct) {
        if (participantId == null || participantId.isBlank()) return true;
        return submit(() -> tx.executeWithoutResult(status -> {
            int inserted = db.update("""
                INSERT IGNORE INTO town_event_poll_vote
                    (poll_id,user_id,participant_type,participant_id,option_index,is_correct,points_awarded)
                VALUES (?,?,?,?,?,?,?)
                """, pollId, blankToNull(userId), participantType, participantId, optionIndex, correct, correct ? 1 : 0);
            if (inserted == 1)
                db.update("UPDATE town_event_poll_option SET vote_count=vote_count+1 WHERE poll_id=? AND option_index=?",
                    pollId, optionIndex);
        }));
    }

    boolean closePoll(String pollId) {
        return submit(() -> db.update("UPDATE town_event_poll SET closed=TRUE,closed_at=CURRENT_TIMESTAMP(6) WHERE id=? AND closed=FALSE", pollId));
    }

    private void closeOpenAttendance(String eventId) {
        db.update("""
            UPDATE town_event_attendance
            SET attended_seconds=attended_seconds+GREATEST(0,TIMESTAMPDIFF(SECOND,COALESCE(segment_started_at,last_seen_at),CURRENT_TIMESTAMP(6))),
                left_at=CURRENT_TIMESTAMP(6),segment_started_at=NULL
            WHERE event_id=? AND left_at IS NULL
            """, eventId);
    }

    private boolean submit(Runnable task) {
        try {
            writer.execute(() -> {
                try {
                    task.run();
                } catch (RuntimeException failure) {
                    org.slf4j.LoggerFactory.getLogger(getClass()).warn("Event persistence failed: {}", failure.getClass().getSimpleName());
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            org.slf4j.LoggerFactory.getLogger(getClass()).warn("Event persistence queue full");
            return false;
        }
    }

    private static String blankToNull(String value) { return value == null || value.isBlank() ? null : value; }

    @PreDestroy
    void shutdown() {
        writer.shutdown();
        try {
            if (!writer.awaitTermination(2, TimeUnit.SECONDS)) writer.shutdownNow();
        } catch (InterruptedException interrupted) {
            writer.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
