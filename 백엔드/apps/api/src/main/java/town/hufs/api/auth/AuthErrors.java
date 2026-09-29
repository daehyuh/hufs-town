package town.hufs.api.auth;

import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.server.ResponseStatusException;
import java.util.Map;

@RestControllerAdvice(basePackageClasses = AuthErrors.class)
class AuthErrors {
    @ExceptionHandler(AuthFailure.class)
    ResponseEntity<?> auth(AuthFailure failure) {
        return ResponseEntity.status(failure.status).body(Map.of("code", failure.code, "message", failure.getMessage()));
    }
    @ExceptionHandler(DataAccessException.class)
    ResponseEntity<?> unavailable(DataAccessException failure) {
        return ResponseEntity.status(503).body(Map.of("code", "AUTH_STORAGE_UNAVAILABLE", "message", "인증 저장소에 연결할 수 없어요. 잠시 후 다시 시도해 주세요."));
    }
    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<?> malformed() {
        return ResponseEntity.badRequest().body(Map.of("code", "INVALID_REQUEST", "message", "요청 형식을 확인해 주세요."));
    }
    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<?> status(ResponseStatusException failure) {
        HttpStatusCode status = failure.getStatusCode();
        String code = switch (status.value()) {
            case 400 -> "INVALID_REQUEST";
            case 404 -> "NOT_FOUND";
            case 409 -> "CONFLICT";
            case 429 -> "RATE_LIMITED";
            default -> "REQUEST_FAILED";
        };
        String message = failure.getReason() == null ? "요청을 처리할 수 없어요." : failure.getReason();
        return ResponseEntity.status(status).body(Map.of("code", code, "message", message));
    }
}
