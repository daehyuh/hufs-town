package town.hufs.world;

import jakarta.annotation.PreDestroy;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

@Component
@ConditionalOnProperty(name = "town.storage-mode", havingValue = "mariadb-redis")
final class UserReportStore {
    record Result(boolean accepted, String code, String message) {}

    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(256), task -> {
            Thread thread = new Thread(task, "town-user-report-storage");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    UserReportStore(JdbcTemplate db, TransactionTemplate tx) {
        this.db = db;
        this.tx = tx;
    }

    boolean create(String reporterUserId, String reporterName, String targetUserId, String targetGuestId, String targetName,
                   String spaceId, String category, String details, Consumer<Result> completed) {
        if ((targetUserId == null) == (targetGuestId == null)) return false;
        try {
            worker.execute(() -> {
                try {
                    Result result = tx.execute(status -> {
                        List<String> activeReporters = db.queryForList("""
                            SELECT id FROM app_user
                            WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL
                            FOR UPDATE
                            """, String.class, reporterUserId);
                        if (activeReporters.isEmpty())
                            return new Result(false, "REPORT_ACCOUNT_UNAVAILABLE", "로그인 계정을 확인할 수 없어 신고를 접수하지 못했어요.");
                        if (targetUserId != null && db.queryForList("""
                            SELECT id FROM app_user WHERE id=? AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE
                            """, String.class, targetUserId).isEmpty())
                            return new Result(false, "REPORT_TARGET_UNAVAILABLE", "신고 대상 계정이 더 이상 활성 상태가 아니에요.");

                        String targetColumn = targetUserId == null ? "target_guest_id" : "target_user_id";
                        String targetId = targetUserId == null ? targetGuestId : targetUserId;
                        int reportsForTarget = db.queryForObject("""
                            SELECT COUNT(*) FROM user_report
                            WHERE reporter_user_id=? AND %s=?
                              AND created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY
                            """.formatted(targetColumn), Integer.class, reporterUserId, targetId);
                        if (reportsForTarget > 0)
                            return new Result(false, "REPORT_TARGET_ALREADY_REPORTED", "같은 참가자는 24시간에 한 번만 신고할 수 있어요.");

                        int reportsToday = db.queryForObject("""
                            SELECT COUNT(*) FROM user_report
                            WHERE reporter_user_id=? AND created_at>=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY
                            """, Integer.class, reporterUserId);
                        if (reportsToday >= 10)
                            return new Result(false, "REPORT_LIMIT", "신고는 하루 최대 10건까지 접수할 수 있어요.");

                        LocalDate reportDay = LocalDate.now(ZoneOffset.UTC);
                        String reportId = UUID.randomUUID().toString();
                        db.update("""
                            INSERT INTO user_report(
                                report_id,reporter_user_id,reporter_name_snapshot,target_user_id,target_guest_id,
                                target_identity_type,target_name_snapshot,conversation_id,message_id,category,details,evidence_text,message_sent_at,
                                source_type,space_id,player_report_day)
                            VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?, '',NULL,'PLAYER',?,?)
                            """, reportId, reporterUserId, reporterName, targetUserId, targetGuestId,
                            targetGuestId == null ? "ACCOUNT" : "GUEST", targetName,
                            category, details, spaceId, reportDay);
                        return new Result(true, "", "신고를 접수했어요. 운영팀이 확인할게요.");
                    });
                    completed.accept(result == null
                        ? new Result(false, "REPORT_STORAGE_UNAVAILABLE", "신고를 접수하지 못했어요. 다시 시도해 주세요.")
                        : result);
                } catch (DuplicateKeyException duplicate) {
                    completed.accept(new Result(false, "REPORT_DUPLICATE", "이 참가자는 오늘 이미 신고했어요."));
                } catch (RuntimeException failure) {
                    LoggerFactory.getLogger(getClass()).warn("Participant report save failed: {}", failure.getClass().getSimpleName());
                    completed.accept(new Result(false, "REPORT_STORAGE_UNAVAILABLE", "신고를 접수하지 못했어요. 다시 시도해 주세요."));
                }
            });
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }

    @PreDestroy
    void shutdown() {
        worker.shutdown();
        try {
            if (!worker.awaitTermination(2, TimeUnit.SECONDS)) worker.shutdownNow();
        } catch (InterruptedException interrupted) {
            worker.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
