package town.hufs.api.space;

import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.Map;

@RestControllerAdvice(basePackageClasses = SpaceErrors.class)
class SpaceErrors {
    private static final Logger log = LoggerFactory.getLogger(SpaceErrors.class);
    @ExceptionHandler(town.hufs.domain.MapRules.Invalid.class) ResponseEntity<?> invalidMap(town.hufs.domain.MapRules.Invalid e) {
        return ResponseEntity.badRequest().body(Map.of("code", "MAP_INVALID", "message", e.getMessage()));
    }
    @ExceptionHandler(SpaceFailure.class) ResponseEntity<?> failure(SpaceFailure e) {
        return ResponseEntity.status(e.status).body(Map.of("code", e.code, "message", e.getMessage()));
    }
    @ExceptionHandler(CollaborativeEditConflict.class) ResponseEntity<?> collaborativeConflict(CollaborativeEditConflict e) {
        return ResponseEntity.status(409).body(Map.of("code", "MAP_EDIT_CONFLICT", "message", e.getMessage(), "sequence", e.sequence, "editor", e.editor));
    }
    @ExceptionHandler(DataAccessException.class) ResponseEntity<?> unavailable(DataAccessException failure) {
        Throwable cause = failure.getMostSpecificCause();
        String origin = Arrays.stream(failure.getStackTrace())
            .filter(frame -> frame.getClassName().startsWith("town.hufs.api."))
            .findFirst()
            .map(frame -> frame.getClassName() + "#" + frame.getMethodName() + ":" + frame.getLineNumber())
            .orElse("unknown");
        if (cause instanceof SQLException sql)
            log.warn("Space storage request failed (sqlState={}, vendorCode={}, origin={})",
                sql.getSQLState(), sql.getErrorCode(), origin);
        else
            log.warn("Space storage request failed (cause={}, origin={})", cause.getClass().getSimpleName(), origin);
        return ResponseEntity.status(503).body(Map.of("code", "SPACE_UNAVAILABLE", "message", "공간 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요."));
    }
    @ExceptionHandler(HttpMessageNotReadableException.class) ResponseEntity<?> malformed() {
        return ResponseEntity.badRequest().body(Map.of("code", "INVALID_REQUEST", "message", "입력 내용을 확인해 주세요."));
    }
    @ExceptionHandler(MaxUploadSizeExceededException.class) ResponseEntity<?> uploadTooLarge() {
        return ResponseEntity.status(413).body(Map.of("code", "ASSET_TOO_LARGE", "message", "에셋은 2MB 이하로 올려 주세요."));
    }
}
